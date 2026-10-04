import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AspectMeta, CategorySuggestion } from "@/lib/ebay/taxonomy";
import type { ItemGroup, ListingResult, PreparedCategory } from "@/lib/types";

// Real preparation and publication with eBay and the second AI pass mocked.
const ebay = vi.hoisted(() => ({
  meta: [] as AspectMeta[],
  conditions: new Set<number>([2990, 3000, 3010]),
}));
vi.mock("@/lib/ebay/taxonomy", () => ({
  suggestLeafCategories: async (): Promise<CategorySuggestion[]> => [
    { id: "57990", name: "Shorts", path: "Clothing > Men > Shorts" },
  ],
  categoryAspects: async () => ebay.meta,
  acceptedConditionIds: async () => ebay.conditions,
}));
vi.mock("@/lib/ebay/session", () => ({
  EBAY_COOKIE: "ebay_conn",
  accessTokenFromCookie: async () => "token",
}));
vi.mock("@/lib/anthropic", () => ({
  getClient: () => ({}),
  parseModelJson: (t: string) => JSON.parse(t),
}));
vi.mock("@/lib/ai-usage", () => ({
  collectUsage: async (fn: () => Promise<unknown>) => ({
    result: await fn(),
    usage: [],
  }),
  currentUsage: () => [],
  measuredMessage: async () => ({
    content: [{ type: "text", text: JSON.stringify({ facts: [] }) }],
  }),
}));

import { prepareListing } from "@/lib/services/prepare";
import { publishListing } from "@/lib/ebay/publish";
import { buildAnalyzedListing } from "@/lib/item-facts";
import { skuAfterAnalysis } from "@/lib/inventory-sticker";

const aspect = (name: string, extra: Partial<AspectMeta> = {}): AspectMeta => ({
  name,
  required: false,
  usage: "RECOMMENDED",
  mode: "FREE_TEXT",
  cardinality: "SINGLE",
  values: [],
  ...extra,
});
const META = [
  aspect("Brand"),
  aspect("Size"),
  aspect("Color"),
  aspect("Type"),
  aspect("Department", { mode: "SELECTION_ONLY", values: ["Men", "Women"] }),
];
const analyzed = (sticker: Record<string, unknown>) =>
  buildAnalyzedListing(
    {
      title: "Mens Red Athletic Shorts",
      description: "Red athletic shorts.",
      category: "mens_pants",
      category_hint: "mens athletic shorts",
      brand: "",
      item_type: "Athletic Shorts",
      color: ["Red"],
      size: "",
      material: "",
      condition: "EXCELLENT",
      condition_notes: "",
      measurements: "",
      suggested_price: 15,
      search_terms: [],
      seo_keywords: [],
      key_features: [],
      specifics: [],
      seller_card: { present: false, photoIndices: [], lines: [] },
      attached_tags: { visible: false, photoIndices: [] },
      inventory_sticker: {
        present: true,
        handwritten_white_sticker: true,
        readable: true,
        value: "1009",
        readings: ["1009"],
        photoIndices: [1],
        confidence: 96,
        ...sticker,
      },
    },
    1,
    "clothing",
  );
const images = [{ mediaType: "image/jpeg", data: "aGVsbG8=" }];
async function prepare(listing: ListingResult) {
  const res = await prepareListing({ listing, images, enrich: true }, "sealed");
  const body = await res.json();
  if (!body.ok) throw new Error(body.error);
  return body as { listing: ListingResult; preparation: PreparedCategory };
}
const autoGroup = (): ItemGroup => ({
  id: "g1",
  sku: "",
  name: "red-shorts",
  photoIds: ["p1"],
  status: "writing",
});

