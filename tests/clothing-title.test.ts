import { describe, expect, it } from "vitest";
import {
  buildClothingTitle,
  distinctiveSearchMatch,
  initialTitle,
  isCodeShaped,
  onCuratedList,
  refreshAutoTitle,
} from "@/lib/clothingTitle";
import { optimizeTitle } from "@/lib/titleOptimizer";
import type { ListingResult } from "@/lib/types";

// A fact is "label" (read from a tag) or [value, confidence] for an estimate.
type Facts = Record<string, string | [string, number]>;
function listing(
  base: Partial<ListingResult>,
  facts: Facts = {},
): ListingResult {
  const item_specifics: Record<string, string> = {};
  const evidence: Record<string, number[]> = {};
  const estimates: Record<string, number> = {};
  for (const [name, fact] of Object.entries(facts)) {
    const [value, confidence] = Array.isArray(fact) ? fact : [fact, 0];
    item_specifics[name] = value;
    evidence[name] = [1];
    if (confidence) estimates[name] = confidence;
  }
  return {
    title: "AI written title",
    description: "",
    ...base,
    item_specifics,
    evidence,
    estimates,
  } as ListingResult;
}
const title = (l: ListingResult) => buildClothingTitle(l)?.title;

// Approved V3 spec examples (hypothetical items).
const examples: [string, ListingResult, string][] = [
  [
    "fleece, curated line",
    listing(
      {
        brand: "Patagonia",
        category: "mens_sweater",
        item_type: "Fleece Pullover",
        size: "M",
        color: ["Gray"],
        search_terms: ["patagonia better sweater"],
      },
      {
        "Product Line": "Better Sweater",
        Material: "Polyester",
        Closure: ["1/4 Zip", 90],
        Neckline: ["Mock Neck", 85],
      },
    ),
    "Patagonia Better Sweater Mens Fleece Pullover Sz M Gray Polyester Mock Neck",
  ],
  [
    "jeans, labeled waist and inseam",
    listing(
      {
        brand: "Levi's",
        category: "womens_jeans",
        item_type: "Jeans",
        size: "28",
        color: ["Blue"],
      },
      {
        "Product Line": "Wedgie Straight",
        "Waist Size": "28",
        Inseam: "28",
        Material: "Cotton",
        Rise: "High Rise",
        Wash: ["Medium Wash", 85],
        "Leg Style": ["Straight Leg", 80],
      },
    ),
    "Levi's Wedgie Straight Womens Jeans W28 L28 Blue Cotton High Rise Medium Wash",
  ],
  [
    "unbranded linen shirt",
    listing(
      {
        brand: "Unknown",
        category: "womens_top",
        item_type: "Button Up Shirt",
        size: "M",
        color: ["White"],
      },
      {
        Material: "Linen",
        "Sleeve Length": ["Long Sleeve", 90],
        Features: ["Collared", 80],
      },
    ),
    "Womens Linen Button Up Shirt Sz M White Long Sleeve Collared",
  ],
  [
    "unbranded wool coat",
    listing(
      {
        brand: "Unbranded",
        category: "mens_coat",
        item_type: "Peacoat",
        size: "L",
        color: ["Navy"],
      },
      {
        Material: "Wool",
        Closure: ["Double Breasted", 90],
        Features: ["Lined", 80],
      },
    ),
    "Mens Wool Peacoat Sz L Navy Double Breasted Lined",
  ],
  [
    "petite dress, internal name dropped",
    listing(
      {
        brand: "Loft",
        category: "womens_dress",
        item_type: "Wrap Midi Dress",
        size: "6",
        color: ["Navy"],
        search_terms: ["loft wrap dress"],
      },
      {
        "Product Line": "Riviera",
        "Size Type": "Petite",
        Material: "Polyester",
        Pattern: ["Polka Dot", 90],
        "Sleeve Length": ["Flutter Sleeve", 85],
        Neckline: ["V-Neck", 80],
      },
    ),
    "Loft Womens Wrap Midi Dress Petite Sz 6 Navy Polyester Polka Dot Flutter Sleeve",
  ],
  [
    "tall shirt, curated fit line",
    listing(
      {
        brand: "Brooks Brothers",
        category: "mens_top",
        item_type: "Button Down Shirt",
        size: "XL",
        color: ["Blue"],
      },
      {
        "Product Line": "Regent Fit",
        "Size Type": "Tall",
        Material: "Cotton",
        Pattern: ["Gingham", 90],
        "Sleeve Length": ["Long Sleeve", 90],
        Features: ["Non-Iron", 80],
      },
    ),
    "Brooks Brothers Regent Fit Mens Button Down Shirt Tall Sz XL Blue Cotton Gingham",
  ],
  [
    "petite cashmere cardigan",
    listing(
      {
        brand: "Talbots",
        category: "womens_sweater",
        item_type: "Cardigan Sweater",
        size: "M",
        color: ["Ivory"],
      },
      {
        Material: "100% Cashmere",
        "Size Type": "Petite",
        Closure: ["Button Front", 90],
      },
    ),
    "Talbots Womens Cashmere Cardigan Sweater Petite Sz M Ivory Button Front",
  ],
  [
    "plus blouse, printed size kept",
    listing(
      {
        brand: "Torrid",
        category: "womens_top",
        item_type: "Blouse",
        size: "2",
        color: ["Black"],
        material: "Polyester",
      },
      {
        "Size Type": "Plus",
        Pattern: ["Floral", 90],
        Features: ["Chiffon", 80],
      },
    ),
    "Torrid Womens Blouse Plus Sz 2 Black Polyester Floral Chiffon",
  ],
  [
    "long model jacket",
    listing(
      {
        brand: "The North Face",
        category: "mens_coat",
        item_type: "Down Puffer Jacket",
        size: "L",
        color: ["Black"],
        material: "Nylon",
      },
      { "Product Line": "1996 Retro Nuptse", Features: ["700 Fill", 90] },
    ),
    "The North Face 1996 Retro Nuptse Mens Down Puffer Jacket Sz L Black 700 Fill",
  ],
  [
    "sneakers with style code",
    listing(
      {
        brand: "Nike",
        category: "womens_shoes",
        item_type: "Sneakers",
        size: "8.5",
        color: ["White"],
      },
      {
        "Product Line": "Air Force 1 '07",
        "Style Code": "DD8959-100",
        Material: "Leather",
        Style: ["Low Top", 85],
      },
    ),
    "Nike Air Force 1 '07 Womens Leather Sneakers Sz 8.5 White Low Top DD8959-100",
  ],
  [
    "boots, line plus model number, standard width hidden",
    listing(
      {
        brand: "Red Wing",
        category: "mens_shoes",
        item_type: "Boots",
        size: "10.5",
        color: ["Amber"],
      },
      {
        "Product Line": "Iron Ranger",
        Model: "8111",
        Material: "Leather",
        "Shoe Width": "D",
        "Toe Shape": ["Cap Toe", 90],
        Closure: ["Lace Up", 90],
      },
    ),
    "Red Wing Iron Ranger 8111 Mens Leather Boots Sz 10.5 Amber Cap Toe Lace Up",
  ],
  [
    "handbag",
    listing(
      {
        brand: "Coach",
        category: "handbag",
        item_type: "Shoulder Bag",
        color: ["Black"],
      },
      {
        "Product Line": "Tabby 26",
        Department: "Women",
        Material: "Pebble Leather",
        "Style Code": "CH857",
        Style: ["Crossbody", 90],
        "Hardware Color": ["Gold", 90],
      },
    ),
    "Coach Tabby 26 Womens Pebble Leather Shoulder Bag Black Crossbody CH857",
  ],
  [
    "character tee protected",
    listing(
      {
        brand: "Bioworld",
        category: "womens_top",
        item_type: "Graphic T-Shirt",
        size: "L",
        color: ["Black"],
        material: "Cotton",
      },
      {
        Character: "Sailor Moon Sailor Scouts",
        Pattern: ["Graphic", 95],
        Neckline: ["Crew Neck", 85],
        "Sleeve Length": ["Short Sleeve", 90],
      },
    ),
    "Bioworld Sailor Moon Sailor Scouts Womens Graphic T-Shirt Sz L Black Crew Neck",
  ],
  [
    "collaboration and theme protected",
    listing(
      {
        brand: "Abercrombie & Fitch",
        category: "mens_top",
        item_type: "Camp Collar Shirt",
        size: "XL",
        color: ["Multicolor"],
        material: "Cotton",
        search_terms: ["trevor project rainbow wave"],
      },
      {
        Collaboration: "The Trevor Project",
        Theme: ["Rainbow Wave", 90],
        "Sleeve Length": ["Short Sleeve", 90],
      },
    ),
    "Abercrombie & Fitch x The Trevor Project Rainbow Wave Mens Camp Collar Shirt XL",
  ],
  [
    "unbranded character tee",
    listing(
      {
        brand: "",
        category: "mens_top",
        item_type: "Graphic T-Shirt",
        size: "L",
        color: ["Gray"],
        material: "Cotton",
      },
      { Character: ["Mickey Mouse", 90], Neckline: ["Crew Neck", 85] },
    ),
    "Mickey Mouse Mens Graphic T-Shirt Sz L Gray Cotton Crew Neck",
  ],
  [
    "sweater style number is an extra",
    listing(
      {
        brand: "Banana Republic",
        category: "womens_sweater",
        item_type: "Crewneck Sweater",
        size: "M",
        color: ["Heather Gray"],
      },
      {
        "Style Code": "438821",
        Material: "Merino Wool",
        Pattern: ["Ribbed Knit", 90],
        "Sleeve Length": ["Long Sleeve", 90],
        Style: ["Pullover", 85],
      },
    ),
    "Banana Republic Womens Merino Wool Crewneck Sweater Sz M Heather Gray",
  ],
  [
    "numbered jeans line",
    listing(
      {
        brand: "Levi's",
        category: "mens_jeans",
        item_type: "Jeans",
        size: "34",
        color: ["Blue"],
      },
      {
        "Product Line": "501 Original Fit",
        "Waist Size": "34",
        Inseam: "36",
        Material: "Cotton",
        Wash: ["Dark Wash", 90],
        Features: ["Button Fly", 85],
      },
    ),
    "Levi's 501 Original Fit Mens Jeans W34 L36 Blue Cotton Dark Wash Button Fly",
  ],
  [
    "long brand with curated line",
    listing(
      {
        brand: "Polo Ralph Lauren",
        category: "mens_top",
        item_type: "Polo Shirt",
        size: "M",
        color: ["Navy"],
        material: "Cotton",
      },
      {
        "Product Line": "Big Pony",
        Features: ["Mesh", 90],
        Fit: ["Custom Slim Fit", 85],
      },
    ),
    "Polo Ralph Lauren Big Pony Mens Polo Shirt Sz M Navy Cotton Custom Slim Fit Mesh",
  ],
  [
    "name that repeats itself",
    listing(
      {
        brand: "BOSS Hugo Boss",
        category: "mens_top",
        item_type: "Polo Shirt",
        size: "L",
        color: ["Navy"],
        material: "Cotton",
      },
      { Fit: ["Slim Fit", 85] },
    ),
    "BOSS Hugo Boss Mens Polo Shirt Sz L Navy Cotton Slim Fit",
  ],
  [
    "'New' inside a brand",
    listing(
      {
        brand: "New Balance",
        category: "mens_shoes",
        item_type: "Sneakers",
        size: "10",
        color: ["Gray"],
      },
      {
        Model: "574",
        Material: "Suede",
        "Style Code": "ML574EVG",
        Style: ["Low Top", 85],
      },
    ),
    "New Balance 574 Mens Suede Sneakers Sz 10 Gray Low Top ML574EVG",
  ],
  [
    "unfamiliar line via search term",
    listing(
      {
        brand: "Marine Layer",
        category: "mens_sweater",
        item_type: "Reversible Pullover",
        size: "XL",
        color: ["Heather Gray"],
        search_terms: ["marine layer corbet reversible"],
      },
      {
        "Product Line": "Corbet",
        Material: "Cotton Blend",
        Closure: ["Quarter Zip", 90],
        "Sleeve Length": ["Long Sleeve", 90],
      },
    ),
    "Marine Layer Corbet Mens Reversible Pullover Sz XL Heather Gray Long Sleeve",
  ],
  [
    "unfamiliar pants line",
    listing(
      {
        brand: "Kuhl",
        category: "mens_pants",
        item_type: "Hiking Pants",
        size: "34",
        color: ["Khaki"],
        search_terms: ["kuhl konfidant air pants"],
      },
      {
        "Product Line": "Konfidant Air",
        "Waist Size": "34",
        Inseam: "32",
        Material: "Nylon",
        Fit: ["Stretch", 90],
        Features: ["Zip Pocket", 85],
      },
    ),
    "Kuhl Konfidant Air Mens Hiking Pants W34 L32 Khaki Nylon Stretch Zip Pocket",
  ],
  [
    "line that names the garment",
    listing(
      {
        brand: "Faherty",
        category: "mens_top",
        item_type: "Button Up Shirt",
        size: "L",
        color: ["Navy"],
        search_terms: ["faherty legend sweater shirt"],
      },
      {
        "Product Line": "Legend Sweater Shirt",
        Material: "Polyester Blend",
        "Sleeve Length": ["Long Sleeve", 90],
        Features: ["Brushed Knit", 80],
      },
    ),
    "Faherty Legend Sweater Shirt Mens Sz L Navy Polyester Blend Long Sleeve",
  ],
  [
    "search term without a label is not used",
    listing(
      {
        brand: "Madewell",
        category: "womens_jeans",
        item_type: "Jeans",
        size: "27",
        color: ["Blue"],
        material: "Cotton",
        search_terms: ["madewell perfect vintage jean"],
      },
      {
        Rise: "High Rise",
        Wash: ["Medium Wash", 85],
        "Leg Style": ["Straight Leg", 80],
      },
    ),
    "Madewell Womens Jeans Sz 27 Blue Cotton High Rise Medium Wash Straight Leg",
  ],
  [
    "label-only line kept last when there is room",
    listing(
      {
        brand: "Lands' End",
        category: "womens_sweater",
        item_type: "Cardigan Sweater",
        size: "M",
        color: ["Navy"],
        material: "Cotton",
        search_terms: ["lands end cardigan"],
      },
      { "Product Line": "Drifter", Pattern: ["Cable Knit", 90] },
    ),
    "Lands' End Womens Cardigan Sweater Sz M Navy Cotton Cable Knit Drifter",
  ],
  [
    "unfamiliar dress line",
    listing(
      {
        brand: "Reformation",
        category: "womens_dress",
        item_type: "Midi Wrap Dress",
        size: "4",
        color: ["Red"],
        search_terms: ["reformation juliette dress"],
      },
      {
        "Product Line": "Juliette",
        Material: "Viscose",
        Pattern: ["Floral", 90],
        "Sleeve Length": ["Puff Sleeve", 90],
        Neckline: ["Sweetheart Neckline", 85],
      },
    ),
    "Reformation Juliette Womens Midi Wrap Dress Sz 4 Red Viscose Floral Puff Sleeve",
  ],
];

