// One place for seller edits to a listing, so every edit path keeps the same
// guarantees: the edited specific becomes seller-reviewed (only its own AI
// provenance is dropped), mirrored main fields stay in sync with the
// specific, and a builder-made title follows the reviewed values.

import type { ListingResult } from "./types";
import { lookup, markSellerReviewed } from "./provenance";
import { buildClothingTitle } from "./clothingTitle";

// Specifics that mirror a main listing field.
const MIRRORED = [
  ["Brand", "brand"],
  ["Size", "size"],
  ["Material", "material"],
  ["Type", "item_type"],
  ["Color", "color"],
  ["Features", "key_features"],
] as const;
type MirroredField = (typeof MIRRORED)[number][1];
const LIST_FIELDS = new Set<MirroredField>(["color", "key_features"]);

const asText = (v: unknown) =>
  Array.isArray(v) ? v.join(" | ") : String(v ?? "");
const asList = (v: string) =>
  v
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);

export function applyListingEdit(
  current: ListingResult,
  patch: Partial<ListingResult>,
): ListingResult {
  const next: ListingResult = { ...current, ...patch };
  const before = current.item_specifics ?? {};
  const specifics = { ...(patch.item_specifics ?? before) };
  const changed = new Set<string>();

  if (patch.item_specifics)
    for (const name of new Set([
      ...Object.keys(before),
      ...Object.keys(patch.item_specifics),
    ]))
      if ((before[name] ?? "") !== (patch.item_specifics[name] ?? ""))
        changed.add(name);

  // A main-field edit (e.g. the size box) is a seller edit of its specific.
  for (const [name, field] of MIRRORED) {
    if (!(field in patch) || patch.item_specifics) continue;
    const value = asText(patch[field]);
    if (value === asText(current[field])) continue;
    const key =
      Object.keys(specifics).find(
        (k) => k.toLowerCase() === name.toLowerCase(),
      ) ?? name;
    specifics[key] = value;
    changed.add(key);
  }
  next.item_specifics = specifics;

  for (const name of changed) {
    markSellerReviewed(next, name);
    // Keep the mirrored main field identical to the reviewed specific so
    // titles and later rebuilds read the seller's value.
    const mirror = MIRRORED.find(
      ([n]) => n.toLowerCase() === name.toLowerCase(),
    );
    if (mirror) {
      const value = lookup(specifics, name) ?? "";
      (next as unknown as Record<string, unknown>)[mirror[1]] = LIST_FIELDS.has(
        mirror[1],
      )
        ? asList(value)
        : value;
    }
  }

  if (
    patch.ebay_condition !== undefined &&
    patch.ebay_condition !== current.ebay_condition
  ) {
    next.defaulted = (next.defaulted ?? []).filter(
      (n) => n.toLowerCase() !== "condition",
    );
    // The seller chose; the card-rule explanation no longer applies. A seller
    // flaw stays in the description and notes.
    next.condition_review = undefined;
  }

  // A builder-made title follows reviewed values; a seller title never moves.
  if (
    changed.size &&
    patch.title === undefined &&
    next.title_source === "auto"
  ) {
    const built = buildClothingTitle(next);
    if (built) next.title = built.title;
  }
  return next;
}

// The seller confirms the value shown for a specific (e.g. the seller-card
// value in a conflict). It becomes the seller's own value and the conflict
// is resolved; nothing else changes.
export function confirmSpecific(
  current: ListingResult,
  name: string,
): ListingResult {
  const next: ListingResult = { ...current };
  markSellerReviewed(next, name);
  return next;
}
