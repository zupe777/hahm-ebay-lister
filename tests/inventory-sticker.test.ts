import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import {
  applySticker,
  autoConfirmable,
  combineStickerResults,
  duplicateSku,
  interpretStickers,
  migrateLegacySku,
  sellerSku,
  skuIssues,
  stickerResult,
} from "@/lib/inventory-sticker";
import { draftIssues } from "@/lib/client-review";
import { loadDraft, saveDraft } from "@/lib/draft-store";
import type { ItemGroup, StickerResult } from "@/lib/types";

// One sticker as the model reports it.
const seen = (
  printed_number: string,
  extra: Partial<{
    handwritten_prefix: string;
    prefix_present: boolean;
    prefix_readable: boolean;
    number_readable: boolean;
    photoIndices: number[];
    confidence: number;
  }> = {},
) => ({
  printed_number,
  number_readable: true,
  prefix_present: false,
  handwritten_prefix: "",
  prefix_readable: false,
  photoIndices: [2],
  confidence: 97,
  ...extra,
});
const prefixed = (prefix: string, n: string, extra = {}) =>
  seen(n, {
    handwritten_prefix: prefix,
    prefix_present: true,
    prefix_readable: true,
    ...extra,
  });

describe("reading the inventory sticker", () => {
  it("reads printed four- and five-digit inventory numbers exactly", () => {
    expect(interpretStickers([seen("5547")], 3)).toMatchObject({
      status: "read",
      value: "5547",
      photoIndices: [2],
    });
    expect(interpretStickers([seen("12345")], 3)).toMatchObject({
      status: "read",
      value: "12345",
    });
  });

  it("keeps a handwritten prefix and hyphen before the printed number", () => {
    expect(interpretStickers([prefixed("A-", "5547")], 3)).toMatchObject({
      status: "read",
      value: "A-5547",
    });
    expect(interpretStickers([prefixed("A-", "12345")], 3).value).toBe(
      "A-12345",
    );
    // Other letter prefixes are supported for the future.
    expect(interpretStickers([prefixed("TH-", "5547")], 3).value).toBe(
      "TH-5547",
    );
  });

  it("never adds a prefix to a numbers-only sticker", () => {
    const r = interpretStickers([seen("5548")], 3);
    expect(r.value).toBe("5548");
  });

  it("never drops an unclear handwritten prefix: the SKU is left to the seller", () => {
    for (const unclear of [
      prefixed("A-", "5547", { prefix_readable: false }),
      prefixed("A", "5547"), // no hyphen as reported
      prefixed("?-", "5547"),
      seen("5547", { handwritten_prefix: "A-", prefix_present: false }),
    ]) {
      const r = interpretStickers([unclear], 3);
      expect(r.status).toBe("ambiguous");
      expect(r.value).toBeUndefined();
      expect(r.candidates ?? []).not.toContain("5547");
    }
  });

  it("leaves unreadable or non-inventory numbers unread", () => {
    for (const bad of [
      seen("554"), // 3 digits
      seen("123456"), // 6 digits
      seen("012345678905"), // UPC
      seen("55A7"),
      seen("5547", { number_readable: false }),
      seen("5547", { confidence: 70 }),
    ])
      expect(interpretStickers([bad], 3)).toMatchObject({
        status: "unreadable",
      });
  });

  it("reports no sticker when none was seen", () => {
    expect(interpretStickers([], 3)).toEqual({
      status: "none",
      photoIndices: [],
    });
    expect(interpretStickers(undefined, 3).status).toBe("none");
  });

  it("asks the seller to choose when several stickers are found", () => {
    const r = interpretStickers(
      [
        seen("5547", { photoIndices: [1] }),
        seen("5548", { photoIndices: [3] }),
      ],
      3,
    );
    expect(r).toMatchObject({
      status: "ambiguous",
      candidates: ["5547", "5548"],
      photoIndices: [1, 3],
    });
    expect(r.value).toBeUndefined();
    // A sticker plus an unreadable second sticker is also the seller's call.
    expect(
      interpretStickers(
        [seen("5547"), seen("55", { number_readable: false })],
        3,
      ).status,
    ).toBe("ambiguous");
  });

  it("the same sticker in several photos is one reading", () => {
    expect(
      interpretStickers(
        [
          seen("5547", { photoIndices: [1] }),
          seen("5547", { photoIndices: [2] }),
        ],
        3,
      ),
    ).toMatchObject({ status: "read", value: "5547", photoIndices: [1, 2] });
  });

  it("does not accept a number that also appears on a product label", () => {
    const r = interpretStickers([seen("5547")], 3, ["RN 5547", "Large"]);
    expect(r.status).toBe("ambiguous");
    expect(r.value).toBeUndefined();
    // Unrelated label numbers do not interfere.
    expect(interpretStickers([seen("5547")], 3, ["RN 55470", "M"]).status).toBe(
      "read",
    );
  });

  it("ignores photo numbers outside the photos sent", () => {
    expect(
      interpretStickers([seen("5547", { photoIndices: [0, 2, 9] })], 3)
        .photoIndices,
    ).toEqual([2]);
  });

  it("maps photo numbers to the item's photos and combines several requests", () => {
    const one = stickerResult(
      { status: "read", value: "A-5547", photoIndices: [2] },
      ["p1", "p2", "p3"],
      "read-sticker",
    );
    expect(one).toMatchObject({
      status: "read",
      value: "A-5547",
      photoIds: ["p2"],
    });
    const none = stickerResult(
      { status: "none", photoIndices: [] },
      ["p25", "p26"],
      "read-sticker",
    );
    expect(combineStickerResults([one, none], "read-sticker")).toMatchObject({
      status: "read",
      value: "A-5547",
      photoIds: ["p2"],
    });
    const other = stickerResult(
      { status: "read", value: "5548", photoIndices: [1] },
      ["p25"],
      "read-sticker",
    );
    expect(combineStickerResults([one, other], "read-sticker")).toMatchObject({
      status: "ambiguous",
      candidates: ["A-5547", "5548"],
    });
  });
});

