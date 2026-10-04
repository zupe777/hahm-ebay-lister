import { beforeEach, describe, expect, it, vi } from "vitest";

// The model is replaced by scripted answers; each call's request is kept.
const model = vi.hoisted(() => ({
  calls: [] as any[],
  answers: [] as unknown[],
}));
vi.mock("@/lib/anthropic", () => ({
  getClient: () => ({}),
  parseModelJson: (t: string) => JSON.parse(t),
  AnthropicAuthError: class extends Error {},
  anthropicAuthError: () => null,
}));
vi.mock("@/lib/ai-usage", () => ({
  collectUsage: async (fn: () => Promise<unknown>) => ({
    result: await fn(),
    usage: [],
  }),
  currentUsage: () => [],
  measuredMessage: async (_stage: string, _client: unknown, params: any) => {
    model.calls.push(params);
    return {
      content: [{ type: "text", text: JSON.stringify(model.answers.shift()) }],
    };
  },
}));

import {
  DETAIL_TARGETS,
  MAX_DETAIL_PHOTOS,
  mergeDetail,
  readDetailRequests,
  type DetailRequest,
} from "@/lib/detail";
import { AI_LISTING_SCHEMA } from "@/lib/ai-schema";
import { ANALYSIS_PROMPT } from "@/lib/prompts";
import { analyzePhotos, finishListing } from "@/lib/services/analyze";
import { analyzeDetail } from "@/lib/services/detail";
import { skuAfterAnalysis } from "@/lib/inventory-sticker";
import type { ItemGroup } from "@/lib/types";

beforeEach(() => {
  model.calls = [];
  model.answers = [];
  vi.stubEnv("PRICE_MARKUP_PERCENT", "");
});

const fact = (
  name: string,
  value: string,
  basis: "label" | "visible_feature" | "estimate",
  photo = 1,
  quote = basis === "label" ? value : "",
) => ({ name, value, photoIndices: [photo], basis, quote, confidence: 90 });

// A first-pass answer: blurry tag photos, a seller card, a sticker.
const firstPass = (over: Record<string, unknown> = {}) => ({
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
  specifics: [
    fact("Brand", "Nike", "estimate"),
    fact("Color", "Red", "visible_feature"),
    fact("Department", "Men", "label", 2, "MENS"),
  ],
  seller_card: { present: false, photoIndices: [], lines: [] },
  attached_tags: { visible: false, photoIndices: [] },
  inventory_sticker: {
    present: true,
    handwritten_white_sticker: true,
    readable: false,
    value: "",
    readings: [],
    photoIndices: [4],
    confidence: 20,
  },
  ...over,
});
const req = (
  photo: number,
  targets: DetailRequest["targets"],
  fields: string[] = [],
): DetailRequest => ({ photo, targets, fields, reasons: [] });
const noDetail = {
  specifics: [],
  seller_card: { present: false, lines: [] },
  inventory_sticker: {
    present: false,
    handwritten_white_sticker: false,
    readable: false,
    value: "",
    readings: [],
    confidence: 0,
  },
  flaw_notes: "",
};

describe("detail requests from the first pass", () => {
  it("are part of the analysis schema and prompt", () => {
    expect(AI_LISTING_SCHEMA.required).toContain("detail_requests");
    expect(
      (AI_LISTING_SCHEMA.properties.detail_requests as any).items.properties
        .target.enum,
    ).toEqual([...DETAIL_TARGETS]);
    expect(ANALYSIS_PROMPT).toMatch(
      /detail_requests: these photos are reduced to about 1024 px/,
    );
    expect(ANALYSIS_PROMPT).toMatch(/Request at most 4 photos/);
  });

  it("are validated, grouped per photo and capped at 4 photos", () => {
    const requests = readDetailRequests(
      {
        detail_requests: [
          {
            photo: 2,
            target: "size_tag",
            fields: ["Size"],
            reason: "tiny tag",
          },
          {
            photo: 2,
            target: "care_tag",
            fields: ["Material", "SKU"],
            reason: "",
          },
          { photo: 9, target: "size_tag", fields: [], reason: "" }, // no such photo
          { photo: 3, target: "astrology", fields: [], reason: "" }, // unknown
          { photo: 1, target: "inventory_sticker", fields: [], reason: "" },
          { photo: 4, target: "seller_card", fields: [], reason: "" },
          { photo: 5, target: "flaw", fields: [], reason: "" },
          { photo: 6, target: "brand_label", fields: ["Brand"], reason: "" },
        ],
      },
      6,
    );
    expect(MAX_DETAIL_PHOTOS).toBe(4);
    expect(requests.map((r) => r.photo)).toEqual([2, 1, 4, 5]);
    expect(requests[0]).toEqual({
      photo: 2,
      targets: ["size_tag", "care_tag"],
      fields: ["Size", "Material"], // inventory numbers are never specifics
      reasons: ["tiny tag"],
    });
    expect(readDetailRequests({ detail_requests: [] }, 3)).toEqual([]);
    expect(readDetailRequests({}, 3)).toEqual([]);
  });
});

