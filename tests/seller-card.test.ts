import { describe, expect, it } from "vitest";
import {
  CARD_FIELDS,
  cardSpecifics,
  parseCardLines,
  readSellerCard,
} from "@/lib/seller-card";
import {
  buildAnalyzedListing,
  gateCustomSpecifics,
  sameFact,
} from "@/lib/item-facts";
import { applyListingDefaults } from "@/lib/listing-defaults";
import { applyListingEdit, confirmSpecific } from "@/lib/seller-edits";
import {
  applyResearchedFacts,
  canonicalizeProvenance,
  conflictMessage,
  factSource,
} from "@/lib/provenance";
import { acceptedPhotoFact, isPromotionalClaim } from "@/lib/photo-facts";
import { isLetterSizeAspect, letterSizeMatch } from "@/lib/ebay/aspects";
import { buildAspects } from "@/lib/ebay/publish";
import { mpnBrand } from "@/lib/ebay/identifiers";
import { buildClothingTitle } from "@/lib/clothingTitle";
import { draftIssues } from "@/lib/client-review";
import { ANALYSIS_PROMPT } from "@/lib/prompts";
import type { ItemGroup, ListingResult } from "@/lib/types";

// Analysis model output as the structured-output schema returns it.
const raw = (over: Record<string, unknown> = {}) => ({
  title: "Mens Button Down Shirt",
  description: "Blue button down shirt.",
  category: "mens_top",
  category_hint: "mens casual shirt",
  brand: "",
  item_type: "Button Down Shirt",
  color: ["Blue"],
  size: "",
  material: "",
  condition: "EXCELLENT",
  condition_notes: "",
  measurements: "",
  suggested_price: 20,
  search_terms: [],
  seo_keywords: [],
  key_features: [],
  specifics: [] as unknown[],
  seller_card: { present: false, photoIndices: [], lines: [] },
  attached_tags: { visible: false, photoIndices: [] },
  ...over,
});
const label = (name: string, value: string, quote = value, photo = 1) => ({
  name,
  value,
  basis: "label",
  quote,
  photoIndices: [photo],
  confidence: 98,
});
const guess = (
  name: string,
  value: string,
  confidence: number,
  basis = "estimate",
) => ({ name, value, basis, quote: "", photoIndices: [2], confidence });
const card = (...lines: string[]) => ({
  present: true,
  photoIndices: [4],
  lines,
});
const analyze = (over: Record<string, unknown> = {}) =>
  buildAnalyzedListing(raw(over), 4);

const ALL_FIELDS = [
  "BRAND: Patagonia",
  "NEW: NO",
  "FLAW: Small hole near hem",
  "CONDITION: Good",
  "MATERIAL: Polyester",
  "SIZE: Large",
  "COLOR: Gray / Navy",
  "FEATURES: Pockets, Hooded",
  "STYLE: Pullover",
  "PRODUCT LINE: Better Sweater",
  "MODEL: Snap-T",
  "MPN: 25528",
  "NOTES: Color looks slightly darker in person",
  "Custom Label (SKU): A-1001",
];

describe("seller card recognition", () => {
  it("recognizes every supported field", () => {
    const parsed = parseCardLines(ALL_FIELDS)!;
    expect(Object.keys(parsed.fields).sort()).toEqual(
      Object.keys(CARD_FIELDS).sort(),
    );
    expect(parsed.fields.FLAW).toBe("Small hole near hem");
    expect(cardSpecifics({ photoIndices: [], fields: parsed.fields })).toEqual({
      Brand: "Patagonia",
      Material: "Polyester",
      Size: "Large",
      Color: "Gray | Navy",
      Features: "Pockets | Hooded",
      Style: "Pullover",
      "Product Line": "Better Sweater",
      Model: "Snap-T",
      MPN: "25528",
    });
  });

  it("reads field names case-insensitively", () => {
    const parsed = parseCardLines([
      "brand: Nike",
      "Product line : Air Max",
      "product_line: ignored duplicate",
      "Mpn: DD8959-100",
      "flaw:   Stain on cuff",
    ])!;
    expect(parsed.fields.BRAND).toBe("Nike");
    expect(parsed.fields["PRODUCT LINE"]).toBe("Air Max ignored duplicate");
    expect(parsed.fields.MPN).toBe("DD8959-100");
    expect(parsed.fields.FLAW).toBe("Stain on cuff");
  });

  it("keeps a wrapped flaw line and unknown fields for review only", () => {
    const parsed = parseCardLines([
      "FLAW: 1-inch tear under",
      "right arm",
      "ERA: 1990s",
    ])!;
    expect(parsed.fields.FLAW).toBe("1-inch tear under right arm");
    expect(parsed.other).toEqual({ ERA: "1990s" });
    const l = analyze({ seller_card: card("BRAND: Nike", "ERA: 1990s") });
    expect(l.item_specifics?.ERA).toBeUndefined();
    expect(l.seller_card?.other).toEqual({ ERA: "1990s" });
  });

  it("does not mistake an ordinary label for a card", () => {
    expect(
      parseCardLines(["RN 54023", "Made in USA", "Care: Machine wash cold"]),
    ).toBeNull();
    // The model must flag a card; label-looking lines alone are not one.
    expect(
      readSellerCard(
        { present: false, photoIndices: [1], lines: ["SIZE: M"] },
        4,
      ),
    ).toBeUndefined();
    const l = analyze({
      brand: "Nike",
      specifics: [label("Brand", "Nike", "NIKE"), label("Size", "M", "SIZE M")],
    });
    expect(l.seller_card).toBeUndefined();
    expect(factSource(l, "Brand")).toBe("label");
    expect(factSource(l, "Size")).toBe("label");
  });

  it("never turns card text into label evidence", () => {
    const l = analyze({
      seller_card: card("BRAND: Patagonia"),
      specifics: [label("Brand", "Patagonia", "BRAND: Patagonia", 4)],
    });
    expect(l.evidence?.Brand).toBeUndefined();
    expect(factSource(l, "Brand")).toBe("card");
    expect(l.item_specifics?.Brand).toBe("Patagonia");
    expect(l.brand).toBe("Patagonia");
    expect(l.conflicts).toBeUndefined();
  });

  it("a manual edit overrides the card value", () => {
    const l = analyze({ seller_card: card("BRAND: Patagonia", "SIZE: L") });
    const edited = applyListingEdit(l, {
      item_specifics: { ...l.item_specifics, Brand: "Columbia" },
    });
    expect(edited.item_specifics?.Brand).toBe("Columbia");
    expect(edited.brand).toBe("Columbia");
    expect(factSource(edited, "Brand")).toBe("seller");
    expect(factSource(edited, "Size")).toBe("card");
    const aspects = buildAspects(edited, "mens_top");
    expect(aspects.Brand).toEqual(["Columbia"]);
  });

  it("follows renamed specifics", () => {
    const l = analyze({ seller_card: card("PRODUCT LINE: Synchilla") });
    l.item_specifics = { "product line": "Synchilla" };
    l.card_specifics = ["product line"];
    canonicalizeProvenance(l, ["Product Line"]);
    expect(l.card_specifics).toEqual(["Product Line"]);
  });
});