const group = (patch: Partial<ItemGroup> = {}): ItemGroup => ({
  id: "g1",
  sku: "",
  name: "shirt",
  photoIds: ["p1", "p2", "p3"],
  status: "done",
  listing: {
    title: "Vineyard Vines Tucker Shirt",
    description: "Seller edited description",
    category_id: "57991",
    suggested_price: 22,
    item_specifics: { Brand: "Vineyard Vines" },
  },
  shipping: { fulfillmentPolicyId: "s", paymentPolicyId: "p" },
  ...patch,
});
const read = (value: string): StickerResult => ({
  status: "read",
  value,
  photoIds: ["p2"],
  source: "analysis",
  checkedAt: 1,
});
const unclear: StickerResult = {
  status: "ambiguous",
  candidates: ["5547", "5548"],
  reason: "More than one inventory sticker was found. Choose the correct one.",
  photoIds: ["p1", "p3"],
  source: "read-sticker",
  checkedAt: 2,
};

describe("the SKU is the seller's", () => {
  it("a reading without confidence evidence is only a suggestion until the seller confirms it", () => {
    const g = { ...group(), ...applySticker(group(), read("A-5547")) };
    expect(g).toMatchObject({
      sku: "A-5547",
      skuSource: "sticker",
      skuConfirmed: false,
    });
    expect(skuIssues(g)).toEqual(["Confirm the SKU before publishing."]);
    expect(draftIssues(g)).toContain("Confirm the SKU before publishing.");
    expect(skuIssues({ ...g, skuConfirmed: true })).toEqual([]);
  });

  it("a SKU reading changes only the SKU fields, never the listing", () => {
    const before = group();
    const patch = applySticker(before, read("5547"));
    expect(Object.keys(patch).sort()).toEqual(
      [
        "sku",
        "skuAutoConfirmed",
        "skuConfirmed",
        "skuSource",
        "sticker",
      ].sort(),
    );
    const typed = sellerSku("5547");
    expect(Object.keys(typed).sort()).toEqual(
      ["sku", "skuAutoConfirmed", "skuConfirmed", "skuSource"].sort(),
    );
  });

  it("a typed SKU counts as confirmed and is kept exactly", () => {
    expect(sellerSku("A-5547")).toEqual({
      sku: "A-5547",
      skuSource: "seller",
      skuConfirmed: true,
      skuAutoConfirmed: false,
    });
    expect(sellerSku("")).toEqual({
      sku: "",
      skuSource: "seller",
      skuConfirmed: false,
      skuAutoConfirmed: false,
    });
  });

  it("later readings never replace a typed or confirmed SKU", () => {
    const typed = group(sellerSku("5547"));
    expect(applySticker(typed, read("A-9999"))).toEqual({
      sticker: read("A-9999"),
    });
    const confirmed = group({
      sku: "A-5547",
      skuSource: "sticker",
      skuConfirmed: true,
    });
    expect(applySticker(confirmed, read("5548"))).toEqual({
      sticker: read("5548"),
    });
    expect(applySticker(confirmed, unclear)).toEqual({ sticker: unclear });
  });

  it("an unclear reading leaves the SKU blank, replacing only an unconfirmed suggestion", () => {
    expect(applySticker(group(), unclear)).toMatchObject({
      sku: "",
      skuConfirmed: false,
    });
    const suggested = group({
      sku: "5547",
      skuSource: "sticker",
      skuConfirmed: false,
    });
    expect(applySticker(suggested, unclear)).toMatchObject({ sku: "" });
    expect(skuIssues(group({ sticker: unclear }))[0]).toMatch(
      /More than one inventory sticker was found/,
    );
  });

  it("a published or attempted SKU never changes", () => {
    for (const locked of [
      group({ sku: "B-3bac4b907da3", postStatus: "posted", listingId: "1" }),
      group({
        sku: "5547",
        publicationAttemptSku: "5547",
        postStatus: "error",
      }),
      group({ sku: "5547", postStatus: "posting" }),
    ])
      expect(applySticker(locked, read("5548"))).toEqual({
        sticker: read("5548"),
      });
  });

  it("publishing is blocked without a valid, confirmed SKU", () => {
    expect(skuIssues(group())[0]).toMatch(/Enter the SKU/);
    expect(
      skuIssues(
        group({ sku: "55 47", skuSource: "seller", skuConfirmed: true }),
      )[0],
    ).toMatch(/no spaces/);
    expect(skuIssues(group({ sku: "5547", skuConfirmed: false }))).toEqual([
      "Confirm the SKU before publishing.",
    ]);
  });

  it("detects duplicate SKUs in the batch, ignoring letter case", () => {
    const a = group({ id: "a", sku: "A-5547" });
    const b = group({ id: "b", sku: "a-5547" });
    const c = group({ id: "c", sku: "5547" });
    expect(duplicateSku(a, [a, b, c])).toBe(true);
    expect(duplicateSku(c, [a, b, c])).toBe(false);
    // Blank SKUs are reported as missing, not as duplicates.
    const x = group({ id: "x" });
    const y = group({ id: "y" });
    expect(duplicateSku(x, [x, y])).toBe(false);
  });
});

