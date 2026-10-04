import type { ListingResult } from "./types";
import type { AspectMeta } from "./ebay/taxonomy";
import { hasName } from "./provenance";
import { cardFlaw, cardNew } from "./seller-card";

const addDefaulted = (listing: ListingResult, name: string) => {
  if (!hasName(listing.defaulted, name))
    listing.defaulted = [...(listing.defaulted ?? []), name];
};

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
    !hasName(listing.seller_specifics, "Size Type") &&
    sizeType &&
    (sizeType.mode === "FREE_TEXT" || sizeType.values.includes("Regular"))
  ) {
    listing.item_specifics = {
      ...listing.item_specifics,
      "Size Type": "Regular",
    };
    addDefaulted(listing, "Size Type");
    if (listing.evidence) {
      listing.evidence = { ...listing.evidence };
      delete listing.evidence["Size Type"];
    }
    if (listing.estimates) {
      listing.estimates = { ...listing.estimates };
      delete listing.estimates["Size Type"];
    }
  }
  if (listing.ebay_condition) return; // the seller's or an earlier choice
  if (listing.condition && !listing.ai_condition)
    listing.ai_condition = listing.condition;
  if (listing.seller_card) {
    applyCardCondition(listing, acceptedIds);
    return;
  }
  // 2990 is Pre-owned Excellent. 3000 must not be used as a substitute:
  // in these clothing categories it means Pre-owned Good.
  if (acceptedIds.has(2990)) setDefaultExcellent(listing);
}

function setDefaultExcellent(listing: ListingResult) {
  // Keep the analysis grade for display; publishing uses ebay_condition.
  addDefaulted(listing, "condition");
  listing.ebay_condition = "PRE_OWNED_EXCELLENT";
  listing.condition = "EXCELLENT";
}

const photos = (ns: number[]) =>
  `photo${ns.length === 1 ? "" : "s"} ${ns.join(", ")}`;

// Condition from a seller information card. Only an explicit NEW: YES makes
// the item seller-declared New; New with tags also needs attached tags
// visible in the photos. A flaw moves the pre-owned default to Pre-owned Good.
// When the card leaves the right choice open, the condition stays empty and
// condition_review tells the seller why.
function applyCardCondition(listing: ListingResult, ids: Set<number>) {
  const card = listing.seller_card;
  const isNew = cardNew(card);
  const flaw = cardFlaw(card);
  const preOwnedGrades = ids.has(2990) || ids.has(3010);
  const notes: string[] = [];
  const review = (text: string) => {
    listing.condition_review = [...notes, text].filter(Boolean).join(" ");
  };
  listing.condition_review = undefined;

  if (isNew === "yes") {
    const newOptions = [
      ids.has(1000) ? "New with tags (1000) if tags are attached" : "",
      ids.has(1500) ? "New without tags (1500)" : "",
      ids.has(1750) ? "New with defects (1750)" : "",
    ].filter(Boolean);
    // Seller-declared New; the exact New condition may still need a choice.
    listing.condition = "NEW_NO_TAGS";
    const choose = newOptions.length
      ? ` Choose the condition that applies: ${newOptions.join(", ")}.`
      : " Choose the condition that applies.";
    if (flaw)
      return review(
        `Seller card says NEW: YES and lists a flaw, so the condition is left for you.${choose}`,
      );
    const tags = listing.attached_tags;
    if (tags?.visible && ids.has(1000)) {
      listing.ebay_condition = "NEW";
      listing.condition = "NEW_WITH_TAGS";
      return review(
        `New with tags: seller card says NEW: YES and attached tags are visible in ${photos(tags.photoIndices)}.`,
      );
    }
    return review(
      tags?.visible
        ? `Seller card says NEW: YES and tags are visible, but this category has no New with tags condition.${choose}`
        : `Seller card says NEW: YES, but no attached tags are visible, so New with tags is not claimed.${choose}`,
    );
  }
  if (isNew === "unclear")
    notes.push(
      `Seller card NEW: "${card?.fields.NEW}" is not a clear YES, so the item is treated as pre-owned.`,
    );

  const written = card?.fields.CONDITION?.trim();
  if (written) {
    const grade = cardGrade(written, ids, preOwnedGrades);
    if (grade) {
      listing.ebay_condition = grade.value;
      listing.condition = grade.condition;
      return review(`Condition from the seller card: ${written}.`);
    }
    return review(
      `Seller card CONDITION: "${written}" does not match a condition for this category; choose it yourself.`,
    );
  }
  if (flaw) {
    if (ids.has(3000) && preOwnedGrades) {
      addDefaulted(listing, "condition");
      listing.ebay_condition = "USED_EXCELLENT"; // 3000 = Pre-owned Good here
      listing.condition = "GOOD";
      return review("Pre-owned Good because the seller card lists a flaw.");
    }
    return review("The seller card lists a flaw; choose the condition.");
  }
  if (ids.has(2990)) setDefaultExcellent(listing);
  if (notes.length) review("");
}

function cardGrade(
  written: string,
  ids: Set<number>,
  preOwnedGrades: boolean,
): { value: string; condition: string } | undefined {
  const g = written
    .toLowerCase()
    .replace(/^pre[\s-]?owned\s*[-:]?\s*/, "")
    .replace(/[^a-z ]/g, "")
    .trim();
  if (g === "excellent" && ids.has(2990))
    return { value: "PRE_OWNED_EXCELLENT", condition: "EXCELLENT" };
  if (g === "good" && ids.has(3000) && preOwnedGrades)
    return { value: "USED_EXCELLENT", condition: "GOOD" };
  if (g === "fair" && ids.has(3010))
    return { value: "PRE_OWNED_FAIR", condition: "FAIR" };
  return undefined;
}
