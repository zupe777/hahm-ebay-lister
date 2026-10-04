import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// eBay upload copies need a canvas; the decision of WHICH source is used is
// tested here, the image sizing rules separately (and in a real browser).
const resizeMock = vi.hoisted(() => ({
  calls: [] as Blob[],
}));
vi.mock("@/lib/resize", async (orig) => ({
  ...(await orig<typeof import("@/lib/resize")>()),
  uploadImageFromOriginal: async (b: Blob) => {
    resizeMock.calls.push(b);
    return new Blob(["upload-from-original"], { type: "image/jpeg" });
  },
}));

import {
  base64ToBlob,
  blobToBase64,
  cleanupUnreferenced,
  deleteOriginals,
  deletePhotoData,
  getPhotoBlob,
  legacyPhotoIds,
  migrateLegacyPhotos,
  savePhotoBlobs,
  storedPhotoIds,
  UPGRADE_REFUSED,
} from "@/lib/photo-store";
import { clearDraft, loadDraft, saveDraft } from "@/lib/draft-store";
import {
  analysisImages,
  thumbnailImages,
  uploadImageBlob,
} from "@/lib/photo-payloads";
import {
  chooseUploadImage,
  ANALYSIS_DIM,
  ANALYSIS_QUALITY,
  THUMB_DIM,
  THUMB_QUALITY,
  UPLOAD_MAX_BASE64,
  UPLOAD_STEPS,
  scaleDown,
} from "@/lib/resize";
import {
  classifyStorageError,
  describeError,
  estimateStorage,
  formatBytes,
  importFits,
  requestPersistence,
  summarizeStorage,
} from "@/lib/storage-health";
import { processFiles } from "@/lib/intake";
import {
  livePreviewCount,
  revokeAllPreviews,
  revokePreview,
  setPreview,
} from "@/lib/photo-previews";
import type { ItemGroup } from "@/lib/types";

const realPut = IDBObjectStore.prototype.put;
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  resizeMock.calls = [];
});
afterEach(() => {
  IDBObjectStore.prototype.put = realPut;
  vi.unstubAllGlobals();
  revokeAllPreviews();
});

// Synthetic JPEG-like bytes: real Blobs with distinct, checkable content.
const bytes = (n: number, seed: number) =>
  Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff);
const jpeg = (n: number, seed: number) =>
  new Blob([bytes(n, seed)], { type: "image/jpeg" });
const sameBytes = async (a?: Blob, b?: Blob) =>
  Boolean(a && b) &&
  Buffer.from(await a!.arrayBuffer()).equals(
    Buffer.from(await b!.arrayBuffer()),
  );

const quotaError = () => new DOMException("", "QuotaExceededError");
// Refuse every write of image data, like a browser over its quota.
function refuseWrites(when: (value: unknown) => boolean = () => true) {
  IDBObjectStore.prototype.put = function (value: any, key?: any) {
    if (when(value)) throw quotaError();
    return realPut.call(this, value, key);
  };
}

