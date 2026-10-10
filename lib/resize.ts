// Photo processing in the browser. Everything is produced as binary Blobs
// (canvas.toBlob); base64 exists only briefly when an API request needs it.
//
// Stored per photo (see lib/photo-store.ts):
//   • master — one JPEG of at most 2000 px on the long side, compressed once
//              from the selected file. It is the exact file uploaded to eBay
//              and the photo the seller can save.
//   • thumb  — ~360 px JPEG for on-screen previews and photo sorting.
// The ~1024 px image the AI reads is made from the master when a request
// needs it and is never stored.

import { PhotoError } from "./storage-health";

export const MASTER_MAX_DIM = 2000;
// Aim for about 0.9 MB per master; quality never drops below 0.80, and only
// then does the long side shrink toward 1800 px.
export const MASTER_TARGET_BYTES = 900 * 1024;
export const MASTER_STEPS: [number, number][] = [
  [2000, 0.88],
  [2000, 0.85],
  [2000, 0.82],
  [2000, 0.8],
  [1900, 0.8],
  [1800, 0.8],
];
// eBay upload requests carry one photo as base64 under Vercel's body limit;
// a master is never larger than this.
export const UPLOAD_MAX_BASE64 = 2_700_000;
export const base64Length = (bytes: number) => Math.ceil(bytes / 3) * 4;
const LAST_RESORT_DIMS = [1600, 1400, 1200, 1000];

export const ANALYSIS_DIM = 1024;
export const ANALYSIS_QUALITY = 0.82;
export const THUMB_DIM = 360;
export const THUMB_QUALITY = 0.5;

export interface Master {
  blob: Blob;
  width: number;
  height: number;
  quality: number;
}

export interface PreparedPhoto {
  master: Blob;
  thumb: Blob;
  width: number;
  height: number;
  quality: number;
  mediaType: "image/jpeg";
}

type Source = ImageBitmap | HTMLImageElement;
export type Encoder = (maxDim: number, quality: number) => Promise<Blob>;

export function scaleDown(w: number, h: number, max: number) {
  if (w <= max && h <= max) return { width: w, height: h };
  const ratio = Math.min(max / w, max / h);
  return { width: Math.round(w * ratio), height: Math.round(h * ratio) };
}

// The master rules, independent of any canvas: the first step whose JPEG is
// at most MASTER_TARGET_BYTES; otherwise the 1800 px / 0.80 result. A smaller
// source is never enlarged, so steps that would produce the same image are
// skipped. Only an image still too large to upload shrinks further.
export async function chooseMaster(
  encode: Encoder,
  srcWidth: number,
  srcHeight: number,
): Promise<Master> {
  let last: Master | undefined;
  let lastKey = "";
  for (const [dim, quality] of MASTER_STEPS) {
    const { width, height } = scaleDown(srcWidth, srcHeight, dim);
    const key = `${width}x${height}@${quality}`;
    if (key === lastKey) continue;
    lastKey = key;
    last = { blob: await encode(dim, quality), width, height, quality };
    if (last.blob.size <= MASTER_TARGET_BYTES) return last;
  }
  if (last && base64Length(last.blob.size) <= UPLOAD_MAX_BASE64) return last;
  for (const dim of LAST_RESORT_DIMS) {
    const { width, height } = scaleDown(srcWidth, srcHeight, dim);
    const blob = await encode(dim, 0.8);
    last = { blob, width, height, quality: 0.8 };
    if (base64Length(blob.size) <= UPLOAD_MAX_BASE64) return last;
  }
  throw new PhotoError("decode", "Photo is too large to store and upload.");
}

// One decode of the selected file: the master and the thumbnail.
export async function preparePhoto(file: Blob): Promise<PreparedPhoto> {
  const bitmap = await loadBitmap(file);
  try {
    const encode = encoderFor(bitmap);
    const master = await chooseMaster(
      encode,
      sizeOf(bitmap).w,
      sizeOf(bitmap).h,
    );
    const thumb = await encode(THUMB_DIM, THUMB_QUALITY);
    return {
      master: master.blob,
      thumb,
      width: master.width,
      height: master.height,
      quality: master.quality,
      mediaType: "image/jpeg",
    };
  } finally {
    if ("close" in bitmap) bitmap.close();
  }
}

