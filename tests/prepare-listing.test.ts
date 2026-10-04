import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AspectMeta, CategorySuggestion } from "@/lib/ebay/taxonomy";
import type { ListingResult, PreparedCategory } from "@/lib/types";

// No network: eBay category data, the eBay session and the second AI pass are
// all mocked. Everything else is the real preparation pipeline.
const ebay = vi.hoisted(() => ({
  suggestions: [] as CategorySuggestion[],
  meta: [] as AspectMeta[],
  conditions: new Set<number>([2990, 3000]),
  fillFacts: [] as unknown[],
  fillCalls: 0,
}));
vi.mock("@/lib/ebay/taxonomy", () => ({
  suggestLeafCategories: async () => ebay.suggestions,
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
  measuredMessage: async () => {
    ebay.fillCalls++;
    return {
      content: [
        { type: "text", text: JSON.stringify({ facts: ebay.fillFacts }) },
      ],
    };
  },
}));

import { prepareListing } from "@/lib/services/prepare";
import { applyListingEdit } from "@/lib/seller-edits";
import { publishListing } from "@/lib/ebay/publish";

const aspect = (name: string, extra: Partial<AspectMeta> = {}): AspectMeta => ({
  name,
  required: false,
  usage: "RECOMMENDED",
  mode: "FREE_TEXT",
  cardinality: "SINGLE",
  values: [],
  ...extra,
});
const select = (
  name: string,
  values: string[],
  extra: Partial<AspectMeta> = {},
) => aspect(name, { mode: "SELECTION_ONLY", values, ...extra });

const SHIRT_META: AspectMeta[] = [
  aspect("Brand", { required: true, usage: "REQUIRED" }),
  select("Size", ["S", "M", "L", "XL"], { required: true, usage: "REQUIRED" }),
  select("Size Type", ["Regular", "Big & Tall"]),
  select("Department", ["Men", "Women", "Unisex Adults"], {
    required: true,
    usage: "REQUIRED",
  }),
  select("Color", ["Blue", "Navy", "White", "Black"]),
  aspect("Type"),
  aspect("Material", { cardinality: "MULTI" }),
  aspect("Features", { cardinality: "MULTI" }),
  select("Neckline", ["V-Neck", "Crew Neck"]),
  select("Sleeve Length", ["Long Sleeve", "Short Sleeve"]),
  select("Sleeve Style", ["Long Sleeve", "Short Sleeve"]),
  aspect("Fabric Weight", { dataType: "NUMBER" }),
  select("Closure", ["Button", "Zip"], { required: true, usage: "REQUIRED" }),
  select("Embellishment", ["None", "Beaded"]),
  aspect("Theme"),
  aspect("Product Line"),
];
const SUGGESTIONS: CategorySuggestion[] = [
  { id: "53159", name: "Tops", path: "Clothing > Women > Women's Tops" },
  {
    id: "57990",
    name: "Casual Shirts",
    path: "Clothing > Men > Men's Shirts > Casual Shirts",
  },
];

// A listing as analysis returns it (evidence = photo numbers; estimates =
// confidence for non-label facts).
const analyzed = (over: Partial<ListingResult> = {}): ListingResult => ({
  title: "Acme Mens Button Down Shirt Sz M Blue",
  title_source: "auto",
  description: "Pre-owned shirt.",
  brand: "Acme",
  category: "mens_top",
  category_hint: "mens casual shirt",
  item_type: "Button Down Shirt",
  size: "M",
  color: ["Blue"],
  material: "Cotton",
  condition: "VERY_GOOD",
  key_features: ["Short Sleeve", "Collared"],
  item_specifics: {},
  evidence: {},
  estimates: {},
  ...over,
});
const images = [{ mediaType: "image/jpeg", data: "aGVsbG8=" }];
async function prepare(listing: ListingResult) {
  const res = await prepareListing({ listing, images, enrich: true }, "sealed");
  const body = await res.json();
  if (!body.ok) throw new Error(body.error);
  return body as { listing: ListingResult; preparation: PreparedCategory };
}

beforeEach(() => {
  vi.stubEnv("APP_SECRET", "unit-test-secret");
  ebay.suggestions = SUGGESTIONS;
  ebay.meta = SHIRT_META;
  ebay.fillFacts = [];
  ebay.fillCalls = 0;
});
afterEach(() => vi.unstubAllEnvs());

