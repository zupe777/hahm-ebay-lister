// API payloads built from stored photo Blobs at the moment a request needs
// them. Base64 lives only for the duration of the request.

import { bestImage, blobToBase64, getMaster, getThumb } from "./photo-store";
import {
  ANALYSIS_STEPS,
  base64Length,
  masterFromImage,
  resizeForAnalysis,
} from "./resize";
import { PhotoError } from "./storage-health";
import { MAX_ANALYSIS_PHOTOS } from "./validation";

// The analysis photos of one item, as base64, stay below this — well under
// the server's limit for one request (ANALYSIS_REQUEST_LIMIT, 3.8 M) so the
// prepare step, which sends the same images with the listing, fits too.
export const ANALYSIS_BUDGET_BASE64 = 3_000_000;

export const tooManyForAnalysis = (n: number) =>
  `This item has ${n} photos selected for AI analysis; the AI can analyze at most ${MAX_ANALYSIS_PHOTOS} per item. Untick ${n - MAX_ANALYSIS_PHOTOS} or more of this item's photos for AI analysis (keep labels, tags and flaws), then retry.`;

export interface ImagePayload {
  mediaType: "image/jpeg";
  data: string;
}

const missing = () =>
  new PhotoError(
    "unknown",
    "A selected photo is missing from browser storage. Add it again, then retry.",
  );

async function payload(blob: Blob | undefined): Promise<ImagePayload> {
  if (!blob) throw missing();
  return { mediaType: "image/jpeg", data: await blobToBase64(blob) };
}

// ~1024 px images for listing analysis, made from each photo's master (or
// its best older image) for this request only.
export async function analysisImage(id: string): Promise<Blob> {
  const best = await bestImage(id);
  if (!best) throw missing();
  return resizeForAnalysis(best.blob);
}

// Every selected photo of an item for one AI request. The set is made at
// 1024 px first; when it is over the budget, all photos are remade at the
// next smaller step (ANALYSIS_STEPS) until the whole set fits. No photo is
// ever left out: more than 24 is refused with a clear message instead.
export async function analysisImages(ids: string[]): Promise<ImagePayload[]> {
  return (await fitAnalysisImages(ids)).images;
}

export async function fitAnalysisImages(ids: string[]): Promise<{
  images: ImagePayload[];
  step: number;
  base64: number;
}> {
  if (ids.length > MAX_ANALYSIS_PHOTOS)
    throw new PhotoError("unknown", tooManyForAnalysis(ids.length));
  const sources: Blob[] = [];
  for (const id of ids) {
    const best = await bestImage(id);
    if (!best) throw missing();
    sources.push(best.blob);
  }
  for (const [step, [dim, quality]] of ANALYSIS_STEPS.entries()) {
    const blobs: Blob[] = [];
    for (const src of sources)
      blobs.push(
        step === 0
          ? await resizeForAnalysis(src)
          : await resizeForAnalysis(src, dim, quality),
      );
    const base64 = blobs.reduce((n, b) => n + base64Length(b.size), 0);
    if (
      base64 <= ANALYSIS_BUDGET_BASE64 ||
      step === ANALYSIS_STEPS.length - 1
    ) {
      if (base64 > ANALYSIS_BUDGET_BASE64)
        throw new PhotoError(
          "unknown",
          `These ${ids.length} photos are too much data for one AI request even at reduced detail. Untick some of this item's photos for AI analysis, then retry.`,
        );
      const images: ImagePayload[] = [];
      for (const b of blobs) images.push(await payload(b));
      return { images, step, base64 };
    }
  }
  throw new Error("unreachable");
}

// ~360 px images for photo sorting (keeps sort requests small).
export async function thumbnailImages(ids: string[]): Promise<ImagePayload[]> {
  const out: ImagePayload[] = [];
  for (const id of ids) out.push(await payload(await getThumb(id)));
  return out;
}

// The eBay upload image: the stored master, byte for byte (never compressed
// again). A photo not yet converted gets a master made by the same rules for
// this upload; a photo with only its ~1024 px image left sends that.
export async function uploadImageBlob(id: string): Promise<Blob> {
  const master = await getMaster(id);
  if (master) return master;
  const best = await bestImage(id);
  if (!best) throw missing();
  if (best.kind === "analysis") return best.blob;
  return (await masterFromImage(best.blob)).blob;
}

export async function uploadImages(ids: string[]): Promise<ImagePayload[]> {
  const out: ImagePayload[] = [];
  for (const id of ids) out.push(await payload(await uploadImageBlob(id)));
  return out;
}
