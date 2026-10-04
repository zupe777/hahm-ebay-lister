import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubLocalStorage, GiB } from "./helpers/quota";
import {
  ASSUMED_LIMIT,
  MIN_RESERVE,
  effectiveLimit,
  forgetLearnedLimit,
  isGenuineQuotaError,
  learnFromError,
  learnFromSuccess,
  loadLimitRecord,
  photosThatFit,
  recordQuotaFailure,
  recordSuccess,
  reserveFor,
  restoreLimitRecord,
  roomForAnother,
  storagePlan,
} from "@/lib/storage-limit";
import { classifyStorageError, PhotoError } from "@/lib/storage-health";
// Registers the IndexedDB copy of the learned limit.
import "@/lib/photo-store";

const MB = 1024 * 1024;
const quotaError = () => new DOMException("", "QuotaExceededError");
let local: Map<string, string>;

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  local = stubLocalStorage();
});
afterEach(() => vi.unstubAllGlobals());

describe("what counts as evidence", () => {
  it("only a genuine QuotaExceededError is evidence of the limit", () => {
    expect(isGenuineQuotaError(quotaError())).toBe(true);
    // As it arrives from a failed IndexedDB transaction.
    expect(isGenuineQuotaError(classifyStorageError(quotaError()))).toBe(true);
    // Errors that only look like a full disk, or are something else.
    expect(isGenuineQuotaError(new Error("disk full"))).toBe(false);
    expect(
      isGenuineQuotaError(classifyStorageError(new Error("quota exceeded"))),
    ).toBe(false);
    expect(isGenuineQuotaError(new DOMException("", "UnknownError"))).toBe(
      false,
    );
    expect(isGenuineQuotaError(new DOMException("", "AbortError"))).toBe(false);
    expect(isGenuineQuotaError(new PhotoError("decode", "bad photo"))).toBe(
      false,
    );
    expect(
      isGenuineQuotaError(new PhotoError("quota", "upgrade refused")),
    ).toBe(false);
    expect(isGenuineQuotaError(null)).toBe(false);
  });

  it("learns from a genuine failure and ignores every other error", async () => {
    const usage = async () => 311 * MB;
    expect(await learnFromError(new Error("disk full"), "import", usage)).toBe(
      false,
    );
    expect(
      await learnFromError(new DOMException("", "UnknownError"), "x", usage),
    ).toBe(false);
    expect(loadLimitRecord().learned).toBeUndefined();
    expect(
      await learnFromError(
        classifyStorageError(quotaError()),
        "photo import",
        usage,
      ),
    ).toBe(true);
    const r = loadLimitRecord();
    expect(r.learned?.bytes).toBe(311 * MB);
    expect(r.failures).toMatchObject([
      { usage: 311 * MB, context: "photo import" },
    ]);
  });
});

describe("the learned limit", () => {
  it("persists across reloads and browser restarts", async () => {
    recordQuotaFailure(311 * MB, "photo import", 1000);
    vi.resetModules();
    const fresh = await import("@/lib/storage-limit");
    expect(fresh.loadLimitRecord().learned).toEqual({
      bytes: 311 * MB,
      at: 1000,
    });
  });

  it("is restored from its IndexedDB copy if localStorage lost it", async () => {
    recordQuotaFailure(311 * MB, "autosave", 2000);
    await new Promise((r) => setTimeout(r, 20)); // mirror write settles
    local.clear();
    expect(loadLimitRecord().learned).toBeUndefined();
    const restored = await restoreLimitRecord();
    expect(restored.learned?.bytes).toBe(311 * MB);
    expect(loadLimitRecord().learned?.bytes).toBe(311 * MB);
  });

  it("a successful write above the learned limit raises it", () => {
    recordQuotaFailure(311 * MB, "photo import", 1);
    recordSuccess(300 * MB, 2);
    expect(loadLimitRecord().learned?.bytes).toBe(311 * MB);
    recordSuccess(330 * MB, 3);
    const r = loadLimitRecord();
    expect(r.learned).toEqual({ bytes: 330 * MB, at: 3, raised: true });
    expect(r.highestSuccess).toBe(330 * MB);
    expect(effectiveLimit(r).raised).toBe(true);
  });

  it("a later genuine failure at lower usage lowers it", () => {
    recordQuotaFailure(311 * MB, "photo import", 1);
    recordSuccess(330 * MB, 2);
    recordQuotaFailure(290 * MB, "autosave", 3);
    const r = loadLimitRecord();
    expect(r.learned?.bytes).toBe(290 * MB);
    expect(r.failures.map((f) => f.usage)).toEqual([311 * MB, 290 * MB]);
    expect(r.highestSuccess).toBe(330 * MB); // history is kept
  });

  it("never expires on a timer", () => {
    recordQuotaFailure(311 * MB, "photo import", Date.UTC(2026, 9, 4));
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2027, 11, 31)); // more than a year later
    const limit = effectiveLimit(loadLimitRecord(), 10 * GiB);
    vi.useRealTimers();
    expect(limit).toMatchObject({ kind: "learned", bytes: 311 * MB });
  });

  it("is forgotten only on request", () => {
    recordQuotaFailure(311 * MB, "photo import", 1);
    forgetLearnedLimit(5);
    expect(effectiveLimit(loadLimitRecord()).kind).toBe("assumed");
  });

  it("learnFromSuccess records the real usage after a write", async () => {
    await learnFromSuccess(async () => 120 * MB);
    expect(loadLimitRecord().highestSuccess).toBe(120 * MB);
  });
});