describe("approved examples", () => {
  for (const [name, l, expected] of examples)
    it(name, () => {
      expect(title(l)).toBe(expected);
      expect(expected.length).toBeLessThanOrEqual(80);
    });

  it("never adds condition words or exceeds 80 characters", () => {
    for (const [, l] of examples) {
      const t = title(l)!;
      expect(t.length).toBeLessThanOrEqual(80);
      expect(t.replace("New Balance", "")).not.toMatch(
        /\b(new|nwt|nwot|euc|guc|used|pre-?owned|excellent)\b/i,
      );
    }
  });
});

describe("rule C: product line, model and named style", () => {
  const base = {
    brand: "Acme",
    category: "womens_top",
    item_type: "Blouse",
    size: "M",
    color: ["Blue"],
  };
  it("protects a label line that appears as a distinctive search phrase", () => {
    const r = buildClothingTitle(
      listing(
        { ...base, search_terms: ["acme harbor blouse"] },
        { "Product Line": "Harbor" },
      ),
    );
    expect(r?.parts.find((p) => p.slot === "line")?.text).toBe("Harbor");
    expect(r?.title).toBe("Acme Harbor Womens Blouse Sz M Blue");
  });
  it("never uses a search phrase without label evidence", () => {
    expect(
      title(
        listing(
          { ...base, search_terms: ["acme harbor blouse"] },
          { "Product Line": ["Harbor", 95] },
        ),
      ),
    ).toBe("Acme Womens Blouse Sz M Blue");
  });
  it("treats a label line with no search phrase as an extra, last and dropped first", () => {
    const r = buildClothingTitle(listing(base, { "Product Line": "Harbor" }));
    expect(r?.parts.at(-1)).toEqual({ slot: "extra", text: "Harbor" });
  });
  it("needs a distinctive word: generic or brand words do not count", () => {
    expect(
      distinctiveSearchMatch(
        "Classic Fit",
        ["acme classic fit blouse"],
        "Acme",
      ),
    ).toBe(false);
    expect(distinctiveSearchMatch("Acme Basics", ["acme basics"], "Acme")).toBe(
      false,
    );
    expect(
      distinctiveSearchMatch(
        "Konfidant Air",
        ["kuhl konfidant air pants"],
        "Kuhl",
      ),
    ).toBe(true);
    // Words must sit in ONE search term.
    expect(
      distinctiveSearchMatch(
        "Konfidant Air",
        ["kuhl konfidant", "air pants"],
        "Kuhl",
      ),
    ).toBe(false);
  });
  it("uses the curated list as a boost without a search phrase", () => {
    expect(onCuratedList("Better Sweater")).toBe(true);
    expect(onCuratedList("Betterment")).toBe(false);
    expect(
      title(
        listing(
          {
            ...base,
            brand: "Patagonia",
            category: "mens_sweater",
            item_type: "Fleece Jacket",
          },
          { "Product Line": "Better Sweater" },
        ),
      ),
    ).toBe("Patagonia Better Sweater Mens Fleece Jacket Sz M Blue");
  });
  it("protects label models on footwear and bags", () => {
    expect(
      title(
        listing(
          {
            brand: "Acme",
            category: "mens_shoes",
            item_type: "Boots",
            size: "9",
            color: ["Brown"],
          },
          { Model: "Ridgeline" },
        ),
      ),
    ).toBe("Acme Ridgeline Mens Boots Sz 9 Brown");
  });
  it("downgrades long unlisted names to extras even with a search phrase", () => {
    const r = buildClothingTitle(
      listing(
        {
          ...base,
          search_terms: ["acme seaside harbor breeze linen edit blouse"],
        },
        { "Product Line": "Seaside Harbor Breeze Linen Edit" },
      ),
    );
    expect(r?.parts.find((p) => p.slot === "extra")?.text).toBe(
      "Seaside Harbor Breeze Linen Edit",
    );
  });
  it("classifies codes", () => {
    expect(isCodeShaped("DD8959-100")).toBe(true);
    expect(isCodeShaped("438821")).toBe(true);
    expect(isCodeShaped("501")).toBe(false);
    expect(isCodeShaped("8111")).toBe(false);
    expect(isCodeShaped("Tabby 26")).toBe(false);
  });
});

