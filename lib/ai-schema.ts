import { PHOTO_FACT_SCHEMA } from "./photo-facts";
import { STICKER_FIELD_SCHEMA } from "./inventory-sticker";
const string = { type: "string" };
const strings = { type: "array", items: string };
export const AI_LISTING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: string,
    description: string,
    category: string,
    category_hint: string,
    brand: string,
    item_type: string,
    color: strings,
    size: string,
    material: string,
    condition: {
      type: "string",
      enum: [
        "EXCELLENT",
        "VERY_GOOD",
        "GOOD",
        "FAIR",
        "FOR_PARTS_OR_NOT_WORKING",
      ],
    },
    condition_notes: string,
    measurements: { type: "string", enum: [""] },
    suggested_price: { type: "number" },
    search_terms: strings,
    seo_keywords: strings,
    key_features: strings,
    specifics: {
      type: "array",
      items: PHOTO_FACT_SCHEMA,
    },
    // The seller's inventory sticker(s), reviewed in lib/inventory-sticker.ts.
    inventory_stickers: STICKER_FIELD_SCHEMA,
  },
  required: [
    "title",
    "description",
    "category",
    "category_hint",
    "brand",
    "item_type",
    "color",
    "size",
    "material",
    "condition",
    "condition_notes",
    "measurements",
    "suggested_price",
    "search_terms",
    "seo_keywords",
    "key_features",
    "specifics",
    "inventory_stickers",
  ],
};