describe("Brand", () => {
  it("accepts readable label or printed branding", () => {
    const l = analyze({
      brand: "Nike",
      specifics: [label("Brand", "Nike", "NIKE")],
    });
    expect(l.brand).toBe("Nike");
    expect(l.estimates?.Brand).toBeUndefined();
  });

  it("accepts the seller card", () => {
    const l = analyze({ seller_card: card("BRAND: Patagonia") });
    expect(l.brand).toBe("Patagonia");
    expect(l.card_specifics).toContain("Brand");
  });

  it("accepts unmistakable visual branding at 90% only as an estimate", () => {
    const l = analyze({
      brand: "Nike",
      specifics: [guess("Brand", "Nike", 92)],
    });
    expect(l.brand).toBe("Nike");
    expect(l.estimates?.Brand).toBe(92);
    expect(factSource(l, "Brand")).toBe("estimate");
  });

  it("rejects lower-confidence visual brands and leaves Brand blank", () => {
    const l = analyze({
      brand: "Nike",
      specifics: [guess("Brand", "Nike", 85)],
    });
    expect(l.brand).toBe("");
    expect(l.item_specifics?.Brand).toBeUndefined();
  });

  it("style resemblance alone does not establish Brand", () => {
    // A top-level brand with no supporting fact is unchecked and cleared.
    expect(analyze({ brand: "Patagonia" }).brand).toBe("");
    const visible = analyze({
      brand: "Patagonia",
      specifics: [guess("Brand", "Patagonia", 75, "visible_feature")],
    });
    expect(visible.brand).toBe("");
  });
});

describe("Material", () => {
  it("a label reading beats the unchecked analysis field", () => {
    const l = analyze({
      material: "Polyester",
      specifics: [label("Material", "100% Cotton", "100% COTTON")],
    });
    expect(l.material).toBe("100% Cotton");
    expect(factSource(l, "Material")).toBe("label");
  });

  it("the seller card wins over a label and the label stays visible", () => {
    const l = analyze({
      seller_card: card("MATERIAL: Wool"),
      specifics: [label("Material", "100% Cotton", "100% COTTON")],
    });
    expect(l.material).toBe("Wool");
    expect(factSource(l, "Material")).toBe("card");
    expect(l.conflicts).toEqual([
      expect.objectContaining({
        name: "Material",
        kept: "Wool",
        other: "100% Cotton",
      }),
    ]);
  });

  it("never invents fiber percentages", () => {
    expect(acceptedPhotoFact(guess("Material", "100% Cotton", 90), 4)).toBe(
      false,
    );
    const l = analyze({
      material: "100% Cotton",
      specifics: [guess("Material", "100% Cotton", 90)],
    });
    expect(l.material).toBe("");
    expect(l.item_specifics?.Material).toBeUndefined();
    const est = analyze({ specifics: [guess("Material", "Cotton", 80)] });
    expect(est.material).toBe("Cotton");
    expect(factSource(est, "Material")).toBe("estimate");
  });

  it("research is represented as research, never as a label", () => {
    const l = analyze({ specifics: [guess("Material", "Cotton", 70)] });
    applyResearchedFacts(l, [
      {
        name: "Material",
        value: "100% Organic Cotton",
        source: "Exact product page",
      },
    ]);
    expect(l.item_specifics?.Material).toBe("100% Organic Cotton");
    expect(factSource(l, "Material")).toBe("researched");
    expect(l.evidence?.Material).toBeUndefined();
    expect(l.estimates?.Material).toBeUndefined();
    // Research never replaces a label; the disagreement is surfaced.
    const labeled = analyze({
      specifics: [label("Material", "100% Cotton", "100% COTTON")],
    });
    applyResearchedFacts(labeled, [
      { name: "Material", value: "Cotton Blend", source: "Similar listing" },
    ]);
    expect(labeled.item_specifics?.Material).toBe("100% Cotton");
    expect(labeled.conflicts?.[0]).toMatchObject({
      keptSource: "the label",
      otherSource: "research",
    });
  });
});

