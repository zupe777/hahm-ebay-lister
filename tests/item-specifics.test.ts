import { describe, expect, it } from "vitest";
import { buildAspects } from "@/lib/ebay/publish";
import {
  matchAllowed,
  removedValues,
  resolveNoneValues,
  canonicalizeAspectKeys,
  keptAsNumber,
} from "@/lib/ebay/aspects";
import { validateAspects } from "@/lib/ebay/draft";
import { canonicalizeProvenance } from "@/lib/provenance";
import { applyListingEdit } from "@/lib/seller-edits";
import { applyListingDefaults } from "@/lib/listing-defaults";
import type { AspectMeta } from "@/lib/ebay/taxonomy";
import type { ListingResult } from "@/lib/types";

const base = (over: Partial<ListingResult> = {}): ListingResult => ({
  title: "Acme Mens Polo Shirt Sz M Blue",
  description: "",
  brand: "Acme",
  size: "M",
  color: ["Blue"],
  material: "Cotton",
  item_type: "Polo Shirt",
  key_features: ["Short Sleeve", "Collared"],
  category: "mens_top",
  ...over,
});
const sel = (
  name: string,
  values: string[],
  extra: Partial<AspectMeta> = {},
): AspectMeta => ({
  name,
  required: false,
  usage: "RECOMMENDED",
  mode: "SELECTION_ONLY",
  cardinality: "SINGLE",
  values,
  ...extra,
});

describe("buildAspects: main-field copying", () => {
  it("copies brand, size, color, material, type, features and department", () => {
    expect(buildAspects(base(), "mens_top")).toEqual({
      Brand: ["Acme"],
      Size: ["M"],
      Color: ["Blue"],
      Material: ["Cotton"],
      Type: ["Polo Shirt"],
      Features: ["Short Sleeve", "Collared"],
      Department: ["Men"],
    });
  });
  it("splits multiple values but keeps names whole", () => {
    const a = buildAspects(
      base({
        material: "Cotton / Polyester",
        color: ["Black & White"],
        brand: "H&M",
      }),
      "mens_top",
    );
    expect(a.Material).toEqual(["Cotton", "Polyester"]);
    expect(a.Color).toEqual(["Black", "White"]);
    expect(a.Brand).toEqual(["H&M"]);
  });
  it("adds analysis specifics only where nothing exists yet", () => {
    const a = buildAspects(
      base({ item_specifics: { Pattern: "Striped", color: "Red" } }),
      "mens_top",
    );
    expect(a.Pattern).toEqual(["Striped"]);
    // Same name in another case: the main-field copy stays (unchecked policy unchanged).
    expect(a.Color).toEqual(["Blue"]);
    expect(a.color).toBeUndefined();
  });
});

describe("buildAspects: precedence (seller > verified > main field)", () => {
  it("prefers an evidence-verified specific over an unchecked main-field copy", () => {
    const a = buildAspects(
      base({
        item_specifics: { Material: "Cotton / Elastane" },
        evidence: { Material: [2] },
      }),
      "mens_top",
    );
    expect(a.Material).toEqual(["Cotton", "Elastane"]);
  });
  it("keeps the main-field copy over an estimated specific (Phase 2 policy untouched)", () => {
    const a = buildAspects(
      base({
        item_specifics: { Material: "Linen" },
        evidence: { Material: [2] },
        estimates: { Material: 70 },
      }),
      "mens_top",
    );
    expect(a.Material).toEqual(["Cotton"]);
  });
  it("uses the seller's reviewed value over everything", () => {
    const a = buildAspects(
      base({
        color: ["Navy"],
        item_specifics: { Color: "Navy", Material: "Wool" },
        evidence: { Material: [1] },
        seller_specifics: ["Color", "Material"],
        material: "Wool",
      }),
      "mens_top",
    );
    expect(a.Color).toEqual(["Navy"]);
    expect(a.Material).toEqual(["Wool"]);
  });
  it("never refills a value the seller cleared", () => {
    const a = buildAspects(
      base({
        item_specifics: { Features: "", Department: "" },
        seller_specifics: ["Features", "Department"],
      }),
      "mens_top",
    );
    expect(a.Features).toBeUndefined();
    expect(a.Department).toBeUndefined();
  });
  it("does not invent missing values", () => {
    const a = buildAspects({ title: "x", description: "" }, "");
    expect(a).toEqual({});
  });
});