// A master (and, when wanted, a thumbnail) from an existing stored image —
// used when converting photos saved by earlier versions.
export async function masterFromImage(
  blob: Blob,
  withThumb = false,
): Promise<Master & { thumb?: Blob }> {
  const bitmap = await loadBitmap(blob);
  try {
    const encode = encoderFor(bitmap);
    const master = await chooseMaster(
      encode,
      sizeOf(bitmap).w,
      sizeOf(bitmap).h,
    );
    return withThumb
      ? { ...master, thumb: await encode(THUMB_DIM, THUMB_QUALITY) }
      : master;
  } finally {
    if ("close" in bitmap) bitmap.close();
  }
}

// A thumbnail from a stored image (a converted photo without one).
export async function thumbFromImage(blob: Blob): Promise<Blob> {
  const bitmap = await loadBitmap(blob);
  try {
    return await encoderFor(bitmap)(THUMB_DIM, THUMB_QUALITY);
  } finally {
    if ("close" in bitmap) bitmap.close();
  }
}

// The ~1024 px AI image, made on demand from a stored image.
export async function resizeForAnalysis(blob: Blob): Promise<Blob> {
  const bitmap = await loadBitmap(blob);
  try {
    return await encoderFor(bitmap)(ANALYSIS_DIM, ANALYSIS_QUALITY);
  } finally {
    if ("close" in bitmap) bitmap.close();
  }
}

// A stored image is usable: it is a JPEG and the browser can decode it.
export async function verifyImage(blob: Blob): Promise<boolean> {
  try {
    const head = new Uint8Array(await blob.slice(0, 3).arrayBuffer());
    if (head[0] !== 0xff || head[1] !== 0xd8 || head[2] !== 0xff) return false;
    const bitmap = await loadBitmap(blob);
    const { w, h } = sizeOf(bitmap);
    if ("close" in bitmap) bitmap.close();
    return w > 0 && h > 0;
  } catch {
    return false;
  }
}

const sizeOf = (src: Source) => ({
  w: "naturalWidth" in src ? src.naturalWidth : src.width,
  h: "naturalHeight" in src ? src.naturalHeight : src.height,
});

function encoderFor(src: Source): Encoder {
  return (maxDim, quality) => drawToJpeg(src, maxDim, quality);
}

function drawToJpeg(
  src: Source,
  maxDim: number,
  quality: number,
): Promise<Blob> {
  const { w, h } = sizeOf(src);
  const { width, height } = scaleDown(w, h, maxDim);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx)
    return Promise.reject(
      new PhotoError("decode", "This browser could not process the photo."),
    );
  // JPEG has no transparency: transparent areas become white, not black.
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, width, height);
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => {
        // Release the canvas memory promptly on large batches.
        canvas.width = canvas.height = 0;
        if (blob) resolve(blob);
        else
          reject(
            new PhotoError(
              "decode",
              "This browser could not encode the photo.",
            ),
          );
      },
      "image/jpeg",
      quality,
    ),
  );
}

// Decode with the camera's orientation applied (EXIF), so portrait photos
// stay upright in the master, the thumbnail and on eBay.
async function loadBitmap(file: Blob): Promise<Source> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      // Fall through to the <img> path (e.g. some HEIC/Safari cases).
    }
  }
  if (typeof Image === "undefined")
    throw new PhotoError(
      "decode",
      "This photo could not be read (unsupported or damaged image file).",
    );
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(
        new PhotoError(
          /heic|heif/i.test(file.type) ? "unsupported" : "decode",
          /heic|heif/i.test(file.type)
            ? "This browser cannot read HEIC photos. Export them as JPG and add them again."
            : "This photo could not be read (unsupported or damaged image file).",
        ),
      );
    };
    img.src = url;
  });
}