const confident = (
  value: string,
  confidence = 97,
  fullResolution = true,
): StickerResult => ({ ...read(value), confidence, fullResolution });

describe("automatic confirmation of confident sticker readings", () => {
  it("a confident, full-resolution reading is confirmed automatically, exactly as printed", () => {
    for (const value of ["5544", "A-5544", "12345", "A-12345"]) {
      const patch = applySticker(group(), confident(value));
      expect(patch).toMatchObject({
        sku: value,
        skuSource: "sticker",
        skuConfirmed: true,
        skuAutoConfirmed: true,
      });
      const g = { ...group(), ...patch };
      expect(skuIssues(g)).toEqual([]);
      expect(draftIssues(g)).not.toContain(
        "Confirm the SKU before publishing.",
      );
    }
  });

  it("95 and above auto-confirm; 85–94 stay suggestions", () => {
    expect(autoConfirmable(confident("5544", 95))).toBe(true);
    expect(applySticker(group(), confident("5544", 95)).skuConfirmed).toBe(
      true,
    );
    for (const c of [94, 90, 85]) {
      const patch = applySticker(group(), confident("5544", c));
      expect(patch).toMatchObject({
        sku: "5544",
        skuConfirmed: false,
        skuAutoConfirmed: false,
      });
      expect(skuIssues({ ...group(), ...patch })).toEqual([
        "Confirm the SKU before publishing.",
      ]);
    }
  });

  it("reduced-resolution photos or missing evidence: suggestion only", () => {
    expect(
      applySticker(group(), confident("5544", 99, false)).skuConfirmed,
    ).toBe(false);
    // Readings saved before confidence was recorded.
    expect(autoConfirmable(read("5544"))).toBe(false);
    expect(autoConfirmable({ ...read("5544"), confidence: 99 })).toBe(false);
  });

  it("unreadable, ambiguous or no sticker never auto-confirm", () => {
    for (const s of [
      unclear,
      { ...unclear, status: "unreadable" as const, candidates: undefined },
      { ...unclear, status: "none" as const, candidates: undefined },
    ]) {
      expect(
        autoConfirmable({ ...s, confidence: 99, fullResolution: true }),
      ).toBe(false);
      expect(applySticker(group(), s)).toMatchObject({
        sku: "",
        skuConfirmed: false,
        skuAutoConfirmed: false,
      });
    }
  });

  it("a SKU another batch item already has (any letter case) is only suggested", () => {
    const g = group({ id: "g1" });
    const other = group({ id: "g2", sku: "a-5544" });
    expect(applySticker(g, confident("A-5544"), [g, other])).toMatchObject({
      sku: "A-5544",
      skuConfirmed: false,
      skuAutoConfirmed: false,
    });
    // The item itself in the batch is not a duplicate.
    expect(applySticker(g, confident("A-5544"), [g]).skuConfirmed).toBe(true);
    expect(duplicateSku({ ...g, sku: "A-5544" }, [other])).toBe(true);
  });

  it("an auto-confirmed SKU is never replaced by later readings, but stays editable", () => {
    const auto = group({
      ...applySticker(group(), confident("A-5544")),
    } as Partial<ItemGroup>);
    expect(applySticker(auto, confident("5545"))).toEqual({
      sticker: confident("5545"),
    });
    expect(applySticker(auto, unclear)).toEqual({ sticker: unclear });
    // Typing replaces it as the seller's own SKU.
    expect({ ...auto, ...sellerSku("A-5545") }).toMatchObject({
      sku: "A-5545",
      skuSource: "seller",
      skuConfirmed: true,
      skuAutoConfirmed: false,
    });
  });

  it("typed, confirmed and locked SKUs are never replaced by a confident reading", () => {
    for (const g of [
      group(sellerSku("5547")),
      group({ sku: "5547", skuSource: "sticker", skuConfirmed: true }),
      group({ sku: "5547", postStatus: "posted", listingId: "1" }),
      group({
        sku: "5547",
        publicationAttemptSku: "5547",
        postStatus: "error",
      }),
    ])
      expect(applySticker(g, confident("A-9999"))).toEqual({
        sticker: confident("A-9999"),
      });
  });

  it("confidence and resolution are kept with the reading and combined conservatively", () => {
    const r = stickerResult(
      { status: "read", value: "A-5544", photoIndices: [2], confidence: 97 },
      ["p1", "p2"],
      "read-sticker",
      true,
    );
    expect(r).toMatchObject({
      value: "A-5544",
      photoIds: ["p2"],
      confidence: 97,
      fullResolution: true,
    });
    expect(
      stickerResult(
        { status: "read", value: "5544", photoIndices: [1], confidence: 97 },
        ["p1"],
        "analysis",
      ).fullResolution,
    ).toBe(false);
    const none = stickerResult(
      { status: "none", photoIndices: [] },
      ["p25"],
      "read-sticker",
      false,
    );
    expect(combineStickerResults([r, none], "read-sticker")).toMatchObject({
      status: "read",
      value: "A-5544",
      confidence: 97,
      fullResolution: true,
    });
    const weaker = { ...r, confidence: 96, photoIds: ["p30"] };
    expect(combineStickerResults([r, weaker], "read-sticker").confidence).toBe(
      96,
    );
    const reduced = { ...r, fullResolution: false };
    expect(
      combineStickerResults([r, reduced], "read-sticker").fullResolution,
    ).toBe(false);
  });

  it("old saved suggestions are not confirmed afterwards", () => {
    const old = group({
      sku: "5544",
      skuSource: "sticker",
      skuConfirmed: false,
      sticker: read("5544"),
    });
    expect(migrateLegacySku(old)).toBe(old);
    expect(skuIssues(old)).toEqual(["Confirm the SKU before publishing."]);
  });
});