// The pre-Blob format (database version 3): base64 photos + assets.
async function seedLegacy(
  photos: {
    id: string;
    data: string;
    previewUrl: string;
    uploadData: string;
    original?: Blob;
  }[],
  workspace: unknown,
) {
  await new Promise<void>((resolve, reject) => {
    const r = indexedDB.open("listing-writer-drafts", 3);
    r.onupgradeneeded = () => {
      for (const s of ["workspace", "photos", "assets"])
        r.result.createObjectStore(s);
    };
    r.onsuccess = () => {
      const db = r.result;
      const tx = db.transaction(["workspace", "photos", "assets"], "readwrite");
      for (const p of photos) {
        tx.objectStore("photos").put(
          {
            id: p.id,
            data: p.data,
            previewUrl: p.previewUrl,
            mediaType: "image/jpeg",
          },
          p.id,
        );
        tx.objectStore("assets").put(
          { original: p.original, uploadData: p.uploadData },
          p.id,
        );
      }
      tx.objectStore("workspace").put(workspace, "current");
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
  });
}

const b64 = (n: number, seed: number) =>
  Buffer.from(bytes(n, seed)).toString("base64");
const legacyPhoto = (i: number) => ({
  id: `old-${i}`,
  data: b64(4000, i),
  previewUrl: `data:image/jpeg;base64,${b64(600, i + 100)}`,
  uploadData: b64(9000, i + 200),
  original: jpeg(20000, i + 300),
});
const legacyGroups: ItemGroup[] = [
  {
    id: "g1",
    sku: "1001",
    skuSource: "sticker",
    name: "red-shorts",
    photoIds: ["old-0", "old-1", "old-2"],
    status: "done",
    listing: {
      title: "Nike Mens Shorts Sz L Red",
      description: "Flaw: 1-inch tear under right arm.",
      seller_specifics: ["Brand"],
      item_specifics: { Brand: "Nike" },
      seller_card: {
        photoIndices: [2],
        fields: { FLAW: "1-inch tear under right arm" },
      },
      inventory_label: { status: "read", value: "1001", photoIndices: [3] },
    },
  },
];
const legacyWorkspace = (ids: string[]) => ({
  version: 1,
  photos: ids.map((id) => ({ id })),
  groups: legacyGroups,
  orphanIds: [],
  binPrefix: "",
  skuStart: 0,
  step: "listings",
  updatedAt: 1,
});

describe("Blob photo storage", () => {
  it("stores originals, analysis images and thumbnails as Blobs, byte for byte", async () => {
    const p = {
      original: jpeg(50_000, 1),
      analysis: jpeg(8_000, 2),
      thumb: jpeg(900, 3),
    };
    await savePhotoBlobs("a", p);
    expect(
      await sameBytes(await getPhotoBlob("a", "original"), p.original),
    ).toBe(true);
    expect(
      await sameBytes(await getPhotoBlob("a", "analysis"), p.analysis),
    ).toBe(true);
    expect(await sameBytes(await getPhotoBlob("a", "thumb"), p.thumb)).toBe(
      true,
    );
    expect((await getPhotoBlob("a", "thumb")) instanceof Blob).toBe(true);
  });

  it("stress: 320 photos through the real storage path, refresh, cleanup and deletion", async () => {
    const ids = Array.from({ length: 320 }, (_, i) => `s-${i}`);
    for (const [i, id] of ids.entries())
      await savePhotoBlobs(id, {
        original: jpeg(30_000 + i, i),
        analysis: jpeg(6_000, i + 1),
        thumb: jpeg(800, i + 2),
      });
    // Two stray records from an earlier batch.
    await savePhotoBlobs("stray-1", {
      analysis: jpeg(10, 1),
      thumb: jpeg(10, 2),
    });
    await savePhotoBlobs("stray-2", {
      analysis: jpeg(10, 1),
      thumb: jpeg(10, 2),
    });
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
    // "Refresh": everything restores from storage.
    const d = await loadDraft();
    expect(d?.photos).toHaveLength(320);
    expect(
      await sameBytes(
        await getPhotoBlob("s-319", "original"),
        jpeg(30_319, 319),
      ),
    ).toBe(true);
    // Startup cleanup removes only unreferenced data.
    const removed = await cleanupUnreferenced(
      new Set(d!.photos.map((p) => p.id)),
    );
    expect(removed.sort()).toEqual(["stray-1", "stray-2"]);
    expect((await storedPhotoIds()).size).toBe(320);
    // Deleting photos removes every stored copy.
    await deletePhotoData(ids.slice(0, 20));
    expect((await storedPhotoIds()).size).toBe(300);
    expect(await getPhotoBlob("s-0", "analysis")).toBeUndefined();
    expect(await getPhotoBlob("s-0", "original")).toBeUndefined();
    // Payloads for an item are generated from Blobs on demand.
    const payload = await analysisImages(ids.slice(20, 40));
    expect(payload).toHaveLength(20);
    expect(payload[0].data).toBe(
      Buffer.from(bytes(6_000, 21)).toString("base64"),
    );
  });

  it("removing originals of posted photos keeps analysis images and thumbnails", async () => {
    await savePhotoBlobs("posted", {
      original: jpeg(5000, 1),
      analysis: jpeg(500, 2),
      thumb: jpeg(50, 3),
    });
    await deleteOriginals(["posted"]);
    expect(await getPhotoBlob("posted", "original")).toBeUndefined();
    expect(await getPhotoBlob("posted", "thumb")).toBeDefined();
    expect(await getPhotoBlob("posted", "analysis")).toBeDefined();
  });
});

describe("migration from the old base64 format", () => {
  it("converts photos to Blobs, removes the base64 copies and keeps every listing detail", async () => {
    const old = [0, 1, 2].map(legacyPhoto);
    await seedLegacy(old, legacyWorkspace(old.map((p) => p.id)));
    const d = await loadDraft();
    // Groups, listings, seller edits, card, SKU and sticker survive.
    expect(d?.groups).toEqual(legacyGroups);
    expect(d?.photos.map((p) => p.id)).toEqual(["old-0", "old-1", "old-2"]);
    // Old photos are readable before conversion.
    expect(
      await sameBytes(await getPhotoBlob("old-1", "original"), old[1].original),
    ).toBe(true);
    const r = await migrateLegacyPhotos();
    expect(r).toEqual({ migrated: 3, remaining: 0 });
    expect(await legacyPhotoIds()).toEqual([]);
    for (const p of old) {
      expect(
        await sameBytes(await getPhotoBlob(p.id, "original"), p.original),
      ).toBe(true);
      expect(await blobToBase64((await getPhotoBlob(p.id, "analysis"))!)).toBe(
        p.data,
      );
      expect(await blobToBase64((await getPhotoBlob(p.id, "thumb"))!)).toBe(
        p.previewUrl.split(",")[1],
      );
    }
    // The stored 2400 px upload copy is gone; eBay copies come from originals.
    await uploadImageBlob("old-0");
    expect(await sameBytes(resizeMock.calls[0], old[0].original)).toBe(true);
  });

  it("an interrupted migration resumes; unconverted photos stay usable", async () => {
    const old = [0, 1, 2, 3, 4].map(legacyPhoto);
    await seedLegacy(old, legacyWorkspace(old.map((p) => p.id)));
    let writes = 0;
    refuseWrites(() => ++writes > 6); // the 3rd photo's writes fail
    const first = await migrateLegacyPhotos();
    expect(first.migrated).toBe(2);
    expect(first.remaining).toBe(3);
    expect(first.error?.kind).toBe("quota");
    // Everything is still readable, converted or not.
    for (const p of old)
      expect(await blobToBase64((await getPhotoBlob(p.id, "analysis"))!)).toBe(
        p.data,
      );
    IDBObjectStore.prototype.put = realPut;
    const second = await migrateLegacyPhotos();
    expect(second).toEqual({ migrated: 3, remaining: 0 });
    expect(await legacyPhotoIds()).toEqual([]);
  });

  it("an over-quota old database still starts, frees unused data and keeps the workspace", async () => {
    const old = [0, 1, 2, 3].map(legacyPhoto);
    // old-3 belongs to no item any more.
    await seedLegacy(old, legacyWorkspace(["old-0", "old-1", "old-2"]));
    refuseWrites(); // the browser refuses every new write
    const d = await loadDraft();
    expect(d?.groups[0].sku).toBe("1001");
    // Deletion still works: unused photo data is freed.
    expect(
      await cleanupUnreferenced(new Set(d!.photos.map((p) => p.id))),
    ).toEqual(["old-3"]);
    // Conversion stops cleanly; old photos stay readable and usable.
    const r = await migrateLegacyPhotos();
    expect(r.migrated).toBe(0);
    expect(r.error?.message).toMatch(/storage is full/);
    expect(await blobToBase64((await getPhotoBlob("old-2", "analysis"))!)).toBe(
      old[2].data,
    );
    expect((await analysisImages(["old-0"]))[0].data).toBe(old[0].data);
    // An autosave fails with a clear, classified error, never silently.
    await expect(
      saveDraft({
        ...legacyWorkspace(["old-0"]),
        photos: [{ id: "old-0", previewUrl: "", mediaType: "image/jpeg" }],
        step: "listings",
      } as any),
    ).rejects.toMatchObject({ kind: "quota" });
    // Once space is available the conversion completes.
    IDBObjectStore.prototype.put = realPut;
    expect((await migrateLegacyPhotos()).remaining).toBe(0);
  });

  it("when the browser refuses the storage upgrade, old data stays readable and deletable", async () => {
    const old = [0, 1].map(legacyPhoto);
    await seedLegacy(old, legacyWorkspace(["old-0"]));
    const realCreate = IDBDatabase.prototype.createObjectStore;
    IDBDatabase.prototype.createObjectStore = function () {
      throw quotaError();
    };
    try {
      const d = await loadDraft();
      expect(d?.groups[0].name).toBe("red-shorts");
      expect(
        await sameBytes(
          await getPhotoBlob("old-0", "original"),
          old[0].original,
        ),
      ).toBe(true);
      expect(await cleanupUnreferenced(new Set(["old-0"]))).toEqual(["old-1"]);
      await expect(
        savePhotoBlobs("new", { analysis: jpeg(1, 1), thumb: jpeg(1, 1) }),
      ).rejects.toMatchObject({ kind: "quota", message: UPGRADE_REFUSED });
    } finally {
      IDBDatabase.prototype.createObjectStore = realCreate;
    }
    // Next start upgrades and converts.
    await loadDraft();
    expect((await migrateLegacyPhotos()).remaining).toBe(0);
  });

  it("embedded photos from the oldest format convert, and are never dropped if they cannot", async () => {
    const inline = {
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
    };
    // Conversion refused: the data stays embedded through the next autosave.
    await seedLegacy([], inline);
    refuseWrites((v) => v instanceof Blob);
    const d = await loadDraft();
    expect(await blobToBase64((await getPhotoBlob("x", "analysis"))!)).toBe(
      inline.photos[0].data,
    );
    await saveDraft({
      ...d!,
      photos: [{ id: "x", previewUrl: "", mediaType: "image/jpeg" }],
    });
    IDBObjectStore.prototype.put = realPut;
    // Converted on a later start.
    const again = await loadDraft();
    expect(again?.photos).toEqual([{ id: "x", mediaType: "image/jpeg" }]);
    expect(await blobToBase64((await getPhotoBlob("x", "analysis"))!)).toBe(
      inline.photos[0].data,
    );
    await clearDraft();
  });
});

describe("storage errors and health", () => {
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
    expect(describeError(new DOMException("", "UnknownError"))).toMatch(
      /UnknownError/,
    );
  });

  it("import errors name the reason for every file and stop when storage is full", async () => {
    const files = ["a.jpg", "b.jpg", "c.jpg", "d.jpg", "e.jpg"].map(
      (name) => ({ name }) as File,
    );
    let n = 0;
    const result = await processFiles(
      files,
      files.length,
      async (f) => {
        if (++n >= 2) throw quotaError();
        return f.name;
      },
      { stopOn: (e) => classifyStorageError(e).kind === "quota" },
    );
    expect(result.values).toEqual(["a.jpg"]);
    expect(result.errors.some((e) => /: $|: ;/.test(e))).toBe(false);
    expect(result.errors[0]).toMatch(/^b\.jpg: Browser storage is full/);
    expect(result.errors.at(-1)).toMatch(
      /more photos? (was|were) not added: Browser storage is full/,
    );
    expect(result.notProcessed).toBeGreaterThan(0);
  });

  it("works when estimate() or persist() are unavailable or persistence is denied", async () => {
    vi.stubGlobal("navigator", {});
    expect(await estimateStorage()).toBeNull();
    expect(await requestPersistence()).toBeNull();
    expect(importFits(null, [{ size: 1 }])).toBeNull();
    vi.stubGlobal("navigator", {
      storage: {
        persisted: async () => false,
        persist: async () => false,
        estimate: async () => ({
          usage: 180 * 1024 ** 2,
          quota: 1.2 * 1024 ** 3,
        }),
      },
    });
    expect(await requestPersistence()).toBe(false);
    const est = (await estimateStorage())!;
    expect(summarizeStorage(est, 5 * 1024 ** 2).text).toBe(
      "Photo storage: 180 MB used of 1.2 GB available · room for about 209 more photos (estimate)",
    );
    expect(importFits(est, [{ size: 2 * 1024 ** 3 }])?.fits).toBe(false);
    expect(importFits(est, [{ size: 4 * 1024 ** 2 }])?.fits).toBe(true);
    expect(formatBytes(333 * 1024 ** 2)).toBe("333 MB");
  });

  it("revokes preview object URLs", async () => {
    const created: string[] = [];
    const revoked: string[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
      created.push(`blob:${created.length}`);
      return created.at(-1)!;
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(
      (u) => void revoked.push(u),
    );
    setPreview("a", jpeg(1, 1));
    setPreview("a", jpeg(1, 2)); // replacing revokes the old URL
    setPreview("b", jpeg(1, 3));
    expect(revoked).toEqual(["blob:0"]);
    revokePreview("a");
    expect(livePreviewCount()).toBe(1);
    revokeAllPreviews();
    expect(livePreviewCount()).toBe(0);
    expect(revoked.sort()).toEqual(["blob:0", "blob:1", "blob:2"]);
    vi.restoreAllMocks();
  });
});

