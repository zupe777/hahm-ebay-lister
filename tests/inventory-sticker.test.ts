import { describe, expect, it } from "vitest";
import {
  clearGeneratedSku,
  MISSING_SKU_MESSAGE,
  readInventorySticker,
  skuAfterAnalysis,
  skuNotes,
  stickerWarning,
  UNREADABLE_STICKER_MESSAGE,
} from "@/lib/inventory-sticker";
import { parseCardLines } from "@/lib/seller-card";
import { buildAnalyzedListing } from "@/lib/item-facts";
import { draftIssues } from "@/lib/client-review";
import { ANALYSIS_PROMPT } from "@/lib/prompts";
import type { ItemGroup, ListingResult } from "@/lib/types";

const raw = (over: Record<string, unknown> = {}) => ({
  title: "Mens Shorts",
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
  specifics: [] as unknown[],
  seller_card: { present: false, photoIndices: [], lines: [] },
  attached_tags: { visible: false, photoIndices: [] },
  inventory_sticker: NONE,
  ...over,
});
const NONE = {
  present: false,
  handwritten_white_sticker: false,
  readable: false,
  value: "",
  readings: [],
  photoIndices: [],
  confidence: 0,
};
const sticker = (value: string, over: Record<string, unknown> = {}) => ({
  present: true,
  handwritten_white_sticker: true,
  readable: true,
  value,
  readings: [value],
  photoIndices: [6],
  confidence: 95,
  ...over,
});
const label = (name: string, value: string, quote = value) => ({
  name,
  value,
  basis: "label",
  quote,
  photoIndices: [2],
  confidence: 98,
});
const analyze = (over: Record<string, unknown> = {}) =>
  buildAnalyzedListing(raw(over), 6, "clothing");
const group = (over: Partial<ItemGroup> = {}): ItemGroup => ({
  id: "g1",
  sku: "",
  name: "red-shorts",
  photoIds: ["p1"],
  status: "done",
  ...over,
});
const skuFor = (l: ListingResult, g = group()) => skuAfterAnalysis(g, l);

const card = (...lines: string[]) => ({
  present: true,
  photoIndices: [5],
  lines,
});
const NO_SKU = { sku: "", skuSource: undefined };
const done = (l: ListingResult, over: Partial<ItemGroup> = {}): ItemGroup => ({
  ...group(),
  listing: l,
  ...skuFor(l, { ...group(), ...over }),
  ...(over.publicationAttemptSku
    ? { publicationAttemptSku: over.publicationAttemptSku }
    : {}),
});