describe("matchAllowed: formatting only, never meaning", () => {
  it("matches spacing, hyphen, case and simple plural differences", () => {
    expect(matchAllowed("V Neck", ["V-Neck", "Crew Neck"])).toBe("V-Neck");
    expect(matchAllowed("v-neck", ["V Neck"])).toBe("V Neck");
    expect(matchAllowed("Crew Neck", ["Crewneck"])).toBe("Crewneck");
    expect(matchAllowed("Crewneck", ["Crew Neck"])).toBe("Crew Neck");
    expect(matchAllowed("BLUE", ["Blue"])).toBe("Blue");
    expect(matchAllowed("Pocket", ["Pockets"])).toBe("Pockets");
    expect(matchAllowed("Button Downs", ["Button-Down"])).toBe("Button-Down");
  });
  it("never matches by meaning", () => {
    expect(matchAllowed("Navy", ["Blue"])).toBeNull();
    expect(matchAllowed("Tunic", ["Top"])).toBeNull();
    expect(matchAllowed("Red", ["Burgundy"])).toBeNull();
    expect(matchAllowed("Slim", ["Regular"])).toBeNull();
  });
  it("keeps dots meaningful and refuses ambiguous formatting matches", () => {
    expect(matchAllowed("10.5", ["105", "10"])).toBeNull();
    expect(matchAllowed("V Neck", ["V-Neck", "VNeck"])).toBeNull();
  });
});

describe('"None" values', () => {
  it("keeps None only where eBay explicitly allows it", () => {
    const a: Record<string, string[]> = {
      Embellishment: ["None"],
      Theme: ["None"],
      Pattern: ["None", "Striped"],
    };
    resolveNoneValues(a, [
      sel("Embellishment", ["None", "Beaded"]),
      sel("Theme", ["Animals"]),
      sel("Pattern", ["Striped"]),
    ]);
    expect(a).toEqual({ Embellishment: ["None"], Pattern: ["Striped"] });
  });
  it("validates an allowed None but still flags a placeholder None", () => {
    expect(
      validateAspects({ Embellishment: ["None"] }, [
        sel("Embellishment", ["None", "Beaded"], { required: true }),
      ]),
    ).toEqual([]);
    expect(
      validateAspects({ Theme: ["None"] }, [
        { ...sel("Theme", []), mode: "FREE_TEXT" },
      ]),
    ).toContain("Remove unknown placeholder in Theme");
  });
  it("buildAspects keeps a literal None for preparation to resolve", () => {
    expect(
      buildAspects(base({ item_specifics: { Embellishment: "None" } }), "")
        .Embellishment,
    ).toEqual(["None"]);
  });
});

describe("removal notes", () => {
  it("reports removed values but not re-spellings or renames", () => {
    expect(
      removedValues(
        {
          "Sleeve Style": ["Cap Sleeve"],
          neckline: ["V Neck"],
          Features: ["Pocket"],
        },
        { Neckline: ["V-Neck"], Features: ["Pockets"] },
        "Not accepted by eBay for this category",
      ),
    ).toEqual([
      {
        name: "Sleeve Style",
        value: "Cap Sleeve",
        reason: "Not accepted by eBay for this category",
      },
    ]);
  });
  it("treats a kept number as kept", () => {
    expect(keptAsNumber("6.1 oz", ["6.1"])).toBe(true);
    expect(keptAsNumber("6.4", ["6"])).toBe(true);
    expect(keptAsNumber("Heavyweight", [])).toBe(false);
    // Text values outside number fields pass through unchanged.
    expect(keptAsNumber("Acme", ["Acme"])).toBe(true);
  });
});