beforeEach(() => {
  vi.stubEnv("APP_SECRET", "unit-test-secret");
  ebay.meta = META;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("inventory sticker through preparation", () => {
  it("14. the detected Custom Label survives preparation and re-preparation", async () => {
    const l = analyzed({});
    const g = { ...autoGroup(), ...skuAfterAnalysis(autoGroup(), l) };
    expect(g.sku).toBe("1009");
    const first = await prepare(l);
    expect(first.listing.inventory_label).toMatchObject({
      status: "read",
      value: "1009",
    });
    const again = await prepare(first.listing);
    expect(again.listing.inventory_label?.value).toBe("1009");
    // Never an item specific, before or after preparation.
    expect(Object.values(again.listing.item_specifics ?? {})).not.toContain(
      "1009",
    );
    // Preparation never touches the SKU; a later analysis keeps it.
    expect(skuAfterAnalysis(g, again.listing).sku).toBe("1009");
  });

  it("13. a manually cleared Custom Label stays blank after re-preparation", async () => {
    const l = analyzed({});
    const cleared: ItemGroup = { ...autoGroup(), sku: "", skuSource: "seller" };
    const { listing } = await prepare(l);
    const again = await prepare(listing);
    expect(skuAfterAnalysis(cleared, again.listing)).toEqual({
      sku: "",
      skuSource: "seller",
    });
  });
});

describe("publishing", () => {
  it("15. publishes exactly the seller-reviewed Custom Label", async () => {
    const { listing, preparation } = await prepare(analyzed({}));
    const writes: { method: string; url: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init: RequestInit = {}) => {
        const u = String(url);
        const method = init.method ?? "GET";
        if (method !== "GET") writes.push({ method, url: u });
        const json = (body: unknown) => new Response(JSON.stringify(body));
        if (u.includes("/fulfillment_policy"))
          return json({
            fulfillmentPolicies: [{ fulfillmentPolicyId: "ship" }],
          });
        if (u.includes("/payment_policy"))
          return json({ paymentPolicies: [{ paymentPolicyId: "pay" }] });
        if (u.includes("/return_policy"))
          return json({
            returnPolicies: [{ returnPolicyId: "ret", returnsAccepted: true }],
          });
        if (u.includes("/location"))
          return json({
            locations: [
              {
                merchantLocationKey: "home",
                merchantLocationStatus: "ENABLED",
              },
            ],
          });
        if (
          u.includes("/offer?sku=") ||
          (u.includes("/inventory_item/") && method === "GET")
        )
          return new Response(null, { status: 404 });
        if (u.includes("/inventory_item/") && method === "PUT")
          return new Response(null, { status: 204 });
        if (u.endsWith("/publish")) return json({ listingId: "1234567890" });
        if (u.endsWith("/offer") && method === "POST")
          return json({ offerId: "OFFER-1" });
        throw new Error("Unexpected request " + method + " " + u);
      }),
    );
    // The seller reviewed the sticker value and kept it.
    const sku = "1009";
    const result = await publishListing("token", {
      sku,
      listing: { ...listing, ebay_condition: "PRE_OWNED_EXCELLENT" },
      imageUrls: ["https://i.ebayimg.com/a.jpg"],
      expectedPhotoCount: 1,
      shipping: {
        fulfillmentPolicyId: "ship",
        paymentPolicyId: "pay",
        returnPolicyId: "ret",
        locationKey: "home",
      },
      review: {
        categoryId: preparation.categoryId,
        expiresAt: preparation.expiresAt,
        signature: preparation.signature,
      },
    });
    expect(result).toMatchObject({ success: true, sku: "1009" });
    expect(writes.find((w) => w.method === "PUT")?.url).toMatch(
      /\/inventory_item\/1009$/,
    );
    // An edited value publishes exactly as typed.
    writes.length = 0;
    const edited = await publishListing("token", {
      sku: "A-1013",
      listing: { ...listing, ebay_condition: "PRE_OWNED_EXCELLENT" },
      imageUrls: ["https://i.ebayimg.com/a.jpg"],
      expectedPhotoCount: 1,
      shipping: {
        fulfillmentPolicyId: "ship",
        paymentPolicyId: "pay",
        returnPolicyId: "ret",
        locationKey: "home",
      },
      review: {
        categoryId: preparation.categoryId,
        expiresAt: preparation.expiresAt,
        signature: preparation.signature,
      },
    });
    expect(edited).toMatchObject({ success: true, sku: "A-1013" });
    expect(writes.find((w) => w.method === "PUT")?.url).toMatch(
      /\/inventory_item\/A-1013$/,
    );
  });
});

const shipping = {
  fulfillmentPolicyId: "ship",
  paymentPolicyId: "pay",
  returnPolicyId: "ret",
  locationKey: "home",
};

describe("seller-only SKU through preparation and publishing", () => {
  it("8. a manual SKU survives analysis and preparation", async () => {
    const l = analyzed({});
    const mine: ItemGroup = {
      ...autoGroup(),
      sku: "A-1013",
      skuSource: "seller",
    };
    const { listing } = await prepare(l);
    const again = await prepare(listing);
    expect(skuAfterAnalysis(mine, again.listing)).toEqual({
      sku: "A-1013",
      skuSource: "seller",
    });
  });

  it("23. preparation never creates or returns a SKU", async () => {
    const l = analyzed({ present: false, handwritten_white_sticker: false });
    expect(l.inventory_label).toBeUndefined();
    const res = await prepareListing(
      { listing: l, images, enrich: true },
      "sealed",
    );
    const body = await res.json();
    expect(JSON.stringify(body)).not.toMatch(/"sku"/i);
    expect(skuAfterAnalysis(autoGroup(), body.listing)).toEqual({
      sku: "",
      skuSource: undefined,
    });
  });

  it("5/24. publishing with a blank SKU is refused before anything is written", async () => {
    const { listing, preparation } = await prepare(analyzed({}));
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        calls.push(String(url));
        return new Response("{}");
      }),
    );
    for (const sku of ["", "   "])
      await expect(
        publishListing("token", {
          sku,
          listing: { ...listing, ebay_condition: "PRE_OWNED_EXCELLENT" },
          imageUrls: ["https://i.ebayimg.com/a.jpg"],
          expectedPhotoCount: 1,
          shipping,
          review: {
            categoryId: preparation.categoryId,
            expiresAt: preparation.expiresAt,
            signature: preparation.signature,
          },
        }),
      ).rejects.toThrow("Custom Label (SKU) is required.");
    expect(calls).toEqual([]);
  });
});