describe("prepareListing", () => {
  it("picks the first suggestion matching the department", async () => {
    const { preparation } = await prepare(analyzed());
    expect(preparation.categoryId).toBe("57990");
    expect(preparation.suggestions?.map((s) => s.id)).toEqual(["57990"]);
  });

  it("stops when no category matches the department", async () => {
    ebay.suggestions = [SUGGESTIONS[0]];
    await expect(prepare(analyzed())).rejects.toThrow(
      "matching this department",
    );
  });

  it("stops when the chosen category rejects the department", async () => {
    ebay.meta = SHIRT_META.map((a) =>
      a.name === "Department" ? { ...a, values: ["Women"] } : a,
    );
    await expect(prepare(analyzed({ category_id: "57990" }))).rejects.toThrow(
      "does not accept Department Men",
    );
  });

  it("applies and labels defaults, keeping the AI grade for display", async () => {
    const { listing } = await prepare(analyzed());
    expect(listing.item_specifics?.["Size Type"]).toBe("Regular");
    expect(listing.ebay_condition).toBe("PRE_OWNED_EXCELLENT");
    expect(listing.defaulted).toEqual(["Size Type", "condition"]);
    expect(listing.ai_condition).toBe("VERY_GOOD");
  });

  it("reports removed values without substituting anything", async () => {
    const { listing, preparation } = await prepare(
      analyzed({
        color: ["Blue", "White"],
        item_specifics: {
          "Sleeve Style": "Cap Sleeve",
          "Fabric Weight": "Heavyweight",
        },
        evidence: { "Sleeve Style": [1], "Fabric Weight": [1] },
      }),
    );
    expect(preparation.removed).toEqual([
      {
        name: "Sleeve Style",
        value: "Cap Sleeve",
        reason: "Not accepted by eBay for this category",
      },
      {
        name: "Color",
        value: "White",
        reason: "eBay allows only one value here",
      },
      {
        name: "Fabric Weight",
        value: "Heavyweight",
        reason: "eBay needs a number here",
      },
    ]);
    expect(listing.item_specifics?.["Sleeve Style"]).toBeUndefined();
    expect(listing.item_specifics?.Color).toBe("Blue");
    // Required-but-missing still blocks, as before.
    expect(preparation.issues).toContain("Enter Closure");
  });

  it("adds second-pass facts as marked estimates and refreshes the builder title", async () => {
    ebay.fillFacts = [
      {
        name: "Neckline",
        value: "V Neck",
        basis: "visible_feature",
        quote: "",
        photoIndices: [1],
        confidence: 80,
      },
    ];
    const { listing } = await prepare(analyzed());
    expect(ebay.fillCalls).toBe(1);
    expect(listing.item_specifics?.Neckline).toBe("V-Neck");
    expect(listing.estimates?.Neckline).toBe(80);
    expect(listing.title).toContain("V-Neck");
  });

  it("keeps analysis estimates through preparation (they used to be stripped)", async () => {
    const { listing } = await prepare(
      analyzed({
        search_terms: ["acme harbor shirt"],
        item_specifics: { "Product Line": "Harbor", Pattern: "Striped" },
        evidence: { "Product Line": [1], Pattern: [2] },
        estimates: { "Product Line": 90, Pattern: 70 },
      }),
    );
    expect(listing.estimates).toMatchObject({
      "Product Line": 90,
      Pattern: 70,
    });
    // An estimated product line is never treated as label-verified in the title.
    expect(listing.title).not.toContain("Harbor");
  });

  it("moves photo citations and estimate markers to eBay's spelling", async () => {
    const { listing } = await prepare(
      analyzed({
        item_specifics: { "sleeve length": "Long Sleeve" },
        evidence: { "sleeve length": [2] },
        estimates: { "sleeve length": 85 },
      }),
    );
    expect(listing.item_specifics?.["Sleeve Length"]).toBe("Long Sleeve");
    expect(listing.evidence?.["Sleeve Length"]).toEqual([2]);
    expect(listing.estimates?.["Sleeve Length"]).toBe(85);
  });

  it('keeps an allowed "None" and drops a placeholder "None" silently', async () => {
    const { listing, preparation } = await prepare(
      analyzed({
        item_specifics: { Embellishment: "None", Theme: "None" },
        evidence: { Embellishment: [1], Theme: [1] },
      }),
    );
    expect(listing.item_specifics?.Embellishment).toBe("None");
    expect(listing.item_specifics?.Theme).toBeUndefined();
    expect(preparation.issues).not.toContain(
      "Remove unknown placeholder in Embellishment",
    );
    expect(preparation.removed).toEqual([]);
  });
});