describe("SKU (Custom Label) comes only from the seller", () => {
  it("1. a new item starts with a blank SKU", () => {
    expect(group().sku).toBe("");
    expect(skuFor(analyze())).toEqual(NO_SKU);
  });

  it("2. no sticker and a blank card SKU field: SKU stays blank", () => {
    const l = analyze({
      seller_card: card("BRAND: Nike", "Custom Label (SKU):"),
    });
    expect(l.seller_card?.fields["CUSTOM LABEL"]).toBeUndefined();
    expect(skuFor(l)).toEqual(NO_SKU);
  });

  it("3. no sticker and no card: SKU stays blank", () => {
    const l = analyze();
    expect(l.inventory_label).toBeUndefined();
    expect(skuFor(l)).toEqual(NO_SKU);
  });

  it("4. a missing SKU is a needs-attention issue", () => {
    const g = done(analyze());
    expect(draftIssues(g)).toContain(MISSING_SKU_MESSAGE);
    expect(skuNotes(g).blocking).toBe(
      "Custom Label (SKU) is missing. Enter your inventory number before publishing.",
    );
  });

  it("6/7. manual SKUs are kept exactly", () => {
    for (const sku of ["1001", "A-1001"]) {
      const g = group({ sku, skuSource: "seller" });
      expect(
        skuFor(analyze({ inventory_sticker: sticker("1007") }), g),
      ).toEqual({
        sku,
        skuSource: "seller",
      });
      expect(draftIssues({ ...g, listing: analyze() })).not.toContain(
        MISSING_SKU_MESSAGE,
      );
    }
  });

  it("9. a manual clear stays blank on re-analysis", () => {
    const l = analyze({
      seller_card: card("Custom Label (SKU): 1001"),
      inventory_sticker: sticker("1001"),
    });
    const g = group({ sku: "", skuSource: "seller" });
    expect(skuFor(l, g)).toEqual({ sku: "", skuSource: "seller" });
    expect(draftIssues({ ...g, listing: l })).toContain(MISSING_SKU_MESSAGE);
  });

  it("10/11. the card Custom Label (SKU) field supplies the SKU exactly", () => {
    for (const v of ["1001", "A-1001"]) {
      const l = analyze({ seller_card: card(`Custom Label (SKU): ${v}`) });
      expect(skuFor(l)).toEqual({ sku: v, skuSource: "card" });
      // Never an item specific.
      expect(Object.values(l.item_specifics ?? {})).not.toContain(v);
    }
    // Spacing and case of the field name do not matter.
    expect(
      parseCardLines(["custom label (sku) :  B-52 "])?.fields["CUSTOM LABEL"],
    ).toBe("B-52");
  });

  it("12. a blank card Custom Label field creates no SKU and never absorbs the next line", () => {
    const parsed = parseCardLines([
      "Custom Label (SKU):",
      "Thank you for shopping",
      "BRAND: Nike",
    ]);
    expect(parsed?.fields["CUSTOM LABEL"]).toBeUndefined();
    const l = analyze({
      seller_card: card("Custom Label (SKU):", "BRAND: Nike"),
    });
    expect(skuFor(l)).toEqual(NO_SKU);
  });

  it("13. other numbers on the card never become the SKU", () => {
    const l = analyze({
      seller_card: card(
        "MPN: 1009",
        "NOTES: bin 1009",
        "SIZE: 32",
        "BRAND: Nike",
      ),
    });
    expect(skuFor(l)).toEqual(NO_SKU);
    expect(l.item_specifics?.MPN).toBe("1009");
  });

  it("14/15. a confident sticker supplies the SKU when manual and card SKUs are absent", () => {
    for (const v of ["1001", "A-1001", "A-1C", "B-52"]) {
      const l = analyze({ inventory_sticker: sticker(v) });
      expect(l.inventory_label).toMatchObject({ status: "read", value: v });
      expect(skuFor(l)).toEqual({ sku: v, skuSource: "sticker" });
    }
    const spaced = analyze({
      inventory_sticker: sticker("  B-52 ", { readings: [" B-52"] }),
    });
    expect(skuFor(spaced).sku).toBe("B-52");
    // A blank card field does not block the sticker.
    const blankCard = analyze({
      seller_card: card("Custom Label (SKU):", "BRAND: Nike"),
      inventory_sticker: sticker("1001"),
    });
    expect(skuFor(blankCard)).toEqual({ sku: "1001", skuSource: "sticker" });
  });

  it("16/17. the card SKU beats the sticker, and a disagreement is shown", () => {
    const l = analyze({
      seller_card: card("Custom Label (SKU): 1001"),
      inventory_sticker: sticker("1007"),
    });
    expect(l.inventory_label).toMatchObject({ status: "read", value: "1007" });
    const g = done(l);
    expect(g).toMatchObject({ sku: "1001", skuSource: "card" });
    expect(skuNotes(g).notice).toBe(
      "Seller card Custom Label (SKU) is 1001; the inventory sticker reads 1007. The card value is used; check which is correct.",
    );
    // Non-blocking.
    expect(draftIssues(g).join(" ")).not.toContain("inventory sticker reads");
    // When they agree there is nothing to show.
    const agree = analyze({
      seller_card: card("Custom Label (SKU): 1001"),
      inventory_sticker: sticker("1001"),
    });
    expect(agree.inventory_label?.status).toBe("read");
    expect(skuNotes(done(agree)).notice).toBe("");
  });

  it("18. a manual SKU beats both card and sticker, and hides their disagreement", () => {
    const l = analyze({
      seller_card: card("Custom Label (SKU): 1001"),
      inventory_sticker: sticker("1007"),
    });
    const g = { ...group({ sku: "A-1013", skuSource: "seller" }), listing: l };
    expect(skuFor(l, g)).toEqual({ sku: "A-1013", skuSource: "seller" });
    expect(skuNotes(g).notice).toBe("");
  });

  it("19. an unreadable sticker leaves the SKU blank with a warning", () => {
    for (const s of [
      sticker("1001", { confidence: 60 }),
      sticker("10?1", { readable: false }),
      sticker("", { readable: false, readings: [] }),
    ]) {
      const l = analyze({ inventory_sticker: s });
      expect(l.inventory_label?.status).toBe("unreadable");
      expect(skuFor(l)).toEqual(NO_SKU);
      expect(draftIssues(done(l))).toContain(
        "Inventory sticker detected but Custom Label could not be read confidently. Enter the Custom Label before publishing.",
      );
    }
    expect(stickerWarning({ status: "unreadable", photoIndices: [1] })).toBe(
      UNREADABLE_STICKER_MESSAGE,
    );
  });

  it("20. conflicting sticker readings leave the SKU blank and show both", () => {
    const l = analyze({
      inventory_sticker: sticker("1001", { readings: ["1001", "1007"] }),
    });
    expect(l.inventory_label).toMatchObject({
      status: "conflict",
      readings: ["1001", "1007"],
    });
    expect(skuFor(l)).toEqual(NO_SKU);
    expect(draftIssues(done(l))).toContain(
      "Inventory stickers disagree (1001, 1007). Enter the correct Custom Label.",
    );
  });

  it("22. re-analysis never generates a SKU; earlier card/sticker values are re-evaluated", () => {
    const fromSticker = group({ sku: "1001", skuSource: "sticker" });
    expect(skuFor(analyze(), fromSticker)).toEqual(NO_SKU);
  });

  it("a SKU already used for a publication attempt is never changed", () => {
    const l = analyze({ inventory_sticker: sticker("1001") });
    const g = group({ sku: "OLD-1", publicationAttemptSku: "OLD-1" });
    expect(skuFor(l, g).sku).toBe("OLD-1");
  });

  it("SKUs generated by older versions are cleared when a draft is restored", () => {
    expect(clearGeneratedSku(group({ sku: "A-B-52aa11bb22cc" })).sku).toBe("");
    expect(clearGeneratedSku(group({ sku: "B-0f1e2d3c4b5a" })).sku).toBe("");
    // Seller, card and sticker values and published SKUs are kept.
    expect(clearGeneratedSku(group({ sku: "1001" })).sku).toBe("1001");
    expect(
      clearGeneratedSku(group({ sku: "A-B-52aa11bb22cc", skuSource: "seller" }))
        .sku,
    ).toBe("A-B-52aa11bb22cc");
    expect(
      clearGeneratedSku(
        group({
          sku: "A-B-52aa11bb22cc",
          publicationAttemptSku: "A-B-52aa11bb22cc",
        }),
      ).sku,
    ).toBe("A-B-52aa11bb22cc");
  });
});

