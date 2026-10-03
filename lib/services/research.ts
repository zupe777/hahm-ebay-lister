import { withDeadline } from "@/lib/network";
import { NextRequest, NextResponse } from "next/server";
import { guardApiRequest } from "@/lib/api-guard";
import { isEbayAppConfigured } from "@/lib/ebay/config";
import { appToken } from "@/lib/ebay/taxonomy";
import { searchComps } from "@/lib/ebay/comps";
import {
  MIN_MARKET_COMPS,
  marketItemPrice,
  myShippingCharge,
  priceMarkupPercent,
} from "@/lib/pricing";
import type { ListingResult } from "@/lib/types";

// One Browse-API search; quick.
export const maxDuration = 30;

// Market price check for a drafted listing: active-comp count, median, and
// range. Uses the app-level eBay token, so it works before a seller connects.
export async function researchListing(input: unknown) {
  if (!isEbayAppConfigured()) {
    return NextResponse.json(
      { ok: false, error: "eBay isn't configured." },
      { status: 200 },
    );
  }

  let body: { listing?: ListingResult };
  try {
    body = input as { listing?: ListingResult };
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid request." },
      { status: 400 },
    );
  }
  if (!body.listing?.title) {
    return NextResponse.json(
      { ok: false, error: "Missing listing." },
      { status: 400 },
    );
  }

  try {
    const comps = await withDeadline(25_000, async () =>
      searchComps(await appToken(), body.listing!),
    );
    // The band stays raw market truth (delivered asking prices). The "Use"
    // suggestion matches the median delivered price after the seller's own
    // shipping, carrying the storewide markup like analysis pricing does.
    const shippingCharge = myShippingCharge();
    const market =
      comps.count >= MIN_MARKET_COMPS && comps.median !== undefined
        ? marketItemPrice(comps.median, shippingCharge, priceMarkupPercent())
        : undefined;
    return NextResponse.json({
      ok: true,
      comps: {
        ...comps,
        shippingCharge,
        minComps: MIN_MARKET_COMPS,
        ...market,
      },
    });
  } catch (e) {
    // Comps are advisory — never let a market-check failure look like an outage.
    console.warn(`[ebay/comps] lookup failed: ${(e as Error).message}`);
    return NextResponse.json(
      { ok: false, error: "Market check unavailable." },
      { status: 200 },
    );
  }
}
