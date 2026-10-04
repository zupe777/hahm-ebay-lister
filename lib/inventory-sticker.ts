// The seller's inventory sticker: a small white label, handwritten in black,
// on the item or its bag ("1001", "A-1001", "B-52"). Its value becomes the
// listing's existing SKU (eBay Custom Label). The analysis model only reports
// what it sees; acceptance here is deterministic and conservative. A sticker
// is never an item specific, never a seller-card field, and never inferred
// from other listing data.

import type { InventoryLabel, ItemGroup, ListingResult } from "./types";

// Letters, numbers and inner hyphens; at least one digit. Spaces, dots,
// slashes, inch marks and units never belong to a sticker value.
const STICKER_FORMAT =
  /^(?=.*\d)[A-Za-z0-9](?:[A-Za-z0-9-]{0,18}[A-Za-z0-9])?$/;
// All-digit runs this long are barcodes (UPC/EAN/GTIN), not inventory numbers.
const BARCODE_LIKE = /^\d{8,}$/;
export const MIN_STICKER_CONFIDENCE = 85;

export const UNREADABLE_STICKER_MESSAGE =
  "Inventory sticker detected but Custom Label could not be read confidently. Enter the Custom Label before publishing.";
export const MISSING_SKU_MESSAGE =
  "Custom Label (SKU) is missing. Enter your inventory number before publishing.";

const same = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();
const words = (v: string) =>
  ` ${v
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, " ")
    .trim()} `;

// What the analysis model reported → a reviewed sticker result, or undefined
// when no sticker was seen. `otherText` is text the value must not match:
// seller-card lines, label quotes and item-specific values (size tags,
// style/RN/model numbers, UPCs).
export function readInventorySticker(
  raw: unknown,
  photoCount: number,
  otherText: string[] = [],
): InventoryLabel | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as {
    present?: unknown;
    handwritten_white_sticker?: unknown;
    readable?: unknown;
    value?: unknown;
    readings?: unknown;
    photoIndices?: unknown;
    confidence?: unknown;
  };
  // Appearance is required evidence: a white, handwritten sticker.
  if (r.present !== true || r.handwritten_white_sticker !== true)
    return undefined;
  const photoIndices = Array.isArray(r.photoIndices)
    ? r.photoIndices.filter(
        (i): i is number => Number.isInteger(i) && i > 0 && i <= photoCount,
      )
    : [];
  const unreadable = (): InventoryLabel => ({
    status: "unreadable",
    photoIndices,
  });
  if (!photoIndices.length) return unreadable();

  const value = typeof r.value === "string" ? r.value.trim() : "";
  const readings = [
    ...new Set(
      (Array.isArray(r.readings) ? r.readings : [])
        .map((v) => String(v ?? "").trim())
        .filter(Boolean),
    ),
  ].slice(0, 6);
  // Distinct readings across photos (case-insensitive) are never resolved
  // automatically.
  const distinct: string[] = [];
  for (const v of [value, ...readings].filter(Boolean))
    if (!distinct.some((d) => same(d, v))) distinct.push(v);
  if (distinct.length > 1)
    return { status: "conflict", photoIndices, readings: distinct };

  const confidence = Number(r.confidence);
  if (
    r.readable !== true ||
    !value ||
    !Number.isFinite(confidence) ||
    confidence < MIN_STICKER_CONFIDENCE ||
    !STICKER_FORMAT.test(value) ||
    BARCODE_LIKE.test(value) ||
    // Printed product text (size tag, style/RN/model number, UPC) or the
    // ITEM INFORMATION card is never the inventory sticker.
    otherText.some((t) => words(t).includes(` ${value.toLowerCase()} `))
  )
    return unreadable();
  return { status: "read", value, photoIndices, confidence };
}

// The Custom Label (SKU) the seller wrote on the ITEM INFORMATION card. Only
// that labelled field counts; other numbers on the card never become the SKU.
export function cardCustomLabel(listing: ListingResult): string {
  return (listing.seller_card?.fields["CUSTOM LABEL"] ?? "").trim();
}

export function stickerWarning(label: InventoryLabel | undefined): string {
  if (!label || label.status === "read") return "";
  if (label.status === "conflict")
    return `Inventory stickers disagree (${(label.readings ?? []).join(", ")}). Enter the correct Custom Label.`;
  return UNREADABLE_STICKER_MESSAGE;
}

// Review notes about the SKU for this item, given where its value came from.
// `blocking` explains a blank SKU (publishing needs one); `notice` is a
// non-blocking disagreement between the card and the sticker.
export function skuNotes(g: ItemGroup): { blocking: string; notice: string } {
  const listing = g.listing;
  const label = listing?.inventory_label;
  const card = listing ? cardCustomLabel(listing) : "";
  const notice =
    g.skuSource === "card" &&
    card &&
    label?.status === "read" &&
    label.value &&
    !same(label.value, card)
      ? `Seller card Custom Label (SKU) is ${card}; the inventory sticker reads ${label.value}. The card value is used; check which is correct.`
      : "";
  const blocking = g.sku.trim()
    ? ""
    : (g.skuSource !== "seller" && stickerWarning(label)) ||
      MISSING_SKU_MESSAGE;
  return { blocking, notice };
}

// SKU (eBay Custom Label) after an analysis result arrives. Only the seller
// supplies it: the seller's own entry (including an intentional clear) >
// the card's Custom Label (SKU) field > a confidently read inventory sticker
// > blank. Nothing is ever generated. A SKU is never changed once a
// publication attempt used it.
export function skuAfterAnalysis(
  g: ItemGroup,
  listing: ListingResult,
): Pick<ItemGroup, "sku" | "skuSource"> {
  if (
    g.skuSource === "seller" ||
    g.publicationAttemptSku ||
    g.postStatus === "posted"
  )
    return { sku: g.sku, skuSource: g.skuSource };
  const card = cardCustomLabel(listing);
  if (card) return { sku: card, skuSource: "card" };
  const label = listing.inventory_label;
  if (label?.status === "read" && label.value)
    return { sku: label.value, skuSource: "sticker" };
  return { sku: "", skuSource: undefined };
}

// Drafts saved before SKUs became seller-only carry generated SKUs
// ("K75-A-1d2e3f4a5b6c"). Those are cleared on restore; a seller's own,
// card or sticker SKU, and any SKU already used to publish, are kept.
export function clearGeneratedSku(g: ItemGroup): ItemGroup {
  if (
    g.skuSource ||
    g.publicationAttemptSku ||
    g.postStatus === "posted" ||
    !/-[a-f0-9]{12}$/.test(g.sku)
  )
    return g;
  return { ...g, sku: "" };
}