describe("image quality is unchanged by Blob storage", () => {
  it("keeps the analysis, thumbnail and eBay upload sizing rules", () => {
    expect([ANALYSIS_DIM, ANALYSIS_QUALITY]).toEqual([1024, 0.82]);
    expect([THUMB_DIM, THUMB_QUALITY]).toEqual([360, 0.5]);
    expect(UPLOAD_STEPS).toEqual([
      [2400, 0.9],
      [2000, 0.8],
      [1600, 0.75],
    ]);
    expect(UPLOAD_MAX_BASE64).toBe(2_700_000);
    expect(scaleDown(4032, 3024, 2400)).toEqual({ width: 2400, height: 1800 });
    expect(scaleDown(800, 600, 1024)).toEqual({ width: 800, height: 600 });
  });

  it("uses the largest upload size that fits, exactly as before", async () => {
    const tried: number[] = [];
    const enc = (sizes: Record<number, number>) => async (dim: number) => {
      tried.push(dim);
      return { size: sizes[dim] } as Blob;
    };
    await chooseUploadImage(enc({ 2400: 1_500_000 }));
    expect(tried).toEqual([2400]);
    tried.length = 0;
    // 2,100,000 bytes → 2,800,000 base64 chars: too big at 2400 px.
    await chooseUploadImage(enc({ 2400: 2_100_000, 2000: 1_400_000 }));
    expect(tried).toEqual([2400, 2000]);
    await expect(
      chooseUploadImage(enc({ 2400: 3e6, 2000: 3e6, 1600: 3e6 })),
    ).rejects.toThrow("Photo is too large to upload.");
  });

  it("eBay copies are generated from the original, with fallbacks for old photos", async () => {
    await savePhotoBlobs("p", {
      original: jpeg(40_000, 9),
      analysis: jpeg(100, 1),
      thumb: jpeg(10, 2),
    });
    expect(await (await uploadImageBlob("p")).text()).toBe(
      "upload-from-original",
    );
    expect(await sameBytes(resizeMock.calls[0], jpeg(40_000, 9))).toBe(true);
    // A photo whose original was removed falls back to the analysis image.
    await deleteOriginals(["p"]);
    expect(await sameBytes(await uploadImageBlob("p"), jpeg(100, 1))).toBe(
      true,
    );
    // Sorting uses thumbnails; analysis uses the 1024 px image.
    expect((await thumbnailImages(["p"]))[0].data).toBe(
      Buffer.from(bytes(10, 2)).toString("base64"),
    );
    await expect(analysisImages(["nope"])).rejects.toThrow(
      /missing from browser storage/,
    );
  });

  it("base64 conversion is lossless both ways", async () => {
    const original = jpeg(70_001, 5);
    const there = await blobToBase64(original);
    expect(await sameBytes(base64ToBlob(there), original)).toBe(true);
  });
});
