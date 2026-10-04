import { NextRequest } from "next/server";
import { guardApiRequest } from "@/lib/api-guard";
import { analyzeDetail } from "@/lib/services/detail";
export const maxDuration = 120;
export async function POST(req: NextRequest) {
  const denied = guardApiRequest(req);
  if (denied) return denied;
  return analyzeDetail(await req.json().catch(() => null));
}
