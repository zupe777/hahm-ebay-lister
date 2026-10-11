import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// The AI client is mocked: nothing is sent to Anthropic or eBay.
const calls = vi.hoisted(() => ({
  params: [] as any[],
  replies: {} as Record<string, unknown>,
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
  measuredMessage: async (stage: string, _c: unknown, params: unknown) => {
    calls.params.push({ stage, params });
    return {
      content: [{ type: "text", text: JSON.stringify(calls.replies[stage]) }],
    };
  },
}));

import { analyzePhotos } from "@/lib/services/analyze";
import { readStickerPhotos } from "@/lib/services/sticker";
import { AI_LISTING_SCHEMA } from "@/lib/ai-schema";
import { buildProfiledAnalysisPrompt } from "@/lib/prompts";
import { POST as publish } from "@/app/api/ebay/publish/route";

const photo = { mediaType: "image/jpeg", data: "aGVsbG8=" };
const sticker = (n: string, prefix = "") => ({
  printed_number: n,
  number_readable: true,
  prefix_present: Boolean(prefix),
  handwritten_prefix: prefix,
  prefix_readable: Boolean(prefix),
  photoIndices: [2],
  confidence: 96,
});

beforeEach(() => {
  calls.params = [];
  calls.replies = {
    routing: { profile: "clothing" },
    analysis: {
      title: "Vineyard Vines Slim Fit Tucker Shirt Blue Pink Plaid",
      description: "Button-down shirt.",
      category: "mens_top",
      category_hint: "mens casual shirt",
      brand: "Vineyard Vines",
      item_type: "Shirt",
      color: ["Blue"],
      size: "M",
      material: "",
      condition: "EXCELLENT",
      condition_notes: "",
      measurements: "",
      suggested_price: 22,
      search_terms: [],
      seo_keywords: [],
      key_features: [],
      specifics: [],
      inventory_stickers: [sticker("5547", "A-")],
    },
  };
});

describe("analysis reads the inventory sticker", () => {
  it("asks for stickers in the schema and the prompt", () => {
    expect(AI_LISTING_SCHEMA.required).toContain("inventory_stickers");
    expect(AI_LISTING_SCHEMA.properties).toHaveProperty("inventory_stickers");
    const prompt = buildProfiledAnalysisPrompt("clothing");
    expect(prompt).toMatch(/INVENTORY STICKER/);
    expect(prompt).toMatch(/clear plastic bag/);
    expect(prompt).toMatch(/UPC/);
  });

  it("returns a reviewed sticker reading alongside the unchanged listing", async () => {
    const res = await analyzePhotos({
      images: [photo, photo],
      profile: "auto",
    });
    const body = await res.json();
    expect(body.ok).toBe(true);
    // The usual title cleanup still runs (it appends the printed size).
    expect(body.listing.title).toMatch(
      /^Vineyard Vines Slim Fit Tucker Shirt Blue Pink Plaid/,
    );
    expect(body.listing.title).not.toContain("5547");
    expect(body.listing.inventory_sticker).toMatchObject({
      status: "read",
      value: "A-5547",
      photoIndices: [2],
    });
    // The sticker is never a listing fact.
    expect(JSON.stringify(body.listing.item_specifics)).not.toContain("5547");
  });

  it("an unclear prefix is reported as ambiguous, not as the bare number", async () => {
    (calls.replies.analysis as any).inventory_stickers = [
      { ...sticker("5547", "A-"), prefix_readable: false },
    ];
    const body = await (
      await analyzePhotos({ images: [photo, photo], profile: "auto" })
    ).json();
    expect(body.listing.inventory_sticker.status).toBe("ambiguous");
    expect(body.listing.inventory_sticker.value).toBeUndefined();
  });
});

describe("Read sticker", () => {
  it("reads only the sticker with its own small schema", async () => {
    calls.replies.sticker = { inventory_stickers: [sticker("12345")] };
    const body = await (
      await readStickerPhotos({ images: [photo, photo, photo] })
    ).json();
    expect(body).toMatchObject({
      ok: true,
      sticker: { status: "read", value: "12345", photoIndices: [2] },
    });
    expect(calls.params).toHaveLength(1);
    const { stage, params } = calls.params[0];
    expect(stage).toBe("sticker");
    expect(params.output_config.format.schema.required).toEqual([
      "inventory_stickers",
    ]);
    expect(params.system).toMatch(/INVENTORY STICKER/);
    // No listing is written.
    expect(body.listing).toBeUndefined();
  });

  it("refuses an empty or oversized request without calling the AI", async () => {
    expect((await readStickerPhotos({ images: [] })).status).toBe(400);
    expect(
      (await readStickerPhotos({ images: Array(25).fill(photo) })).status,
    ).toBe(400);
    expect(calls.params).toHaveLength(0);
  });
});

describe("publishing requires a confirmed SKU", () => {
  const fetchSpy = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchSpy.mockReset();
  });
  const request = (body: unknown) =>
    new NextRequest("https://test.example/api/ebay/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const listing = { title: "Shirt", description: "Shirt" };
  it("refuses a blank or unconfirmed SKU before contacting eBay", async () => {
    for (const body of [
      { sku: "", skuConfirmed: true, listing, imageUrls: ["u"] },
      { sku: "5547", listing, imageUrls: ["u"] },
      { sku: "5547", skuConfirmed: false, listing, imageUrls: ["u"] },
    ]) {
      const res = await publish(request(body));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/confirm the SKU/i);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
