import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installQuota,
  stubLocalStorage,
  stubLocks,
  type Quota,
} from "./helpers/quota";

// Canvas work needs a browser; here it is replaced by deterministic stand-ins
// (the real image rules are tested below with fake encoders and in a real
// browser in browser/storage.spec.ts).
const resizeMock = vi.hoisted(() => ({
  analysisCalls: [] as Blob[],
  masterCalls: [] as Blob[],
}));
vi.mock("@/lib/resize", async (orig) => ({
  ...(await orig<typeof import("@/lib/resize")>()),
  resizeForAnalysis: async (b: Blob) => {
    resizeMock.analysisCalls.push(b);
    return new Blob([`analysis-of-${b.size}`], { type: "image/jpeg" });
  },
  masterFromImage: async (b: Blob) => {
    resizeMock.masterCalls.push(b);
    return {
      blob: new Blob([`made-master-${b.size}`], { type: "image/jpeg" }),
      width: 2000,
      height: 1500,
      quality: 0.88,
    };
  },
}));

import {
  base64ToBlob,
  blobToBase64,
  cleanupUnreferenced,
  convertPhotos,
  deletePhotoData,
  getMaster,
  getThumb,
  photoStats,
  photosToConvert,
  releasePhotos,
  savePhoto,
  sortOutUnreferenced,
  storedPhotoIds,
  SETTLE_ATTEMPTS,
  UPGRADE_REFUSED,
  type ConvertDeps,
} from "@/lib/photo-store";
import { clearDraft, loadDraft, saveDraft } from "@/lib/draft-store";
import {
  analysisImages,
  detailImage,
  thumbnailImages,
  uploadImageBlob,
  uploadImages,
} from "@/lib/photo-payloads";
import {
  ANALYSIS_DIM,
  ANALYSIS_QUALITY,
  MASTER_MAX_DIM,
  MASTER_STEPS,
  MASTER_TARGET_BYTES,
  THUMB_DIM,
  THUMB_QUALITY,
  UPLOAD_MAX_BASE64,
  chooseMaster,
  scaleDown,
} from "@/lib/resize";
import {
  classifyStorageError,
  describeError,
  estimateStorage,
  formatBytes,
  requestPersistence,
} from "@/lib/storage-health";
import {
  FULL_REASON,
  importReason,
  processFiles,
  ReserveReached,
  RESERVE_REASON,
  stopsImport,
  summarizeImport,
} from "@/lib/intake";
import {
  effectiveLimit,
  learnFromError,
  learnFromSuccess,
  loadLimitRecord,
  roomForAnother,
  storagePlan,
} from "@/lib/storage-limit";
import { conversionNote } from "@/lib/photo-conversion";
import {
  livePreviewCount,
  loadPreview,
  revokeAllPreviews,
  revokePreview,
  setPreview,
} from "@/lib/photo-previews";
import type { ItemGroup } from "@/lib/types";

let quota: Quota | undefined;
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  stubLocalStorage();
  resizeMock.analysisCalls = [];
  resizeMock.masterCalls = [];
});
afterEach(() => {
  quota?.restore();
  quota = undefined;
  vi.unstubAllGlobals();
  revokeAllPreviews();
});

const KB = 1024;
// Synthetic images: real Blobs with distinct, checkable content. "JPEGs"
// start with the JPEG marker so the stand-in verifier accepts them.
const bytes = (n: number, seed: number) =>
  Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff);
const jpeg = (n: number, seed: number) => {
  const b = bytes(Math.max(n, 3), seed);
  b.set([0xff, 0xd8, 0xff]);
  return new Blob([b], { type: "image/jpeg" });
};
const sameBytes = async (a?: Blob, b?: Blob) =>
  Boolean(a && b) &&
  Buffer.from(await a!.arrayBuffer()).equals(
    Buffer.from(await b!.arrayBuffer()),
  );
const quotaError = () => new DOMException("", "QuotaExceededError");

// Conversion stand-ins: a master about 27% of its source (a 3.3 MB phone
// photo → ~0.9 MB master), a small thumbnail, and a decode check.
const unreadable = new Set<number>();
const badMasters = new Set<number>();
function deps(extra: Partial<ConvertDeps> = {}): ConvertDeps & {
  made: number[];
} {
  const made: number[] = [];
  return {
    made,
    makeMaster: async (blob, withThumb) => {
      if (unreadable.has(blob.size)) throw new Error("cannot decode");
      made.push(blob.size);
      const master = jpeg(
        Math.max(16, Math.round(blob.size * 0.27)),
        blob.size,
      );
      return {
        blob: master,
        ...(withThumb
          ? { thumb: jpeg(Math.max(8, Math.round(blob.size * 0.01)), 7) }
          : {}),
      };
    },
    makeThumb: async (blob) =>
      jpeg(Math.max(8, Math.round(blob.size * 0.03)), 9),
    verify: async (blob) => {
      const head = new Uint8Array(await blob.slice(0, 3).arrayBuffer());
      return head[0] === 0xff && head[1] === 0xd8 && !badMasters.has(blob.size);
    },
    ...extra,
  };
}
beforeEach(() => {
  unreadable.clear();
  badMasters.clear();
});

// ── Seeding databases written by earlier versions ───────────────────────────

