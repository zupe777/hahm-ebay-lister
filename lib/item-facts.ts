// Turns the analysis model's raw JSON into a listing whose every specific has
// a stated source. Precedence (highest first): seller edit, seller card,
// readable label/printed branding, exact-item research, strong visible photo
// evidence, AI estimate. A lower source never silently replaces a higher one;
// a seller card that disagrees with a label keeps the card value and records
// the disagreement for the seller.

import type { ListingResult, SellerCard } from "./types";
import { parseListing } from "./validation";
import { cleanGeneratedDescription } from "./description";
import {
  acceptedPhotoFact,
  isClothingWorkflow,
  isEstimate,
  isPromotionalClaim,
  type PhotoFact,
} from "./photo-facts";
import { cardFlaw, cardSpecifics, readSellerCard } from "./seller-card";
import { readInventorySticker } from "./inventory-sticker";

// Specific names for an inventory number; never item specifics.
const INVENTORY_NAME =
  /^(inventory( (number|no|#|label|sticker|tag))?|sku|custom label|stock (number|no|#)|bin( (number|code))?)$/i;
import {
  addConflict,
  findKey,
  hasName,
  lookup,
  SOURCE_LABEL,
  type FactSource,
  factSource,
} from "./provenance";

const norm = (v: string) =>
  v
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const SIZE_WORDS: Record<string, string> = {
  xxs: "xxs",
  "extra extra small": "xxs",
  xs: "xs",
  "extra small": "xs",
  "x small": "xs",
  s: "s",
  small: "s",
  sm: "s",
  m: "m",
  medium: "m",
  med: "m",
  l: "l",
  large: "l",
  lg: "l",
  xl: "xl",
  "extra large": "xl",
  "x large": "xl",
  xxl: "xxl",
  "2xl": "xxl",
  "xx large": "xxl",
  "extra extra large": "xxl",
  xxxl: "xxxl",
  "3xl": "xxxl",
};
const sizeKey = (v: string) => SIZE_WORDS[norm(v)] ?? norm(v);
const fiberSet = (v: string) =>
  new Set(
    norm(v.replace(/\d+\s*%/g, " "))
      .split(" ")
      .filter((w) => w && !/^\d+$/.test(w)),
  );
const listSet = (v: string) =>
  new Set(
    v
      .split(/\s*[|,/]\s*/)
      .map(norm)
      .filter(Boolean),
  );
const sameSet = (a: Set<string>, b: Set<string>) =>
  a.size === b.size && [...a].every((x) => b.has(x));

// Formatting-only differences ("L" vs "Large", "Cotton" vs "100% Cotton",
// "NIKE" vs "Nike") are not conflicts.
export function sameFact(name: string, a: string, b: string): boolean {
  const n = name.toLowerCase();
  if (n === "size") return sizeKey(a) === sizeKey(b);
  if (n.includes("material") || n === "fabric")
    return sameSet(fiberSet(a), fiberSet(b));
  if (n === "color" || n === "features") return sameSet(listSet(a), listSet(b));
  return norm(a) === norm(b);
}

// Specifics that name the item itself; a conflict here holds publishing until
// the seller edits or confirms the value.
export const IDENTITY_FACTS = ["Brand", "Model", "MPN", "Product Line"];
export const isIdentityConflict = (name: string) =>
  IDENTITY_FACTS.some((n) => n.toLowerCase() === name.toLowerCase());

// Card text quoted back as a "label" fact would launder seller information
// into manufacturer evidence. Such facts are dropped; the card supplies them.
function quotesCard(fact: unknown, cardLines: string[]): boolean {
  const f = fact as Partial<PhotoFact>;
  if (f?.basis !== "label" || typeof f.quote !== "string") return false;
  const quote = norm(f.quote);
  if (!quote) return false;
  // The whole card line, or its value after the field name.
  return cardLines.some(
    (line) =>
      norm(line) === quote || norm(line.replace(/^[^:=]*[:=]/, "")) === quote,
  );
}

const MIRROR: Record<string, "brand" | "size" | "material"> = {
  brand: "brand",
  size: "size",
  material: "material",
};
const splitList = (v: string) =>
  v
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);

export function buildAnalyzedListing(
  raw: Record<string, unknown>,
  photoCount: number,
  profile?: string,
): ListingResult {
  const clothing = isClothingWorkflow({
    category: raw.category,
    item_profile: profile,
  });
  const {
    seller_card: rawCard,
    attached_tags: rawTags,
    inventory_sticker: rawSticker,
    ...rest
  } = raw;
  const card = readSellerCard(rawCard, photoCount);
  const cardLines =
    card && Array.isArray((rawCard as { lines?: unknown })?.lines)
      ? ((rawCard as { lines: unknown[] }).lines.map(String) as string[])
      : [];
  const specifics = Array.isArray(raw.specifics) ? raw.specifics : [];
  const supported = specifics
    .filter((s) => !quotesCard(s, cardLines))
    .filter((s): s is PhotoFact =>
      acceptedPhotoFact(s, photoCount, { clothing }),
    )
    // Seller information is never an item specific.
    .filter((s) => !/^(notes?|flaws?|seller notes?|new)$/i.test(s.name.trim()))
    // The inventory sticker feeds the SKU only.
    .filter((s) => !INVENTORY_NAME.test(s.name.trim()));

  const listing = parseListing({
    ...rest,
    item_specifics: Object.fromEntries(supported.map((s) => [s.name, s.value])),
  });
  listing.description = cleanGeneratedDescription(listing.description);
  listing.evidence = Object.fromEntries(
    supported.map((s) => [s.name, s.photoIndices]),
  );
  listing.estimates = Object.fromEntries(
    supported.filter(isEstimate).map((s) => [s.name, s.confidence ?? 0]),
  );
  const visible = supported
    .filter((s) => s.basis === "visible_feature")
    .map((s) => s.name);
  if (visible.length) listing.visible = visible;

  const tags = rawTags as { visible?: unknown; photoIndices?: unknown };
  const tagPhotos = Array.isArray(tags?.photoIndices)
    ? tags.photoIndices.filter(
        (i): i is number => Number.isInteger(i) && i > 0 && i <= photoCount,
      )
    : [];
  listing.attached_tags = {
    visible: tags?.visible === true && tagPhotos.length > 0,
    photoIndices: tags?.visible === true ? tagPhotos : [],
  };

  // Inventory sticker → SKU (Custom Label). Printed product text and the
  // seller card are never the sticker, so its value must not match them.
  // The card's own Custom Label (SKU) line is the seller's SKU, not
  // unrelated card text, so a sticker may agree with it.
  const cardText = (
    Array.isArray((rawCard as { lines?: unknown })?.lines)
      ? (rawCard as { lines: unknown[] }).lines.map(String)
      : []
  ).filter((line) => !/^\s*custom\s*label/i.test(line));
  const productText = specifics
    .filter((f: any) => !INVENTORY_NAME.test(String(f?.name ?? "").trim()))
    .flatMap((f: any) => [String(f?.value ?? ""), String(f?.quote ?? "")]);
  const sticker = readInventorySticker(rawSticker, photoCount, [
    ...cardText,
    ...productText,
  ]);
  if (sticker) listing.inventory_label = sticker;

  resolveCheckedField(listing, "Brand", "brand");
  resolveCheckedField(listing, "Material", "material");
  if (card) applySellerCard(listing, card);
  ensureSellerDisclosures(listing);
  return listing;
}

// Brand and Material leave analysis only with a stated source: a label fact,
// or a marked estimate that passed its threshold (90% for Brand). A bare
// top-level value from the model is unchecked and is cleared.
function resolveCheckedField(
  l: ListingResult,
  name: string,
  field: "brand" | "material",
): void {
  const key = findKey(l.item_specifics, name);
  l[field] = key ? String(l.item_specifics![key]) : "";
}

// Card values become specifics with card provenance; the mirrored main fields
// follow so titles and rebuilds read the seller's value.
export function applySellerCard(l: ListingResult, card: SellerCard): void {
  l.seller_card = card;
  for (const [name, value] of Object.entries(cardSpecifics(card))) {
    const key = findKey(l.item_specifics, name) ?? name;
    const existing = String(l.item_specifics?.[key] ?? "").trim();
    const src: FactSource = existing ? factSource(l, key) : "unchecked";
    const strongBrand =
      name === "Brand" && (src === "estimate" || src === "visible");
    if (
      existing &&
      (src === "label" || src === "researched" || strongBrand) &&
      !sameFact(name, value, existing)
    )
      addConflict(l, {
        name,
        kept: value,
        keptSource: SOURCE_LABEL.card,
        other: existing,
        otherSource: SOURCE_LABEL[src],
      });
    const specifics = { ...l.item_specifics };
    delete specifics[key];
    specifics[name] = value;
    l.item_specifics = specifics;
    for (const map of ["evidence", "estimates", "researched"] as const) {
      const k = findKey(l[map], name);
      if (k !== undefined) {
        const next = { ...l[map] } as Record<string, unknown>;
        delete next[k];
        (l as unknown as Record<string, unknown>)[map] = next;
      }
    }
    if (l.visible)
      l.visible = l.visible.filter(
        (n) => n.toLowerCase() !== name.toLowerCase(),
      );
    if (!hasName(l.card_specifics, name))
      l.card_specifics = [...(l.card_specifics ?? []), name];
    const mirror = MIRROR[name.toLowerCase()];
    if (mirror) l[mirror] = value;
    if (name === "Color") l.color = splitList(value);
    if (name === "Features") l.key_features = splitList(value).slice(0, 10);
  }
}

const endsSentence = (s: string) => /[.!?)"']$/.test(s.trim());

// Generic AI condition wording that would soften or contradict a flaw the
// seller disclosed. Only these phrases are removed; other condition wording
// and every other sentence stay as written.
const MINIMIZING: RegExp[] = [
  // "with minor signs of wear", "shows light wear", "normal signs of use" —
  // generic only: "light wear on cuffs" names a place and stays.
  /\s*,?\s*\b(?:with|showing|shows|has|having)?\s*(?:only\s+|some\s+|very\s+)?(?:minor|light|minimal|slight|gentle|normal|general|mild)\s+(?:signs?\s+of\s+)?(?:wear(?:\s+and\s+tear)?|use)\b(?!\s+(?:on|at|near|to|around|along|in|by)\b)/gi,
  // "gently used", "lightly worn"
  /\s*\b(?:gently|lightly)\s+(?:used|worn)\b/gi,
  // "no flaws", "no visible damage or stains"
  /\s*\b(?:has\s+|with\s+|shows\s+)?no\s+(?:visible\s+|notable\s+|major\s+|significant\s+|obvious\s+)?(?:flaws?|damage|holes?|tears?|stains?|defects?|issues?|signs\s+of\s+wear)(?:\s*(?:,|or|and)\s*(?:flaws?|damage|holes?|tears?|stains?|defects?|issues?))*\b/gi,
  // "in excellent condition", "like new", "flawless"
  /\s*\b(?:in\s+)?(?:overall\s+)?(?:excellent|great|perfect|mint|like[- ]new)\s+(?:pre-?owned\s+|used\s+)?condition\b/gi,
  /\s*\b(?:flawless|like[- ]new)\b/gi,
];
// What may be left of a sentence once its condition claim is gone.
const LEFTOVER = new Set(
  "has have had is are was it this item shows show showing with and overall in the a an very only some but".split(
    " ",
  ),
);
const sentenceNorm = (v: string) => norm(v.replace(/^flaw\s*:/i, ""));

// The seller's FLAW wording controls the disclosure. "Flaw: <exact words>."
// appears in the description and condition notes; generic AI wording that
// softens or contradicts it ("minor signs of wear", "no flaws", "like new")
// is removed; a sentence that only restates the flaw becomes the disclosure.
export function discloseFlaw(
  text: string,
  flaw: string,
  first = false,
): string {
  const disclosure = `Flaw: ${flaw}${endsSentence(flaw) ? "" : "."}`;
  const sentences = text
    .trim()
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean);
  let disclosed = false;
  const out: string[] = [];
  for (const sentence of sentences) {
    if (sentence.includes(flaw)) {
      if (sentence.includes(`Flaw: ${flaw}`)) disclosed = true;
      else if (sentenceNorm(sentence) === sentenceNorm(flaw)) {
        out.push(disclosure);
        disclosed = true;
        continue;
      }
      out.push(sentence); // never edit text that carries the seller's words
      continue;
    }
    let cleaned = sentence;
    for (const re of MINIMIZING) cleaned = cleaned.replace(re, "");
    cleaned = cleaned
      .replace(/\s+([.,!?;:])/g, "$1")
      .replace(/,\s*([.!?])/g, "$1")
      .replace(/^[\s,;:]+/, "")
      .replace(/\s{2,}/g, " ")
      .trim();
    if (cleaned === sentence) {
      out.push(sentence);
      continue;
    }
    const words = norm(cleaned).split(" ").filter(Boolean);
    if (!words.length || words.every((w) => LEFTOVER.has(w))) continue;
    out.push(cleaned.charAt(0).toUpperCase() + cleaned.slice(1));
  }
  if (!disclosed)
    out.splice(first ? 0 : Math.min(1, out.length), 0, disclosure);
  return out.join(" ");
}

export function ensureSellerDisclosures(l: ListingResult): void {
  const flaw = cardFlaw(l.seller_card);
  if (!flaw) return;
  l.description = discloseFlaw(l.description, flaw);
  l.condition_notes = discloseFlaw(l.condition_notes ?? "", flaw, true);
}

// Custom specifics (names eBay does not list for the category) need real
// support: the seller, the seller card, a readable label, exact research, or
// a concrete visible feature at 75% or more. AI guesses and marketing words
// are removed (preparation reports each removal).
export const CUSTOM_ESTIMATE_CONFIDENCE = 75;
export function gateCustomSpecifics(
  aspects: Record<string, string[]>,
  meta: { name: string }[],
  l: ListingResult,
): void {
  const known = new Set(meta.map((a) => a.name.toLowerCase()));
  for (const k of Object.keys(aspects)) {
    if (known.has(k.toLowerCase())) continue;
    const src = factSource(l, k);
    if (["seller", "card", "label", "researched", "default"].includes(src))
      continue;
    const confidence = Number(lookup(l.estimates, k) ?? 0);
    if (
      src === "visible" &&
      confidence >= CUSTOM_ESTIMATE_CONFIDENCE &&
      !aspects[k].some((v) => isPromotionalClaim(v, k))
    )
      continue;
    delete aspects[k];
  }
}
