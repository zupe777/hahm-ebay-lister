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
  search_terms?: string[];
  seo_keywords?: string[];
  key_features?: string[];
  item_specifics?: Record<string, string>;
  item_profile?: string;
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
}

export interface SortResponse {
  ok: boolean;
  groups?: { name: string; photoIndices: number[] }[];
  orphanIndices?: number[];
  error?: string;
}

// ── Client-side working model for the bulk flow ──────────────────────────────

export interface Photo {
  id: string;
  previewUrl: string;
  mediaType: string;
  original?: Blob;
  uploadData?: string;
  analysisSelected?: boolean;
  data: string; // base64, no prefix
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
  sku: string; // bin reference, e.g. "K75-A"
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
