import { NextResponse } from "next/server";
import type Anthropic from "@anthropic-ai/sdk";
import {
  getClient,
  parseModelJson,
  AnthropicAuthError,
  anthropicAuthError,
} from "@/lib/anthropic";
import { safeErrorResponse } from "@/lib/api-guard";
import { collectUsage, currentUsage, measuredMessage } from "@/lib/ai-usage";
import { toImageBlock, type ImageBlock } from "@/lib/images";
import {
  STICKER_JSON_SCHEMA,
  STICKER_ONLY_PROMPT,
  interpretStickers,
} from "@/lib/inventory-sticker";
import { resolveModel } from "@/lib/models";
import { imagesProblem } from "@/lib/validation";
import { ANALYSIS_MODEL, firstText } from "@/lib/services/analyze";

// Reads only the inventory sticker from an item's photos ("Read sticker").
// It never writes or changes listing content; the browser applies the
// result to the item's SKU suggestion only.
const CALL_TIMEOUT_MS = 90_000;

async function handle(input: unknown) {
  const body = input as {
    images?: { mediaType: string; data: string }[];
    analysisModel?: string;
  } | null;
  const problem = body ? imagesProblem(body.images) : "Invalid request body.";
  if (problem)
    return NextResponse.json({ ok: false, error: problem }, { status: 400 });
  const blocks = (body!.images ?? [])
    .map(toImageBlock)
    .filter((b): b is ImageBlock => Boolean(b));
  if (!blocks.length)
    return NextResponse.json(
      { ok: false, error: "No readable photos found. Use JPG, PNG, or WebP." },
      { status: 400 },
    );
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
    const resp = await measuredMessage(
      "sticker",
      client,
      {
        model: resolveModel(body!.analysisModel, ANALYSIS_MODEL),
        max_tokens: 1000,
        output_config: {
          format: { type: "json_schema", schema: STICKER_JSON_SCHEMA },
        },
        system: STICKER_ONLY_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              ...blocks,
              {
                type: "text",
                text: "Report the inventory stickers in these photos now.",
              },
            ],
          },
        ],
      },
      { timeout: CALL_TIMEOUT_MS, maxRetries: 1 },
    );
    const raw = parseModelJson<{ inventory_stickers?: unknown }>(
      firstText(resp),
    );
    return NextResponse.json({
      ok: true,
      sticker: interpretStickers(raw?.inventory_stickers, blocks.length),
      usage: currentUsage(),
    });
  } catch (e) {
    const fatal = e instanceof AnthropicAuthError ? e : anthropicAuthError(e);
    if (fatal)
      return NextResponse.json(
        { ok: false, error: fatal.message },
        { status: fatal.status },
      );
    return safeErrorResponse(
      "sticker",
      e,
      "Could not read the inventory sticker — please try again.",
    );
  }
}

export async function readStickerPhotos(input: unknown) {
  return (await collectUsage(() => handle(input))).result;
}
