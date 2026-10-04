import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AspectMeta, CategorySuggestion } from "@/lib/ebay/taxonomy";
import type { ListingResult, PreparedCategory } from "@/lib/types";

// The real preparation pipeline with eBay data and the second AI pass mocked.
const ebay = vi.hoisted(() => ({
  meta: [] as AspectMeta[],
  conditions: new Set<number>([1000, 1500, 1750, 2990, 3000, 3010]),
  fillFacts: [] as unknown[],
  prompt: "",
}));
vi.mock("@/lib/ebay/taxonomy", () => ({
  suggestLeafCategories: async (): Promise<CategorySuggestion[]> => [
    {
      id: "57990",
      name: "Casual Shirts",
      path: "Clothing > Men > Men's Shirts > Casual Shirts",
    },
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
  measuredMessage: async (_k: string, _c: unknown, req: any) => {
    ebay.prompt = req.messages[0].content.at(-1).text;
    return {
      content: [
        { type: "text", text: JSON.stringify({ facts: ebay.fillFacts }) },
      ],
    };
  },
}));

import { prepareListing } from "@/lib/services/prepare";
import { buildAnalyzedListing } from "@/lib/item-facts";
import { applyListingEdit } from "@/lib/seller-edits";
import { factSource } from "@/lib/provenance";

const aspect = (name: string, extra: Partial<AspectMeta> = {}): AspectMeta => ({
  name,
  required: false,
  usage: "RECOMMENDED",
  mode: "FREE_TEXT",
  cardinality: "SINGLE",
  values: [],
  ...extra,
});
const META: AspectMeta[] = [
  aspect("Brand", { required: true, usage: "REQUIRED" }),
  aspect("Size", { required: true, usage: "REQUIRED" }),
  aspect("Color", { cardinality: "MULTI" }),
  aspect("Material", { cardinality: "MULTI" }),
  aspect("Features", { cardinality: "MULTI" }),
  aspect("Product Line"),
  aspect("Pattern"),
  aspect("Sleeve Length"),
  aspect("Upper Material"),
  aspect("Department", { mode: "SELECTION_ONLY", values: ["Men", "Women"] }),
];

const analyzed = (over: Record<string, unknown> = {}) =>
  buildAnalyzedListing(
    {
      title: "Mens Shirt",
      description:
        "Soft blue shirt that feels luxurious. Unverified marketing sentence.",
      category: "mens_top",
      category_hint: "mens casual shirt",
      brand: "",
      item_type: "Button Down Shirt",
      color: ["Blue"],
      size: "",
      material: "",
      condition: "VERY_GOOD",
      condition_notes: "",
      measurements: "",
      suggested_price: 20,
      search_terms: [],
      seo_keywords: [],
      key_features: ["Ultra comfortable everyday wear"],
      specifics: [
        {
          name: "Pattern",
          value: "Striped",
          basis: "estimate",
          quote: "",
          photoIndices: [1],
          confidence: 70,
        },
      ],
      seller_card: {
        present: true,
        photoIndices: [2],
        lines: [
          "BRAND: Patagonia",
          "SIZE: L",
          "FEATURES: Pockets",
          "FLAW: 1-inch tear under right arm",
        ],
      },
      attached_tags: { visible: false, photoIndices: [] },
      ...over,
    },
    2,
  );
const images = [{ mediaType: "image/jpeg", data: "aGVsbG8=" }];
async function prepare(listing: ListingResult) {
  const res = await prepareListing({ listing, images, enrich: true }, "sealed");
  const body = await res.json();
  if (!body.ok) throw new Error(body.error);
  return body as { listing: ListingResult; preparation: PreparedCategory };
}

beforeEach(() => {
  vi.stubEnv("APP_SECRET", "unit-test-secret");
  ebay.meta = META;
  ebay.fillFacts = [];
  ebay.prompt = "";
});
afterEach(() => vi.unstubAllEnvs());

describe("seller card through preparation", () => {
  it("keeps card provenance and values through repeated preparation", async () => {
    const first = await prepare(analyzed());
    expect(first.listing.item_specifics?.Brand).toBe("Patagonia");
    expect(first.listing.item_specifics?.Size).toBe("L");
    expect(first.listing.item_specifics?.Features).toBe("Pockets");
    expect(factSource(first.listing, "Brand")).toBe("card");
    const again = await prepare(first.listing);
    expect(again.listing.item_specifics?.Features).toBe("Pockets");
    expect(factSource(again.listing, "Features")).toBe("card");
    expect(again.listing.seller_card?.fields.FLAW).toBe(
      "1-inch tear under right arm",
    );
  });

  it("FLAW gives Pre-owned Good, labeled as such and as a default", async () => {
    const { listing, preparation } = await prepare(analyzed());
    expect(listing.ebay_condition).toBe("USED_EXCELLENT");
    expect(
      preparation.conditions.find((c) => c.value === listing.ebay_condition)
        ?.label,
    ).toBe("Pre-owned Good (3000)");
    expect(listing.description).toContain("Flaw: 1-inch tear under right arm.");
  });
});

describe("second AI pass", () => {
  it("does not read the first-pass description, key features or estimates", async () => {
    await prepare(analyzed());
    expect(ebay.prompt).toContain("Patagonia");
    expect(ebay.prompt).not.toContain("Unverified marketing sentence");
    expect(ebay.prompt).not.toContain("feels luxurious");
    expect(ebay.prompt).not.toContain("Ultra comfortable");
    expect(ebay.prompt).not.toContain("Striped");
    expect(ebay.prompt).not.toContain("1-inch tear");
    expect(ebay.prompt).not.toMatch(/even below 60/);
  });

  it("never overwrites seller or card values and fills only gaps", async () => {
    const base = await prepare(analyzed());
    const edited = applyListingEdit(base.listing, {
      item_specifics: {
        ...base.listing.item_specifics,
        "Sleeve Length": "Short Sleeve",
      },
    });
    ebay.fillFacts = [
      {
        name: "Brand",
        value: "Columbia",
        basis: "label",
        quote: "Columbia",
        photoIndices: [1],
        confidence: 99,
      },
      {
        name: "Features",
        value: "Hooded",
        basis: "visible_feature",
        quote: "",
        photoIndices: [1],
        confidence: 90,
      },
      {
        name: "Sleeve Length",
        value: "Long Sleeve",
        basis: "visible_feature",
        quote: "",
        photoIndices: [1],
        confidence: 95,
      },
      {
        name: "Upper Material",
        value: "Leather",
        basis: "estimate",
        quote: "",
        photoIndices: [1],
        confidence: 30,
      },
      {
        name: "Product Line",
        value: "Better Sweater",
        basis: "label",
        quote: "BETTER SWEATER",
        photoIndices: [1],
        confidence: 99,
      },
    ];
    const { listing } = await prepareListing(
      { listing: edited, images, enrich: true },
      "sealed",
    ).then((r) => r.json());
    expect(listing.item_specifics.Brand).toBe("Patagonia");
    expect(listing.item_specifics.Features).toBe("Pockets");
    expect(listing.item_specifics["Sleeve Length"]).toBe("Short Sleeve");
    expect(listing.item_specifics["Upper Material"]).toBeUndefined();
    expect(listing.item_specifics["Product Line"]).toBe("Better Sweater");
    expect(factSource(listing, "Product Line")).toBe("label");
  });
});

describe("custom specifics in preparation", () => {
  it("reports AI-only custom specifics it removes", async () => {
    const l = analyzed({
      specifics: [
        {
          name: "Hood Style",
          value: "Drawstring",
          basis: "visible_feature",
          quote: "",
          photoIndices: [1],
          confidence: 80,
        },
        {
          name: "Vibe",
          value: "Outdoorsy",
          basis: "estimate",
          quote: "",
          photoIndices: [1],
          confidence: 80,
        },
      ],
    });
    const { listing, preparation } = await prepare(l);
    expect(listing.item_specifics?.["Hood Style"]).toBe("Drawstring");
    expect(listing.item_specifics?.Vibe).toBeUndefined();
    expect(preparation.removed).toContainEqual({
      name: "Vibe",
      value: "Outdoorsy",
      reason: "Custom specific without seller, label or strong photo support",
    });
  });
});

describe("conflicts through preparation", () => {
  it("are kept, not erased, and a manual edit resolves them", async () => {
    const l = analyzed({
      specifics: [
        {
          name: "Size",
          value: "M",
          basis: "label",
          quote: "M",
          photoIndices: [1],
          confidence: 99,
        },
      ],
    });
    const { listing } = await prepare(l);
    expect(listing.item_specifics?.Size).toBe("L");
    expect(listing.conflicts).toEqual([
      expect.objectContaining({ name: "Size", kept: "L", other: "M" }),
    ]);
    const fixed = applyListingEdit(listing, {
      item_specifics: { ...listing.item_specifics, Size: "M" },
    });
    expect(fixed.conflicts).toEqual([]);
    const again = await prepare(fixed);
    expect(again.listing.item_specifics?.Size).toBe("M");
    expect(again.listing.conflicts).toEqual([]);
  });
});

describe("seller and card sizes against eBay's allowed values", () => {
  const withSizes = (values: string[]) =>
    META.map((a) =>
      a.name === "Size" ? { ...a, mode: "SELECTION_ONLY" as const, values } : a,
    );
  const carded = (size: string) =>
    analyzed({
      seller_card: {
        present: true,
        photoIndices: [2],
        lines: [`SIZE: ${size}`],
      },
    });

  it("normalizes a card Large to L and keeps seller-card provenance", async () => {
    ebay.meta = withSizes(["S", "M", "L", "XL"]);
    const { listing, preparation } = await prepare(carded("Large"));
    expect(listing.item_specifics?.Size).toBe("L");
    expect(factSource(listing, "Size")).toBe("card");
    expect(listing.seller_card?.fields.SIZE).toBe("Large");
    // (This test category has no Type aspect, so only Size is checked.)
    expect(
      (preparation.removed ?? []).filter((r) => r.name === "Size"),
    ).toEqual([]);
    expect(preparation.issues.join(" ")).not.toMatch(/Size/);
    // Repeat preparation keeps the same value and source.
    const again = await prepare(listing);
    expect(again.listing.item_specifics?.Size).toBe("L");
    expect(factSource(again.listing, "Size")).toBe("card");
  });

  it("normalizes a seller-reviewed size the same way", async () => {
    ebay.meta = withSizes(["S", "M", "L", "XL"]);
    const base = await prepare(analyzed({ seller_card: undefined }));
    const edited = applyListingEdit(base.listing, {
      item_specifics: { ...base.listing.item_specifics, Size: "X-Large" },
    });
    const { listing } = await prepare(edited);
    expect(listing.item_specifics?.Size).toBe("XL");
    expect(factSource(listing, "Size")).toBe("seller");
  });

  it("surfaces an ambiguous equivalent instead of guessing", async () => {
    ebay.meta = withSizes(["L", "XL", "XXL", "2XL"]);
    const { listing, preparation } = await prepare(carded("Extra Extra Large"));
    expect(listing.item_specifics?.Size).toBeUndefined();
    expect(preparation.removed?.filter((r) => r.name === "Size")).toEqual([
      {
        name: "Size",
        value: "Extra Extra Large",
        reason: "Matches more than one eBay size (XXL, 2XL); choose one",
      },
    ]);
    expect(preparation.issues.join(" ")).toMatch(/Size/);
  });

  it("does not convert numeric or qualified sizes", async () => {
    ebay.meta = withSizes(["S", "M", "L", "XL"]);
    for (const size of ["8", "Youth L", "Tall L"]) {
      const { listing, preparation } = await prepare(carded(size));
      expect(listing.item_specifics?.Size).toBeUndefined();
      expect(preparation.removed).toContainEqual({
        name: "Size",
        value: size,
        reason: "Not accepted by eBay for this category",
      });
    }
  });

  it("leaves AI label sizes to the existing rules", async () => {
    ebay.meta = withSizes(["S", "M", "L", "XL"]);
    const l = analyzed({
      seller_card: undefined,
      specifics: [
        {
          name: "Size",
          value: "Large",
          basis: "label",
          quote: "LARGE",
          photoIndices: [1],
          confidence: 99,
        },
      ],
    });
    const { listing } = await prepare(l);
    expect(listing.item_specifics?.Size).toBeUndefined();
  });
});

describe("blank card fields vs an intentional manual clear", () => {
  const blankCard = {
    present: true,
    photoIndices: [2],
    lines: ["BRAND:", "SIZE:", "MATERIAL:", "STYLE: Pullover"],
  };
  const labelFacts = [
    {
      name: "Brand",
      value: "Ralph Lauren",
      basis: "label",
      quote: "RALPH LAUREN",
      photoIndices: [1],
      confidence: 99,
    },
    {
      name: "Size",
      value: "Large",
      basis: "label",
      quote: "LARGE",
      photoIndices: [1],
      confidence: 99,
    },
  ];

  it("blank card fields are filled from labels and the second pass", async () => {
    ebay.fillFacts = [
      {
        name: "Sleeve Length",
        value: "Long Sleeve",
        basis: "visible_feature",
        quote: "",
        photoIndices: [1],
        confidence: 90,
      },
      {
        name: "Material",
        value: "Cotton",
        basis: "estimate",
        quote: "",
        photoIndices: [1],
        confidence: 80,
      },
    ];
    const { listing } = await prepare(
      analyzed({ seller_card: blankCard, specifics: labelFacts }),
    );
    expect(listing.item_specifics?.Brand).toBe("Ralph Lauren");
    expect(factSource(listing, "Brand")).toBe("label");
    expect(listing.item_specifics?.Size).toBe("Large");
    expect(listing.item_specifics?.Material).toBe("Cotton");
    expect(factSource(listing, "Material")).toBe("estimate");
    expect(listing.item_specifics?.["Sleeve Length"]).toBe("Long Sleeve");
    expect(listing.card_specifics).toEqual(["Style"]);
  });

  it("15. a manual UI clear stays blank after re-preparation", async () => {
    ebay.fillFacts = [
      {
        name: "Material",
        value: "Cotton",
        basis: "estimate",
        quote: "",
        photoIndices: [1],
        confidence: 85,
      },
    ];
    const first = await prepare(
      analyzed({ seller_card: blankCard, specifics: labelFacts }),
    );
    expect(first.listing.item_specifics?.Brand).toBe("Ralph Lauren");
    expect(first.listing.item_specifics?.Material).toBe("Cotton");
    const cleared = applyListingEdit(first.listing, {
      item_specifics: {
        ...first.listing.item_specifics,
        Brand: "",
        Material: "",
      },
    });
    expect(cleared.seller_specifics).toEqual(
      expect.arrayContaining(["Brand", "Material"]),
    );
    // The second pass offers values for both; neither is used.
    ebay.fillFacts = [
      {
        name: "Brand",
        value: "Ralph Lauren",
        basis: "label",
        quote: "RALPH LAUREN",
        photoIndices: [1],
        confidence: 99,
      },
      {
        name: "Material",
        value: "Cotton",
        basis: "estimate",
        quote: "",
        photoIndices: [1],
        confidence: 85,
      },
    ];
    const again = await prepare(cleared);
    expect(again.listing.item_specifics?.Brand).toBeUndefined();
    expect(again.listing.item_specifics?.Material).toBeUndefined();
    expect(again.listing.brand).toBe("");
    expect(factSource(again.listing, "Brand")).toBe("seller");
    expect(ebay.prompt).not.toContain('"Brand"');
  });
});
