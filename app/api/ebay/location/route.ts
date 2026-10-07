import { NextRequest, NextResponse } from "next/server";
import { guardApiRequest } from "@/lib/api-guard";
import { accessTokenFromCookie, EBAY_COOKIE } from "@/lib/ebay/session";
import { createInventoryLocation } from "@/lib/ebay/publish";
import { withDeadline } from "@/lib/network";
import { inventoryLocationSchema } from "@/lib/validation";

// Creates the seller's one-time shipping origin (an enabled US warehouse
// Inventory API location) with the connected eBay account. The address is
// passed straight to eBay and is not stored.
export async function POST(req: NextRequest) {
  const denied = guardApiRequest(req);
  if (denied) return denied;
  const parsed = inventoryLocationSchema.safeParse(
    await req.json().catch(() => null),
  );
  if (!parsed.success)
    return NextResponse.json(
      {
        ok: false,
        error: parsed.error.issues[0]?.message ?? "Check the address.",
      },
      { status: 400 },
    );
  return withDeadline(25_000, async () => {
    try {
      const token = await accessTokenFromCookie(
        req.cookies.get(EBAY_COOKIE)?.value,
      );
      if (!token)
        return NextResponse.json(
          { ok: false, error: "Connect eBay to create a shipping origin." },
          { status: 401 },
        );
      await createInventoryLocation(token, parsed.data);
      return NextResponse.json({
        ok: true,
        merchantLocationKey: parsed.data.merchantLocationKey,
      });
    } catch (e) {
      return NextResponse.json(
        { ok: false, error: (e as Error).message },
        { status: 502 },
      );
    }
  });
}