describe("Features", () => {
  it("accepts obvious visible features", () => {
    const l = analyze({
      specifics: [guess("Features", "Pockets | Hooded", 85, "visible_feature")],
    });
    expect(l.item_specifics?.Features).toBe("Pockets | Hooded");
    expect(factSource(l, "Features")).toBe("visible");
  });

  it("rejects subjective marketing phrases", () => {
    for (const v of [
      "Super Soft",
      "Luxurious",
      "Premium Quality",
      "Amazing fit",
      "High Performance",
    ])
      expect(
        acceptedPhotoFact(guess("Features", v, 95, "visible_feature"), 4),
      ).toBe(false);
    // Printed manufacturer terminology may stand.
    expect(acceptedPhotoFact(label("Features", "Premium", "PREMIUM"), 4)).toBe(
      true,
    );
    const l = analyze({ key_features: ["Luxurious feel", "Pockets"] });
    expect(buildAspects(l, "mens_top").Features).toEqual(["Pockets"]);
  });

  it("seller card features outrank AI features", () => {
    const l = analyze({
      key_features: ["Drawstring"],
      seller_card: card("FEATURES: Pockets, Zip Pockets"),
      specifics: [guess("Features", "Drawstring", 80, "visible_feature")],
    });
    expect(buildAspects(l, "mens_top").Features).toEqual([
      "Pockets",
      "Zip Pockets",
    ]);
    expect(l.key_features).toEqual(["Pockets", "Zip Pockets"]);
  });
});

describe("Upper Material", () => {
  it("a low-confidence guess is no longer accepted or requested", () => {
    expect(acceptedPhotoFact(guess("Upper Material", "Leather", 30), 4)).toBe(
      false,
    );
    expect(acceptedPhotoFact(guess("Upper Material", "Leather", 70), 4)).toBe(
      true,
    );
    expect(ANALYSIS_PROMPT).not.toMatch(/always include your best guess/i);
  });
});

describe("Custom specifics", () => {
  const l = analyze({
    seller_card: card("STYLE: Quarter Zip"),
    specifics: [
      label("Lining", "Fleece", "FLEECE LINED"),
      guess("Hood Style", "Drawstring Hood", 80, "visible_feature"),
      guess("Pocket Count", "2", 60, "visible_feature"),
      guess("Era", "1990s look", 85),
      guess("Feel", "Soft", 90, "visible_feature"),
    ],
  });
  l.seller_specifics = ["My Note"];
  const aspects: Record<string, string[]> = {
    Style: ["Quarter Zip"],
    Lining: ["Fleece"],
    "Hood Style": ["Drawstring Hood"],
    "Pocket Count": ["2"],
    Era: ["1990s look"],
    Feel: ["Comfortable"],
    "My Note": ["Kept"],
  };
  gateCustomSpecifics(aspects, [{ name: "Brand" }], l);
  it("keeps card, label, seller and concrete visible facts at 75%+", () => {
    expect(aspects.Style).toEqual(["Quarter Zip"]);
    expect(aspects.Lining).toEqual(["Fleece"]);
    expect(aspects["My Note"]).toEqual(["Kept"]);
    expect(aspects["Hood Style"]).toEqual(["Drawstring Hood"]);
  });
  it("removes 60% facts, pure guesses and subjective phrases", () => {
    expect(aspects["Pocket Count"]).toBeUndefined();
    expect(aspects.Era).toBeUndefined();
    expect(aspects.Feel).toBeUndefined();
  });
});

describe("MPN, model and style numbers", () => {
  it("are never guessed from appearance in clothing listings", () => {
    for (const name of [
      "MPN",
      "Model",
      "Style Code",
      "Model Number",
      "Part Number",
    ])
      expect(
        acceptedPhotoFact(guess(name, "DD8959-100", 99, "visible_feature"), 4, {
          clothing: true,
        }),
      ).toBe(false);
    expect(
      acceptedPhotoFact(label("Style Code", "DD8959-100"), 4, {
        clothing: true,
      }),
    ).toBe(true);
    // Clothing analysis (category mens_top) applies the rule.
    const l = analyze({ specifics: [guess("Model", "Air Max 90", 95)] });
    expect(l.item_specifics?.Model).toBeUndefined();
  });

  it("pairs an identifier with a label or card brand", () => {
    const labeled = analyze({
      specifics: [label("Brand", "Nike", "NIKE"), label("MPN", "DD8959-100")],
    });
    expect(mpnBrand(labeled)).toBe("Nike");
    const carded = analyze({
      seller_card: card("BRAND: Nike", "MPN: DD8959-100"),
    });
    expect(carded.item_specifics?.MPN).toBe("DD8959-100");
    expect(mpnBrand(carded)).toBe("Nike");
  });

  it("an estimated or unchecked brand cannot enable MPN pairing", () => {
    const estimated = analyze({
      specifics: [guess("Brand", "Nike", 95), label("MPN", "DD8959-100")],
    });
    expect(estimated.brand).toBe("Nike");
    expect(mpnBrand(estimated)).toBe("");
    const unchecked: ListingResult = {
      title: "t",
      description: "d",
      brand: "Nike",
      item_specifics: { MPN: "DD8959-100" },
    };
    expect(mpnBrand(unchecked)).toBe("");
  });
});