describe("evidence thresholds", () => {
  const tee = {
    brand: "Acme",
    category: "mens_top",
    item_type: "Graphic T-Shirt",
    size: "L",
    color: ["Black"],
  };
  it("needs 85% to name a character from artwork", () => {
    expect(title(listing(tee, { Character: ["Snoopy", 84] }))).toBe(
      "Acme Mens Graphic T-Shirt Sz L Black",
    );
    expect(title(listing(tee, { Character: ["Snoopy", 85] }))).toBe(
      "Acme Snoopy Mens Graphic T-Shirt Sz L Black",
    );
  });
  it("needs 75% for estimated details", () => {
    expect(title(listing(tee, { Neckline: ["V-Neck", 74] }))).toBe(
      "Acme Mens Graphic T-Shirt Sz L Black",
    );
    expect(title(listing(tee, { Neckline: ["V-Neck", 75] }))).toBe(
      "Acme Mens Graphic T-Shirt Sz L Black V-Neck",
    );
  });
  it("treats an unprotected character as a detail when the item is not graphic", () => {
    const r = buildClothingTitle(
      listing({ ...tee, item_type: "Pajama Top" }, { Character: "Snoopy" }),
    );
    expect(r?.parts.find((p) => p.text === "Snoopy")?.slot).toBe("detail");
  });
  it("never puts an unverified premium fiber in the title", () => {
    expect(
      title(listing({ ...tee, item_type: "Sweater", material: "Cashmere" })),
    ).toBe("Acme Mens Sweater Sz L Black");
    expect(
      title(
        listing(
          { ...tee, item_type: "Sweater" },
          { Material: ["Cashmere", 90] },
        ),
      ),
    ).toBe("Acme Mens Sweater Sz L Black");
  });
  it("treats a material copied by preparation like the analysis field", () => {
    const l = listing({ ...tee, item_type: "Sweater", material: "Acrylic" });
    l.item_specifics = { ...l.item_specifics, Material: "Acrylic" };
    expect(title(l)).toBe("Acme Mens Sweater Sz L Black Acrylic");
  });
});

