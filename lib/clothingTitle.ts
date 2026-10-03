// Structured eBay titles for clothing, shoes and bags.
//
// The AI identifies attributes (with photo evidence); this module decides the
// order, which parts deserve scarce space, duplicates and the 80-character
// limit. It arranges WHOLE parts only: it never deletes or reorders words
// inside a brand, collaboration, product line, model or character name (word
// dedupe once corrupted "BOSS Hugo Boss" and "Duran Duran"). Condition words
// are never added. Returns null when there isn't enough reliable information,
// so the caller keeps the AI-written title instead.

import type { ListingResult } from "./types";
import { APPAREL_CATEGORIES, PANTS_CATEGORIES } from "./categories";
import { isPlaceholderValue } from "./ebay/aspects";
import { isLabelOnlyFact } from "./photo-facts";
import {
  CURATED_IDENTITIES,
  DESCRIPTIVE_STOP_WORDS,
  GENERIC_TITLE_WORDS,
  PREMIUM_FIBER_RE,
} from "./title-identities";

export const TITLE_LIMIT = 80;
// Estimated facts need this confidence to appear in a title (item specifics
// keep their own, lower threshold).
export const TITLE_ESTIMATE_CONFIDENCE = 75;
// Naming a character from the artwork alone is a stronger claim.
export const CHARACTER_ESTIMATE_CONFIDENCE = 85;

type Slot =
  | "brand"
  | "collab"
  | "line"
  | "model"
  | "character"
  | "dept"
  | "premium"
  | "garment"
  | "size"
  | "color"
  | "material"
  | "detail"
  | "idcode"
  | "extra";

export interface TitlePart {
  slot: Slot;
  text: string;
}

export interface ClothingTitle {
  title: string;
  parts: TitlePart[];
  dropped: string[];
  // Never-dropped parts alone exceeded the limit and the title was clipped.
  shortened: boolean;
}

const FOOTWEAR_BAGS = new Set([
  "womens_shoes",
  "mens_shoes",
  "handbag",
  "wallet",
]);
const TITLE_CATEGORIES = new Set([...APPAREL_CATEGORIES, "handbag", "wallet"]);

export function isClothingTitleItem(l: ListingResult): boolean {
  return TITLE_CATEGORIES.has(String(l.category || ""));
}

// ── Text helpers ─────────────────────────────────────────────────────────────

const PLACEHOLDER_BRAND_RE =
  /^(unknown|unbranded|no\s*brand|generic|n\/?a|none|brand\s*unknown)$/i;