describe("inventory sticker safeguards", () => {
  it("a clothing size tag L is never the SKU", () => {
    const l = analyze({ specifics: [label("Size", "L", "L")] });
    expect(l.inventory_label).toBeUndefined();
    expect(skuFor(l)).toEqual(NO_SKU);
    const mis = analyze({ inventory_sticker: sticker("L") });
    expect(mis.inventory_label?.status).toBe("unreadable");
    expect(skuFor(mis).sku).toBe("");
  });

  it("a UPC or barcode number is never the SKU", () => {
    expect(
      analyze({ specifics: [label("UPC", "012345678905")] }).inventory_label,
    ).toBeUndefined();
    expect(
      analyze({ inventory_sticker: sticker("012345678905") }).inventory_label
        ?.status,
    ).toBe("unreadable");
  });

  it("style, RN and model numbers are never the SKU", () => {
    for (const [fact, value] of [
      [label("Style Code", "DD8959-100", "STYLE DD8959-100"), "DD8959-100"],
      [label("Brand", "Nike", "NIKE RN 56323"), "56323"],
      [label("Model", "574", "574"), "574"],
    ] as const)
      expect(
        analyze({ specifics: [fact], inventory_sticker: sticker(value) })
          .inventory_label?.status,
      ).toBe("unreadable");
  });

  it("ruler numbers are never the SKU", () => {
    expect(
      analyze({
        inventory_sticker: sticker("12", { handwritten_white_sticker: false }),
      }).inventory_label,
    ).toBeUndefined();
    for (const v of ["12.5", '32"', "14 in"])
      expect(
        analyze({ inventory_sticker: sticker(v) }).inventory_label?.status,
      ).toBe("unreadable");
  });

  it("a sticker matching other card text is rejected; one matching the card SKU is not", () => {
    const other = analyze({
      seller_card: card("MPN: 1009"),
      inventory_sticker: sticker("1009", { photoIndices: [5] }),
    });
    expect(other.inventory_label?.status).toBe("unreadable");
    const sameSku = analyze({
      seller_card: card("Custom Label (SKU): 1009"),
      inventory_sticker: sticker("1009"),
    });
    expect(sameSku.inventory_label?.status).toBe("read");
  });

  it("the sticker number never becomes an item specific", () => {
    const l = analyze({
      inventory_sticker: sticker("1001"),
      specifics: [label("Inventory Number", "1001"), label("SKU", "1001")],
    });
    expect(l.item_specifics).toEqual({});
    expect(l.inventory_label?.value).toBe("1001");
  });

  it("the analysis prompt describes the sticker and the card field", () => {
    expect(ANALYSIS_PROMPT).toContain("INVENTORY STICKER");
    expect(ANALYSIS_PROMPT).toContain("Custom Label (SKU)");
    for (const word of [
      "size tags",
      "UPCs",
      "RN numbers",
      "rulers",
      "seller information card",
    ])
      expect(ANALYSIS_PROMPT).toContain(word);
  });

  it("rejects malformed reports", () => {
    expect(readInventorySticker(undefined, 4)).toBeUndefined();
    expect(readInventorySticker({ present: true }, 4)).toBeUndefined();
    expect(
      readInventorySticker(sticker("1001", { photoIndices: [9] }), 4)?.status,
    ).toBe("unreadable");
  });
});
