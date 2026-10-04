import { APPAREL_CATEGORIES } from "./categories";
// Label facts must match their quoted text. Visual judgments and educated
// guesses are accepted at >= MIN_ESTIMATE_CONFIDENCE so the seller only fills
// genuinely unknown aspects. An eBay allowed-value list is never evidence.
export const MIN_ESTIMATE_CONFIDENCE = 60;
// Brand without readable label text or wordmark: only very strong visual
// branding, kept marked as an AI estimate. Style resemblance is not enough.
export const BRAND_ESTIMATE_CONFIDENCE = 90;
// A wrong guess here misrepresents the item or breaks catalog matching:
// these must come from a readable label or stay empty.
const labelOnly =
  /\b(upc|ean|isbn|gtin|mpn)\b|manufactur|vintage|handmade|personaliz|inseam|\brise\b|chest|waist size|measurement|length \(in|pit to pit/i;
// Clothing and accessories only: model, style and part numbers are never
// guessed from appearance. Other categories keep their earlier rules.
const clothingLabelOnly =
  /\bsku\b|^model$|model (number|no)|style (code|number|no|#)|part number/i;
export const CLOTHING_WORKFLOW_CATEGORIES = new Set([
  ...APPAREL_CATEGORIES,
  "handbag",
  "wallet",
  "sunglasses",
  "accessory",
]);
// The clothing/accessory workflow: the clothing profile or a clothing,
// shoe, bag or fashion-accessory category.
export const isClothingWorkflow = (l: {
  category?: unknown;
  item_profile?: unknown;
}) =>
  l.item_profile === "clothing" ||
  CLOTHING_WORKFLOW_CATEGORIES.has(String(l.category ?? ""));

// Promotional claims are not facts. A value is a claim when it is only
// promotional words ("Amazing", "Super Cute", "Premium Quality"), contains a
// promotional phrase, or opens with a promotional adjective ("Luxurious Soft
// Lining"). Proper names are not claims: identity aspects (Product Line,
// Model, Collaboration, Character, Theme…) and names ending in Collection,
// Edition, Series… are left alone, as are label, seller and card values,
// which never pass through this check.
const PROMO = new Set([
  "amazing", "gorgeous", "stunning", "beautiful", "luxurious", "luxury",
  "premium", "perfect", "great", "awesome", "cute", "lovely", "iconic",
  "stylish", "elegant", "chic", "trendy", "timeless", "versatile",
  "flattering", "comfortable", "comfy", "cozy", "fabulous", "incredible",
]); // prettier-ignore
const FILLER = new Set([
  "very", "super", "ultra", "so", "really", "and", "feel", "feels", "fit",
  "look", "looks", "quality", "style", "design", "comfort", "soft", "wear",
  "piece", "item", "find", "buy", "a", "an", "the", "with",
]); // prettier-ignore
const PROMO_PHRASE =
  /\b(must[- ]have|high[- ]performance|(high|top|premium)[- ]quality|(super|ultra|buttery|so)[- ](soft|cute|comfy|comfortable))\b/i;
const NAME_SUFFIX = /\b(collection|edition|series|line|collab|capsule|range)$/i;
const IDENTITY_ASPECT =
  /^(brand|product line|model|style( name)?|collection|collaboration|character( family)?|theme|franchise|series|edition|team|artist|designer)$/i;
export function isPromotionalClaim(value: string, name = ""): boolean {
  if (IDENTITY_ASPECT.test(name.trim())) return false;
  const text = value.trim();
  const words = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  if (!words.length || NAME_SUFFIX.test(text)) return false;
  if (PROMO_PHRASE.test(text)) return true;
  if (words.every((w) => PROMO.has(w) || FILLER.has(w))) return true;
  return PROMO.has(words[0]);
}
// Fiber percentages come from a label, the seller or exact research only.
const PERCENT = /\d\s*%/;
export const isLabelOnlyFact = (name: string) => labelOnly.test(name);
export const isClothingLabelOnlyFact = (name: string) =>
  labelOnly.test(name) || clothingLabelOnly.test(name);
// Legacy visible_feature facts without a confidence score.
const visible = new Set([
  "color",
  "pattern",
  "sleeve length",
  "neckline",
  "closure",
  "collar",
  "collar style",
  "style",
  "type",
  "accents",
  "features",
  "pocket type",
]);
export interface PhotoFact {
  name: string;
  value: string;
  photoIndices: number[];
  basis: "label" | "visible_feature" | "estimate";
  quote: string;
  confidence?: number;
}
export function acceptedPhotoFact(
  raw: unknown,
  count: number,
  // Clothing/accessory listings also keep model, style and part numbers
  // label-only (see isClothingWorkflow).
  opts: { clothing?: boolean } = {},
): raw is PhotoFact {
  if (!raw || typeof raw !== "object") return false;
  const s = raw as PhotoFact;
  if (
    typeof s.name !== "string" ||
    typeof s.value !== "string" ||
    !s.value.trim() ||
    s.value.length > 500 ||
    !Array.isArray(s.photoIndices) ||
    !s.photoIndices.length ||
    !s.photoIndices.every((i) => Number.isInteger(i) && i > 0 && i <= count)
  )
    return false;
  if (s.basis === "label") {
    if (typeof s.quote !== "string" || !s.quote.trim()) return false;
    const normalize = (v: string) =>
      " " +
      v
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim() +
      " ";
    // A size tag M does not establish Men, Regular fit or a manufacturing year.
    if (
      /year.*manufact|manufact.*year/i.test(s.name) &&
      !/manufactured|made in \d{4}/i.test(s.quote)
    )
      return false;
    return s.value
      .split(" | ")
      .every((v) => normalize(s.quote).includes(normalize(v)));
  }
  if (s.basis !== "visible_feature" && s.basis !== "estimate") return false;
  if (labelOnly.test(s.name)) return false;
  if (opts.clothing && clothingLabelOnly.test(s.name)) return false;
  if (PERCENT.test(s.value) || isPromotionalClaim(s.value, s.name))
    return false;
  const minimum = /^brand$/i.test(s.name.trim())
    ? BRAND_ESTIMATE_CONFIDENCE
    : MIN_ESTIMATE_CONFIDENCE;
  if (typeof s.confidence === "number")
    return Number.isFinite(s.confidence) && s.confidence >= minimum;
  return (
    s.basis === "visible_feature" &&
    minimum === MIN_ESTIMATE_CONFIDENCE &&
    visible.has(s.name.toLowerCase())
  );
}
export const isEstimate = (f: PhotoFact) => f.basis !== "label";
export const PHOTO_FACT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string" },
    value: { type: "string" },
    photoIndices: { type: "array", items: { type: "integer" } },
    basis: { type: "string", enum: ["label", "visible_feature", "estimate"] },
    quote: { type: "string" },
    confidence: { type: "integer" },
  },
  required: ["name", "value", "photoIndices", "basis", "quote", "confidence"],
};
