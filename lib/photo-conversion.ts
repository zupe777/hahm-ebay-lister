// Converting photos saved by earlier versions in this browser: the image
// work (lib/resize.ts) plus the seller-facing status text.

import type { ConvertDeps, ConvertResult } from "./photo-store";
import { masterFromImage, thumbFromImage, verifyImage } from "./resize";

// Chrome deletes stored data (and credits its space) only once the page
// holds no reference to it: give garbage collection a reason and a moment
// to run before a write refused as full is retried.
export async function settleStorage(attempt: number): Promise<void> {
  for (let i = 0; i < 8; i++)
    new Uint8Array(new ArrayBuffer(16 * 1024 * 1024))[0] = 1;
  await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
}

export const browserConvertDeps: ConvertDeps = {
  makeMaster: async (blob, withThumb) => {
    const m = await masterFromImage(blob, withThumb);
    return { blob: m.blob, thumb: m.thumb };
  },
  makeThumb: thumbFromImage,
  verify: verifyImage,
  settle: settleStorage,
};

const photos = (n: number) => `${n} photo${n === 1 ? "" : "s"}`;

// Null when conversion finished cleanly.
export function conversionNote(r: ConvertResult): string | undefined {
  const notes: string[] = [];
  if (r.paused === "quota" || r.paused === "upgrade")
    notes.push(
      `Photo conversion paused: browser storage is full. ${photos(r.remaining)} still use${r.remaining === 1 ? "s" : ""} the older, larger format and remain${r.remaining === 1 ? "s" : ""} fully usable — nothing was deleted. To continue, remove a few photos you no longer need (✕ on a photo) or use "Release photos of posted items"; conversion then resumes automatically. Do not clear site data.`,
    );
  else if (r.paused === "error")
    notes.push(
      `Photo conversion stopped: ${r.error?.message ?? "unknown error"} ${photos(r.remaining)} remain${r.remaining === 1 ? "s" : ""} in the older format and stay usable. Reload the page to try again.`,
    );
  if (r.unreadable.length)
    notes.push(
      `${photos(r.unreadable.length)} saved by an earlier version could not be read for conversion and ${r.unreadable.length === 1 ? "was" : "were"} left exactly as stored.`,
    );
  return notes.length ? notes.join(" ") : undefined;
}
