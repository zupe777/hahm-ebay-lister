import { NextRequest, NextResponse } from "next/server";
import { getClient, AnthropicAuthError } from "@/lib/anthropic";
import { guardApiRequest, safeErrorResponse } from "@/lib/api-guard";
import { checkMergeGroups, MAX_SEAM_PHOTOS } from "@/lib/sortPipeline";
import { isAllowedModel } from "@/lib/models";
import { toImageBlock, type WireImage } from "@/lib/images";

// Merge check across sort-chunk boundaries: big batches are sorted 100 photos
// per request, so an item photographed across a boundary is split into two
// groups. The client sends the photos of each boundary group nearest the
// boundary (at most MAX_SEAM_PHOTOS in total); the decision is the same one
// the sort pipeline uses to merge adjacent groups within a request.

export const maxDuration = 60;

// Keeps one request under Vercel's 4.5 MB body limit.
const MAX_BASE64_CHARS = 3_800_000;

const photos = (v: unknown): WireImage[] | null =>
  Array.isArray(v) &&
  v.length > 0 &&
  v.every((img) => toImageBlock(img as WireImage) !== null)
    ? (v as WireImage[])
    : null;

export async function POST(req: NextRequest) {
  const denied = guardApiRequest(req);
  if (denied) return denied;

  let body: { a?: unknown; b?: unknown; sortModel?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid request body." },
      { status: 400 },
    );
  }
  const a = photos(body.a);
  const b = photos(body.b);
  if (!a || !b) {
    return NextResponse.json(
      { ok: false, error: "Missing photos." },
      { status: 400 },
    );
  }
  if (
    a.length + b.length > MAX_SEAM_PHOTOS ||
    [...a, ...b].reduce((n, img) => n + img.data.length, 0) > MAX_BASE64_CHARS
  ) {
    return NextResponse.json(
      {
        ok: false,
        error: `Send at most ${MAX_SEAM_PHOTOS} photos per boundary check.`,
      },
      { status: 400 },
    );
  }

  const requested =
    typeof body.sortModel === "string" ? body.sortModel.trim() : "";
  const model = isAllowedModel(requested) ? requested : undefined;

  try {
    const merge = await checkMergeGroups(getClient(), a, b, model);
    // The check could not run (API failure or time budget spent): never a
    // guess — the client keeps the groups separate and says so.
    if (merge === null)
      return NextResponse.json(
        { ok: false, error: "The boundary check could not be completed." },
        { status: 503 },
      );
    return NextResponse.json({ ok: true, merge });
  } catch (e) {
    if (e instanceof AnthropicAuthError) {
      return NextResponse.json(
        { ok: false, error: e.message },
        { status: e.status },
      );
    }
    return safeErrorResponse("merge-check", e, "Merge check failed.");
  }
}
