// Optional storewide price markup (PRICE_MARKUP_PERCENT env var).
//
// For sellers who run a permanent store-level sale: the sale discounts every
// listing, so auto-suggested prices need to be inflated up front to land where
// they should after the discount. The markup is applied wherever a price is
// SUGGESTED (analysis result, comps median) — never silently at publish time,
// so the price the seller reviews on the card is exactly the price that
// publishes (the same principle that removed the old hidden 18% markup).
//
// Unset/invalid → 0, so deployments without the env var behave exactly as
// before. Note the arithmetic: +40% then a 40%-off sale nets 84% of the
// original (1.4 × 0.6). To have the discounted price land back on the
// suggested price under an X%-off sale, set 100·X/(100−X) — e.g. ~66.7 for a
// 40%-off sale.

import type { ListingResult } from "@/lib/types";

// Parse the configured markup percent. Exposed with an injectable raw value so
// tests don't have to mutate process.env.
export function priceMarkupPercent(
  raw: string | undefined = process.env.PRICE_MARKUP_PERCENT
): number {
  if (raw === undefined || raw.trim() === "") return 0;
  const pct = Number(raw);
  if (!Number.isFinite(pct) || pct < 0) {
    console.warn(`[pricing] ignoring invalid PRICE_MARKUP_PERCENT=${JSON.stringify(raw)}`);
    return 0;
  }
  return pct;
}

// Apply a percent markup to a suggested price, rounded to cents. Missing,
// unparseable, and ≤0 prices pass through untouched — 0 is the model's
// explicit "couldn't identify it, seller prices manually" signal and must
// stay 0 so the UI keeps flagging it.
export function applyPriceMarkup(price: number, percent: number): number;
export function applyPriceMarkup(
  price: ListingResult["suggested_price"],
  percent: number
): ListingResult["suggested_price"];
export function applyPriceMarkup(
  price: ListingResult["suggested_price"],
  percent: number
): ListingResult["suggested_price"] {
  if (percent <= 0) return price;
  const n = typeof price === "string" ? parseFloat(price) : price;
  if (n === undefined || !Number.isFinite(n) || n <= 0) return price;
  return Math.round(n * (1 + percent / 100) * 100) / 100;
}

// ── Market pricing from active comps ─────────────────────────────────────────
// Suggest an item price whose DELIVERED cost (item + the seller's own shipping)
// matches the median delivered price of comparable active listings. Only ever
// offered behind a "Use" button; never written to a draft automatically.

export const MIN_MARKET_COMPS = 3;
export const MIN_ITEM_PRICE = 5;
// Smallest .99 price at or above the floor: 5.00–5.49 rounds up to this.
const FLOOR_ROUNDED_PRICE = 5.99;
export const DEFAULT_SHIPPING_CHARGE = 7.99;

// The seller's buyer-paid shipping charge (MY_SHIPPING_CHARGE). Unset or
// invalid → the 7.99 default.
export function myShippingCharge(
  raw: string | undefined = process.env.MY_SHIPPING_CHARGE
): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_SHIPPING_CHARGE;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.warn(`[pricing] ignoring invalid MY_SHIPPING_CHARGE=${JSON.stringify(raw)}`);
    return DEFAULT_SHIPPING_CHARGE;
  }
  return Math.round(n * 100) / 100;
}

// Nearest price ending in .99, computed in whole cents (20.00 → 19.99,
// 12.50 → 12.99, 6.20 → 5.99).
export function roundTo99(price: number): number {
  const cents = Math.round(price * 100);
  return (Math.round((cents + 1) / 100) * 100 - 1) / 100;
}

export interface MarketPrice {
  // What the "Use" button sets.
  itemPrice: number;
  // Median delivered price minus shipping, before markup and rounding.
  rawItemPrice: number;
  // The computed price fell under MIN_ITEM_PRICE, so itemPrice is the floor
  // and the seller's delivered price will be above the market median.
  belowFloor: boolean;
}

export function marketItemPrice(
  deliveredMedian: number,
  shipping: number,
  markupPercent = 0
): MarketPrice {
  const raw = Math.round((deliveredMedian - shipping) * 100) / 100;
  const computed = raw > 0 ? applyPriceMarkup(raw, markupPercent) : raw;
  if (computed < MIN_ITEM_PRICE)
    return { itemPrice: MIN_ITEM_PRICE, rawItemPrice: raw, belowFloor: true };
  return {
    itemPrice: Math.max(FLOOR_ROUNDED_PRICE, roundTo99(computed)),
    rawItemPrice: raw,
    belowFloor: false,
  };
}
