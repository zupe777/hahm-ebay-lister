import type { AspectMeta } from "./ebay/taxonomy";
import type { AiUsage } from "./ai-usage";
import type { ShippingSelection } from "./validation";
// Shape of a generated listing. Mirrors the JSON the model returns in the
// Python script's analyze_photos(), plus the routed profile.

export interface ListingResult {
  title: string;
  category?: string;
  category_hint?: string;
  category_id?: string;
  ebay_condition?: string;
  evidence?: Record<string, number[]>;
  // Confidence (60–100) for specifics the AI estimated rather than read off a label.
  estimates?: Record<string, number>;
  brand?: string;
  item_type?: string;
  color?: string[] | string;
  size?: string;
  material?: string;
  condition?: string;
  condition_notes?: string;
  measurements?: string;
  description: string;
  suggested_price?: number | string;
  // Where suggested_price came from: the AI's unverified photo estimate, the
  // market "Use" button, or the seller's own edit.
  price_source?: "ai" | "market" | "seller";
  // Where title came from: the structured clothing builder, the AI-written
  // title, or the seller's own edit (never rebuilt automatically).
  title_source?: "auto" | "ai" | "seller";
  // Specifics the seller edited in review. Their values outrank analysis and
  // main-field copies whenever specifics are rebuilt.
  seller_specifics?: string[];
  // Values filled by seller defaults rather than observed ("Size Type",
  // "condition"), so review can label them as defaults.
  defaulted?: string[];
  // The analysis condition grade, kept for display when a default condition
  // replaced it.
  ai_condition?: string;
  // Seller information card read from the photos. Seller-supplied facts,
  // never manufacturer-label evidence.
  seller_card?: SellerCard;
  // Specifics whose value came from the seller card.
  card_specifics?: string[];
  // Specifics the AI saw plainly in the photos (basis visible_feature) rather
  // than guessed; both carry an estimates confidence.
  visible?: string[];
  // Specifics supplied by exact-item research: name → source note. Research
  // ranks below label evidence and is never shown as a label reading.
  researched?: Record<string, string>;
  // Disagreements between high-quality sources, kept for seller review until
  // the seller edits or confirms that specific.
  conflicts?: FactConflict[];
  // Retail tags the analysis saw attached to the item.
  attached_tags?: { visible: boolean; photoIndices: number[] };
  // Why the condition was chosen or left for the seller (seller card rules).
  condition_review?: string;
  // The seller's handwritten inventory sticker, as read from the photos. Its
  // value feeds the item's SKU (eBay Custom Label); never an item specific.
  inventory_label?: InventoryLabel;
  search_terms?: string[];
  seo_keywords?: string[];
  key_features?: string[];
  item_specifics?: Record<string, string>;
  item_profile?: string;
}

export interface SellerCard {
  photoIndices: number[];
  // Supported fields (BRAND, NEW, FLAW, …) with the seller's exact wording.
  fields: Record<string, string>;
  // Other FIELD: VALUE lines, preserved for review only.
  other?: Record<string, string>;
}

export interface InventoryLabel {
  // read: confidently read; unreadable: seen but not confidently readable;
  // conflict: photos show different values.
  status: "read" | "unreadable" | "conflict";
  value?: string;
  readings?: string[];
  photoIndices: number[];
  confidence?: number;
}

export interface FactConflict {
  name: string;
  kept: string;
  keptSource: string;
  other: string;
  otherSource: string;
}

export interface AnalyzeRequestBody {
  // Browser-resized JPEG data URLs or raw base64 strings.
  images: { mediaType: string; data: string }[];
  profile: string;
  // Optional model overrides; server falls back to its defaults when omitted.
  analysisModel?: string;
  routerModel?: string;
}

export interface AnalyzeResponse {
  ok: boolean;
  listing?: ListingResult;
  error?: string;
  // Present only when some photos should be re-read at full resolution.
  detailRequests?: import("./detail").DetailRequest[];
  raw?: Record<string, unknown>;
  profile?: string;
  photoCount?: number;
}

export interface SortResponse {
  ok: boolean;
  groups?: { name: string; photoIndices: number[] }[];
  orphanIndices?: number[];
  error?: string;
}

// ── Client-side working model for the bulk flow ──────────────────────────────

// A photo in the working batch. Image data stays in browser storage
// (lib/photo-store.ts); memory holds only this metadata and an object URL for
// the stored thumbnail.
export interface Photo {
  id: string;
  // Object URL of the stored thumbnail, valid for this page session only
  // ("" while unavailable). Never saved.
  previewUrl: string;
  mediaType: string;
  name?: string;
  size?: number;
  analysisSelected?: boolean;
  // The photo's stored image data could not be found.
  missing?: boolean;
  // Large copies released after the item was posted; the thumbnail remains.
  released?: boolean;
}

export type ItemStatus = "idle" | "writing" | "done" | "error";

export type PostStatus = "idle" | "posting" | "posted" | "error";

// Market price check from active eBay comps (see lib/ebay/comps.ts). Advisory:
// shown beside the AI's estimate so the seller prices with real data in view.
export interface CompsSummary {
  ok: boolean;
  sources?: {
    id: string;
    title: string;
    url: string;
    price: number;
    shipping?: number;
    total?: number;
    condition: string;
    // Multi-size (variation) listing: shown, but not counted in the median.
    variation?: boolean;
  }[];
  checkedAt?: string;
  matchBasis?: string;
  query: string;
  count: number;
  median?: number;
  trimmedMean?: number;
  low?: number;
  high?: number;
  confidence: number;
  basis: string;
  // Sources listed but not counted in the median.
  excludedVariations?: number;
  unknownShipping?: number;
  // Market pricing (lib/pricing.ts marketItemPrice), added by the research
  // service. itemPrice is present only with at least minComps counted comps.
  shippingCharge?: number;
  minComps?: number;
  itemPrice?: number;
  rawItemPrice?: number;
  belowFloor?: boolean;
}

export interface ItemGroup {
  cloudBatchId?: string;
  id: string;
  sku: string; // the seller's inventory number; published as eBay's Custom Label; may be blank
  // Where sku came from: the seller's own entry (including an intentional
  // clear, which nothing replaces), the seller card's Custom Label (SKU)
  // field, or the inventory sticker. SKUs are never generated.
  skuSource?: "seller" | "card" | "sticker";
  name: string;
  photoIds: string[];
  listing?: ListingResult;
  status: ItemStatus;
  error?: string;
  analysisPhotoIds?: string[];
  preparation?: PreparedCategory;
  preparationError?: string;
  usage?: AiUsage[];
  compsStatus?: "loading" | "unavailable" | "ready" | "stale";
  shipping?: Partial<ShippingSelection>;
  imageUrls?: string[];
  uploadedPhotoIds?: string[];
  publicationAttemptSku?: string;
  evidencePhotoIds?: string[];
  // Market price check (fetched right after the listing is written)
  comps?: CompsSummary;
  // eBay posting state (Phase 2)
  postStatus?: PostStatus;
  listingId?: string;
  postError?: string;
  // Non-fatal quality warnings from the last publish (e.g. schema unavailable)
  postWarnings?: string[];
}

export interface PreparedCategory {
  suggestions?: import("./ebay/taxonomy").CategorySuggestion[];
  categoryId: string;
  categoryName: string;
  aspects: AspectMeta[];
  conditions: { value: string; label: string }[];
  expiresAt: number;
  signature: string;
  issues: string[];
  // Values preparation removed, shown to the seller as non-blocking notes.
  removed?: { name: string; value: string; reason: string }[];
}