describe("Conflicts", () => {
  it("keeps the card Brand and surfaces the label's", () => {
    const l = analyze({
      seller_card: card("BRAND: Polo Ralph Lauren"),
      specifics: [label("Brand", "Lauren Ralph Lauren", "LAUREN RALPH LAUREN")],
    });
    expect(l.brand).toBe("Polo Ralph Lauren");
    expect(conflictMessage(l.conflicts![0])).toBe(
      "Seller card says Polo Ralph Lauren; the label appears to say Lauren Ralph Lauren — please review Brand.",
    );
  });

  it("keeps the card Size and surfaces the tag's", () => {
    const l = analyze({
      seller_card: card("SIZE: Large"),
      specifics: [label("Size", "M", "M")],
    });
    expect(l.size).toBe("Large");
    expect(conflictMessage(l.conflicts![0])).toBe(
      "Seller card says Large; the label appears to say M — please review Size.",
    );
  });

  it("formatting differences are not conflicts", () => {
    expect(sameFact("Size", "L", "Large")).toBe(true);
    expect(sameFact("Size", "XL", "Extra Large")).toBe(true);
    expect(sameFact("Material", "Cotton", "100% Cotton")).toBe(true);
    expect(sameFact("Material", "Cotton", "60% Cotton 40% Polyester")).toBe(
      false,
    );
    expect(sameFact("Brand", "NIKE", "Nike")).toBe(true);
    const l = analyze({
      seller_card: card("SIZE: L"),
      specifics: [label("Size", "Large", "LARGE")],
    });
    expect(l.conflicts).toBeUndefined();
  });

  it("an identity conflict holds publishing; size conflicts only warn", () => {
    const l = analyze({
      seller_card: card("BRAND: Polo Ralph Lauren", "SIZE: Large"),
      specifics: [
        label("Brand", "Lauren Ralph Lauren", "LAUREN RALPH LAUREN"),
        label("Size", "M", "M"),
      ],
    });
    const g = {
      id: "1",
      sku: "A-1",
      name: "a",
      photoIds: ["p"],
      status: "done",
      listing: l,
    } as ItemGroup;
    const issues = draftIssues(g);
    expect(issues.some((i) => i.includes("please review Brand"))).toBe(true);
    expect(issues.some((i) => i.includes("please review Size"))).toBe(false);
  });

  it("a manual correction or confirmation resolves the conflict", () => {
    const l = analyze({
      seller_card: card("BRAND: Polo Ralph Lauren", "SIZE: Large"),
      specifics: [
        label("Brand", "Lauren Ralph Lauren", "LAUREN RALPH LAUREN"),
        label("Size", "M", "M"),
      ],
    });
    const edited = applyListingEdit(l, { size: "M" });
    expect(edited.conflicts?.map((c) => c.name)).toEqual(["Brand"]);
    expect(edited.item_specifics?.Size).toBe("M");
    const confirmed = confirmSpecific(edited, "Brand");
    expect(confirmed.conflicts).toEqual([]);
    expect(confirmed.item_specifics?.Brand).toBe("Polo Ralph Lauren");
    expect(factSource(confirmed, "Brand")).toBe("seller");
  });
});