function openVersion(version: number, stores: string[]): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open("listing-writer-drafts", version);
    r.onupgradeneeded = () => {
      for (const s of stores)
        if (!r.result.objectStoreNames.contains(s))
          r.result.createObjectStore(s);
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function put(
  db: IDBDatabase,
  store: string,
  entries: [string, unknown][],
) {
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    for (const [k, v] of entries) tx.objectStore(store).put(v, k);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

const groups: ItemGroup[] = [
  {
    id: "g1",
    sku: "A-1013",
    skuSource: "seller",
    name: "red-shorts",
    photoIds: ["v-0", "v-1", "v-2"],
    status: "done",
    listing: {
      title: "Nike Mens Shorts Sz L Red",
      description: "Flaw: 1-inch tear under right arm.",
      seller_specifics: ["Brand"],
      item_specifics: { Brand: "Nike", Size: "L" },
      card_specifics: ["Size"],
      evidence: { Size: [2] },
      seller_card: {
        photoIndices: [2],
        fields: {
          FLAW: "1-inch tear under right arm",
          "CUSTOM LABEL": "A-1013",
        },
      },
      inventory_label: { status: "read", value: "1001", photoIndices: [3] },
      suggested_price: 24.99,
      price_source: "seller",
    },
    preparation: { categoryId: "15690" } as any,
  },
  {
    id: "g2",
    sku: "B-7",
    name: "posted-tee",
    photoIds: ["v-3"],
    status: "done",
    postStatus: "posted",
    listingId: "1234567890",
    listing: { title: "Tee", description: "" },
  },
];
const workspace = (ids: string[], version = 2) => ({
  version,
  photos: ids.map((id) => ({ id, mediaType: "image/jpeg", size: 3300 * KB })),
  groups,
  orphanIds: [],
  binPrefix: "",
  skuStart: 0,
  step: "listings",
  updatedAt: 1,
});

// The version-4 format (the user's real database): original + ~1024 px
// analysis + thumbnail per photo.
async function seedV4(n: number, originalBytes = 33 * KB, ids?: string[]) {
  const db = await openVersion(4, [
    "workspace",
    "photos",
    "assets",
    "originals",
    "analysis",
    "thumbs",
  ]);
  const keys = ids ?? Array.from({ length: n }, (_, i) => `v-${i}`);
  await put(
    db,
    "originals",
    keys.map((k, i) => [k, jpeg(originalBytes + i * 100, i)]),
  );
  await put(
    db,
    "analysis",
    keys.map((k, i) => [k, jpeg(2 * KB, i + 50)]),
  );
  await put(
    db,
    "thumbs",
    keys.map((k, i) => [k, jpeg(300, i + 90)]),
  );
  await put(db, "workspace", [["current", workspace(keys)]]);
  db.close();
  return keys;
}

// The version-3 base64 format.
const b64 = (n: number, seed: number) =>
  Buffer.from(bytes(n, seed)).toString("base64");
async function seedV3(
  photos: { id: string; original?: Blob; uploadData?: string }[],
  ids = photos.map((p) => p.id),
) {
  const db = await openVersion(3, ["workspace", "photos", "assets"]);
  await put(
    db,
    "photos",
    photos.map((p, i) => [
      p.id,
      {
        id: p.id,
        data: b64(4000, i),
        previewUrl: `data:image/jpeg;base64,${b64(600, i + 100)}`,
        mediaType: "image/jpeg",
      },
    ]),
  );
  await put(
    db,
    "assets",
    photos.map((p) => [
      p.id,
      { original: p.original, uploadData: p.uploadData },
    ]),
  );
  await put(db, "workspace", [["current", workspace(ids, 1)]]);
  db.close();
}

async function storeKeys(store: string): Promise<string[]> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open("listing-writer-drafts");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  try {
    if (!db.objectStoreNames.contains(store)) return [];
    return await new Promise((resolve) => {
      const r = db.transaction(store).objectStore(store).getAllKeys();
      r.onsuccess = () => resolve(r.result.map(String).sort());
    });
  } finally {
    db.close();
  }
}

// ── New photos ───────────────────────────────────────────────────────────────

describe("photo storage: one master and one thumbnail per photo", () => {
  it("stores the master and thumbnail as Blobs, byte for byte, and nothing else", async () => {
    const p = { master: jpeg(900 * KB, 1), thumb: jpeg(30 * KB, 2) };
    await savePhoto("a", p);
    expect(await sameBytes(await getMaster("a"), p.master)).toBe(true);
    expect(await sameBytes(await getThumb("a"), p.thumb)).toBe(true);
    expect(await storeKeys("masters")).toEqual(["a"]);
    expect(await storeKeys("thumbs")).toEqual(["a"]);
    for (const s of ["originals", "analysis", "photos", "assets"])
      expect(await storeKeys(s)).toEqual([]);
  });

  it("uploads the exact stored master bytes to eBay — never compressed again", async () => {
    const master = jpeg(870 * KB, 3);
    await savePhoto("m", { master, thumb: jpeg(10, 1) });
    expect(await sameBytes(await uploadImageBlob("m"), master)).toBe(true);
    const [payload] = await uploadImages(["m"]);
    expect(payload.data).toBe(await blobToBase64(master));
    expect((await detailImage("m")).data).toBe(await blobToBase64(master));
    expect(resizeMock.masterCalls).toHaveLength(0);
  });

  it("makes the 1024 px AI image from the master on demand and never stores it", async () => {
    const master = jpeg(800 * KB, 4);
    await savePhoto("m", { master, thumb: jpeg(10, 1) });
    const [img] = await analysisImages(["m"]);
    expect(await sameBytes(resizeMock.analysisCalls[0], master)).toBe(true);
    expect(Buffer.from(img.data, "base64").toString()).toBe(
      `analysis-of-${800 * KB}`,
    );
    expect(await storeKeys("analysis")).toEqual([]);
    // Sorting uses thumbnails.
    expect((await thumbnailImages(["m"]))[0].data).toBe(
      await blobToBase64(jpeg(10, 1)),
    );
    await expect(analysisImages(["nope"])).rejects.toThrow(
      /missing from browser storage/,
    );
  });

  it("restores after refresh, cleans up only unreferenced data, deletes every copy", async () => {
    const ids = Array.from({ length: 400 }, (_, i) => `s-${i}`);
    for (const [i, id] of ids.entries())
      await savePhoto(id, { master: jpeg(3000 + i, i), thumb: jpeg(100, i) });
    await savePhoto("stray", { master: jpeg(10, 1), thumb: jpeg(10, 2) });
    await saveDraft({
      photos: ids.map((id) => ({
        id,
        previewUrl: "",
        mediaType: "image/jpeg",
      })),
      groups: [],
      orphanIds: [],
      binPrefix: "",
      skuStart: 0,
      step: "upload",
      updatedAt: 1,
    });
    const d = await loadDraft();
    expect(d?.photos).toHaveLength(400);
    expect(await sameBytes(await getMaster("s-399"), jpeg(3399, 399))).toBe(
      true,
    );
    expect(
      await cleanupUnreferenced(new Set(d!.photos.map((p) => p.id))),
    ).toEqual(["stray"]);
    await deletePhotoData(ids.slice(0, 20));
    expect((await storedPhotoIds()).size).toBe(380);
    expect(await getMaster("s-0")).toBeUndefined();
    expect(await getThumb("s-0")).toBeUndefined();
    const stats = await photoStats();
    expect(stats.masters).toBe(380);
    expect(stats.avgPhotoBytes).toBeCloseTo(3000 + 209.5 + 100, 0);
  });
});

// ── The real-world failure: 34 photos, only 6 fit ──────────────────────────

describe("import at the storage limit", () => {
  // The app's import step for one file (app/page.tsx), with a quota.
  function importer(photoBytes: number) {
    let n = 0;
    return async (file: File) => {
      const id = `new-${n++}-${file.name}`;
      // Decoding and encoding take a moment, so the second worker is always
      // mid-photo when the first one hits the limit (as in the real failure).
      await new Promise((r) => setTimeout(r, 5));
      try {
        await savePhoto(id, {
          master: jpeg(photoBytes, n),
          thumb: jpeg(Math.round(photoBytes / 30), n),
        });
      } catch (e) {
        await learnFromError(e, "photo import");
        throw e;
      }
      return id;
    };
  }
  const files = (count: number) =>
    Array.from(
      { length: count },
      (_, i) => ({ name: `IMG_${i + 1}.jpg` }) as File,
    );

  it("adds 6 of 34 and accounts for all 28 others, including the 2 in flight", async () => {
    const photo = 34 * KB;
    // Room for exactly 6 photos (master + thumbnail) and a little more.
    quota = installQuota(6 * (photo + Math.round(photo / 30)) + 10 * KB);
    const result = await processFiles(files(34), importer(photo), {
      reasonOf: importReason,
      stopOn: stopsImport,
    });
    expect(result.values).toHaveLength(6);
    const counts = { added: 0, failed: 0, skipped: 0 };
    for (const o of result.outcomes) counts[o.status]++;
    // Two photos were already being prepared when storage filled.
    expect(counts).toEqual({ added: 6, failed: 2, skipped: 26 });
    expect(result.summary).toBe(
      "Added 6 of 34 photos. 28 were not added because browser storage is full.",
    );
    // The genuine QuotaExceededError became the learned limit.
    const r = loadLimitRecord();
    expect(r.learned?.bytes).toBe(quota.usage());
    expect(r.failures[0].context).toBe("photo import");
    // What was stored is intact and nothing half-written remains.
    expect((await storeKeys("masters")).length).toBe(6);
    expect((await storeKeys("thumbs")).length).toBe(6);
  });

  it("stops at the reserve line before Chrome's limit, and says why", async () => {
    const photo = 100 * KB;
    const limit = { bytes: 2400 * KB, kind: "learned" as const };
    // Simulated reserve check as in app/page.tsx (reserve here: 24 MB is
    // larger than this tiny limit, so scale it via a custom check).
    quota = installQuota(10_000 * KB);
    let stored = 0;
    const reserve = 600 * KB;
    const result = await processFiles(
      files(20),
      async (f) => {
        // As in app/page.tsx: photos in flight count against the room left.
        if (stored + photo > limit.bytes - reserve) throw new ReserveReached();
        stored += photo + 10;
        await savePhoto(f.name, { master: jpeg(photo, 1), thumb: jpeg(10, 1) });
        return f.name;
      },
      { reasonOf: importReason, stopOn: stopsImport },
    );
    expect(result.values).toHaveLength(17);
    expect(result.summary).toBe(
      `Added 17 of 20 photos. 3 were not added (IMG_18.jpg, IMG_19.jpg, IMG_20.jpg) because ${RESERVE_REASON}.`,
    );
    // Autosave still has room: the reserve was never used.
    await expect(
      saveDraft({
        photos: [],
        groups,
        orphanIds: [],
        binPrefix: "",
        skuStart: 0,
        step: "upload",
        updatedAt: 2,
      }),
    ).resolves.toBeUndefined();
  });

  it("counts photos left out before the import by the plan, and failures by reason", () => {
    const summary = summarizeImport(
      [
        { status: "added", name: "a.jpg", value: 1 },
        {
          status: "failed",
          name: "b.heic",
          reason: importReason(new Error("x")),
        },
        {
          status: "failed",
          name: "c.jpg",
          reason: importReason(classifyStorageError(quotaError())),
        },
      ],
      [{ count: 5, reason: RESERVE_REASON }],
    );
    expect(summary).toMatch(/^Added 1 of 8 photos\./);
    expect(summary).toContain("1 was not added (b.heic) because of an error");
    expect(summary).toContain(
      `1 was not added (c.jpg) because ${FULL_REASON}.`,
    );
    expect(summary).toContain(`5 were not added because ${RESERVE_REASON}.`);
    expect(
      summarizeImport([{ status: "added", name: "a", value: 1 }]),
    ).toBeNull();
  });

  it("the import plan uses the learned limit with real stored-photo averages", () => {
    const limit = effectiveLimit(
      {
        version: 1,
        learned: { bytes: 311 * 1024 * KB, at: 1 },
        failures: [],
        highestSuccess: 0,
        updatedAt: 1,
      },
      311 * 1024 * KB + 10 * 1024 ** 3,
    );
    const plan = storagePlan(0, limit, 930 * KB);
    // (311 MB − 31.1 MB reserve) / 0.93 MB ≈ 308 photos.
    expect(plan.photosLeft).toBe(308);
    expect(roomForAnother(278 * 1024 * KB, limit, 930 * KB)).toBe(true);
    expect(roomForAnother(280 * 1024 * KB, limit, 930 * KB)).toBe(false);
  });
});

// ── Autosave at the limit ────────────────────────────────────────────────────

describe("autosave at or near the limit", () => {
  it("fails with a classified, learned quota error, then succeeds once space is freed", async () => {
    const ids = ["p1", "p2", "p3"];
    quota = installQuota(Infinity);
    for (const id of ids)
      await savePhoto(id, { master: jpeg(50 * KB, 1), thumb: jpeg(KB, 1) });
    quota.limit = quota.usage(); // exactly full
    const draft = {
      photos: ids.map((id) => ({
        id,
        previewUrl: "",
        mediaType: "image/jpeg",
      })),
      groups,
      orphanIds: [],
      binPrefix: "",
      skuStart: 0,
      step: "listings" as const,
      updatedAt: 1,
    };
    const err = await saveDraft(draft).catch((e) => e);
    expect(err).toMatchObject({ kind: "quota" });
    expect(await learnFromError(err, "autosave")).toBe(true);
    expect(loadLimitRecord().learned?.bytes).toBe(quota.usage());
    // Removing one photo frees space; the retried save succeeds and the
    // successful write is recorded.
    await deletePhotoData(["p3"]);
    await expect(
      saveDraft({ ...draft, photos: draft.photos.slice(0, 2) }),
    ).resolves.toBeUndefined();
    await learnFromSuccess();
    expect(loadLimitRecord().highestSuccess).toBe(quota.usage());
    expect((await loadDraft())?.groups).toEqual(groups);
  });
});

// ── Converting the real version-4 database, including while full ───────────

describe("conversion of photos saved by earlier versions", () => {
  it("converts while already essentially full, keeping every listing detail", async () => {
    const ids = await seedV4(30);
    // Measure the seeded database, then fix the limit just above it: not
    // even one master fits until something is deleted.
    quota = installQuota(Infinity);
    const before = await loadDraft();
    // Count what the seeded database holds.
    for (const id of ids) {
      const o = await (await import("@/lib/photo-store")).bestImage(id);
      quota.sizes.set(`originals/${id}`, o!.blob.size);
      quota.sizes.set(`analysis/${id}`, 2 * KB);
      quota.sizes.set(`thumbs/${id}`, 300);
    }
    const full = quota.usage();
    quota.limit = full + 1 * KB; // less than one master (~9 KB)
    const d = deps();
    const r = await convertPhotos(ids, d);
    expect(r).toMatchObject({ converted: 30, remaining: 0, unreadable: [] });
    expect(r.paused).toBeUndefined();
    // Recreatable 1024 px copies were deleted first to make working space.
    expect(r.freedRecreatable).toBe(30);
    expect(await storeKeys("masters")).toEqual([...ids].sort());
    expect(await storeKeys("thumbs")).toEqual([...ids].sort());
    expect(await storeKeys("originals")).toEqual([]);
    expect(await storeKeys("analysis")).toEqual([]);
    expect(quota.usage()).toBeLessThan(full * 0.4);
    // Listing data never changes.
    const after = await loadDraft();
    expect(after?.groups).toEqual(before?.groups);
    expect(after?.photos.map((p) => p.id)).toEqual(ids);
    // The master is what eBay receives.
    const master = await getMaster("v-0");
    expect(await sameBytes(await uploadImageBlob("v-0"), master)).toBe(true);
    expect(await photosToConvert()).toEqual([]);
  });

  it("pauses safely when there is no working space at all, deleting nothing but recreatable copies", async () => {
    const ids = await seedV4(5);
    // No recreatable copies to free.
    const db = await openVersion(4, []);
    await new Promise<void>((resolve) => {
      const tx = db.transaction("analysis", "readwrite");
      tx.objectStore("analysis").clear();
      tx.oncomplete = () => resolve();
    });
    db.close();
    quota = installQuota(Infinity);
    for (const id of ids) {
      quota.sizes.set(`originals/${id}`, 33 * KB);
      quota.sizes.set(`thumbs/${id}`, 300);
    }
    quota.limit = quota.usage(); // full
    const r = await convertPhotos(ids, deps());
    expect(r).toMatchObject({ converted: 0, remaining: 5, paused: "quota" });
    expect(await storeKeys("originals")).toEqual([...ids].sort());
    expect(await storeKeys("masters")).toEqual([]);
    expect(loadLimitRecord().failures.at(-1)?.context).toBe("photo conversion");
    expect(conversionNote(r)).toMatch(
      /paused: browser storage is full\. 5 photos still use the older, larger format and remain fully usable — nothing was deleted\. To continue, remove a few photos/,
    );
    // Every photo is still usable meanwhile: previews, analysis, upload.
    expect(await getThumb("v-1")).toBeDefined();
    expect((await analysisImages(["v-1"])).length).toBe(1);
    await uploadImageBlob("v-1");
    expect(resizeMock.masterCalls).toHaveLength(1); // made for the upload only
    // The seller removes one photo; conversion resumes and finishes.
    await deletePhotoData(["v-4"]);
    const again = await convertPhotos(ids.slice(0, 4), deps());
    expect(again).toMatchObject({ converted: 4, remaining: 0 });
  });

  it("resumes after the tab closed before a master was written", async () => {
    const ids = await seedV4(4);
    const d = deps({
      checkpoint: (step, id) => {
        if (step === "before-write" && id === "v-2")
          throw new Error("tab closed");
      },
    });
    const first = await convertPhotos(ids, d);
    expect(first).toMatchObject({
      converted: 2,
      paused: "error",
      remaining: 2,
    });
    expect(await getMaster("v-2")).toBeUndefined();
    expect(await storeKeys("originals")).toEqual(["v-2", "v-3"]);
    const second = await convertPhotos(ids, deps());
    expect(second).toMatchObject({ converted: 4, remaining: 0 });
    expect(await storeKeys("originals")).toEqual([]);
  });

  it("resumes after the tab closed between writing a master and deleting the original", async () => {
    const ids = await seedV4(3);
    const first = await convertPhotos(
      ids,
      deps({
        checkpoint: (step, id) => {
          if (step === "after-write" && id === "v-1")
            throw new Error("tab closed");
        },
      }),
    );
    expect(first.paused).toBe("error");
    // Both exist: the old original was not deleted early.
    expect(await getMaster("v-1")).toBeDefined();
    expect(await storeKeys("originals")).toEqual(["v-1", "v-2"]);
    const masterBefore = await getMaster("v-1");
    const d = deps();
    const second = await convertPhotos(ids, d);
    expect(second).toMatchObject({ converted: 3, remaining: 0 });
    // v-1's verified master was kept, not made again.
    expect(d.made).toHaveLength(1); // only v-2
    expect(await sameBytes(await getMaster("v-1"), masterBefore)).toBe(true);
    expect(await storeKeys("originals")).toEqual([]);
  });

  it("an unreadable original is left exactly as stored; the others convert", async () => {
    const ids = await seedV4(3);
    unreadable.add(33 * KB + 100); // v-1's original
    const r = await convertPhotos(ids, deps());
    expect(r).toMatchObject({
      converted: 2,
      unreadable: ["v-1"],
      remaining: 0,
    });
    expect(await storeKeys("originals")).toEqual(["v-1"]);
    expect(await getMaster("v-1")).toBeUndefined();
    expect(conversionNote(r)).toMatch(
      /1 photo saved by an earlier version could not be read/,
    );
  });

  it("a master that does not read back correctly is discarded and the original kept", async () => {
    const ids = await seedV4(2);
    badMasters.add(Math.round((33 * KB + 100) * 0.27)); // v-1's master
    const r = await convertPhotos(ids, deps());
    expect(r.unreadable).toEqual(["v-1"]);
    expect(await getMaster("v-1")).toBeUndefined();
    expect(await storeKeys("originals")).toEqual(["v-1"]);
  });

  it("waits for Chrome to release freed space, then continues instead of pausing", async () => {
    const ids = await seedV4(4);
    // Chrome credits deleted data's space a few seconds late: the first two
    // master writes are refused as full.
    const realPut = IDBObjectStore.prototype.put;
    let refusals = 2;
    IDBObjectStore.prototype.put = function (value: any, key?: any) {
      const r = realPut.call(this, value, key);
      if (this.name === "masters" && refusals > 0) {
        refusals--;
        const tx = this.transaction as any;
        queueMicrotask(() => tx._abort("QuotaExceededError"));
      }
      return r;
    };
    const settles: number[] = [];
    try {
      const r = await convertPhotos(
        ids,
        deps({ settle: async (attempt) => void settles.push(attempt) }),
      );
      expect(r).toMatchObject({ converted: 4, remaining: 0 });
      expect(r.paused).toBeUndefined();
    } finally {
      IDBObjectStore.prototype.put = realPut;
    }
    expect(settles).toEqual([0, 1]);
    expect(SETTLE_ATTEMPTS).toBe(8);
    expect(await storeKeys("originals")).toEqual([]);
  });

  it("pauses after the settle attempts are used up", async () => {
    const ids = await seedV4(2);
    const realPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value: any, key?: any) {
      const r = realPut.call(this, value, key);
      if (this.name === "masters") {
        const tx = this.transaction as any;
        queueMicrotask(() => tx._abort("QuotaExceededError"));
      }
      return r;
    };
    const settles: number[] = [];
    try {
      const r = await convertPhotos(
        ids,
        deps({ settle: async (attempt) => void settles.push(attempt) }),
      );
      expect(r).toMatchObject({ converted: 0, remaining: 2, paused: "quota" });
    } finally {
      IDBObjectStore.prototype.put = realPut;
    }
    expect(settles).toHaveLength(SETTLE_ATTEMPTS);
    expect(await storeKeys("originals")).toEqual(["v-0", "v-1"]);
  });

  it("only one tab converts at a time", async () => {
    stubLocks();
    const ids = await seedV4(6);
    const [a, b] = await Promise.all([
      convertPhotos(ids, deps()),
      convertPhotos(ids, deps()),
    ]);
    const busy = [a, b].filter((r) => r.busy);
    expect(busy).toHaveLength(1);
    expect([a, b].find((r) => !r.busy)).toMatchObject({ converted: 6 });
    expect(await storeKeys("masters")).toHaveLength(6);
    expect(await storeKeys("originals")).toEqual([]);
  });

  it("converts the version-3 base64 format directly to masters", async () => {
    await seedV3([
      { id: "o-0", original: jpeg(40 * KB, 1), uploadData: b64(9000, 2) },
      // No original left: the old 2400 px upload copy is the best source.
      { id: "o-1", uploadData: b64(9000, 3) },
    ]);
    const before = await loadDraft();
    expect(before?.groups).toEqual(groups);
    const d = deps();
    const r = await convertPhotos(["o-0", "o-1"], d);
    expect(r).toMatchObject({ converted: 2, remaining: 0 });
    expect(d.made).toEqual([40 * KB, 9000]);
    for (const s of ["photos", "assets", "originals", "analysis"])
      expect(await storeKeys(s)).toEqual([]);
    expect(await storeKeys("thumbs")).toEqual(["o-0", "o-1"]);
    expect((await loadDraft())?.groups).toEqual(groups);
  });

  it("when the browser refuses the storage upgrade, old photos stay usable and conversion pauses", async () => {
    const ids = await seedV4(2);
    const realCreate = IDBDatabase.prototype.createObjectStore;
    IDBDatabase.prototype.createObjectStore = function () {
      throw quotaError();
    };
    try {
      const d = await loadDraft();
      expect(d?.groups[0].sku).toBe("A-1013");
      const r = await convertPhotos(ids, deps());
      expect(r.paused).toBe("upgrade");
      expect(r.error?.message).toBe(UPGRADE_REFUSED);
      expect(await storeKeys("originals")).toEqual(ids);
      await expect(
        savePhoto("new", { master: jpeg(1, 1), thumb: jpeg(1, 1) }),
      ).rejects.toMatchObject({ kind: "quota", message: UPGRADE_REFUSED });
    } finally {
      IDBDatabase.prototype.createObjectStore = realCreate;
    }
    expect((await convertPhotos(ids, deps())).converted).toBe(2);
  });

  it("embedded photos from the oldest format are stored, converted, and never dropped", async () => {
    const db = await openVersion(3, ["workspace", "photos", "assets"]);
    await put(db, "workspace", [
      [
        "current",
        {
          version: 1,
          photos: [
            {
              id: "x",
              data: b64(300, 1),
              previewUrl: `data:image/jpeg;base64,${b64(50, 2)}`,
              mediaType: "image/jpeg",
              uploadData: b64(900, 3),
            },
          ],
          groups: [],
          orphanIds: [],
          binPrefix: "",
          skuStart: 0,
          step: "upload",
          updatedAt: 1,
        },
      ],
    ]);
    db.close();
    const d = await loadDraft();
    expect(d?.photos).toEqual([{ id: "x", mediaType: "image/jpeg" }]);
    expect(await photosToConvert()).toEqual(["x"]);
    expect((await convertPhotos(["x"], deps())).converted).toBe(1);
    expect(await getMaster("x")).toBeDefined();
    await clearDraft();
  });
});