describe("merging a follow-up: only requested details change", () => {
  it("updates requested specifics from the full-resolution read, nothing else", () => {
    const { raw, changed } = mergeDetail(
      firstPass(),
      {
        ...noDetail,
        specifics: [
          fact("Brand", "Nike", "label", 1, "NIKE"),
          fact("Size", "L", "label", 1, "L"),
          fact("Color", "Crimson", "label", 1, "CRIMSON"), // not requested
          fact("Material", "Polyester", "estimate"), // estimates never count
        ],
      },
      req(3, ["brand_label", "size_tag"]),
    );
    expect(changed).toEqual(["Brand", "Size"]);
    const specifics = raw.specifics as any[];
    expect(specifics.find((s) => s.name === "Brand")).toMatchObject({
      basis: "label",
      photoIndices: [3],
    });
    expect(specifics.find((s) => s.name === "Color").value).toBe("Red");
    expect(specifics.some((s) => s.name === "Material")).toBe(false);
    expect(raw.size).toBe("L");
  });

  it("never replaces a label reading with a weaker one", () => {
    const { raw, changed } = mergeDetail(
      firstPass(),
      {
        ...noDetail,
        specifics: [fact("Department", "Women", "visible_feature")],
      },
      req(2, ["other_text"], ["Department"]),
    );
    expect(changed).toEqual([]);
    expect(
      (raw.specifics as any[]).find((s) => s.name === "Department").value,
    ).toBe("Men");
  });

  it("accepts a measurement only when it is printed on a label", () => {
    const answer = {
      ...noDetail,
      specifics: [
        fact("Inseam", "30 in", "visible_feature"),
        fact("Waist Size", "32 in", "label", 1, "W32"),
      ],
    };
    const { changed } = mergeDetail(
      firstPass(),
      answer,
      req(2, ["measurement"], ["Inseam", "Waist Size"]),
    );
    expect(changed).toEqual(["Waist Size"]);
  });

  it("re-reads the seller card and the sticker only when they were requested", () => {
    const answer = {
      ...noDetail,
      seller_card: {
        present: true,
        lines: ["BRAND: Gap", "CUSTOM LABEL (SKU): A-1013"],
      },
      inventory_sticker: {
        present: true,
        handwritten_white_sticker: true,
        readable: true,
        value: "1009",
        readings: ["1009"],
        confidence: 95,
      },
      flaw_notes: "Small hole near the left hem.",
    };
    const unrequested = mergeDetail(firstPass(), answer, req(4, ["size_tag"]));
    expect(unrequested.changed).toEqual([]);
    expect((unrequested.raw.seller_card as any).present).toBe(false);
    const requested = mergeDetail(
      firstPass(),
      answer,
      req(4, ["seller_card", "inventory_sticker", "flaw"]),
    );
    expect(requested.changed).toEqual([
      "seller card",
      "inventory sticker",
      "condition notes",
    ]);
    expect(requested.raw.seller_card).toEqual({
      present: true,
      photoIndices: [4],
      lines: ["BRAND: Gap", "CUSTOM LABEL (SKU): A-1013"],
    });
    expect((requested.raw.inventory_sticker as any).photoIndices).toEqual([4]);
    expect(requested.raw.condition_notes).toBe("Small hole near the left hem.");
  });

  it("an unreadable re-read keeps the first reading", () => {
    const { raw, changed } = mergeDetail(
      firstPass(),
      noDetail,
      req(4, ["inventory_sticker", "size_tag"]),
    );
    expect(changed).toEqual([]);
    expect(raw.inventory_sticker).toEqual(firstPass().inventory_sticker);
  });
});