describe("limit, reserve and safe room", () => {
  it("assumes about 300 MB before any failure, labelled as assumed", () => {
    const r = loadLimitRecord();
    expect(effectiveLimit(r)).toEqual({
      bytes: ASSUMED_LIMIT,
      kind: "assumed",
    });
    expect(ASSUMED_LIMIT).toBe(300 * MB);
    // Proven capacity above the assumption raises it.
    recordSuccess(420 * MB);
    expect(effectiveLimit(loadLimitRecord()).bytes).toBe(420 * MB);
  });

  it("never uses Chrome's padded quota as capacity", () => {
    // The real observation: 302,333 bytes used, quota 10,737,720,573.
    const r = loadLimitRecord();
    const limit = effectiveLimit(r, 10_737_720_573);
    expect(limit.kind).toBe("assumed");
    const plan = storagePlan(302_333, limit, 930 * 1024);
    // About 290 photos, never "thousands".
    expect(plan.photosLeft).toBeGreaterThan(250);
    expect(plan.photosLeft).toBeLessThan(320);
    recordQuotaFailure(311 * MB, "photo import");
    const learned = effectiveLimit(loadLimitRecord(), 311 * MB + 10 * GiB);
    expect(learned).toMatchObject({ kind: "learned", bytes: 311 * MB });
  });

  it("a genuinely smaller browser-reported quota lowers the limit", () => {
    recordQuotaFailure(311 * MB, "photo import");
    expect(effectiveLimit(loadLimitRecord(), 120 * MB)).toEqual({
      bytes: 120 * MB,
      kind: "browser",
    });
  });

  it("keeps a reserve of the larger of 24 MB or 10%", () => {
    expect(reserveFor(311 * MB)).toBe(Math.round(31.1 * MB));
    expect(reserveFor(100 * MB)).toBe(MIN_RESERVE);
    expect(MIN_RESERVE).toBe(24 * MB);
    const limit = { bytes: 311 * MB, kind: "learned" as const };
    const reserve = reserveFor(311 * MB);
    // Exactly at the reserve line: no room for photos, but the reserve
    // itself stays free for autosave and listing edits.
    const full = storagePlan(311 * MB - reserve, limit, MB);
    expect(full).toMatchObject({ state: "full", photosLeft: 0, safeBytes: 0 });
    expect(roomForAnother(311 * MB - reserve - 2 * MB, limit, MB)).toBe(true);
    expect(roomForAnother(311 * MB - reserve - MB / 2, limit, MB)).toBe(false);
    const low = storagePlan(240 * MB, limit, MB);
    expect(low.state).toBe("low");
    expect(storagePlan(20 * MB, limit, MB).state).toBe("ok");
  });

  it("counts how many of a selection fit before the reserve", () => {
    const limit = { bytes: 311 * MB, kind: "learned" as const };
    const plan = storagePlan(250 * MB, limit, MB); // ~29.9 MB of safe room
    expect(photosThatFit(34, plan)).toBe(29);
    expect(photosThatFit(10, plan)).toBe(10);
    expect(photosThatFit(5, storagePlan(300 * MB, limit, MB))).toBe(0);
  });
});
