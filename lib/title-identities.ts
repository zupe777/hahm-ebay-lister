// Data for the clothing title builder (lib/clothingTitle.ts).

// Well-known product lines and models buyers search for by name. A positive
// signal for protecting a label-verified name in the title — never a gate:
// label-verified names also qualify through a distinctive search term or the
// footwear/handbag rule. Matched as whole-word phrases, case-insensitively.
// prettier-ignore
export const CURATED_IDENTITIES = [
  // Outerwear and fleece
  "better sweater", "synchilla", "snap t", "nano puff", "retro x",
  "down sweater", "baggies", "nuptse", "denali", "thermoball", "venture",
  "mountain light", "atom", "beta", "torrent", "ultra light down",
  // Sneakers and shoes
  "air force 1", "air max", "dunk", "jordan", "cortez", "blazer",
  "chuck taylor", "stan smith", "samba", "gazelle", "superstar", "574",
  "990", "992", "550", "old skool", "sk8 hi", "classic leather", "gel lyte",
  "iron ranger", "moc toe", "blucher", "1460", "chelsea",
  // Denim and pants
  "501", "505", "511", "514", "wedgie", "ribcage", "twig",
  // Activewear
  "align", "define", "scuba", "wunder under", "abc", "groove",
  // Bags
  "tabby", "speedy", "neverfull", "pillow tabby", "willow",
  // Shirts, polos and fits
  "big pony", "regent", "milano", "madison", "shep shirt", "oxford",
  // Women's lines
  "maeve", "tippi",
];

// Words that cannot make a search phrase distinctive on their own.
// prettier-ignore
export const GENERIC_TITLE_WORDS = new Set([
  "the", "a", "an", "and", "for", "by", "with", "of", "in", "on", "classic",
  "original", "basic", "basics", "essential", "essentials", "signature",
  "everyday", "premium", "collection", "series", "edition", "style", "new",
  "authentic", "genuine", "vintage", "brand", "mens", "men", "womens",
  "women", "ladies", "unisex", "kids", "size", "sz", "small", "medium",
  "large", "xs", "s", "m", "l", "xl", "xxl", "2xl", "3xl", "petite", "plus",
  "tall", "regular", "slim", "relaxed", "fit", "straight", "skinny", "loose",
  "oversized", "black", "white", "blue", "navy", "gray", "grey", "red",
  "green", "pink", "purple", "brown", "beige", "tan", "cream", "ivory",
  "khaki", "cotton", "polyester", "nylon", "wool", "cashmere", "linen",
  "silk", "leather", "denim", "fleece", "shirt", "tshirt", "tee", "top",
  "blouse", "sweater", "sweatshirt", "hoodie", "cardigan", "pullover",
  "jacket", "coat", "vest", "dress", "skirt", "pants", "jeans", "shorts",
  "leggings", "joggers", "chinos", "shoes", "sneakers", "boots", "sandals",
  "heels", "bag", "handbag", "purse", "wallet", "hat", "cap", "scarf",
  "belt",
]);

// Fibers worth placing before the garment when read from a label.
export const PREMIUM_FIBER_RE =
  /\b(cashmere|merino|wool|silk|linen|leather|suede|alpaca|mohair)\b/i;

// Filler, claim and condition words removed from AI-written descriptive
// parts. Never applied to brand, collaboration, line, model or character.
// prettier-ignore
export const DESCRIPTIVE_STOP_WORDS = new Set([
  "beautiful", "cute", "gorgeous", "stunning", "lovely", "nice", "wow",
  "look", "rare", "htf", "authentic", "genuine", "vintage", "new", "nwt",
  "nwot", "nwob", "euc", "guc", "vguc", "used", "preowned", "pre-owned",
  "excellent", "condition", "mint", "tags",
]);
