import { beforeEach, describe, expect, it, vi } from "vitest";

// The AI client is mocked: nothing is sent to Anthropic or eBay.
const calls = vi.hoisted(() => ({
  params: [] as any[],
  reply: {} as unknown,
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
      content: [{ type: "text", text: JSON.stringify(calls.reply) }],
    };
  },
}));

import {
  DESCRIPTION_RULES,
  cleanGeneratedDescription,
  descriptionHtml,
  inventoryDescription,
} from "@/lib/description";
import { buildProfiledAnalysisPrompt } from "@/lib/prompts";
import { describeFacts, improveDescription } from "@/lib/services/describe";
import type { ListingResult } from "@/lib/types";

const structured = `Vineyard Vines Slim Fit Tucker shirt in a blue and pink plaid — a classic button-down (button-up) shirt for everyday or preppy looks.

Product Details:
- Brand: Vineyard Vines
- Tagged size: M
- Material: 100% cotton (per tag)
- Long sleeves with button cuffs

Condition:
Pre-owned in very good condition. Small light mark on the left cuff.

Measurements:
See photos for measurements.`;

describe("generated descriptions keep their structure", () => {
  it("keeps paragraphs, section lines and bullets", () => {
    expect(cleanGeneratedDescription(structured)).toBe(structured);
  });

  it("still removes internal review wording without losing flaws", () => {
    expect(
      cleanGeneratedDescription(
        "Shirt.\n\nCondition:\nPreliminary used cosmetic condition with a small hole at the cuff.\nSeller to verify.\n\n• Cotton\n* Size M",
      ),
    ).toBe(
      "Shirt.\n\nCondition:\nA small hole at the cuff.\n\n- Cotton\n- Size M",
    );
  });

  it("collapses runs of blank lines and stray spaces only", () => {
    expect(cleanGeneratedDescription("One.  Two.\n\n\n\nThree\t four.")).toBe(
      "One. Two.\n\nThree four.",
    );
  });
});

describe("safe HTML for eBay", () => {
  it("turns paragraphs, sections and bullets into simple HTML", () => {
    const html = descriptionHtml(structured);
    expect(html).toMatch(/^<div style="[^"]+">/);
    expect(html).toContain(
      '<h3 style="font-size:17px;margin:18px 0 6px;">Product Details</h3>',
    );
    expect(html).toContain(">Brand: Vineyard Vines</li>");
    expect(html).toContain(">Condition</h3>");
    expect(html.match(/<li /g)).toHaveLength(4);
    expect(html.match(/<p /g)).toHaveLength(3);
    // Only these tags ever appear.
    const tags = [...html.matchAll(/<\/?([a-z0-9]+)/g)].map((m) => m[1]);
    expect(new Set(tags)).toEqual(new Set(["div", "p", "h3", "ul", "li"]));
  });

  it("escapes every special character; no active content can get through", () => {
    const html = descriptionHtml(
      `<script>alert("x")</script>\n- <img src=x onerror=alert(1)>\nTom & Jerry's "best" tee <a href="javascript:alert(1)">link</a>`,
    );
    expect(html).not.toMatch(/<script|<img|<a |<iframe|<style|<link/i);
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("Tom &amp; Jerry&#39;s &quot;best&quot; tee");
    const tags = [...html.matchAll(/<\/?([a-z0-9]+)/g)].map((m) => m[1]);
    expect(
      tags.every((t) => ["div", "p", "h3", "ul", "li", "br"].includes(t)),
    ).toBe(true);
  });

  it("existing one-paragraph drafts still convert, line breaks kept", () => {
    expect(descriptionHtml("Blue shirt. Small mark on cuff.")).toBe(
      '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#222;max-width:900px;"><p style="margin:0 0 12px;">Blue shirt. Small mark on cuff.</p></div>',
    );
    expect(descriptionHtml("Line one\nLine two")).toContain(
      "Line one<br>Line two",
    );
    expect(descriptionHtml("   \n ")).toBe("");
    // "Condition: Excellent" on one line is text, not a section heading.
    expect(descriptionHtml("Condition: Excellent")).toContain(
      '<p style="margin:0 0 12px;">Condition: Excellent</p>',
    );
  });

  it("the inventory record gets the HTML when it fits, plain text otherwise", () => {
    expect(inventoryDescription(structured)).toBe(descriptionHtml(structured));
    const long = Array.from({ length: 600 }, (_, i) => `word${i}`).join(" ");
    const r = inventoryDescription(long);
    expect(r.length).toBeLessThanOrEqual(4000);
    expect(r).not.toContain("<");
    expect(r.endsWith("…")).toBe(true);
  });
});