describe("names, duplicates and cleanup", () => {
  it("keeps names whole and skips only whole duplicate parts", () => {
    expect(
      title(
        listing(
          {
            brand: "Duran Duran",
            category: "mens_top",
            item_type: "Graphic Tee",
            size: "M",
            color: ["Black"],
          },
          { Character: "Duran Duran" },
        ),
      ),
    ).toBe("Duran Duran Mens Graphic Tee Sz M Black");
    expect(
      title(
        listing({
          brand: "True Religion",
          category: "mens_jeans",
          item_type: "Jeans",
          size: "32",
          color: ["Blue"],
        }),
      ),
    ).toBe("True Religion Mens Jeans Sz 32 Blue");
  });
  it("removes filler and condition words from descriptive parts only", () => {
    expect(
      title(
        listing({
          brand: "New Balance",
          category: "womens_top",
          item_type: "NWT Cute Vintage Hoodie",
          size: "S",
          color: ["Pink"],
        }),
      ),
    ).toBe("New Balance Womens Hoodie Sz S Pink");
  });
  it("skips run-together duplicates like Crew Neck vs Crewneck", () => {
    expect(
      title(
        listing(
          {
            brand: "Acme",
            category: "mens_sweater",
            item_type: "Crewneck Sweater",
            size: "M",
            color: ["Gray"],
          },
          { Neckline: ["Crew Neck", 90] },
        ),
      ),
    ).toBe("Acme Mens Crewneck Sweater Sz M Gray");
  });
  it("skips a garment that a protected name already ends with", () => {
    const r = buildClothingTitle(
      listing(
        {
          brand: "Acme",
          category: "mens_top",
          item_type: "Graphic Tee",
          size: "M",
          color: ["Red"],
        },
        { Character: "Spider-Man Tee", Pattern: ["Graphic", 90] },
      ),
    );
    expect(r?.parts.some((p) => p.slot === "garment")).toBe(false);
    expect(r?.title).toBe("Acme Spider-Man Tee Mens Sz M Red Graphic");
  });
  it("omits placeholder brands and builds from the strongest attributes", () => {
    for (const brand of ["Unknown", "Unbranded", "No Brand", "Generic", "N/A"])
      expect(
        title(
          listing({
            brand,
            category: "womens_dress",
            item_type: "Maxi Dress",
            size: "S",
            color: ["Green"],
          }),
        ),
      ).toBe("Womens Maxi Dress Sz S Green");
  });
});