describe("Condition and New", () => {
  const ids = new Set([1000, 1500, 1750, 2990, 3000, 3010]);
  const prepared = (l: ListingResult, accepted = ids) => {
    applyListingDefaults(l, [], accepted);
    return l;
  };

  it("no card: transparent Pre-owned Excellent default", () => {
    const l = prepared(analyze());
    expect(l.ebay_condition).toBe("PRE_OWNED_EXCELLENT");
    expect(l.defaulted).toContain("condition");
  });

  it("NEW: YES makes the item seller-declared New, never NWT without tags", () => {
    const l = prepared(analyze({ seller_card: card("NEW: YES") }));
    expect(l.condition).toBe("NEW_NO_TAGS");
    expect(l.ebay_condition).toBeUndefined();
    expect(l.defaulted ?? []).not.toContain("condition");
    expect(l.condition_review).toContain("no attached tags are visible");
    expect(l.condition_review).toContain("New without tags (1500)");
  });

  it("NEW: YES with attached tags visible is New with tags", () => {
    const l = prepared(
      analyze({
        seller_card: card("New: y"),
        attached_tags: { visible: true, photoIndices: [3] },
      }),
    );
    expect(l.ebay_condition).toBe("NEW");
    expect(l.condition).toBe("NEW_WITH_TAGS");
    expect(l.condition_review).toContain("photo 3");
  });

  it("tags alone or an unclear NEW never make an item New", () => {
    const tags = prepared(
      analyze({ attached_tags: { visible: true, photoIndices: [3] } }),
    );
    expect(tags.ebay_condition).toBe("PRE_OWNED_EXCELLENT");
    const unclear = prepared(analyze({ seller_card: card("NEW: maybe") }));
    expect(unclear.ebay_condition).toBe("PRE_OWNED_EXCELLENT");
    expect(unclear.condition_review).toContain("not a clear YES");
    const noCategory = prepared(
      analyze({
        seller_card: card("NEW: YES"),
        attached_tags: { visible: true, photoIndices: [3] },
      }),
      new Set([1500, 2990]),
    );
    expect(noCategory.ebay_condition).toBeUndefined();
  });

  it("FLAW sets the pre-owned default to Pre-owned Good", () => {
    const l = prepared(
      analyze({ seller_card: card("FLAW: 1-inch tear under right arm") }),
    );
    expect(l.ebay_condition).toBe("USED_EXCELLENT"); // 3000 = Pre-owned Good
    expect(l.condition).toBe("GOOD");
    expect(l.defaulted).toContain("condition");
    // FLAW: none is no flaw.
    expect(
      prepared(analyze({ seller_card: card("FLAW: None", "BRAND: X") }))
        .ebay_condition,
    ).toBe("PRE_OWNED_EXCELLENT");
  });

  it("keeps the exact flaw wording in the description and notes", () => {
    const l = analyze({
      description: "Pre-owned shirt with minor signs of wear.",
      seller_card: card("FLAW: 1-inch tear under right arm"),
    });
    // The seller's words replace the AI's softer characterization.
    expect(l.description).toBe(
      "Pre-owned shirt. Flaw: 1-inch tear under right arm.",
    );
    expect(l.condition_notes).toBe("Flaw: 1-inch tear under right arm.");
    // A sentence that only restates the flaw becomes the disclosure.
    const once = analyze({
      description: "Shirt. 1-inch tear under right arm.",
      seller_card: card("FLAW: 1-inch tear under right arm"),
    });
    expect(once.description).toBe("Shirt. Flaw: 1-inch tear under right arm.");
  });

  it("AI cannot omit the flaw, and contradicting wording is removed", () => {
    const omitted = analyze({
      description:
        "Navy button-front shirt. Gently used with no visible flaws. Chest pocket and long sleeves.",
      condition_notes: "Excellent condition.",
      seller_card: card("FLAW: 1-inch tear under right arm"),
    });
    expect(omitted.description).toBe(
      "Navy button-front shirt. Flaw: 1-inch tear under right arm. Chest pocket and long sleeves.",
    );
    expect(omitted.condition_notes).toBe("Flaw: 1-inch tear under right arm.");
    const likeNew = analyze({
      description:
        "Navy shirt in excellent condition with button front. Like new.",
      seller_card: card("FLAW: 1-inch tear under right arm"),
    });
    expect(likeNew.description).toBe(
      "Navy shirt with button front. Flaw: 1-inch tear under right arm.",
    );
  });

  it("keeps unrelated accurate description and condition content", () => {
    const l = analyze({
      description:
        "Patagonia fleece pullover. Light wear on cuffs. Snap placket and kangaroo pocket.",
      condition_notes: "Light wear on cuffs.",
      seller_card: card("FLAW: 1-inch tear under right arm"),
    });
    expect(l.description).toBe(
      "Patagonia fleece pullover. Flaw: 1-inch tear under right arm. Light wear on cuffs. Snap placket and kangaroo pocket.",
    );
    expect(l.condition_notes).toBe(
      "Flaw: 1-inch tear under right arm. Light wear on cuffs.",
    );
    // No flaw on the card: the AI description is untouched.
    const none = analyze({
      description: "Pre-owned shirt with minor signs of wear.",
      seller_card: card("FLAW: none", "BRAND: Acme"),
    });
    expect(none.description).toBe("Pre-owned shirt with minor signs of wear.");
  });

  it("never edits a sentence that carries the seller's own words", () => {
    const l = analyze({
      description:
        "Shirt with a 1-inch tear under right arm near the seam, otherwise minor signs of wear.",
      seller_card: card("FLAW: 1-inch tear under right arm"),
    });
    expect(l.description).toBe(
      "Shirt with a 1-inch tear under right arm near the seam, otherwise minor signs of wear. Flaw: 1-inch tear under right arm.",
    );
  });

  it("a manual condition choice wins without deleting the flaw", () => {
    const l = prepared(
      analyze({ seller_card: card("FLAW: 1-inch tear under right arm") }),
    );
    const chosen = applyListingEdit(l, {
      ebay_condition: "PRE_OWNED_FAIR",
      condition: "GOOD",
    });
    prepared(chosen);
    expect(chosen.ebay_condition).toBe("PRE_OWNED_FAIR");
    expect(chosen.description).toContain("1-inch tear under right arm");
    expect(chosen.condition_notes).toContain("1-inch tear under right arm");
    expect(chosen.seller_card?.fields.FLAW).toBe("1-inch tear under right arm");
  });

  it("maps an explicit card grade only when the category has it", () => {
    const fair = prepared(
      analyze({ seller_card: card("CONDITION: Pre-owned Fair") }),
    );
    expect(fair.ebay_condition).toBe("PRE_OWNED_FAIR");
    const odd = prepared(analyze({ seller_card: card("CONDITION: Like new") }));
    expect(odd.ebay_condition).toBeUndefined();
    expect(odd.condition_review).toContain("choose it yourself");
  });
});

