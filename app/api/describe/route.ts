import { NextRequest } from "next/server";
import { guardApiRequest } from "@/lib/api-guard";
import { improveDescription } from "@/lib/services/describe";
export const maxDuration = 150;
export async function POST(req: NextRequest) {
  const denied = guardApiRequest(req);
  if (denied) return denied;
  return improveDescription(await req.json().catch(() => null));
}