// ── Photos whose autosave failed are never lost ─────────────────────────────

describe("photos stored but not yet listed by a saved workspace", () => {
  it("are kept and added back on the next start, with their names, in order", async () => {
    const draft = (ids: string[]) => ({
      photos: ids.map((id) => ({
        id,
        previewUrl: "",
        mediaType: "image/jpeg",
      })),
      groups,
      orphanIds: [],
      binPrefix: "",
      skuStart: 0,
      step: "review" as const,
      updatedAt: 1,
    });
    await savePhoto(
      "a",
      { master: jpeg(100, 1), thumb: jpeg(10, 1) },
      { name: "IMG_1.jpg", size: 4_800_000 },
    );
    await saveDraft(draft(["a"]));
    // Two more photos are stored, then the autosave fails (storage full).
    await savePhoto(
      "b",
      { master: jpeg(100, 2), thumb: jpeg(10, 2) },
      { name: "IMG_2.jpg", size: 4_700_000 },
    );
    await new Promise((r) => setTimeout(r, 5));
    await savePhoto(
      "c",
      { master: jpeg(100, 3), thumb: jpeg(10, 3) },
      { name: "IMG_3.jpg" },
    );
    // Next start: the saved workspace lists only "a".
    const d = await loadDraft();
    const sorted = await sortOutUnreferenced(
      new Set(d!.photos.map((p) => p.id)),
    );
    expect(sorted.removed).toEqual([]);
    expect(sorted.adopted.map((p) => [p.id, p.name, p.size])).toEqual([
      ["b", "IMG_2.jpg", 4_700_000],
      ["c", "IMG_3.jpg", undefined],
    ]);
    expect(await getMaster("b")).toBeDefined();
    // Once a saved workspace lists them, they are no longer pending.
    await saveDraft(draft(["a", "b", "c"]));
    expect(await storeKeys("pending")).toEqual([]);
    expect(
      (await sortOutUnreferenced(new Set(["a", "b", "c"]))).adopted,
    ).toEqual([]);
  });

  it("adopts version-4 photos missing from the workspace (the seller's 91 vs 85), removes only unusable leftovers", async () => {
    // 4 photos stored; the workspace lists 3 (its last save failed).
    await seedV4(4, 33 * KB, ["v-0", "v-1", "v-2", "v-3"]);
    const db = await openVersion(4, []);
    await put(db, "workspace", [["current", workspace(["v-0", "v-1", "v-2"])]]);
    // Leftovers: an old-format record of a removed photo, and a thumbnail
    // with no image of its own.
    await put(db, "photos", [["gone", { id: "gone", data: b64(10, 1) }]]);
    await put(db, "thumbs", [["thumb-only", jpeg(10, 1)]]);
    db.close();
    const d = await loadDraft();
    const sorted = await sortOutUnreferenced(
      new Set(d!.photos.map((p) => p.id)),
    );
    expect(sorted.adopted.map((p) => p.id)).toEqual(["v-3"]);
    expect(sorted.removed.sort()).toEqual(["gone", "thumb-only"]);
    expect(await storeKeys("originals")).toEqual(["v-0", "v-1", "v-2", "v-3"]);
  });
});