describe("drafts saved by earlier versions", () => {
  it("removes generated SKUs from unpublished items and keeps every other field", () => {
    const old = group({ sku: "B-3bac4b907da3" });
    const migrated = migrateLegacySku(old);
    expect(migrated).toEqual({
      ...old,
      sku: "",
      skuConfirmed: false,
      legacySku: "B-3bac4b907da3",
    });
    expect(migrateLegacySku(group({ sku: "K75-A-1d2e3f4a5b6c" })).sku).toBe("");
  });

  it("keeps a seller-entered SKU (unconfirmed) and never touches published items", () => {
    expect(migrateLegacySku(group({ sku: "5547" }))).toMatchObject({
      sku: "5547",
      skuConfirmed: false,
    });
    const live = group({
      sku: "B-3bac4b907da3",
      postStatus: "posted",
      listingId: "123",
    });
    expect(migrateLegacySku(live)).toBe(live);
    const attempted = group({
      sku: "B-3bac4b907da3",
      publicationAttemptSku: "B-3bac4b907da3",
      postStatus: "error",
    });
    expect(migrateLegacySku(attempted)).toBe(attempted);
    const current = group({
      sku: "A-5547",
      skuSource: "seller",
      skuConfirmed: true,
    });
    expect(migrateLegacySku(current)).toBe(current);
  });
});