describe("sizes", () => {
  const pants = {
    brand: "Acme",
    category: "mens_pants",
    item_type: "Chinos",
    size: "32",
    color: ["Khaki"],
  };
  it("never puts an estimated inseam or rise in the title", () => {
    expect(
      title(
        listing(
          { ...pants, category: "womens_pants", item_type: "Leggings" },
          { Inseam: ["25", 90], Rise: ["High Rise", 90] },
        ),
      ),
    ).toBe("Acme Womens Leggings Sz 32 Khaki");
    expect(
      title(
        listing(
          { ...pants, category: "womens_pants", item_type: "Leggings" },
          { Inseam: "25", Rise: "High Rise" },
        ),
      ),
    ).toBe('Acme Womens Leggings Sz 32 Khaki High Rise 25" Inseam');
  });
  it("uses W/L only when both are read from labels", () => {
    expect(title(listing(pants, { "Waist Size": "32", Inseam: "30" }))).toBe(
      "Acme Mens Chinos W32 L30 Khaki",
    );
    expect(
      title(listing(pants, { "Waist Size": "32", Inseam: ["30", 90] })),
    ).toBe("Acme Mens Chinos Sz 32 Khaki");
  });
  it("adds size types only from labels and never converts printed sizes", () => {
    const top = {
      brand: "Acme",
      category: "womens_top",
      item_type: "Blouse",
      size: "2",
      color: ["Black"],
    };
    expect(title(listing(top, { "Size Type": "Plus" }))).toBe(
      "Acme Womens Blouse Plus Sz 2 Black",
    );
    expect(title(listing(top, { "Size Type": ["Plus", 90] }))).toBe(
      "Acme Womens Blouse Sz 2 Black",
    );
    expect(title(listing(top, { "Size Type": "Regular" }))).toBe(
      "Acme Womens Blouse Sz 2 Black",
    );
  });
  it("formats one-size and non-standard shoe widths", () => {
    expect(
      title(
        listing(
          {
            brand: "Acme",
            category: "hat",
            item_type: "Beanie",
            size: "OS",
            color: ["Gray"],
          },
          { Department: "Unisex Adults" },
        ),
      ),
    ).toBe("Acme Unisex Beanie One Size Gray");
    expect(
      title(
        listing(
          {
            brand: "Acme",
            category: "mens_shoes",
            item_type: "Loafers",
            size: "11",
            color: ["Brown"],
          },
          { "Shoe Width": "EE" },
        ),
      ),
    ).toBe("Acme Mens Loafers Sz 11 EE Brown");
  });
});

