// Product identifiers (UPC / EAN / ISBN / MPN) extracted from the analysis
// model's item specifics, validated before they go anywhere near eBay.
//
// The Inventory API accepts these as dedicated product fields, and a valid
// identifier lets eBay match the item to its catalog (established title,
// aspects, and product page) — a big win for books, media, games, and boxed
// products. Vintage one-off clothing has no identifiers, so nothing changes.

import type { ListingResult } from "@/lib/types";
import { isPlaceholderValue } from "./aspects";
import { factSource } from "@/lib/provenance";

export interface ProductIdentifiers {
  upc?: string;
  ean?: string;
  isbn?: string;
  mpn?: string;
}

function digitsOnly(raw: string): string {
  return raw.replace(/[\s\-–.]/g, "");
}

// All-zero codes pass the GS1 checksum but identify nothing real.
function isAllZeros(code: string): boolean {
  return /^0+$/.test(code);
}

// GS1 check digit (UPC-A / EAN-13): weighted sum mod 10.
function gs1CheckOk(code: string): boolean {
  const digits = code.split("").map(Number);
  const check = digits.pop()!;
  let sum = 0;
  // Weight 3 applies to alternating positions counted from the right.
  digits.reverse().forEach((d, i) => {
    sum += d * (i % 2 === 0 ? 3 : 1);
  });
  return (10 - (sum % 10)) % 10 === check;
}

export function validUpc(raw: string): string | null {
  const code = digitsOnly(raw);
  return /^\d{12}$/.test(code) && !isAllZeros(code) && gs1CheckOk(code) ? code : null;
}

export function validEan(raw: string): string | null {
  const code = digitsOnly(raw);
  return /^\d{13}$/.test(code) && !isAllZeros(code) && gs1CheckOk(code) ? code : null;
}

export function validIsbn(raw: string): string | null {
  const code = digitsOnly(raw).toUpperCase();
  if (/^\d{13}$/.test(code)) {
    // ISBN-13 uses the same GS1 check and starts with the Bookland prefix.
    return (code.startsWith("978") || code.startsWith("979")) && gs1CheckOk(code)
      ? code
      : null;
  }
  if (/^\d{9}[\dX]$/.test(code)) {
    let sum = 0;
    for (let i = 0; i < 10; i++) {
      const c = code[i] === "X" ? 10 : Number(code[i]);
      sum += c * (10 - i);
    }
    return sum % 11 === 0 ? code : null;
  }
  return null;
}

export function validMpn(raw: string): string | null {
  const s = String(raw || "").trim();
  if (!s || isPlaceholderValue(s) || s.length > 65) return null;
  // An MPN needs at least one digit or letter and shouldn't be a sentence.
  return /^[\w\-./#+ ]{2,65}$/.test(s) && !/\s{2,}|\w+\s+\w+\s+\w+\s+\w+/.test(s)
    ? s
    : null;
}

function specificValue(listing: ListingResult, ...keys: string[]): string {
  const specifics = listing.item_specifics || {};
  for (const [k, v] of Object.entries(specifics)) {
    if (keys.some((key) => k.toLowerCase() === key.toLowerCase())) {
      const s = String(v ?? "").trim();
      if (s) return s;
    }
  }
  return "";
}

// Pull whatever identifiers the photos actually showed. A 13-digit "UPC" is
// really an EAN; a Bookland EAN doubles as the ISBN-13.
export function extractProductIdentifiers(listing: ListingResult): ProductIdentifiers {
  const out: ProductIdentifiers = {};

  const upcRaw = specificValue(listing, "UPC", "Barcode");
  if (upcRaw) {
    const upc = validUpc(upcRaw);
    if (upc) out.upc = upc;
    else {
      const ean = validEan(upcRaw);
      if (ean) out.ean = ean;
    }
  }

  const eanRaw = specificValue(listing, "EAN");
  if (!out.ean && eanRaw) {
    const ean = validEan(eanRaw);
    if (ean) out.ean = ean;
  }

  const isbnRaw = specificValue(listing, "ISBN");
  if (isbnRaw) {
    const isbn = validIsbn(isbnRaw);
    if (isbn) out.isbn = isbn;
  }
  if (!out.isbn && out.ean && (out.ean.startsWith("978") || out.ean.startsWith("979"))) {
    out.isbn = out.ean;
  }

  const mpnRaw = specificValue(listing, "MPN", "Manufacturer Part Number", "Model Number");
  if (mpnRaw) {
    const mpn = validMpn(mpnRaw);
    if (mpn) out.mpn = mpn;
  }

  return out;
}

// Catalog matching is only worth switching on when a strong identifier exists —
// UPC/EAN/ISBN uniquely identify a product; an MPN alone is too fuzzy.
export function hasCatalogIdentifier(ids: ProductIdentifiers): boolean {
  return Boolean(ids.upc || ids.ean || ids.isbn);
}

// A brand value eBay's Brand/MPN pair validation will accept: a real brand
// name — not a placeholder, not the unbranded markers. eBay rejects an MPN
// whose brand half is missing (error 25002, tag <BrandMPN>), so the publish
// pipeline only ships an MPN when this returns something.
export function realBrand(listing: ListingResult): string {
  const b = String(listing.brand || "").trim();
  if (!b || isPlaceholderValue(b) || /^(no\s?brand|unbranded|unknown|generic|n\/?a)$/i.test(b)) {
    return "";
  }
  return b.slice(0, 65);
}

// The brand half of a product-level Brand/MPN pair. It must be well
// supported: the seller's value, the seller card, a readable label or exact
// research. An AI-estimated or unchecked brand never enables MPN pairing.
export function mpnBrand(listing: ListingResult): string {
  const brand = realBrand(listing);
  if (!brand) return "";
  const src = factSource(listing, "Brand");
  if (!["seller", "card", "label", "researched"].includes(src)) return "";
  const specific = Object.entries(listing.item_specifics ?? {}).find(
    ([k]) => k.toLowerCase() === "brand",
  )?.[1];
  // The pair publishes the main brand; it must be the supported value.
  return specific && specific.trim().toLowerCase() === brand.toLowerCase()
    ? brand
    : "";
}