describe("SKU state persists in saved batches", () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
  });
  it("restores SKU, source, confirmation and sticker; migrates only old generated SKUs", async () => {
    const confirmed = group({
      id: "confirmed",
      sku: "A-5547",
      skuSource: "sticker",
      skuConfirmed: true,
      sticker: read("A-5547"),
    });
    const legacy = group({ id: "legacy", sku: "C-0123456789ab" });
    const live = group({
      id: "live",
      sku: "B-3bac4b907da3",
      postStatus: "posted",
      listingId: "406000000000",
      publicationAttemptSku: "B-3bac4b907da3",
    });
    await saveDraft({
      photos: [],
      groups: [confirmed, legacy, live],
      orphanIds: [],
      binPrefix: "",
      skuStart: 0,
      step: "listings",
      updatedAt: 1,
    });
    const d = await loadDraft();
    const byId = Object.fromEntries(d!.groups.map((g) => [g.id, g]));
    expect(byId.confirmed).toEqual(confirmed);
    expect(byId.legacy).toEqual({
      ...legacy,
      sku: "",
      skuConfirmed: false,
      legacySku: "C-0123456789ab",
    });
    expect(byId.live).toEqual(live);
    // A second restore changes nothing further.
    await saveDraft({ ...d!, updatedAt: 2 });
    const again = await loadDraft();
    expect(again!.groups).toEqual(d!.groups);
  });
});
