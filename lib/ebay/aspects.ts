// Small helpers for eBay item-specifics (aspects), shared between the publish
// pipeline and the model-assisted aspect filler.

import type { AspectMeta } from "./taxonomy";

// eBay rejects any item-specific (aspect) value longer than this (error 25002).
export const MAX_ASPECT_VALUE_LEN = 65;

// Buyer-facing phrases the analysis model sometimes writes for unknown fields.
// These are not attribute values — "Material = See tag in photos" would become
// a searchable eBay filter value. They belong in the description, never in an
// aspect, so every aspect value passes through this check.
// Deliberately narrow: "see"/"check" only count with a photo/tag-ish object so
// real values like the brand "See by Chloé" or pattern "Check Print" survive.
const PLACEHOLDER_VALUE_RE =
  /^((see|check|refer\sto)\s+.*\b(photo|pic|image|tag|label|listing|description|measurement|above|below)|unknown\b|unclear\b|n\/?a\b|none\b|not\s(visible|shown|applicable|available|sure)|no\s(size|tag|label|brand\svisible)|unable\s|can'?t\s|tbd\b|maybe\b|possibly\b|[-?.]+$)/i;

export function isPlaceholderValue(s: string): boolean {
  const t = (s || "").trim();
  return !t || PLACEHOLDER_VALUE_RE.test(t);
}

// Clip an aspect value to eBay's limit, breaking at a word boundary when the
// truncation point lands far enough in to leave a readable phrase.
export function clipAspectValue(s: string, maxLen = MAX_ASPECT_VALUE_LEN): string {
  const t = (s || "").trim();
  if (t.length <= maxLen) return t;
  const cut = t.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > maxLen * 0.6 ? cut.slice(0, lastSpace) : cut).trim();
}

// Clean a single aspect value: placeholder phrases become "", real values get
// clipped to eBay's length limit.
export function cleanAspectValue(s: string, maxLen = MAX_ASPECT_VALUE_LEN): string {
  return isPlaceholderValue(s) ? "" : clipAspectValue(s, maxLen);
}

// Split a model-provided value into its parts ("Cotton / Polyester" →
// ["Cotton", "Polyester"]), cleaning each. Multi-value aspects keep every
// part; single-value aspects take the first (see enforceCardinality).
//
// A split only happens when EVERY resulting part is a real word (3+ chars):
// "Black & White" and "Cotton/Polyester" split, while names and sizes whose
// pieces are fragments — "AC/DC", "H&M", "Texas A&M", "9 1/2", "S/M" — stay
// whole instead of being shredded.
const VALUE_SEPARATOR_RE = /\s*(?:\/|,|\||&|\band\b)\s*/i;
const MIN_SPLIT_PART_LEN = 3;

export function splitAspectValues(v: unknown, maxLen = MAX_ASPECT_VALUE_LEN): string[] {
  const flat: string[] = [];
  const push = (raw: unknown) => {
    const s = String(raw ?? "").trim();
    if (!s) return;
    let parts = s.split(VALUE_SEPARATOR_RE).map((p) => p.trim());
    if (parts.length < 2 || parts.some((p) => p.length < MIN_SPLIT_PART_LEN)) {
      parts = [s];
    }
    for (const part of parts) {
      const cleaned = cleanAspectValue(part.replace(/\s+/g, " "), maxLen);
      if (cleaned && !flat.some((x) => x.toLowerCase() === cleaned.toLowerCase())) {
        flat.push(cleaned);
      }
    }
  };
  if (Array.isArray(v)) v.forEach(push);
  else push(v);
  return flat;
}

// Cap how many values a MULTI aspect carries — enough to keep real data
// ("Casual, Travel, Workwear") without letting a rambling model response
// turn one aspect into a paragraph.
export const MAX_MULTI_VALUES = 5;

// Make every aspect's value count legal for eBay. MULTI aspects keep up to
// MAX_MULTI_VALUES entries; SINGLE aspects (and aspects eBay doesn't know,
// where MULTI can't be proven safe) collapse to their first value. Features
// is the long-standing exception: eBay accepts several everywhere it exists,
// and the app always sent it as a list.
export function enforceCardinality(
  aspects: Record<string, string[]>,
  meta: AspectMeta[]
): void {
  const byName = new Map(meta.map((a) => [a.name.toLowerCase(), a]));
  for (const key of Object.keys(aspects)) {
    const a = byName.get(key.toLowerCase());
    const vals = aspects[key] || [];
    if (vals.length <= 1) continue;
    const multi = a ? a.cardinality === "MULTI" : key === "Features";
    aspects[key] = multi ? vals.slice(0, MAX_MULTI_VALUES) : vals.slice(0, 1);
  }
}