// ── Releasing photos of posted items ─────────────────────────────────────────

describe("release photos of posted items", () => {
  it("removes only the large copies; thumbnails and listing data stay", async () => {
    await savePhoto("posted", {
      master: jpeg(900 * KB, 1),
      thumb: jpeg(KB, 2),
    });
    await savePhoto("unposted", {
      master: jpeg(900 * KB, 3),
      thumb: jpeg(KB, 4),
    });
    await saveDraft({
      photos: [
        { id: "posted", previewUrl: "", mediaType: "image/jpeg" },
        { id: "unposted", previewUrl: "", mediaType: "image/jpeg" },
      ],
      groups,
      orphanIds: [],
      binPrefix: "",
      skuStart: 0,
      step: "listings",
      updatedAt: 1,
    });
    await releasePhotos(["posted"]);
    expect(await getMaster("posted")).toBeUndefined();
    expect(await getThumb("posted")).toBeDefined();
    expect(await getMaster("unposted")).toBeDefined();
    expect((await loadDraft())?.groups).toEqual(groups);
    await expect(uploadImageBlob("posted")).rejects.toThrow(/missing/);
    // A startup cleanup never treats the kept thumbnail as unused.
    expect(await cleanupUnreferenced(new Set(["posted", "unposted"]))).toEqual(
      [],
    );
  });
});

