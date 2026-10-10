// API payloads built from stored photo Blobs at the moment a request needs
// them. Base64 lives only for the duration of the request.

import { bestImage, blobToBase64, getMaster, getThumb } from "./photo-store";
import { masterFromImage, resizeForAnalysis } from "./resize";
import { PhotoError } from "./storage-health";

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

export async function analysisImages(ids: string[]): Promise<ImagePayload[]> {
  const out: ImagePayload[] = [];
  for (const id of ids) out.push(await payload(await analysisImage(id)));
  return out;
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