// Whole-word tokens for comparisons: case, punctuation, possessives and simple
// plurals ignored; tee/t-shirt treated alike.
function token(word: string): string {
  let t = word
    .toLowerCase()
    .replace(/[’']s$/, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
  if (t === "tee" || t === "tees" || t === "tshirts") t = "tshirt";
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) t = t.slice(0, -1);
  return t;
}
function tokens(text: string): string[] {
  return text
    .split(/[\s\-/]+/)
    .map(token)
    .filter(Boolean);
}
const compact = (text: string) => tokens(text).join("");
const last = <T>(items: T[]): T | undefined => items[items.length - 1];
const GENERIC = new Set([...GENERIC_TITLE_WORDS].map(token));

// Keep letters, digits and the punctuation real names and sizes use.
function clean(text: unknown): string {
  return String(text ?? "")
    .replace(/[^\p{L}\p{N}\s'’&./"+%-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// AI-written descriptive text: drop filler, claim and condition words, then
// capitalize word starts without lowering the rest ("1/4 zip" → "1/4 Zip").
function descriptive(text: unknown): string {
  const kept = clean(text)
    .split(" ")
    .filter((w) => w && !DESCRIPTIVE_STOP_WORDS.has(w.toLowerCase()));
  return kept
    .join(" ")
    .replace(/(^|[\s\-/])(\p{Ll})/gu, (_, sep, c) => sep + c.toUpperCase());
}

// ── Evidence ─────────────────────────────────────────────────────────────────

interface Evidence {
  value: (name: string) => string;
  // Came from photo analysis (label or estimate), not copied from a field.
  hasEvidence: (name: string) => boolean;
  // Read from a label: has photo evidence and is not an estimate.
  verified: (name: string) => boolean;
  confidence: (name: string) => number;
  ok: (name: string, threshold?: number) => boolean;
}

function evidenceFor(l: ListingResult): Evidence {
  const lookup = <T>(map: Record<string, T> | undefined, name: string) => {
    if (!map) return undefined;
    const key = Object.keys(map).find(
      (k) => k.toLowerCase() === name.toLowerCase(),
    );
    return key === undefined ? undefined : map[key];
  };
  const value = (name: string) => {
    const raw = String(lookup(l.item_specifics, name) ?? "")
      .split(" | ")[0]
      .trim();
    return isPlaceholderValue(raw) ? "" : raw;
  };
  const verified = (name: string) =>
    Boolean(value(name)) &&
    Boolean(lookup(l.evidence, name)?.length) &&
    lookup(l.estimates, name) === undefined;
  const confidence = (name: string) => {
    if (!value(name)) return 0;
    if (verified(name)) return 100;
    return Number(lookup(l.estimates, name) ?? 0);
  };
  return {
    value,
    hasEvidence: (name) => Boolean(lookup(l.evidence, name)?.length),
    verified,
    confidence,
    ok: (name, threshold = TITLE_ESTIMATE_CONFIDENCE) =>
      confidence(name) >= threshold,
  };
}

// ── Identity rules (spec rule A–D) ───────────────────────────────────────────

const STOP = new Set(["the", "a", "an", "and", "for", "by", "with", "of"]);
const meaningful = (text: string) => tokens(text).filter((t) => !STOP.has(t));

// Codes such as DD8959-100, ML574EVG, CH857 or 438821. Short numbers like
// 501, 574 or 8111 are model names, not codes.
export function isCodeShaped(value: string): boolean {
  const v = value.trim();
  return (
    !/\s/.test(v) &&
    v.length >= 5 &&
    /^[A-Za-z0-9-]+$/.test(v) &&
    (v.match(/\d/g)?.length ?? 0) >= 2
  );
}

export function onCuratedList(value: string): boolean {
  const hay = ` ${tokens(value).join(" ")} `;
  return CURATED_IDENTITIES.some((entry) =>
    hay.includes(` ${tokens(entry).join(" ")} `),
  );
}

// The value's meaningful words all appear in ONE search term, and at least one
// of them is distinctive (not generic, not part of the brand).
export function distinctiveSearchMatch(
  value: string,
  searchTerms: string[] | undefined,
  brand: string,
): boolean {
  const words = meaningful(value);
  if (!words.length) return false;
  const brandWords = new Set(tokens(brand));
  const distinctive = words.some((w) => !GENERIC.has(w) && !brandWords.has(w));
  if (!distinctive) return false;
  return (searchTerms ?? []).some((term) => {
    const have = new Set(tokens(String(term)));
    return words.every((w) => have.has(w));
  });
}

const shapeOk = (value: string) =>
  value.length <= 30 && value.trim().split(/\s+/).length <= 4;

// ── Size ─────────────────────────────────────────────────────────────────────

const SIZE_TYPES: Record<string, string> = {
  petite: "Petite",
  petites: "Petite",
  plus: "Plus",
  "plus size": "Plus",
  tall: "Tall",
  "big & tall": "Big & Tall",
  "big and tall": "Big & Tall",
  maternity: "Maternity",
  juniors: "Juniors",
};
const STANDARD_WIDTHS = new Set([
  "m",
  "medium",
  "regular",
  "standard",
  "b",
  "d",
]);

function sizePart(l: ListingResult, ev: Evidence): string {
  const number = (v: string) => v.match(/\d+(?:\.\d+)?/)?.[0];
  if (ev.verified("Waist Size") && ev.verified("Inseam")) {
    const w = number(ev.value("Waist Size"));
    const i = number(ev.value("Inseam"));
    if (w && i) return `W${w} L${i}`;
  }
  const raw = clean(l.size);
  if (!raw || isPlaceholderValue(raw)) return "";
  if (/^(one size|os|osfa|o\/s|one size fits all)$/i.test(raw))
    return "One Size";
  const type = ev.verified("Size Type")
    ? SIZE_TYPES[ev.value("Size Type").toLowerCase()]
    : undefined;
  let size = `Sz ${raw.replace(/^(size|sz)\s*/i, "")}`;
  if (type && !new RegExp(`\\b${type}\\b`, "i").test(raw))
    size = `${type} ${size}`;
  const width = ev.verified("Shoe Width") ? ev.value("Shoe Width") : "";
  if (width && !STANDARD_WIDTHS.has(width.toLowerCase())) size += ` ${width}`;
  return size;
}

// ── Garment and details ──────────────────────────────────────────────────────

const CATEGORY_NOUNS: Record<string, string> = {
  womens_top: "Top",
  mens_top: "Shirt",
  womens_dress: "Dress",
  womens_skirt: "Skirt",
  womens_pants: "Pants",
  mens_pants: "Pants",
  womens_jeans: "Jeans",
  mens_jeans: "Jeans",
  womens_coat: "Coat",
  mens_coat: "Jacket",
  womens_sweater: "Sweater",
  mens_sweater: "Sweater",
  womens_shoes: "Shoes",
  mens_shoes: "Shoes",
  handbag: "Handbag",
  wallet: "Wallet",
  scarf: "Scarf",
  belt: "Belt",
  hat: "Hat",
};

function garmentPart(l: ListingResult, ev: Evidence): string {
  return (
    descriptive(l.item_type) ||
    (ev.ok("Type") ? descriptive(ev.value("Type")) : "") ||
    CATEGORY_NOUNS[String(l.category || "")] ||
    ""
  );
}

function detailNames(l: ListingResult, garment: string): string[] {
  const cat = String(l.category || "");
  if (cat.endsWith("_shoes"))
    return ["Toe Shape", "Heel Style", "Closure", "Style", "Features"];
  if (cat === "handbag" || cat === "wallet")
    return ["Style", "Closure", "Hardware Color", "Features"];
  if (
    PANTS_CATEGORIES.has(cat) ||
    /\b(jeans|pants|trousers|chinos|shorts|leggings|joggers)\b/i.test(garment)
  )
    return ["Rise", "Wash", "Fit", "Leg Style", "Inseam", "Features"];
  return [
    "Pattern",
    "Sleeve Length",
    "Neckline",
    "Closure",
    "Fit",
    "Style",
    "Dress Length",
    "Features",
  ];
}

function detailText(name: string, value: string, garment: string): string {
  const v = descriptive(value);
  if (!v) return "";
  if (/^fit$/i.test(name) && /^regular$/i.test(v)) return "";
  if (/^pattern$/i.test(name) && /^solid$/i.test(v)) return "";
  if (
    /^sleeve length$/i.test(name) &&
    /^short sleeve$/i.test(v) &&
    /\b(t-?shirt|tee|polo)\b/i.test(garment)
  )
    return "";
  if (/^hardware color$/i.test(name)) return `${v} Hardware`;
  if (/^inseam$/i.test(name)) {
    const n = v.match(/\d+(?:\.\d+)?/)?.[0];
    return n ? `${n}" Inseam` : "";
  }
  return v;
}

// ── Builder ──────────────────────────────────────────────────────────────────

export function buildClothingTitle(l: ListingResult): ClothingTitle | null {
  if (!isClothingTitleItem(l)) return null;
  const ev = evidenceFor(l);
  const cat = String(l.category || "");
  const terms = l.search_terms ?? [];

  const brandRaw = clean(ev.verified("Brand") ? ev.value("Brand") : l.brand);
  const brand = PLACEHOLDER_BRAND_RE.test(brandRaw) ? "" : brandRaw;

  const parts: TitlePart[] = [];
  const extras: string[] = [];
  const lateDetails: string[] = [];
  let idcode = "";

  if (brand) parts.push({ slot: "brand", text: brand });

  // Rule A: collaborations are identity when read from a label.
  if (ev.verified("Collaboration")) {
    const c = clean(ev.value("Collaboration"));
    if (c)
      parts.push({
        slot: "collab",
        text: /^(x|for)\s/i.test(c) ? c : `x ${c}`,
      });
  }

  // Rules C and D: product line, model and named style need label evidence.
  const identityNames: [string, Slot][] = [
    ["Product Line", "line"],
    ["Model", "model"],
    ["Style", "line"],
  ];
  const identityKept: { slot: Slot; text: string; strong: boolean }[] = [];
  for (const [name, slot] of identityNames) {
    if (!ev.verified(name)) continue;
    const value = clean(ev.value(name));
    if (!value) continue;
    if (isCodeShaped(value)) {
      if (FOOTWEAR_BAGS.has(cat)) idcode ||= value;
      else extras.push(value);
      continue;
    }
    const listed = onCuratedList(value);
    const searched = distinctiveSearchMatch(value, terms, brand);
    const footwearBag = FOOTWEAR_BAGS.has(cat);
    const isIdentity = listed || ((searched || footwearBag) && shapeOk(value));
    if (isIdentity)
      identityKept.push({ slot, text: value, strong: listed || searched });
    else if (name === "Style") lateDetails.push(value);
    else extras.push(value);
  }
  // Rule D: label-read style codes and part numbers.
  for (const name of ["Style Code", "MPN", "Manufacturer Part Number"]) {
    const value = clean(ev.value(name));
    if (!value || !ev.verified(name) || !isCodeShaped(value)) continue;
    if (FOOTWEAR_BAGS.has(cat)) idcode ||= value;
    else extras.push(value);
  }
  // One line slot; a second line-type value becomes the model slot.
  let lineUsed = false;
  for (const p of identityKept) {
    const slot: Slot = p.slot === "line" && !lineUsed ? "line" : "model";
    if (slot === "line") lineUsed = true;
    parts.push({ slot, text: p.text });
  }

  // Rule B: character/theme is identity on graphic items or when searched.
  const garment = garmentPart(l, ev);
  const graphic =
    /\b(graphic|print|character)\b/i.test(ev.value("Pattern")) ||
    /\b(graphic|print)\b/i.test(garment);
  for (const name of ["Character", "Character Family", "Theme", "Franchise"]) {
    const threshold = /theme/i.test(name)
      ? TITLE_ESTIMATE_CONFIDENCE
      : CHARACTER_ESTIMATE_CONFIDENCE;
    if (!ev.ok(name, threshold)) continue;
    const value = clean(ev.value(name));
    if (!value) continue;
    if (graphic || distinctiveSearchMatch(value, terms, brand))
      parts.push({ slot: "character", text: value });
    else lateDetails.push(value);
  }

  // Department.
  let dept = "";
  if (cat.startsWith("mens_")) dept = "Mens";
  else if (cat.startsWith("womens_")) dept = "Womens";
  else if (ev.ok("Department")) {
    const d = ev.value("Department");
    if (/^(men|mens|men's)$/i.test(d)) dept = "Mens";
    else if (/^(women|womens|women's)$/i.test(d)) dept = "Womens";
    else if (/unisex/i.test(d) && !/kids/i.test(d)) dept = "Unisex";
  }
  if (dept) parts.push({ slot: "dept", text: dept });

  // Material: premium fibers only from a label, placed before the garment.
  // A Material specific must meet the title threshold; without one, the
  // analysis material field is used as today, but never for a premium fiber.
  const noPercent = (v: unknown) =>
    clean(v)
      .replace(/\b\d+\s*%\s*/g, "")
      .split(/\s*[|,/]\s*/)[0];
  // Preparation copies the analysis material into specifics without evidence;
  // treat that copy like the analysis field it came from.
  const materialSpec = ev.hasEvidence("Material")
    ? noPercent(ev.value("Material"))
    : "";
  if (materialSpec) {
    if (ev.verified("Material") && PREMIUM_FIBER_RE.test(materialSpec))
      parts.push({ slot: "premium", text: descriptive(materialSpec) });
    else if (ev.ok("Material") && !PREMIUM_FIBER_RE.test(materialSpec))
      parts.push({ slot: "material", text: descriptive(materialSpec) });
  } else {
    const m = noPercent(l.material);
    if (m && !isPlaceholderValue(m) && !PREMIUM_FIBER_RE.test(m))
      parts.push({ slot: "material", text: descriptive(m) });
  }

  // Garment, skipped when a protected name already ends with its noun; its
  // remaining words become a detail.
  if (garment) {
    const head = last(tokens(garment));
    const named = parts.find(
      (p) =>
        ["line", "model", "character", "collab"].includes(p.slot) &&
        last(tokens(p.text)) === head,
    );
    if (named) {
      const rest = garment.split(" ").slice(0, -1).join(" ");
      if (rest) lateDetails.push(rest);
    } else parts.push({ slot: "garment", text: garment });
  }

  const size = sizePart(l, ev);
  if (size) parts.push({ slot: "size", text: size });

  const colorRaw = Array.isArray(l.color) ? l.color[0] : l.color;
  const color = descriptive(colorRaw || ev.value("Color"));
  if (color && !isPlaceholderValue(color))
    parts.push({ slot: "color", text: color });

  // Details: ranked by garment family, each from a label or ≥75% estimate.
  const detailCandidates: string[] = [];
  for (const name of detailNames(l, garment)) {
    if (!ev.ok(name)) continue;
    // Measurements such as rise and inseam only ever come from a label.
    if (isLabelOnlyFact(name) && !ev.verified(name)) continue;
    if (/^inseam$/i.test(name) && size.startsWith("W")) continue;
    const text = detailText(name, ev.value(name), garment);
    if (text) detailCandidates.push(text);
  }
  detailCandidates.push(...lateDetails.map(descriptive).filter(Boolean));
  for (const text of detailCandidates) parts.push({ slot: "detail", text });

  if (idcode) parts.push({ slot: "idcode", text: idcode });
  for (const text of extras) parts.push({ slot: "extra", text });

  // Not enough reliable information for a structured title: no garment noun,
  // or nothing that identifies the item beyond its category (a department and
  // noun derived from the category alone, e.g. "Womens Top", are not enough).
  const garmentFromItem = Boolean(
    descriptive(l.item_type) || (ev.ok("Type") && ev.value("Type")),
  );
  const anchors = parts.some(
    (p) =>
      ["brand", "collab", "line", "model", "character", "size"].includes(
        p.slot,
      ) ||
      (p.slot === "dept" && garmentFromItem),
  );
  if (!garment || !anchors) return null;

  return assemble(parts, identityKept);
}

const ORDER: Slot[] = [
  "brand",
  "collab",
  "line",
  "model",
  "character",
  "dept",
  "premium",
  "garment",
  "size",
  "color",
  "material",
  "detail",
  "idcode",
  "extra",
];
const MAX_DETAILS = 3;

function assemble(
  candidates: TitlePart[],
  identities: { text: string; strong: boolean }[],
): ClothingTitle {
  const ordered = [...candidates].sort(
    (a, b) => ORDER.indexOf(a.slot) - ORDER.indexOf(b.slot),
  );
  // Whole-part duplicate removal: a part is skipped when all its words already
  // appear, or (for multi-word parts) its run-together form already appears.
  // Words inside a part are never removed.
  const kept: TitlePart[] = [];
  const seen = new Set<string>();
  let details = 0;
  for (const p of ordered) {
    const text = p.text.trim();
    if (!text) continue;
    const words = tokens(text);
    const joined = kept.map((k) => compact(k.text)).join("");
    const duplicate =
      kept.length > 0 &&
      words.length > 0 &&
      (words.every((w) => seen.has(w)) ||
        (words.length > 1 && joined.includes(compact(text))));
    if (duplicate) continue;
    if (p.slot === "detail" && ++details > MAX_DETAILS) continue;
    kept.push({ slot: p.slot, text });
    words.forEach((w) => seen.add(w));
  }

  let parts = kept;
  const dropped: string[] = [];
  const text = () => parts.map((p) => p.text).join(" ");
  const drop = (pred: (p: TitlePart, i: number) => boolean, note: string) => {
    if (text().length <= TITLE_LIMIT) return;
    const idx = parts.findIndex(pred);
    if (idx < 0) return;
    dropped.push(`${note}: ${parts[idx].text}`);
    parts = parts.filter((_, i) => i !== idx);
  };
  // Drops the last detail when exactly n details remain.
  const dropDetail = (n: number) => {
    const idx = parts
      .map((p, i) => (p.slot === "detail" ? i : -1))
      .filter((i) => i >= 0);
    if (idx.length === n) drop((_, i) => i === idx[n - 1], `detail ${n}`);
  };

  // Drop order: lowest buyer value first.
  while (text().length > TITLE_LIMIT && parts.some((p) => p.slot === "extra"))
    drop((p) => p.slot === "extra", "extra");
  dropDetail(3);
  dropDetail(2);
  drop((p) => p.slot === "material", "material");
  dropDetail(1);
  drop((p) => p.slot === "idcode", "style code");
  drop((p) => p.slot === "color", "color");
  if (text().length > TITLE_LIMIT) {
    const s = parts.find((p) => p.slot === "size" && /\bSz /.test(p.text));
    if (s) {
      dropped.push(`"Sz"`);
      parts = parts.map((p) =>
        p === s ? { ...p, text: p.text.replace(/\bSz /, "") } : p,
      );
    }
  }
  if (text().length > TITLE_LIMIT) {
    const g = parts.find((p) => p.slot === "garment" && p.text.includes(" "));
    if (g) {
      const head = last(g.text.split(" "))!;
      dropped.push(`garment shortened: ${g.text} → ${head}`);
      parts = parts.map((p) => (p === g ? { ...p, text: head } : p));
    }
  }
  drop((p) => p.slot === "premium", "premium fiber");
  if (text().length > TITLE_LIMIT) {
    // Keep whichever of line/model is the stronger identity.
    const line = parts.find((p) => p.slot === "line");
    const model = parts.find((p) => p.slot === "model");
    if (line && model) {
      const strong = (t: string) =>
        identities.find((i) => i.text === t)?.strong ?? false;
      const victim = strong(model.text) && !strong(line.text) ? line : model;
      dropped.push(`${victim.slot}: ${victim.text}`);
      parts = parts.filter((p) => p !== victim);
    }
  }

  let title = text();
  let shortened = false;
  if (title.length > TITLE_LIMIT) {
    const cut = title.slice(0, TITLE_LIMIT);
    const space = cut.lastIndexOf(" ");
    title = (space > TITLE_LIMIT * 0.6 ? cut.slice(0, space) : cut).trim();
    shortened = true;
  }
  return { title, parts, dropped, shortened };
}

// Title for a freshly analyzed listing: the structured clothing title when
// there is enough reliable information, otherwise the AI-written title with
// the original append-only cleanup.
export function initialTitle(
  l: ListingResult,
  legacy: (l: ListingResult) => string,
): Pick<ListingResult, "title" | "title_source"> {
  const built = buildClothingTitle(l);
  return built
    ? { title: built.title, title_source: "auto" }
    : { title: legacy(l), title_source: "ai" };
}

// After preparation adds specifics, rebuild a title the builder made. Never
// touches a seller-edited or AI-written title, and skips the rebuild when the
// photo evidence was cleared by specific edits (it would only lose detail).
export function refreshAutoTitle(l: ListingResult): void {
  if (l.title_source !== "auto") return;
  if (!l.evidence || Object.keys(l.evidence).length === 0) return;
  const built = buildClothingTitle(l);
  if (built) l.title = built.title;
}
