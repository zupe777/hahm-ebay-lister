import { PHOTO_FACT_SCHEMA } from "./photo-facts";
import { DETAIL_REQUESTS_SCHEMA } from "./detail";
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
    // A seller information card, transcribed line by line; parsed in code.
    seller_card: {
      type: "object",
      additionalProperties: false,
      properties: {
        present: { type: "boolean" },
        photoIndices: { type: "array", items: { type: "integer" } },
        lines: strings,
      },
      required: ["present", "photoIndices", "lines"],
    },
    // The seller's small white handwritten inventory sticker (SKU source).
    inventory_sticker: {
      type: "object",
      additionalProperties: false,
      properties: {
        present: { type: "boolean" },
        handwritten_white_sticker: { type: "boolean" },
        readable: { type: "boolean" },
        value: string,
        readings: strings,
        photoIndices: { type: "array", items: { type: "integer" } },
        confidence: { type: "integer" },
      },
      required: [
        "present",
        "handwritten_white_sticker",
        "readable",
        "value",
        "readings",
        "photoIndices",
        "confidence",
      ],
    },
    // Retail/manufacturer tags still attached to the item.
    attached_tags: {
      type: "object",
      additionalProperties: false,
      properties: {
        visible: { type: "boolean" },
        photoIndices: { type: "array", items: { type: "integer" } },
      },
      required: ["visible", "photoIndices"],
    },
    // Photos to re-read at full resolution (see lib/detail.ts).
    detail_requests: DETAIL_REQUESTS_SCHEMA,
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
    "seller_card",
    "attached_tags",
    "inventory_sticker",
    "detail_requests",
  ],
};