describe("NOTES", () => {
  it("are kept as seller information, never a specific or a stronger claim", () => {
    const l = analyze({
      seller_card: card("NOTES: color looks slightly darker in person"),
      specifics: [guess("Notes", "Black", 90)],
    });
    expect(l.seller_card?.fields.NOTES).toBe(
      "color looks slightly darker in person",
    );
    expect(l.item_specifics?.Notes).toBeUndefined();
    expect(l.item_specifics?.Color).toBeUndefined();
    expect(l.color).toEqual(["Blue"]);
  });
});

describe("Title", () => {
  it("uses card Brand, Size and Color", () => {
    const l = analyze({
      seller_card: card("BRAND: Patagonia", "SIZE: L", "COLOR: Gray"),
      item_type: "Fleece Pullover",
      color: ["Blue"],
    });
    expect(buildClothingTitle(l)?.title).toBe(
      "Patagonia Mens Fleece Pullover Sz L Gray",
    );
  });

  it("card Product Line still needs V3 identity support", () => {
    const l = analyze({
      seller_card: card("BRAND: Acme", "PRODUCT LINE: Weekend Comfort Line"),
      item_type: "Shirt",
    });
    // Not identity (no search term, list entry or footwear rule): V3 keeps
    // it out of the identity slot, as a trailing extra like a label line.
    expect(buildClothingTitle(l)?.title).toBe(
      "Acme Mens Shirt Blue Weekend Comfort Line",
    );
    const searched = analyze({
      seller_card: card("BRAND: Patagonia", "PRODUCT LINE: Synchilla"),
      item_type: "Fleece Pullover",
      search_terms: ["Synchilla"],
    });
    expect(buildClothingTitle(searched)?.title).toContain(
      "Patagonia Synchilla",
    );
  });
});

describe("card text vs real labels", () => {
  it("drops only facts that quote a card line, not label words the card also uses", () => {
    const l = analyze({
      seller_card: card("BRAND: Patagonia", "NOTES: cotton feels thin"),
      specifics: [
        label("Material", "Cotton", "COTTON"),
        label("Brand", "Patagonia", "Patagonia", 4),
      ],
    });
    expect(factSource(l, "Material")).toBe("label");
    expect(factSource(l, "Brand")).toBe("card");
    expect(l.evidence?.Brand).toBeUndefined();
  });
});

describe("letter-size equivalents", () => {
  const LETTERS = ["XS", "S", "M", "L", "XL", "XXL"];
  it("maps spelled-out letter sizes to the one allowed value", () => {
    const cases: [string, string[], string][] = [
      ["Small", LETTERS, "S"],
      ["Medium", LETTERS, "M"],
      ["Large", LETTERS, "L"],
      ["large", LETTERS, "L"],
      ["Extra Large", LETTERS, "XL"],
      ["X-Large", LETTERS, "XL"],
      ["x large", LETTERS, "XL"],
      ["Extra Small", LETTERS, "XS"],
      ["X-Small", LETTERS, "XS"],
      ["Extra Extra Large", LETTERS, "XXL"],
      ["XX-Large", ["S", "M", "L", "2XL"], "2XL"],
      ["L", ["Small", "Medium", "Large"], "Large"],
    ];
    for (const [value, allowed, expected] of cases)
      expect(letterSizeMatch(value, allowed).match).toBe(expected);
  });

  it("does not guess when two allowed values are equivalent", () => {
    const r = letterSizeMatch("Extra Extra Large", ["L", "XL", "XXL", "2XL"]);
    expect(r.match).toBeUndefined();
    expect(r.candidates).toEqual(["XXL", "2XL"]);
  });

  it("never converts sizes semantically", () => {
    const allowed = [
      "XS",
      "S",
      "M",
      "L",
      "XL",
      "XXL",
      "2X",
      "Youth L",
      "Petite M",
      "L Tall",
    ];
    for (const value of [
      "8", // women's 8 → M
      "Womens 8",
      "40", // men's 40 → L
      "Mens 40",
      "EU 42",
      "2", // 2 → 2X
      "Youth L",
      "Petite M",
      "Tall L",
      "10.5", // shoe size
      "US 9",
    ])
      expect(
        letterSizeMatch(
          value,
          allowed.filter((a) => a !== value),
        ).match,
      ).toBeUndefined();
    // Youth L, Petite M and L Tall are never the adult/regular equivalent.
    expect(
      letterSizeMatch("Large", ["Youth L", "L Tall"]).match,
    ).toBeUndefined();
    expect(letterSizeMatch("Medium", ["Petite M"]).match).toBeUndefined();
  });

  it("applies only to clothing Size aspects", () => {
    expect(isLetterSizeAspect("Size")).toBe(true);
    expect(isLetterSizeAspect("Size (Women's)")).toBe(true);
    expect(isLetterSizeAspect("Size Type")).toBe(false);
    expect(isLetterSizeAspect("US Shoe Size")).toBe(false);
  });
});

