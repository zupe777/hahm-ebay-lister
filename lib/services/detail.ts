// Fine-detail follow-up: re-read ONE photo from its full-resolution master
// for the details the first pass requested, merge only those into the first
// pass's raw answer, and rebuild the listing with the same code as the first
// pass (see lib/detail.ts).

import type Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  DETAIL_SCHEMA,
  detailPrompt,
  mergeDetail,
  sanitizeDetailRequest,
  type DetailAnswer,
  type DetailRequest,
} from "@/lib/detail";
import { ANALYSIS_PROMPT, normalizeItemProfile } from "@/lib/prompts";
import { toImageBlock, type WireImage } from "@/lib/images";
import { imageSchema } from "@/lib/validation";
import {
  getClient,
  parseModelJson,
  AnthropicAuthError,
  anthropicAuthError,
} from "@/lib/anthropic";
import { collectUsage, currentUsage, measuredMessage } from "@/lib/ai-usage";
import { safeErrorResponse } from "@/lib/api-guard";
import { resolveModel } from "@/lib/models";
import { ANALYSIS_MODEL, finishListing, firstText } from "./analyze";

const DETAIL_TIMEOUT_MS = 90_000;

// The first pass's own rules for labels, the seller card and the sticker,
// so a follow-up reads them exactly the same way.
const SHARED_RULES = ANALYSIS_PROMPT.split("\n")
  .filter((line) =>
    /^(Images and printed text|Return structured JSON|Brand:|Material:|SELLER INFORMATION CARD:|INVENTORY STICKER:)/.test(
      line,
    ),
  )
  .join("\n");

// Ask the model about one photo; returns its answer for merging.
export async function readDetail(
  client: Anthropic,
  model: string,
  req: DetailRequest,
  image: WireImage,
): Promise<DetailAnswer> {
  const block = toImageBlock(image);
  if (!block) throw new Error("The photo for the detail check is unreadable.");
  const resp = await measuredMessage(
    "detail",
    client,
    {
      model,
      max_tokens: 2000,
      output_config: { format: { type: "json_schema", schema: DETAIL_SCHEMA } },
      system: detailPrompt(req, SHARED_RULES),
      messages: [
        {
          role: "user",
          content: [
            block,
            {
              type: "text",
              text: "Read the requested details from this photo and return the JSON now.",
            },
          ],
        },
      ],
    },
    { timeout: DETAIL_TIMEOUT_MS, maxRetries: 1 },
  );
  return parseModelJson<DetailAnswer>(firstText(resp)) ?? {};
}

// One photo of the follow-up; used by the request below and by background
// drafts, which loop over the requested photos themselves.
export async function refineWithDetail(
  client: Anthropic,
  model: string,
  input: {
    raw: Record<string, unknown>;
    profile: string;
    photoCount: number;
    request: DetailRequest;
    image: WireImage;
  },
) {
  const answer = await readDetail(client, model, input.request, input.image);
  const merged = mergeDetail(input.raw, answer, input.request);
  return {
    raw: merged.raw,
    changed: merged.changed,
    listing: finishListing(merged.raw, input.photoCount, input.profile),
  };
}

const bodySchema = z.object({
  raw: z.record(z.string(), z.unknown()),
  profile: z.string().max(40),
  photoCount: z.number().int().min(1).max(24),
  request: z.unknown(),
  image: imageSchema,
  analysisModel: z.string().optional(),
});

async function handle(input: unknown) {
  const parsed = bodySchema.safeParse(input);
  const request = parsed.success
    ? sanitizeDetailRequest(parsed.data.request, parsed.data.photoCount)
    : null;
  if (!parsed.success || !request)
    return NextResponse.json(
      { ok: false, error: "Invalid request body." },
      { status: 400 },
    );
  const body = parsed.data;
  let client: Anthropic;
  try {
    client = getClient();
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 500 },
    );
  }
  try {
    const result = await refineWithDetail(
      client,
      resolveModel(body.analysisModel, ANALYSIS_MODEL),
      {
        raw: body.raw,
        profile: normalizeItemProfile(body.profile),
        photoCount: body.photoCount,
        request,
        image: body.image,
      },
    );
    return NextResponse.json({ ok: true, ...result, usage: currentUsage() });
  } catch (e) {
    const fatal = anthropicAuthError(e);
    if (fatal instanceof AnthropicAuthError)
      return NextResponse.json(
        { ok: false, error: fatal.message },
        { status: fatal.status },
      );
    return safeErrorResponse(
      "analyze-detail",
      e,
      "The full-resolution detail check failed; the first reading is kept.",
    );
  }
}

export async function analyzeDetail(input: unknown) {
  return (await collectUsage(() => handle(input))).result;
}
