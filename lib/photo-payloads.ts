// API payloads built from stored photo Blobs at the moment a request needs
// them. Base64 lives only for the duration of the request.

import {
  blobToBase64,
  getPhotoBlob,
  getUploadSource,
  base64ToBlob,
} from "./photo-store";
import { uploadImageFromOriginal } from "./resize";
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

// ~1024 px images for listing analysis and preparation.
export async function analysisImages(ids: string[]): Promise<ImagePayload[]> {
  const out: ImagePayload[] = [];
  for (const id of ids)
    out.push(await payload(await getPhotoBlob(id, "analysis")));
  return out;
}

// ~360 px images for photo sorting (keeps sort requests small).
export async function thumbnailImages(ids: string[]): Promise<ImagePayload[]> {
  const out: ImagePayload[] = [];
  for (const id of ids)
    out.push(await payload(await getPhotoBlob(id, "thumb")));
  return out;
}

// The eBay upload copy, generated from the original (never stored).
export async function uploadImageBlob(id: string): Promise<Blob> {
  const source = await getUploadSource(id);
  if (source.original) return uploadImageFromOriginal(source.original);
  if (source.legacyUpload) return base64ToBlob(source.legacyUpload);
  if (source.analysis) return source.analysis;
  throw missing();
}

export async function uploadImages(ids: string[]): Promise<ImagePayload[]> {
  const out: ImagePayload[] = [];
  for (const id of ids) out.push(await payload(await uploadImageBlob(id)));
  return out;
}
