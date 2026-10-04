// Photo processing in the browser. Everything is produced as binary Blobs
// (canvas.toBlob); base64 exists only briefly when an API request needs it.
//
// Stored per photo (see lib/photo-store.ts):
//   • analysis — ~1024 px JPEG for writing the listing (tags need detail)
//   • thumb    — ~360 px JPEG for on-screen previews and photo sorting
//   • original — the file as selected
// The eBay upload copy (up to 2400 px) is generated from the original only
// when publishing, with the same size and quality rules as before.

import { PhotoError } from "./storage-health";

export const ANALYSIS_DIM = 1024;
export const ANALYSIS_QUALITY = 0.82;
export const THUMB_DIM = 360;
export const THUMB_QUALITY = 0.5;
// eBay upload copy: tried in order until it fits the request-size bound.
export const UPLOAD_STEPS: [number, number][] = [
  [2400, 0.9],
  [2000, 0.8],
  [1600, 0.75],
];
// Base64 characters per upload image (keeps upload requests under Vercel's
// body limit). Unchanged from the earlier stored upload copy.
export const UPLOAD_MAX_BASE64 = 2_700_000;
export const base64Length = (bytes: number) => Math.ceil(bytes / 3) * 4;

export interface PreparedPhoto {
  original: Blob;
  analysis: Blob;
  thumb: Blob;
  mediaType: "image/jpeg";
}

type Source = ImageBitmap | HTMLImageElement;
export type Encoder = (maxDim: number, quality: number) => Promise<Blob>;

export async function preparePhoto(file: Blob): Promise<PreparedPhoto> {
  const bitmap = await loadBitmap(file);
  try {
    const encode = encoderFor(bitmap);
    const analysis = await encode(ANALYSIS_DIM, ANALYSIS_QUALITY);
    const thumb = await encode(THUMB_DIM, THUMB_QUALITY);
    return { original: file, analysis, thumb, mediaType: "image/jpeg" };
  } finally {
    if ("close" in bitmap) bitmap.close();
  }
}

// The upload copy rules: the first step whose JPEG fits the size bound.
export async function chooseUploadImage(encode: Encoder): Promise<Blob> {
  for (const [dim, quality] of UPLOAD_STEPS) {
    const blob = await encode(dim, quality);
    if (base64Length(blob.size) <= UPLOAD_MAX_BASE64) return blob;
  }
  throw new PhotoError("decode", "Photo is too large to upload.");
}

// eBay upload copy generated from the stored original.
export async function uploadImageFromOriginal(original: Blob): Promise<Blob> {
  const bitmap = await loadBitmap(original);
  try {
    return await chooseUploadImage(encoderFor(bitmap));
  } finally {
    if ("close" in bitmap) bitmap.close();
  }
}

function encoderFor(src: Source): Encoder {
  return (maxDim, quality) => drawToJpeg(src, maxDim, quality);
}

function drawToJpeg(
  src: Source,
  maxDim: number,
  quality: number,
): Promise<Blob> {
  const w = "width" in src ? src.width : 0;
  const h = "height" in src ? src.height : 0;
  const { width, height } = scaleDown(w, h, maxDim);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx)
    return Promise.reject(
      new PhotoError("decode", "This browser could not process the photo."),
    );
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

export function scaleDown(w: number, h: number, max: number) {
  if (w <= max && h <= max) return { width: w, height: h };
  const ratio = Math.min(max / w, max / h);
  return { width: Math.round(w * ratio), height: Math.round(h * ratio) };
}

async function loadBitmap(file: Blob): Promise<Source> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file);
    } catch {
      // Fall through to the <img> path (e.g. some HEIC/Safari cases).
    }
  }
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