// ── Image rules ──────────────────────────────────────────────────────────────

describe("master image rules", () => {
  // A fake encoder whose output size depends on dimensions and quality.
  function encoder(bytesAt: (dim: number, q: number) => number) {
    const calls: [number, number][] = [];
    return {
      calls,
      encode: async (dim: number, q: number) => {
        calls.push([dim, q]);
        return { size: bytesAt(dim, q) } as Blob;
      },
    };
  }

  it("uses the constants that were approved", () => {
    expect(MASTER_MAX_DIM).toBe(2000);
    expect(MASTER_TARGET_BYTES).toBe(900 * KB);
    expect(MASTER_STEPS).toEqual([
      [2000, 0.88],
      [2000, 0.85],
      [2000, 0.82],
      [2000, 0.8],
      [1900, 0.8],
      [1800, 0.8],
    ]);
    expect(Math.min(...MASTER_STEPS.map(([, q]) => q))).toBe(0.8);
    expect([ANALYSIS_DIM, ANALYSIS_QUALITY]).toEqual([1024, 0.82]);
    expect([THUMB_DIM, THUMB_QUALITY]).toEqual([360, 0.5]);
    expect(UPLOAD_MAX_BASE64).toBe(2_700_000);
    expect(scaleDown(4032, 3024, 2000)).toEqual({ width: 2000, height: 1500 });
    expect(scaleDown(3024, 4032, 2000)).toEqual({ width: 1500, height: 2000 });
  });

  it("keeps 2000 px at 0.88 when that is already about 0.9 MB or less", async () => {
    const e = encoder(() => 700 * KB);
    const m = await chooseMaster(e.encode, 4032, 3024);
    expect(e.calls).toEqual([[2000, 0.88]]);
    expect(m).toMatchObject({ width: 2000, height: 1500, quality: 0.88 });
  });

  it("lowers quality step by step, never below 0.80, before shrinking toward 1800 px", async () => {
    const e = encoder((dim, q) => Math.round(dim * dim * q * 0.3));
    // 2000²·q·0.3: 0.88→1.06M, 0.85→1.02M, 0.82→0.98M, 0.80→0.96M (all >
    // 921,600); 1900²·0.8·0.3 = 866K fits.
    const m = await chooseMaster(e.encode, 4032, 3024);
    expect(e.calls).toEqual([
      [2000, 0.88],
      [2000, 0.85],
      [2000, 0.82],
      [2000, 0.8],
      [1900, 0.8],
    ]);
    expect(m).toMatchObject({ width: 1900, height: 1425, quality: 0.8 });
  });

  it("keeps the 1800 px / 0.80 image when nothing reaches the target but it uploads", async () => {
    const e = encoder(() => 1_500_000);
    const m = await chooseMaster(e.encode, 6000, 4000);
    expect(m).toMatchObject({ width: 1800, height: 1200, quality: 0.8 });
    expect(e.calls).toHaveLength(6);
  });

  it("never enlarges a smaller photo, and skips steps that would repeat", async () => {
    const e = encoder(() => 950 * KB);
    const m = await chooseMaster(e.encode, 1200, 900);
    // 2000/1900/1800 at 0.80 are the same 1200×900 image: encoded once.
    expect(e.calls).toEqual([
      [2000, 0.88],
      [2000, 0.85],
      [2000, 0.82],
      [2000, 0.8],
    ]);
    expect(m).toMatchObject({ width: 1200, height: 900 });
  });

  it("shrinks further only when an image still could not be uploaded", async () => {
    const e = encoder((dim) => (dim >= 1800 ? 2_100_000 : 1_000_000));
    const m = await chooseMaster(e.encode, 4000, 3000);
    expect(m.width).toBe(1600);
    await expect(
      chooseMaster(encoder(() => 3e6).encode, 4000, 3000),
    ).rejects.toThrow(/too large/);
  });
});

