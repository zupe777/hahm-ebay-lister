// Provenance for item specifics: where each value came from. Names are
// matched case-insensitively because eBay's canonical spelling ("Sleeve
// Length") can differ from the analysis model's ("Sleeve length").

import type { ListingResult } from "./types";

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

// The seller reviewed this specific: their value replaces any AI provenance
// for that one field, and it is no longer a default.
export function markSellerReviewed(l: ListingResult, name: string): void {
  l.evidence = withoutKey(l.evidence, name);
  l.estimates = withoutKey(l.estimates, name);
  l.defaulted = withoutName(l.defaulted, name);
  if (!hasName(l.seller_specifics, name))
    l.seller_specifics = [...(l.seller_specifics ?? []), name];
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
  l.seller_specifics = renameList(l.seller_specifics);
  l.defaulted = renameList(l.defaulted);
}