describe("precedence after a follow-up", () => {
  it("seller-card values still win over a sharper label reading, and the conflict is shown", () => {
    const raw = firstPass({
      seller_card: { present: true, photoIndices: [5], lines: ["BRAND: Gap"] },
    });
    const { raw: merged } = mergeDetail(
      raw,
      {
        ...noDetail,
        specifics: [fact("Brand", "Old Navy", "label", 1, "OLD NAVY")],
      },
      req(3, ["brand_label"]),
    );
    const listing = finishListing(merged, 5, "clothing");
    expect(listing.brand).toBe("Gap");
    expect(listing.card_specifics).toContain("Brand");
    expect(listing.conflicts?.[0]).toMatchObject({
      name: "Brand",
      kept: "Gap",
      other: "Old Navy",
    });
  });

  it("SKU precedence stays manual > card > sticker > blank", () => {
    const answer = {
      ...noDetail,
      inventory_sticker: {
        present: true,
        handwritten_white_sticker: true,
        readable: true,
        value: "1009",
        readings: ["1009"],
        confidence: 96,
      },
    };
    const sticker = finishListing(
      mergeDetail(firstPass(), answer, req(4, ["inventory_sticker"])).raw,
      5,
      "clothing",
    );
    expect(sticker.inventory_label).toMatchObject({
      status: "read",
      value: "1009",
    });
    const auto: ItemGroup = {
      id: "g",
      sku: "",
      name: "x",
      photoIds: [],
      status: "writing",
    };
    expect(skuAfterAnalysis(auto, sticker)).toEqual({
      sku: "1009",
      skuSource: "sticker",
    });
    // The seller's own SKU is final.
    expect(
      skuAfterAnalysis(
        { ...auto, sku: "MINE-1", skuSource: "seller" },
        sticker,
      ),
    ).toEqual({ sku: "MINE-1", skuSource: "seller" });
    // A card Custom Label beats the sticker.
    const card = finishListing(
      mergeDetail(
        firstPass({
          seller_card: {
            present: true,
            photoIndices: [5],
            lines: ["CUSTOM LABEL (SKU): A-1013"],
          },
        }),
        answer,
        req(4, ["inventory_sticker"]),
      ).raw,
      5,
      "clothing",
    );
    expect(skuAfterAnalysis(auto, card)).toEqual({
      sku: "A-1013",
      skuSource: "card",
    });
  });
});

describe("the analysis and follow-up requests", () => {
  const img = (data: string) => ({ mediaType: "image/jpeg", data });

  it("the first pass returns requests (and the raw answer) only when it needs them", async () => {
    model.answers = [
      { ...firstPass(), detail_requests: [] },
      {
        ...firstPass(),
        detail_requests: [
          {
            photo: 2,
            target: "size_tag",
            fields: ["Size"],
            reason: "tag too small",
          },
        ],
      },
    ];
    const body = { images: [img("aaaa"), img("bbbb")], profile: "clothing" };
    const plain = await (await analyzePhotos(body)).json();
    expect(plain.ok).toBe(true);
    expect(plain.detailRequests).toBeUndefined();
    expect(plain.raw).toBeUndefined();
    const asked = await (await analyzePhotos(body)).json();
    expect(asked.detailRequests).toEqual([
      {
        photo: 2,
        targets: ["size_tag"],
        fields: ["Size"],
        reasons: ["tag too small"],
      },
    ]);
    expect(asked.raw.detail_requests).toBeUndefined();
    expect(asked.profile).toBe("clothing");
    expect(asked.photoCount).toBe(2);
  });

  it("the follow-up sends only the master image and returns the rebuilt listing", async () => {
    model.answers = [
      { ...noDetail, specifics: [fact("Size", "XL", "label", 1, "XL")] },
    ];
    const master = Buffer.from("full-resolution-master").toString("base64");
    const res = await analyzeDetail({
      raw: firstPass(),
      profile: "clothing",
      photoCount: 5,
      request: req(3, ["size_tag"], ["Size"]),
      image: img(master),
    });
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.changed).toEqual(["Size"]);
    expect(body.listing.item_specifics.Size).toBe("XL");
    expect(body.listing.evidence.Size).toEqual([3]);
    // One image, the master, at full resolution.
    const content = model.calls[0].messages[0].content;
    const images = content.filter((b: any) => b.type === "image");
    expect(images).toHaveLength(1);
    expect(images[0].source.data).toBe(master);
    expect(model.calls[0].system).toMatch(
      /Read ONLY these details from this photo: size_tag/,
    );
    expect(model.calls[0].system).toMatch(/SELLER INFORMATION CARD:/);
    expect(model.calls[0].system).toMatch(/INVENTORY STICKER:/);
  });

  it("rejects malformed follow-up requests", async () => {
    for (const bad of [
      null,
      {
        raw: firstPass(),
        profile: "clothing",
        photoCount: 5,
        request: req(9, ["size_tag"]),
        image: img("x"),
      },
      {
        raw: firstPass(),
        profile: "clothing",
        photoCount: 5,
        request: { photo: 1, targets: ["bogus"] },
        image: img("x"),
      },
      {
        raw: firstPass(),
        profile: "clothing",
        photoCount: 5,
        request: req(1, ["size_tag"]),
        image: { mediaType: "text/html", data: "x" },
      },
    ]) {
      const res = await analyzeDetail(bad);
      expect(res.status).toBe(400);
    }
    expect(model.calls).toHaveLength(0);
  });
});
