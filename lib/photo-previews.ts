// Object URLs for photo previews. Each photo has at most one live URL; it is
// revoked when the photo is removed or the batch is cleared, so previews
// never leak memory.

import { getPhotoBlob } from "./photo-store";

const urls = new Map<string, string>();

export function setPreview(id: string, blob: Blob): string {
  revokePreview(id);
  const url = URL.createObjectURL(blob);
  urls.set(id, url);
  return url;
}

// Preview from storage: the thumbnail, else the analysis image. "" if the
// photo's data is gone.
export async function loadPreview(id: string): Promise<string> {
  const blob =
    (await getPhotoBlob(id, "thumb")) ?? (await getPhotoBlob(id, "analysis"));
  return blob ? setPreview(id, blob) : "";
}

export function revokePreview(id: string): void {
  const url = urls.get(id);
  if (url) URL.revokeObjectURL(url);
  urls.delete(id);
}

export function revokeAllPreviews(): void {
  for (const id of [...urls.keys()]) revokePreview(id);
}

export const livePreviewCount = () => urls.size;
