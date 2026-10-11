import { NextRequest } from "next/server";
import { guardApiRequest } from "@/lib/api-guard";
import { readStickerPhotos } from "@/lib/services/sticker";
export const maxDuration = 120;
export async function POST(req: NextRequest) {
  const denied = guardApiRequest(req);
  if (denied) return denied;
  return readStickerPhotos(await req.json().catch(() => null));
}