// eBay hard-validates NUMBER-typed aspects at publish time ("Fabric weight
// must be greater than 0. Enter up to 1 number after the decimal.") — a prose
// value like "Heavyweight" fails the whole listing with 25002. Keep only a
// positive numeric token pulled from each value ("6.1 oz" → "6.1", int32
// aspects rounded to whole numbers) and drop the aspect entirely when none of
// its values contain one. Returns the names of dropped aspects for logging.
export function sanitizeNumericAspects(
  aspects: Record<string, string[]>,
  meta: AspectMeta[]
): string[] {
  const dropped: string[] = [];
  const byName = new Map(meta.map((a) => [a.name.toLowerCase(), a]));
  for (const key of Object.keys(aspects)) {
    const a = byName.get(key.toLowerCase());
    if (!a || a.dataType !== "NUMBER") continue;
    const kept: string[] = [];
    for (const v of aspects[key] || []) {
      const m = String(v).match(/-?\d+(?:\.\d+)?/);
      if (!m) continue;
      const num = a.format === "int32" ? String(Math.round(Number(m[0]))) : m[0];
      if (Number(num) > 0 && !kept.includes(num)) kept.push(num);
    }
    if (kept.length) {
      aspects[key] = kept;
    } else {
      delete aspects[key];
      dropped.push(key);
    }
  }
  return dropped;
}

