import type { CompsSummary, ListingResult } from "./types";

// Shared wording for where a draft's price came from. Market comps are active
// asking prices, never sold prices.
export function priceSourceLabel(listing: ListingResult | undefined): string {
  switch (listing?.price_source) {
    case "market":
      return "From active asking prices (not sold)";
    case "seller":
      return "Your price";
    case "ai":
      return "AI estimate: unverified, from photos only";
    default:
      return "Unverified estimate";
  }
}

export const money = (n: number) => `$${n.toFixed(2)}`;

export function belowFloorWarning(comps: CompsSummary): string {
  const delivered = (comps.itemPrice ?? 0) + (comps.shippingCharge ?? 0);
  return `Market median minus your shipping is below the ${money(comps.itemPrice ?? 0)} minimum. At ${money(comps.itemPrice ?? 0)}, your delivered price (${money(delivered)}) is above the market median (${money(comps.median ?? 0)}).`;
}
