// Seller information cards: a card the seller places in the photos with
// FIELD: VALUE lines ("BRAND: Patagonia", "FLAW: 1-inch tear under right arm").
// The analysis model only transcribes the card's lines; this module parses
// them deterministically. Card values are seller-supplied facts. They are
// never manufacturer-label evidence and never proof of authenticity.

import type { SellerCard } from "./types";

// Field → item specific it fills. null: seller information that is not an
// eBay specific (condition, flaws and notes are handled separately).
export const CARD_FIELDS: Record<string, string | null> = {
  BRAND: "Brand",
  NEW: null,
  FLAW: null,
  CONDITION: null,
  MATERIAL: "Material",
  SIZE: "Size",
  COLOR: "Color",
  FEATURES: "Features",
  STYLE: "Style",
  "PRODUCT LINE": "Product Line",
  MODEL: "Model",
  MPN: "MPN",
  NOTES: null,
  // "Custom Label (SKU):" — the seller's inventory number for the eBay SKU.
  // Never an item specific.
  "CUSTOM LABEL": null,
};
// Other spellings of a field name, after squashing.
const ALIASES: Record<string, string> = {
  CUSTOMLABELSKU: "CUSTOM LABEL",
};
// Specifics that hold several values; card values split on , / | ;
const LIST_FIELDS = new Set(["COLOR", "FEATURES"]);

// "Product line", "PRODUCT_LINE" and "productline" all name PRODUCT LINE.
const squash = (s: string) => s.toUpperCase().replace(/[^A-Z]/g, "");
const BY_SQUASHED = new Map(
  Object.keys(CARD_FIELDS).map((f) => [squash(f), f]),
);

export function cardFieldName(raw: string): string | undefined {
  const key = squash(raw);
  return BY_SQUASHED.get(key) ?? ALIASES[key];
}

// A blank-ish value: the seller wrote the field but no fact.
const EMPTY = /^(?:none|no|n\/?a|-+|—|nothing|nil)\.?$/i;

export interface ParsedCard {
  fields: Record<string, string>;
  // FIELD: VALUE lines with a field name this app does not use. Preserved for
  // review, never turned into specifics.
  other: Record<string, string>;
}

// Parse transcribed card lines. Returns null unless at least one supported
// field is present, so ordinary label text ("RN 54023", "Made in USA",
// "Care: machine wash") is never mistaken for a card.
export function parseCardLines(lines: string[]): ParsedCard | null {
  const fields: Record<string, string> = {};
  const other: Record<string, string> = {};
  let last: { map: Record<string, string>; key: string } | undefined;
  for (const raw of lines) {
    const line = String(raw ?? "").trim();
    if (!line) continue;
    const m = /^([A-Za-z][A-Za-z _\-/()]{0,29}?)\s*[:=]\s*(.*)$/.exec(line);
    if (!m) {
      // A wrapped continuation of the previous value keeps the exact wording.
      // A blank field ("Custom Label (SKU):") never absorbs a later line.
      if (last && last.map[last.key])
        last.map[last.key] = `${last.map[last.key]} ${line}`.trim();
      continue;
    }
    const field = cardFieldName(m[1]);
    const value = m[2].trim();
    const map = field ? fields : other;
    const key = field ?? m[1].trim().toUpperCase();
    map[key] = map[key] ? `${map[key]} ${value}`.trim() : value;
    last = { map, key };
  }
  for (const map of [fields, other])
    for (const [k, v] of Object.entries(map)) if (!v.trim()) delete map[k];
  return Object.keys(fields).length ? { fields, other } : null;
}

// Card as reported by the analysis model: { present, photoIndices, lines }.
export function readSellerCard(
  raw: unknown,
  photoCount: number,
): SellerCard | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as {
    present?: unknown;
    photoIndices?: unknown;
    lines?: unknown;
  };
  if (r.present !== true || !Array.isArray(r.lines)) return undefined;
  const parsed = parseCardLines(r.lines.map(String).slice(0, 40));
  if (!parsed) return undefined;
  const photoIndices = Array.isArray(r.photoIndices)
    ? r.photoIndices.filter(
        (i): i is number => Number.isInteger(i) && i > 0 && i <= photoCount,
      )
    : [];
  return {
    photoIndices,
    fields: clip(parsed.fields),
    ...(Object.keys(parsed.other).length ? { other: clip(parsed.other) } : {}),
  };
}

const clip = (m: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(m)
      .slice(0, 30)
      .map(([k, v]) => [k.slice(0, 40), v.slice(0, 500)]),
  );

// NEW: only an explicit, unambiguous yes makes an item seller-declared New.
export function cardNew(
  card: SellerCard | undefined,
): "yes" | "no" | "unclear" | undefined {
  const v = card?.fields.NEW?.trim();
  if (!v) return undefined;
  if (/^(?:yes|y|true)\.?$/i.test(v)) return "yes";
  if (/^(?:no|n|false)\.?$/i.test(v)) return "no";
  return "unclear";
}

// The seller's flaw wording, exactly as written; "" for none.
export function cardFlaw(card: SellerCard | undefined): string {
  const v = card?.fields.FLAW?.trim() ?? "";
  return EMPTY.test(v) ? "" : v;
}

export function cardNotes(card: SellerCard | undefined): string {
  const v = card?.fields.NOTES?.trim() ?? "";
  return EMPTY.test(v) ? "" : v;
}

// Specifics the card supplies, keyed by eBay aspect name.
export function cardSpecifics(
  card: SellerCard | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [field, value] of Object.entries(card?.fields ?? {})) {
    const name = CARD_FIELDS[field];
    if (!name || EMPTY.test(value.trim())) continue;
    out[name] = LIST_FIELDS.has(field)
      ? value
          .split(/\s*[,/|;]\s*/)
          .map((v) => v.trim())
          .filter(Boolean)
          .join(" | ")
      : value.trim();
  }
  return out;
}