// An "&" that does not start a complete escaped character.
const brokenEntity = /&(?!(?:amp|lt|gt|quot|#39);)/;

describe("the inventory record's shortened copy (4,000 characters)", () => {
  const long = (n: number) =>
    `<script>alert("x")</script> Tom & Jerry's "best" tee <b>bold</b>\n\n` +
    Array.from({ length: n }, (_, i) => `- detail ${i} & more <ok>`).join("\n");

  it("escapes markup, stays within the limit and ends on a whole word", () => {
    const text = long(400);
    expect(descriptionHtml(text).length).toBeGreaterThan(4000);
    const r = inventoryDescription(text);
    expect(r.length).toBeLessThanOrEqual(4000);
    expect(r).not.toMatch(/[<>]/);
    expect(r).not.toMatch(/<script|<b>/i);
    expect(
      r.startsWith(
        "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; Tom &amp; Jerry&#39;s &quot;best&quot; tee &lt;b&gt;bold&lt;/b&gt;",
      ),
    ).toBe(true);
    expect(r).not.toMatch(brokenEntity);
    expect(r.endsWith("…")).toBe(true);
    expect(r).not.toMatch(/\s…$/);
  });

  it("never cuts an escaped character in half, even without spaces", () => {
    for (let k = 0; k < 6; k++) {
      const r = inventoryDescription("x".repeat(k) + "&".repeat(5000));
      expect(r.length).toBeLessThanOrEqual(4000);
      expect(r).not.toMatch(brokenEntity);
      expect(r.endsWith("&amp;…")).toBe(true);
    }
    const quotes = inventoryDescription(`'"<>`.repeat(2000));
    expect(quotes.length).toBeLessThanOrEqual(4000);
    expect(quotes).not.toMatch(/[<>"']/);
    expect(quotes).not.toMatch(brokenEntity);
  });

  it("escaped text that fits is kept whole", () => {
    // HTML too long (many bullets) but the escaped text fits.
    const text = Array.from({ length: 120 }, (_, i) => `- A & ${i}`).join("\n");
    expect(descriptionHtml(text).length).toBeGreaterThan(4000);
    const r = inventoryDescription(text);
    expect(r).toBe(text.replace(/&/g, "&amp;"));
  });

  it("the buyer-facing HTML is never shortened", () => {
    const text = long(400);
    const html = descriptionHtml(text);
    expect(html.length).toBeGreaterThan(20000);
    expect(html).toContain(">detail 399 &amp; more &lt;ok&gt;</li>");
  });
});

describe("description writing instructions", () => {
  it("clothing gets the full structure and clothing details", () => {
    const p = buildProfiledAnalysisPrompt("clothing");
    expect(p).toContain(DESCRIPTION_RULES);
    for (const s of [
      "Product Details:",
      "Condition:",
      "Measurements:",
      "fiber percentages",
      "neckline or collar",
      "country of manufacture",
      "care instructions",
      "Never invent measurements",
      "keyword list",
      "at most once",
    ])
      expect(p).toContain(s);
  });

  it("other categories do not get clothing fields", () => {
    const hard = buildProfiledAnalysisPrompt("hard_goods");
    expect(hard).toContain("testing status");
    expect(hard).toContain("Do not use clothing fields");
    expect(hard).not.toContain("neckline or collar");
    expect(buildProfiledAnalysisPrompt("media")).toContain("ISBN");
    expect(buildProfiledAnalysisPrompt("collectibles")).toContain("franchise");
  });

  it("measurements only when supplied or shown with a tape", () => {
    expect(DESCRIPTION_RULES).toContain(
      'only when the seller supplied measurements (state them exactly as given) or when photos show the item with a measuring tape or ruler (then write exactly "See photos for measurements.")',
    );
  });
});

const draft: ListingResult = {
  title: "Vineyard Vines Slim Fit Tucker Shirt Blue Pink Plaid M",
  description: "Shirt. Small light mark on the left cuff.",
  brand: "Vineyard Vines",
  item_type: "Shirt",
  size: "M",
  color: ["Blue", "Pink"],
  material: "Cotton",
  condition_notes: "Small light mark on the left cuff",
  ebay_condition: "PRE_OWNED_EXCELLENT",
  category_id: "57991",
  item_profile: "clothing",
  suggested_price: 22,
  item_specifics: {
    Brand: "Vineyard Vines",
    Size: "M",
    Fit: "Slim",
    Pattern: "Plaid",
  },
  search_terms: ["Tucker shirt"],
};

describe("Improve description", () => {
  beforeEach(() => {
    calls.params = [];
    calls.reply = { description: structured };
  });

  it("uses the draft's latest facts, separating estimated specifics", () => {
    const facts = describeFacts(draft, {
      condition: "Pre-owned Excellent",
      category: "Casual Button-Down Shirts",
      estimated: ["Fit"],
    });
    expect(facts.item_specifics).toEqual({
      Brand: "Vineyard Vines",
      Size: "M",
      Pattern: "Plaid",
    });
    expect(facts.estimated_specifics).toEqual({ Fit: "Slim" });
    expect(facts.condition).toBe("Pre-owned Excellent");
    expect(facts.current_description).toBe(draft.description);
    expect(facts.title).toBe(draft.title);
  });

  it("returns only a proposed description built from the current draft", async () => {
    const res = await improveDescription({
      listing: draft,
      condition: "Pre-owned Excellent",
      category: "Casual Button-Down Shirts",
      estimated: ["Fit"],
      images: [{ mediaType: "image/jpeg", data: "aGVsbG8=" }],
    });
    const body = await res.json();
    expect(body).toEqual({ ok: true, description: structured, usage: [] });
    expect(calls.params).toHaveLength(1);
    const { stage, params } = calls.params[0];
    expect(stage).toBe("describe");
    expect(params.output_config.format.schema.required).toEqual([
      "description",
    ]);
    expect(params.system).toContain(DESCRIPTION_RULES);
    expect(params.system).toContain("keep every flaw");
    const text = params.messages[0].content.at(-1).text;
    expect(text).toContain(
      '"current_description": "Shirt. Small light mark on the left cuff."',
    );
    expect(text).toContain('"condition": "Pre-owned Excellent"');
    expect(text).toContain('"estimated_specifics": {\n    "Fit": "Slim"');
    expect(params.messages[0].content[0].type).toBe("image");
  });

  it("works from the facts alone and keeps the structure of the reply", async () => {
    calls.reply = {
      description:
        "Opening.\n\nProduct Details:\n• Cotton\n\nCondition:\nPreliminary cosmetic grade with a small mark.",
    };
    const body = await (await improveDescription({ listing: draft })).json();
    expect(body.description).toBe(
      "Opening.\n\nProduct Details:\n- Cotton\n\nCondition:\nA small mark.",
    );
    expect(calls.params[0].params.messages[0].content).toHaveLength(1);
  });

  it("refuses bad input without calling the AI", async () => {
    expect((await improveDescription({ listing: { title: "" } })).status).toBe(
      400,
    );
    expect(
      (
        await improveDescription({
          listing: draft,
          images: Array(25).fill({ mediaType: "image/jpeg", data: "aGVsbG8=" }),
        })
      ).status,
    ).toBe(400);
    expect(calls.params).toHaveLength(0);
  });
});
