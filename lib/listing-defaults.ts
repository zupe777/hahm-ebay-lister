import type { ListingResult } from "./types";
import type { AspectMeta } from "./ebay/taxonomy";

// Clothing resale defaults, not facts inferred from the photos: most resale
// garments are Regular sizing and pre-owned. Apply only to empty fields while
// preparing the draft, never during publication; the seller can change both.
export function applyListingDefaults(
  listing: ListingResult,
  meta: AspectMeta[],
  acceptedIds: Set<number>,
): void {
  const sizeType = meta.find((a) => a.name === "Size Type");
  if (
    !listing.item_specifics?.["Size Type"]?.trim() &&
    sizeType &&
    (sizeType.mode === "FREE_TEXT" || sizeType.values.includes("Regular"))
  ) {
    listing.item_specifics = {
      ...listing.item_specifics,
      "Size Type": "Regular",
    };
    if (listing.evidence) {
      listing.evidence = { ...listing.evidence };
      delete listing.evidence["Size Type"];
    }
    if (listing.estimates) {
      listing.estimates = { ...listing.estimates };
      delete listing.estimates["Size Type"];
    }
  }
  // 2990 is Pre-owned Excellent. 3000 must not be used as a substitute:
  // in these clothing categories it means Pre-owned Good.
  if (!listing.ebay_condition && acceptedIds.has(2990)) {
    listing.ebay_condition = "PRE_OWNED_EXCELLENT";
    listing.condition = "EXCELLENT";
  }
}
