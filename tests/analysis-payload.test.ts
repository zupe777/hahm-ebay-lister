import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stubLocalStorage } from "./helpers/quota";

// The canvas resize is replaced by a size-faithful stand-in: the output size
// scales with the pixel count and quality of each step. At 1024 px / 0.82 a
// detailed clothing photo measured about 245 KB of base64 in Chromium.
const calls = vi.hoisted(() => ({ steps: [] as string[], scale: 1 }));
vi.mock("@/lib/resize", async (orig) => {
  const real = await orig<typeof import("@/lib/resize")>();
  return {
    ...real,
    resizeForAnalysis: async (
      _b: Blob,
      dim = real.ANALYSIS_DIM,
      quality = real.ANALYSIS_QUALITY,
    ) => {
      calls.steps.push(`${dim}@${quality}`);
      const base = 183_000; // bytes at 1024 px / 0.82 ≈ 245 KB base64
      const bytes = Math.round(
        base * calls.scale * (dim / 1024) ** 2 * (quality / 0.82) ** 2,
      );
      return new Blob([new Uint8Array(bytes)], { type: "image/jpeg" });
    },
  };
});

import { savePhoto } from "@/lib/photo-store";
import {
  ANALYSIS_BUDGET_BASE64,
  analysisImages,
  fitAnalysisImages,
} from "@/lib/photo-payloads";
import { ANALYSIS_STEPS, fullAnalysisSize } from "@/lib/resize";
import {
  ANALYSIS_DATA_TOO_LARGE,
  ANALYSIS_REQUEST_LIMIT,
  TOO_MANY_ANALYSIS_PHOTOS,
  imagesProblem,
} from "@/lib/validation";
import { analyzePhotos } from "@/lib/services/analyze";
import { needsWriting, retryTargets, writeState } from "@/lib/write-status";
import type { ItemGroup } from "@/lib/types";

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  stubLocalStorage();
  calls.steps = [];
  calls.scale = 1;
});

const jpeg = (n: number) => {
  const b = new Uint8Array(n);
  b.set([0xff, 0xd8, 0xff]);
  return new Blob([b], { type: "image/jpeg" });
};
async function item(n: number) {
  const ids = Array.from({ length: n }, (_, i) => `p${i}`);
  for (const id of ids)
    await savePhoto(id, { master: jpeg(600_000), thumb: jpeg(1000) });
  return ids;
}
const totalBase64 = (images: { data: string }[]) =>
  images.reduce((n, i) => n + i.data.length, 0);

describe("analysis images fit one request without dropping photos", () => {
  it("an item that fits is sent unchanged, at 1024 px", async () => {
    const r = await fitAnalysisImages(await item(6));
    expect(r.step).toBe(0);
    expect(r.images).toHaveLength(6);
    expect(new Set(calls.steps)).toEqual(new Set(["1024@0.82"]));
  });

  it("the 18-photo item that used to fail now fits, with all 18 photos", async () => {
    const ids = await item(18);
    const r = await fitAnalysisImages(ids);
    // At 1024 px it would be ~4.4 MB, over the server's limit.
    expect(18 * 245_000).toBeGreaterThan(ANALYSIS_REQUEST_LIMIT);
    expect(r.images).toHaveLength(18);
    expect(r.step).toBeGreaterThan(0);
    expect(totalBase64(r.images)).toBe(r.base64);
    expect(r.base64).toBeLessThanOrEqual(ANALYSIS_BUDGET_BASE64);
    expect(ANALYSIS_BUDGET_BASE64).toBeLessThan(ANALYSIS_REQUEST_LIMIT * 0.8);
    // Every photo was remade at the same, smallest sufficient step.
    const [dim, q] = ANALYSIS_STEPS[r.step];
    expect(calls.steps.filter((s) => s === `${dim}@${q}`)).toHaveLength(18);
    // And the server accepts it.
    expect(imagesProblem(r.images)).toBeNull();
  });

  it("24 photos still fit; 25 are refused with a clear message, nothing sent", async () => {
    const r = await fitAnalysisImages(await item(24));
    expect(r.images).toHaveLength(24);
    expect(r.base64).toBeLessThanOrEqual(ANALYSIS_BUDGET_BASE64);
    calls.steps = [];
    await expect(analysisImages(await item(25))).rejects.toThrow(
      "This item has 25 photos selected for AI analysis; the AI can analyze at most 24 per item. Untick 1 or more of this item's photos for AI analysis (keep labels, tags and flaws), then retry.",
    );
    expect(calls.steps).toEqual([]);
  });

  it("refuses clearly, never silently trims, when even the smallest step is too large", async () => {
    // Photos so detailed that 24 are over the budget at every step.
    calls.scale = 12;
    const ids = await item(24);
    await expect(fitAnalysisImages(ids)).rejects.toThrow(
      "These 24 photos are too much data for one AI request even at reduced detail. Untick some of this item's photos for AI analysis, then retry.",
    );
    // Every step was tried before giving up.
    expect(new Set(calls.steps).size).toBe(ANALYSIS_STEPS.length);
  });
});