describe("80-character limit", () => {
  it("drops in the approved order", () => {
    const r = buildClothingTitle(
      listing(
        {
          brand: "Abercrombie & Fitch",
          category: "mens_top",
          item_type: "Camp Collar Shirt",
          size: "XL",
          color: ["Multicolor"],
          material: "Cotton",
          search_terms: ["trevor project rainbow wave"],
        },
        {
          Collaboration: "The Trevor Project",
          Theme: ["Rainbow Wave", 90],
          Pattern: ["Wave Print", 90],
          "Sleeve Length": ["Long Sleeve", 90],
          "Style Code": "AF123456",
        },
      ),
    );
    expect(r?.dropped).toEqual([
      "extra: AF123456",
      "detail 2: Long Sleeve",
      "material: Cotton",
      "detail 1: Wave Print",
      "color: Multicolor",
      '"Sz"',
    ]);
    expect(r?.title).toBe(
      "Abercrombie & Fitch x The Trevor Project Rainbow Wave Mens Camp Collar Shirt XL",
    );
  });
  it("clips at a word boundary and flags it when protected parts alone are too long", () => {
    const r = buildClothingTitle(
      listing(
        {
          brand: "Extraordinarily Long Heritage Outfitters Company",
          category: "mens_coat",
          item_type: "Waxed Cotton Field Jacket",
          size: "XL",
          search_terms: ["northumberland bedale"],
        },
        { "Product Line": "Northumberland Bedale" },
      ),
    );
    expect(r?.shortened).toBe(true);
    expect(r!.title.length).toBeLessThanOrEqual(80);
    expect(
      "Extraordinarily Long Heritage Outfitters Company Northumberland Bedale Mens Waxed Cotton Field Jacket XL".startsWith(
        r!.title,
      ),
    ).toBe(true);
    expect(r!.title.endsWith(" ")).toBe(false);
  });
});