describe("hard goods keep their pre-Phase-2 identifier rules", () => {
  // Phase 1 baseline: a confident visual Model estimate on a camera was
  // accepted and marked as an estimate. Phase 2 must not change that.
  const camera = (specifics: unknown[]) =>
    buildAnalyzedListing(
      raw({
        category: "camera",
        category_hint: "mirrorless camera",
        item_type: "Camera",
        specifics,
      }),
      4,
      "hard_goods",
    );
  it("accepts a confident Model estimate outside clothing, as before", () => {
    const fact = guess("Model", "EOS R5", 85);
    expect(acceptedPhotoFact(fact, 4)).toBe(true);
    expect(acceptedPhotoFact(fact, 4, { clothing: false })).toBe(true);
    const l = camera([
      fact,
      guess("Model Number", "R5-01", 80),
      guess("Part Number", "4147C002", 80),
    ]);
    expect(l.item_specifics?.Model).toBe("EOS R5");
    expect(l.estimates?.Model).toBe(85);
    expect(l.item_specifics?.["Model Number"]).toBe("R5-01");
    expect(l.item_specifics?.["Part Number"]).toBe("4147C002");
  });
  it("keeps the shared safeguards that already existed", () => {
    const l = camera([
      guess("MPN", "4147C002", 95),
      guess("UPC", "013803331", 95),
    ]);
    expect(l.item_specifics?.MPN).toBeUndefined();
    expect(l.item_specifics?.UPC).toBeUndefined();
  });
  it("the clothing profile still applies the clothing rule", () => {
    const shoe = buildAnalyzedListing(
      raw({
        category: "mens_shoes",
        specifics: [guess("Model", "Air Max 90", 95)],
      }),
      4,
      "clothing",
    );
    expect(shoe.item_specifics?.Model).toBeUndefined();
  });
});

describe("promotional claims vs proper names", () => {
  it("rejects promotional claims", () => {
    for (const [value, name] of [
      ["Amazing", "Features"],
      ["Gorgeous", "Accents"],
      ["Luxurious", "Features"],
      ["Premium Quality", "Features"],
      ["Must Have", "Features"],
      ["Super Cute", "Features"],
      ["Super Soft", "Fabric Type"],
      ["Amazing fit", "Fit"],
      ["High Performance", "Features"],
      ["Luxurious Soft Lining", "Lining"],
    ])
      expect(isPromotionalClaim(value, name), `${name}: ${value}`).toBe(true);
  });

  it("accepts proper names and concrete features", () => {
    for (const [value, name] of [
      ["Great Outdoors Collection", "Features"],
      ["Great Outdoors Collection", "Collection"],
      ["Great Outdoors", "Product Line"],
      ["The Amazing Spider-Man", "Character"],
      ["Premium Denim", "Model"],
      ["Luxury Edition", "Edition"],
      ["Perfect Fit Series", "Features"],
      ["Comfort Waistband", "Features"],
      ["Soft Shell", "Type"],
      ["Pockets", "Features"],
    ])
      expect(isPromotionalClaim(value, name), `${name}: ${value}`).toBe(false);
  });

  it("estimates use the distinction; labels, cards and sellers are never filtered", () => {
    expect(
      acceptedPhotoFact(
        guess("Product Line", "Great Outdoors", 80, "visible_feature"),
        4,
      ),
    ).toBe(true);
    expect(
      acceptedPhotoFact(
        guess("Features", "Super Cute", 95, "visible_feature"),
        4,
      ),
    ).toBe(false);
    expect(
      acceptedPhotoFact(
        label("Features", "Premium Quality", "PREMIUM QUALITY"),
        4,
      ),
    ).toBe(true);
    const l = analyze({ seller_card: card("FEATURES: Super Soft, Pockets") });
    expect(buildAspects(l, "mens_top").Features).toEqual([
      "Super Soft",
      "Pockets",
    ]);
  });

  it("custom specifics keep proper names and drop claims", () => {
    const l = analyze({
      specifics: [
        guess(
          "Collection Name",
          "Great Outdoors Collection",
          85,
          "visible_feature",
        ),
        guess("Look", "Gorgeous", 85, "visible_feature"),
      ],
    });
    const aspects: Record<string, string[]> = {
      "Collection Name": ["Great Outdoors Collection"],
      Look: ["Gorgeous"],
    };
    gateCustomSpecifics(aspects, [], l);
    expect(aspects["Collection Name"]).toEqual(["Great Outdoors Collection"]);
    expect(aspects.Look).toBeUndefined();
  });
});