describe("re-preparation keeps seller edits", () => {
  it("Color Blue → Navy survives re-preparation, and the title follows", async () => {
    const first = await prepare(analyzed());
    expect(first.listing.item_specifics?.Color).toBe("Blue");
    const edited = applyListingEdit(first.listing, {
      item_specifics: { ...first.listing.item_specifics, Color: "Navy" },
    });
    const again = await prepare(edited);
    expect(again.listing.item_specifics?.Color).toBe("Navy");
    expect(again.listing.color).toEqual(["Navy"]);
    expect(again.listing.title).toContain("Navy");
    expect(again.listing.title).not.toContain("Blue");
  });

  it("a Features edit survives re-preparation and is not refilled by the AI", async () => {
    const first = await prepare(analyzed());
    expect(first.listing.item_specifics?.Features).toBe(
      "Short Sleeve | Collared",
    );
    const edited = applyListingEdit(first.listing, {
      item_specifics: { ...first.listing.item_specifics, Features: "Pockets" },
    });
    ebay.fillFacts = [
      {
        name: "Features",
        value: "Roll-Tab Sleeves",
        basis: "visible_feature",
        quote: "",
        photoIds: [1],
        photoIndices: [1],
        confidence: 95,
      },
    ];
    const again = await prepare(edited);
    expect(again.listing.item_specifics?.Features).toBe("Pockets");
    expect(again.listing.key_features).toEqual(["Pockets"]);
  });

  it("a cleared specific stays cleared and keeps its default from coming back", async () => {
    const first = await prepare(analyzed());
    const edited = applyListingEdit(first.listing, {
      item_specifics: {
        ...first.listing.item_specifics,
        "Size Type": "",
        Features: "",
      },
    });
    const again = await prepare(edited);
    expect(again.listing.item_specifics?.["Size Type"]).toBeUndefined();
    expect(again.listing.item_specifics?.Features).toBeUndefined();
    expect(again.listing.defaulted).toEqual(["condition"]);
  });

  it("editing one specific keeps every other specific's photo citation", async () => {
    const first = await prepare(
      analyzed({
        item_specifics: { Neckline: "V-Neck", "Sleeve Length": "Short Sleeve" },
        evidence: { Neckline: [2], "Sleeve Length": [3] },
        estimates: { "Sleeve Length": 80 },
      }),
    );
    const edited = applyListingEdit(first.listing, {
      item_specifics: {
        ...first.listing.item_specifics,
        Neckline: "Crew Neck",
      },
    });
    expect(edited.evidence).toEqual({ "Sleeve Length": [3] });
    expect(edited.estimates).toEqual({ "Sleeve Length": 80 });
    const again = await prepare(edited);
    expect(again.listing.evidence?.["Sleeve Length"]).toEqual([3]);
    expect(again.listing.estimates?.["Sleeve Length"]).toBe(80);
    expect(again.listing.item_specifics?.Neckline).toBe("Crew Neck");
  });
});

describe("publishing after category data changed", () => {
  it("rejects stale specifics instead of rewriting them", async () => {
    const { listing, preparation } = await prepare(
      analyzed({
        item_specifics: { Closure: "Button" },
        evidence: { Closure: [1] },
      }),
    );
    // eBay no longer accepts the reviewed Color value.
    ebay.meta = SHIRT_META.map((a) =>
      a.name === "Color" ? { ...a, values: ["Black"] } : a,
    );
    const writes: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init: RequestInit = {}) => {
        const u = String(url);
        if ((init.method ?? "GET") !== "GET") writes.push(u);
        if (u.includes("/fulfillment_policy"))
          return new Response(
            JSON.stringify({
              fulfillmentPolicies: [
                { fulfillmentPolicyId: "ship", name: "Ship" },
              ],
            }),
          );
        if (u.includes("/payment_policy"))
          return new Response(
            JSON.stringify({ paymentPolicies: [{ paymentPolicyId: "pay" }] }),
          );
        if (u.includes("/return_policy"))
          return new Response(
            JSON.stringify({
              returnPolicies: [
                { returnPolicyId: "ret", returnsAccepted: true },
              ],
            }),
          );
        if (u.includes("/location"))
          return new Response(
            JSON.stringify({
              locations: [
                {
                  merchantLocationKey: "home",
                  merchantLocationStatus: "ENABLED",
                  name: "Home",
                },
              ],
            }),
          );
        throw new Error("Unexpected request " + u);
      }),
    );
    try {
      await expect(
        publishListing("token", {
          sku: "STALE-1",
          listing: { ...listing, suggested_price: 20 },
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
        }),
      ).rejects.toThrow("Choose an allowed value for Color");
      expect(writes).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