describe("provenance follows renamed specifics", () => {
  it("moves evidence, estimates, seller and default records to eBay's spelling", () => {
    const l = base({
      evidence: { "sleeve length": [3], Brand: [1] },
      estimates: { "sleeve length": 80 },
      seller_specifics: ["pattern"],
      defaulted: ["size type"],
    });
    canonicalizeProvenance(l, [
      "Sleeve Length",
      "Pattern",
      "Size Type",
      "Brand",
    ]);
    expect(l.evidence).toEqual({ "Sleeve Length": [3], Brand: [1] });
    expect(l.estimates).toEqual({ "Sleeve Length": 80 });
    expect(l.seller_specifics).toEqual(["Pattern"]);
    expect(l.defaulted).toEqual(["Size Type"]);
  });
  it("never overwrites an existing canonical record", () => {
    const l = base({
      evidence: { "Sleeve Length": [1], "sleeve length": [5] },
    });
    canonicalizeProvenance(l, ["Sleeve Length"]);
    expect(l.evidence).toEqual({ "Sleeve Length": [1] });
  });
  it("renames the specifics themselves case-insensitively", () => {
    const a: Record<string, string[]> = { "sleeve length": ["Long Sleeve"] };
    canonicalizeAspectKeys(a, [sel("Sleeve Length", ["Long Sleeve"])]);
    expect(a).toEqual({ "Sleeve Length": ["Long Sleeve"] });
  });
});

describe("seller edits", () => {
  const analyzed = () =>
    base({
      title_source: "auto",
      item_specifics: { Color: "Blue", Pattern: "Striped", Brand: "Acme" },
      evidence: { Pattern: [2], Brand: [1], Color: [1] },
      estimates: { Pattern: 80 },
    });
  it("marks only the edited specific as seller-reviewed and keeps other provenance", () => {
    const next = applyListingEdit(analyzed(), {
      item_specifics: { Color: "Navy", Pattern: "Striped", Brand: "Acme" },
    });
    expect(next.color).toEqual(["Navy"]);
    expect(next.seller_specifics).toEqual(["Color"]);
    expect(next.evidence).toEqual({ Pattern: [2], Brand: [1] });
    expect(next.estimates).toEqual({ Pattern: 80 });
    // The builder-made title follows the reviewed color.
    expect(next.title).toContain("Navy");
    expect(next.title).not.toContain("Blue");
  });
  it("syncs Features into the main field", () => {
    const next = applyListingEdit(analyzed(), {
      item_specifics: {
        ...analyzed().item_specifics,
        Features: "Pockets | Vented Hem",
      },
    });
    expect(next.key_features).toEqual(["Pockets", "Vented Hem"]);
    expect(next.seller_specifics).toEqual(["Features"]);
  });
  it("treats a main-field edit (the size box) as a reviewed specific", () => {
    const next = applyListingEdit(analyzed(), { size: "L" });
    expect(next.item_specifics?.Size).toBe("L");
    expect(next.seller_specifics).toEqual(["Size"]);
    expect(next.evidence).toEqual(analyzed().evidence);
  });
  it("never rebuilds a title the seller typed", () => {
    const next = applyListingEdit(
      { ...analyzed(), title: "My title", title_source: "seller" },
      {
        item_specifics: { Color: "Navy", Pattern: "Striped", Brand: "Acme" },
      },
    );
    expect(next.title).toBe("My title");
  });
  it("a changed condition is no longer a default", () => {
    const next = applyListingEdit(
      { ...analyzed(), defaulted: ["condition", "Size Type"] },
      { ebay_condition: "USED_GOOD" },
    );
    expect(next.defaulted).toEqual(["Size Type"]);
  });
});

describe("defaults are recorded as defaults", () => {
  const meta = [sel("Size Type", ["Regular", "Petite"])];
  it("labels the Size Type and condition defaults and keeps the AI grade", () => {
    const l = base({ condition: "VERY_GOOD" });
    applyListingDefaults(l, meta, new Set([2990]));
    expect(l.item_specifics?.["Size Type"]).toBe("Regular");
    expect(l.ebay_condition).toBe("PRE_OWNED_EXCELLENT");
    expect(l.condition).toBe("EXCELLENT");
    expect(l.defaulted).toEqual(["Size Type", "condition"]);
    expect(l.ai_condition).toBe("VERY_GOOD");
  });
  it("does not default a Size Type the seller cleared", () => {
    const l = base({
      item_specifics: { "Size Type": "" },
      seller_specifics: ["Size Type"],
    });
    applyListingDefaults(l, meta, new Set());
    expect(l.item_specifics?.["Size Type"]).toBe("");
    expect(l.defaulted).toBeUndefined();
  });
});