describe("full analysis size for automatic SKU confirmation", () => {
  it("lower JPEG quality at 1024 px still counts as full size; smaller dimensions do not", () => {
    expect(ANALYSIS_STEPS[1][0]).toBe(1024);
    expect([0, 1].map(fullAnalysisSize)).toEqual([true, true]);
    expect(
      ANALYSIS_STEPS.slice(2).map((_, i) => fullAnalysisSize(i + 2)),
    ).toEqual(ANALYSIS_STEPS.slice(2).map(() => false));
    expect(fullAnalysisSize(99)).toBe(false);
  });

  it("an item that only needs lower quality keeps full size; one that needs smaller photos does not", async () => {
    // 13 photos: over budget at 1024 px / 0.82, fits at 1024 px / 0.72.
    const quality = await fitAnalysisImages(await item(13));
    expect(quality.step).toBe(1);
    expect(fullAnalysisSize(quality.step)).toBe(true);
    // 24 photos need smaller dimensions.
    const smaller = await fitAnalysisImages(await item(24));
    expect(ANALYSIS_STEPS[smaller.step][0]).toBeLessThan(1024);
    expect(fullAnalysisSize(smaller.step)).toBe(false);
  });
});

describe("the server explains a refused photo set", () => {
  const img = (chars: number) => ({
    mediaType: "image/jpeg",
    data: "A".repeat(chars),
  });
  it("names the reason instead of 'Invalid request body.'", () => {
    expect(imagesProblem(Array.from({ length: 25 }, () => img(10)))).toBe(
      TOO_MANY_ANALYSIS_PHOTOS,
    );
    expect(imagesProblem(Array.from({ length: 18 }, () => img(245_000)))).toBe(
      ANALYSIS_DATA_TOO_LARGE,
    );
    expect(imagesProblem([img(10)])).toBeNull();
    expect(imagesProblem(undefined)).toBe("Invalid request body.");
  });

  it("/api/analyze answers the 18-photo, 4.4 MB request with the reason", async () => {
    const res = await analyzePhotos({
      images: Array.from({ length: 18 }, () => img(245_000)),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      ok: false,
      error: ANALYSIS_DATA_TOO_LARGE,
    });
  });
});

describe("which listings a retry may write", () => {
  const g = (id: string, patch: Partial<ItemGroup>): ItemGroup => ({
    id,
    sku: "",
    name: id,
    photoIds: ["x"],
    status: "idle",
    ...patch,
  });
  const groups = [
    g("written", { status: "done", listing: { title: "T", description: "" } }),
    g("failed", { status: "error", error: "Too large" }),
    g("never", { status: "idle" }),
    g("writing", { status: "writing" }),
    g("cloud", { status: "idle", cloudBatchId: "b1" }),
    g("empty", { status: "idle", photoIds: [] }),
  ];

  it("labels each state", () => {
    expect(groups.map(writeState)).toEqual([
      "written",
      "failed",
      "not-written",
      "writing",
      "not-written",
      "not-written",
    ]);
  });

  it("only not-written or failed items are ever retried; written ones never", () => {
    expect(groups.filter(needsWriting).map((x) => x.id)).toEqual([
      "failed",
      "never",
    ]);
    expect(
      retryTargets(groups, ["written", "failed", "writing", "cloud", "never"]),
    ).toEqual(["failed", "never"]);
    expect(retryTargets(groups, ["written"])).toEqual([]);
  });
});