describe("seller card is an override sheet: blank fields are determined normally", () => {
  const blankCard = card(
    "BRAND:",
    "SIZE:",
    "MATERIAL:",
    "COLOR:",
    "FEATURES:",
    "FLAW:",
    "NEW:",
    "NOTES:",
    "STYLE: Pullover",
  );
  const ids = new Set([1000, 1500, 2990, 3000, 3010]);

  it("1. a filled card Brand wins over label and estimate", () => {
    const l = analyze({
      seller_card: card("BRAND: Ralph Lauren"),
      specifics: [guess("Brand", "Polo", 95)],
    });
    expect(l.brand).toBe("Ralph Lauren");
    expect(factSource(l, "Brand")).toBe("card");
  });

  it("2. blank card Brand: a readable label Brand is still used", () => {
    const l = analyze({
      seller_card: blankCard,
      specifics: [label("Brand", "Ralph Lauren", "RALPH LAUREN")],
    });
    expect(l.seller_card?.fields.BRAND).toBeUndefined();
    expect(l.brand).toBe("Ralph Lauren");
    expect(factSource(l, "Brand")).toBe("label");
  });

  it("3. blank card Brand: a valid ≥90% visual Brand is still used as an estimate", () => {
    const l = analyze({
      seller_card: blankCard,
      specifics: [guess("Brand", "Nike", 93)],
    });
    expect(l.brand).toBe("Nike");
    expect(factSource(l, "Brand")).toBe("estimate");
  });

  it("4. blank card Brand: unsupported Brand stays blank", () => {
    const l = analyze({
      brand: "Patagonia",
      seller_card: blankCard,
      specifics: [guess("Brand", "Patagonia", 80)],
    });
    expect(l.brand).toBe("");
    expect(l.item_specifics?.Brand).toBeUndefined();
  });

  it("5. a filled card Size wins (normalized in preparation)", () => {
    const l = analyze({
      seller_card: card("SIZE: Large"),
      specifics: [label("Size", "M", "M")],
    });
    expect(l.size).toBe("Large");
    expect(factSource(l, "Size")).toBe("card");
  });

  it("6. blank card Size: the garment tag Size is still used", () => {
    const l = analyze({
      seller_card: blankCard,
      size: "M",
      specifics: [label("Size", "M", "SIZE M")],
    });
    expect(l.item_specifics?.Size).toBe("M");
    expect(factSource(l, "Size")).toBe("label");
  });

  it("7. a filled card Material wins", () => {
    const l = analyze({
      seller_card: card("MATERIAL: 100% Cotton"),
      specifics: [guess("Material", "Polyester", 80)],
    });
    expect(l.material).toBe("100% Cotton");
    expect(factSource(l, "Material")).toBe("card");
  });

  it("8. blank card Material: the label Material is still used", () => {
    const l = analyze({
      seller_card: blankCard,
      specifics: [label("Material", "100% Cotton", "100% COTTON")],
    });
    expect(l.material).toBe("100% Cotton");
    expect(factSource(l, "Material")).toBe("label");
  });

  it("9. blank card Material: allowed estimates still work, without percentages", () => {
    const l = analyze({
      seller_card: blankCard,
      specifics: [guess("Material", "Cotton", 75)],
    });
    expect(l.material).toBe("Cotton");
    expect(factSource(l, "Material")).toBe("estimate");
    const pct = analyze({
      seller_card: blankCard,
      specifics: [guess("Material", "100% Cotton", 90)],
    });
    expect(pct.material).toBe("");
  });

  it("10. a filled card Color wins", () => {
    const l = analyze({
      seller_card: card("COLOR: Navy"),
      color: ["Blue"],
      specifics: [guess("Color", "Blue", 90, "visible_feature")],
    });
    expect(l.color).toEqual(["Navy"]);
    expect(buildAspects(l, "mens_top").Color).toEqual(["Navy"]);
    expect(factSource(l, "Color")).toBe("card");
  });

  it("11. blank card Color: normal photo Color detection still works", () => {
    const l = analyze({
      seller_card: blankCard,
      color: ["Blue"],
      specifics: [guess("Color", "Blue", 90, "visible_feature")],
    });
    expect(l.color).toEqual(["Blue"]);
    expect(factSource(l, "Color")).toBe("visible");
    expect(buildAspects(l, "mens_top").Color).toEqual(["Blue"]);
  });

  it("12. blank card Features: normal feature detection still works", () => {
    const l = analyze({
      seller_card: blankCard,
      key_features: [],
      specifics: [guess("Features", "Hooded | Pockets", 85, "visible_feature")],
    });
    expect(l.card_specifics).toEqual(["Style"]);
    expect(l.item_specifics?.Features).toBe("Hooded | Pockets");
    expect(buildAspects(l, "mens_top").Features).toEqual(["Hooded", "Pockets"]);
  });

  it("13. blank card FLAW: no seller flaw, visible possible flaws are kept", () => {
    const l = applyAndPrepare(
      analyze({
        seller_card: blankCard,
        description: "Gray pullover. Small stain on left cuff.",
        condition_notes: "Possible stain on left cuff; please check.",
      }),
    );
    expect(l.description).toBe("Gray pullover. Small stain on left cuff.");
    expect(l.condition_notes).toBe(
      "Possible stain on left cuff; please check.",
    );
    expect(l.description).not.toContain("Flaw:");
    // No seller-reported flaw: the Pre-owned Excellent default, not Good.
    expect(l.ebay_condition).toBe("PRE_OWNED_EXCELLENT");
    // Nothing is invented when no flaw is visible.
    const clean = analyze({
      seller_card: blankCard,
      description: "Gray pullover.",
    });
    expect(clean.description).toBe("Gray pullover.");
  });

  it("14. blank NEW: the item stays pre-owned", () => {
    const l = applyAndPrepare(
      analyze({
        seller_card: blankCard,
        attached_tags: { visible: true, photoIndices: [1] },
      }),
    );
    expect(l.ebay_condition).toBe("PRE_OWNED_EXCELLENT");
    expect(l.condition).toBe("EXCELLENT");
  });

  function applyAndPrepare(l: ListingResult) {
    applyListingDefaults(l, [], ids);
    return l;
  }
});