// Formatting-only form of a value: case, spaces, hyphens, underscores and
// apostrophes ignored ("V Neck" = "V-Neck", "Crew Neck" = "Crewneck").
// Dots, slashes and other characters stay, so "10.5" never equals "105".
export function formatKey(value: string): string {
  return (value || "").toLowerCase().replace(/[\s\-_'’]+/g, "");
}

// Match a value against eBay's allowed list, case-insensitively and tolerating
// singular/plural (so "Unisex Adult" resolves to the valid "Unisex Adults"),
// then by formatting-only equivalence. Never by meaning: "Navy" does not match
// "Blue". Returns the canonical allowed value, or null if there's no match (or
// if formatting alone can't pick a single allowed value).
export function matchAllowed(value: string, allowed: string[]): string | null {
  const ls = (value || "").trim().toLowerCase();
  if (!ls) return null;
  for (const v of allowed) {
    const lv = v.toLowerCase();
    if (lv === ls || lv === `${ls}s` || `${lv}s` === ls) return v;
  }
  const key = formatKey(ls);
  if (!key) return null;
  const hits = allowed.filter((v) => {
    const kv = formatKey(v);
    return kv === key || kv === `${key}s` || `${kv}s` === key;
  });
  return hits.length === 1 ? hits[0] : null;
}

// "None" is normally a placeholder, but some aspects list it as a real value.
export const isNoneValue = (v: string) => /^none$/i.test((v || "").trim());

// Keep "None" only where the aspect explicitly allows it (as eBay spells it);
// everywhere else it is the usual placeholder and is removed.
export function resolveNoneValues(
  aspects: Record<string, string[]>,
  meta: AspectMeta[],
): void {
  for (const key of Object.keys(aspects)) {
    const vals = aspects[key] || [];
    if (!vals.some(isNoneValue)) continue;
    const a = meta.find((m) => m.name.toLowerCase() === key.toLowerCase());
    const allowedNone = a?.values.find(isNoneValue);
    const kept = [
      ...new Set(
        vals
          .map((v) => (isNoneValue(v) ? allowedNone : v))
          .filter((v): v is string => Boolean(v)),
      ),
    ];
    if (kept.length) aspects[key] = kept;
    else delete aspects[key];
  }
}

export interface RemovedValue {
  name: string;
  value: string;
  reason: string;
}

// Values present before a preparation step and gone after it. A value that was
// only re-spelled (renamed key, canonical spelling, plural) is not "removed".
export function removedValues(
  before: Record<string, string[]>,
  after: Record<string, string[]>,
  reason: string,
  kept: (value: string, now: string[]) => boolean = (value, now) =>
    now.some(
      (n) =>
        formatKey(n) === formatKey(value) ||
        matchAllowed(value, [n]) ||
        letterSizeMatch(value, [n]).match,
    ),
): RemovedValue[] {
  const out: RemovedValue[] = [];
  for (const [key, vals] of Object.entries(before)) {
    const afterKey =
      Object.keys(after).find((k) => k.toLowerCase() === key.toLowerCase()) ?? key;
    const now = after[afterKey] ?? [];
    for (const value of vals)
      if (!kept(value, now)) out.push({ name: afterKey, value, reason });
  }
  return out;
}

// sanitizeNumericAspects keeps a value's number ("6.1 oz" → "6.1", rounded
// for whole-number aspects); only values without a usable number are removed.
export function keptAsNumber(value: string, now: string[]): boolean {
  if (now.includes(value)) return true;
  const num = String(value).match(/-?\d+(?:\.\d+)?/)?.[0];
  if (!num) return false;
  return now.includes(num) || now.includes(String(Math.round(Number(num))));
}

export const cloneAspects = (a: Record<string, string[]>) =>
  Object.fromEntries(Object.entries(a).map(([k, v]) => [k, [...v]]));

// Rename model-provided aspect keys to eBay's exact (canonical) aspect names,
// matching case-insensitively. The analysis model says "Country/region of
// manufacture" or "SLEEVE LENGTH"; eBay only counts the specific if the key
// matches its localized aspect name exactly — otherwise it stays "suggested"
// on the live listing.
export function canonicalizeAspectKeys(
  aspects: Record<string, string[]>,
  meta: AspectMeta[]
): void {
  const canonical = new Map<string, string>();
  for (const a of meta) {
    if (a.name) canonical.set(a.name.toLowerCase(), a.name);
  }
  for (const key of Object.keys(aspects)) {
    const proper = canonical.get(key.toLowerCase());
    if (proper && proper !== key) {
      if (!aspects[proper]) aspects[proper] = aspects[key];
      delete aspects[key];
    }
  }
  // Snap SELECTION_ONLY values to eBay's canonical spelling where we can.
  for (const a of meta) {
    if (a.mode !== "SELECTION_ONLY" || !aspects[a.name]?.length) continue;
    const vals = aspects[a.name];
    const matched: string[] = [];
    for (const v of vals) {
      const m = matchAllowed(v, a.values);
      if (m && !matched.includes(m)) matched.push(m);
    }
    if (matched.length) {
      aspects[a.name] = matched;
      continue;
    }
    // The value may be a compound allowed value that value-splitting broke
    // apart ("Hook & Eye" → Hook, Eye) — try rejoining before giving up.
    if (vals.length > 1) {
      for (const sep of [" & ", " / ", ", ", " and "]) {
        const joined = matchAllowed(vals.join(sep), a.values);
        if (joined) {
          aspects[a.name] = [joined];
          break;
        }
      }
    }
  }
}

// ── Letter-size equivalents ──────────────────────────────────────────────────
//
// Only spelled-out letter sizes and their abbreviations ("Large" ↔ "L",
// "X-Large" ↔ "XL"). No semantic conversion: numeric, women's/men's numbered,
// EU, youth, petite, tall, plus ("2X") and shoe sizes never map to anything.
const LETTER_SIZES: Record<string, string> = {
  xs: "xs",
  "x small": "xs",
  "extra small": "xs",
  s: "s",
  small: "s",
  m: "m",
  medium: "m",
  l: "l",
  large: "l",
  xl: "xl",
  "x large": "xl",
  "extra large": "xl",
  xxl: "xxl",
  "2xl": "xxl",
  "xx large": "xxl",
  "extra extra large": "xxl",
};
const letterSize = (v: string) =>
  LETTER_SIZES[
    v
      .toLowerCase()
      .replace(/[-_.]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  ];

// Clothing Size aspects ("Size", "Size (Women's)"), not Size Type or shoe sizes.
export const isLetterSizeAspect = (name: string) =>
  /^size(\s*\((men|women)'?s\))?$/i.test(name.trim());

// The one allowed value that is the same letter size, or the candidates when
// there is not exactly one (none, or ambiguous such as XXL and 2XL).
export function letterSizeMatch(
  value: string,
  allowed: string[],
): { match?: string; candidates: string[] } {
  const key = letterSize(value);
  if (!key) return { candidates: [] };
  const candidates = allowed.filter((a) => letterSize(a) === key);
  return candidates.length === 1
    ? { match: candidates[0], candidates }
    : { candidates };
}