// ── Errors, health and previews ──────────────────────────────────────────────

describe("storage errors, health and previews", () => {
  it("classifies errors with meaningful messages, even when the browser gives none", () => {
    expect(classifyStorageError(quotaError()).kind).toBe("quota");
    expect(describeError(quotaError())).toMatch(/Browser storage is full/);
    expect(
      classifyStorageError(new DOMException("x", "SecurityError")).kind,
    ).toBe("unavailable");
    expect(classifyStorageError(new DOMException("", "AbortError")).kind).toBe(
      "transaction",
    );
    expect(describeError(null)).toMatch(/could not store/);
  });

  it("works when estimate() or persist() are unavailable or persistence is denied", async () => {
    vi.stubGlobal("navigator", {});
    expect(await estimateStorage()).toBeNull();
    expect(await requestPersistence()).toBeNull();
    vi.stubGlobal("navigator", {
      storage: {
        persisted: async () => false,
        persist: async () => false,
        estimate: async () => ({ usage: 302_333, quota: 10_737_720_573 }),
      },
    });
    expect(await requestPersistence()).toBe(false);
    expect(formatBytes(311 * 1024 * KB)).toBe("311 MB");
  });

  it("previews come from thumbnails and their object URLs are revoked", async () => {
    const created: string[] = [];
    const revoked: string[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
      created.push(`blob:${created.length}`);
      return created.at(-1)!;
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(
      (u) => void revoked.push(u),
    );
    await savePhoto("t", { master: jpeg(100, 1), thumb: jpeg(10, 2) });
    expect(await loadPreview("t")).toBe("blob:0");
    setPreview("t", jpeg(1, 2)); // replacing revokes the old URL
    setPreview("b", jpeg(1, 3));
    expect(revoked).toEqual(["blob:0"]);
    revokePreview("t");
    expect(livePreviewCount()).toBe(1);
    revokeAllPreviews();
    expect(livePreviewCount()).toBe(0);
    expect(revoked.sort()).toEqual(["blob:0", "blob:1", "blob:2"]);
    vi.restoreAllMocks();
  });

  it("base64 conversion is lossless both ways", async () => {
    const original = jpeg(70_001, 5);
    expect(
      await sameBytes(base64ToBlob(await blobToBase64(original)), original),
    ).toBe(true);
  });
});
