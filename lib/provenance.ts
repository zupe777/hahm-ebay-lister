// Provenance for item specifics: where each value came from. Names are
// matched case-insensitively because eBay's canonical spelling ("Sleeve
// Length") can differ from the analysis model's ("Sleeve length").

import type { FactConflict, ListingResult } from "./types";

export function findKey(
  map: Record<string, unknown> | undefined,
  name: string,
): string | undefined {
  if (!map) return undefined;
  const lower = name.toLowerCase();
  return Object.keys(map).find((k) => k.toLowerCase() === lower);
}

export function lookup<T>(
  map: Record<string, T> | undefined,
  name: string,
): T | undefined {
  const key = findKey(map, name);
  return key === undefined ? undefined : map![key];
}

export const hasName = (list: string[] | undefined, name: string) =>
  (list ?? []).some((n) => n.toLowerCase() === name.toLowerCase());

const withoutName = (list: string[] | undefined, name: string) =>
  (list ?? []).filter((n) => n.toLowerCase() !== name.toLowerCase());

function withoutKey<T>(
  map: Record<string, T> | undefined,
  name: string,
): Record<string, T> | undefined {
  if (!map) return map;
  const key = findKey(map, name);
  if (key === undefined) return map;
  const next = { ...map };
  delete next[key];
  return next;
}

// The seller reviewed this specific: their value replaces any AI, card or
// research provenance for that one field, it is no longer a default, and any
// conflict about it is resolved.
export function markSellerReviewed(l: ListingResult, name: string): void {
  l.evidence = withoutKey(l.evidence, name);
  l.estimates = withoutKey(l.estimates, name);
  l.defaulted = withoutName(l.defaulted, name);
  if (l.card_specifics) l.card_specifics = withoutName(l.card_specifics, name);
  if (l.visible) l.visible = withoutName(l.visible, name);
  if (l.researched) l.researched = withoutKey(l.researched, name);
  if (l.conflicts)
    l.conflicts = l.conflicts.filter(
      (c) => c.name.toLowerCase() !== name.toLowerCase(),
    );
  if (!hasName(l.seller_specifics, name))
    l.seller_specifics = [...(l.seller_specifics ?? []), name];
}

// Where a specific's value came from, highest authority first.
export type FactSource =
  | "seller"
  | "card"
  | "label"
  | "researched"
  | "visible"
  | "estimate"
  | "default"
  | "unchecked";

export function factSource(l: ListingResult, name: string): FactSource {
  if (hasName(l.seller_specifics, name)) return "seller";
  if (hasName(l.card_specifics, name)) return "card";
  if (hasName(l.defaulted, name)) return "default";
  const cited = Boolean(lookup(l.evidence, name)?.length);
  if (cited && lookup(l.estimates, name) === undefined) return "label";
  if (lookup(l.researched, name) !== undefined) return "researched";
  if (lookup(l.estimates, name) !== undefined)
    return hasName(l.visible, name) ? "visible" : "estimate";
  return "unchecked";
}

// Seller, seller card, a readable label or exact-item research: values that
// later passes and main-field copies must never replace.
export const isAuthoritative = (l: ListingResult, name: string) =>
  ["seller", "card", "label", "researched"].includes(factSource(l, name));

// Hook for exact-item research (Material, Product Line, Style, Model,
// Features…). Research fills or replaces only photo estimates and unchecked
// copies; seller, card and label values stay, and a disagreement with one of
// them is surfaced as a conflict. Research is never recorded as photo or
// label evidence.
export function applyResearchedFacts(
  l: ListingResult,
  facts: { name: string; value: string; source: string }[],
): void {
  for (const f of facts) {
    const value = f.value.trim();
    if (!f.name.trim() || !value) continue;
    const key = findKey(l.item_specifics, f.name) ?? f.name;
    const current = String(l.item_specifics?.[key] ?? "").trim();
    const src = factSource(l, key);
    if (src === "seller" || src === "card" || src === "label") {
      if (current && current.toLowerCase() !== value.toLowerCase())
        addConflict(l, {
          name: key,
          kept: current,
          keptSource: SOURCE_LABEL[src],
          other: value,
          otherSource: SOURCE_LABEL.researched,
        });
      continue;
    }
    l.item_specifics = { ...l.item_specifics, [key]: value };
    l.evidence = withoutKey(l.evidence, key);
    l.estimates = withoutKey(l.estimates, key);
    l.defaulted = withoutName(l.defaulted, key);
    if (l.visible) l.visible = withoutName(l.visible, key);
    l.researched = { ...withoutKey(l.researched, key), [key]: f.source };
  }
}

export const SOURCE_LABEL: Record<FactSource, string> = {
  seller: "your edit",
  card: "seller card",
  label: "the label",
  researched: "research",
  visible: "the photos",
  estimate: "the AI estimate",
  default: "the default",
  unchecked: "the AI draft",
};

export function addConflict(l: ListingResult, c: FactConflict): void {
  const rest = (l.conflicts ?? []).filter(
    (x) =>
      !(
        x.name.toLowerCase() === c.name.toLowerCase() &&
        x.otherSource === c.otherSource
      ),
  );
  l.conflicts = [...rest, c];
}

export function conflictMessage(c: FactConflict): string {
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  return `${cap(c.keptSource)} says ${c.kept}; ${c.otherSource} appears to say ${c.other} — please review ${c.name}.`;
}

// Move provenance records to eBay's canonical aspect names when the specifics
// themselves are renamed, so photo citations and estimate markers follow the
// value. An existing canonical entry is never overwritten.
export function canonicalizeProvenance(
  l: ListingResult,
  canonicalNames: string[],
): void {
  const canonical = new Map(canonicalNames.map((n) => [n.toLowerCase(), n]));
  const renameMap = <T>(map: Record<string, T> | undefined) => {
    if (!map) return map;
    const next: Record<string, T> = {};
    for (const [k, v] of Object.entries(map)) {
      const proper = canonical.get(k.toLowerCase()) ?? k;
      if (proper === k || !(proper in map)) {
        if (!(proper in next)) next[proper] = v;
      }
    }
    return next;
  };
  const renameList = (list: string[] | undefined) =>
    list && [...new Set(list.map((n) => canonical.get(n.toLowerCase()) ?? n))];
  l.evidence = renameMap(l.evidence);
  l.estimates = renameMap(l.estimates);
  l.researched = renameMap(l.researched);
  l.seller_specifics = renameList(l.seller_specifics);
  l.defaulted = renameList(l.defaulted);
  l.card_specifics = renameList(l.card_specifics);
  l.visible = renameList(l.visible);
  if (l.conflicts)
    l.conflicts = l.conflicts.map((c) => ({
      ...c,
      name: canonical.get(c.name.toLowerCase()) ?? c.name,
    }));
}