describe("fallback and title source", () => {
  it("falls back when there is no garment or nothing but the category", () => {
    expect(
      buildClothingTitle(listing({ brand: "Acme", category: "womens_top" }, {}))
        ?.title,
    ).toBe("Acme Womens Top");
    expect(buildClothingTitle(listing({ category: "womens_top" }))).toBeNull();
    expect(
      buildClothingTitle(listing({ brand: "", category: "", item_type: "" })),
    ).toBeNull();
    expect(
      buildClothingTitle(
        listing({ brand: "Canon", category: "camera", item_type: "Camera" }),
      ),
    ).toBeNull();
  });
  it("marks builder titles auto and keeps the AI title path for everything else", () => {
    const clothing = listing({
      brand: "Acme",
      category: "mens_top",
      item_type: "Polo Shirt",
      size: "M",
    });
    expect(initialTitle(clothing, optimizeTitle)).toEqual({
      title: "Acme Mens Polo Shirt Sz M",
      title_source: "auto",
    });
    const camera = listing({
      title: "Canon R5 Camera Body",
      brand: "Canon",
      category: "camera",
    });
    expect(initialTitle(camera, optimizeTitle)).toEqual({
      title: "Canon R5 Camera Body",
      title_source: "ai",
    });
  });
  it("rebuilds only builder titles with intact evidence after preparation", () => {
    const make = (source: ListingResult["title_source"]) => ({
      ...listing(
        {
          title: "Old",
          brand: "Acme",
          category: "mens_top",
          item_type: "Polo Shirt",
          size: "M",
        },
        { Pattern: ["Striped", 90] },
      ),
      title_source: source,
    });
    const auto = make("auto");
    refreshAutoTitle(auto);
    expect(auto.title).toBe("Acme Mens Polo Shirt Sz M Striped");
    for (const source of ["seller", "ai", undefined] as const) {
      const l = make(source);
      refreshAutoTitle(l);
      expect(l.title).toBe("Old");
    }
    const edited = { ...make("auto"), evidence: {} };
    refreshAutoTitle(edited);
    expect(edited.title).toBe("Old");
  });
});
