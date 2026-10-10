// Photo storage in IndexedDB, as binary Blobs.
//
// Per photo the store keeps exactly two things:
//   masters — one JPEG of at most 2000 px, the exact file uploaded to eBay
//             and the photo the seller can save;
//   thumbs  — a ~360 px JPEG for previews and photo sorting.
// The ~1024 px AI image is made from the master on demand. Workspace metadata
// (groups, listings) lives in the separate "workspace" store and never
// contains image data. "meta" holds a copy of the learned storage limit.
// "pending" marks each newly imported photo, written in the same transaction
// as its images and removed once a saved workspace lists the photo: a photo
// whose workspace save failed (e.g. storage full) is found and kept on the
// next start instead of being mistaken for unused data.
//
// Earlier versions are converted one photo at a time (convertPhotos):
//   version 4 — "originals" (the selected file), "analysis" (~1024 px), thumbs;
//   version 3 — "photos" (base64 analysis + preview) and "assets" (original
//               Blob + a 2400 px upload copy as base64).
// A photo's old data is deleted only after its master has been written, read
// back and decoded. Until then every read falls back to the old data, so
// nothing stops working mid-conversion.
//
// All image access goes through this module, so a different backing store
// (for example a folder on disk) can replace IndexedDB here later.

import { classifyStorageError, PhotoError } from "./storage-health";
import {
  isGenuineQuotaError,
  learnFromError,
  setLimitMirror,
  type LimitRecord,
} from "./storage-limit";

export const DB_NAME = "listing-writer-drafts";
export const DB_VERSION = 5;
export const PHOTO_STORES = ["masters", "thumbs"] as const;
// Readable for conversion; never written with new photos.
export const OLD_STORES = ["originals", "analysis"] as const;
export const LEGACY_STORES = ["photos", "assets"] as const;
const ALL_IMAGE_STORES = [...PHOTO_STORES, ...OLD_STORES, ...LEGACY_STORES];
// Everything stored per photo.
const PHOTO_DATA_STORES = [...ALL_IMAGE_STORES, "pending"];
const ALL_STORES = ["workspace", "meta", ...PHOTO_DATA_STORES];

// ── Opening the database ─────────────────────────────────────────────────────

function openAt(version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let r: IDBOpenDBRequest;
    try {
      if (typeof indexedDB === "undefined")
        throw new PhotoError(
          "unavailable",
          "Browser storage (IndexedDB) is not available in this browser.",
        );
      r =
        version === undefined
          ? indexedDB.open(DB_NAME)
          : indexedDB.open(DB_NAME, version);
    } catch (e) {
      reject(classifyStorageError(e));
      return;
    }
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const s of ALL_STORES)
        if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(classifyStorageError(r.error));
    r.onblocked = () =>
      reject(
        new PhotoError(
          "unavailable",
          "Close other lister tabs, then reload to update photo storage.",
        ),
      );
  });
}

// Upgrading creates the new stores. When the browser refuses even that (for
// example a site already at its storage limit) the existing database is
// opened as it is, so old photos stay readable and can still be deleted; the
// upgrade is retried on the next open, after space has been freed.
export async function openDb(): Promise<IDBDatabase> {
  try {
    return await openAt(DB_VERSION);
  } catch (e) {
    const err = classifyStorageError(e);
    if (err.kind === "unavailable" && /other lister tabs/.test(err.message))
      throw err;
    try {
      const db = await openAt();
      if (has(db, "workspace")) {
        console.warn(
          "[photo-store] storage upgrade refused; using existing storage",
          e,
        );
        return db;
      }
      db.close();
    } catch {
      /* fall through */
    }
    throw err;
  }
}

const has = (db: IDBDatabase, store: string) =>
  db.objectStoreNames.contains(store);

export const UPGRADE_REFUSED =
  "Photo storage could not be upgraded because browser storage is full. Remove a few photos you do not need, then reload.";

// Run one transaction; resolves on commit, rejects with a classified error.
export async function transact<T>(
  stores: readonly string[],
  mode: IDBTransactionMode,
  body: (tx: IDBTransaction, db: IDBDatabase) => T,
  // Stores that must exist (new-format writes); others are used if present.
  required: readonly string[] = [],
): Promise<Awaited<T>> {
  const db = await openDb();
  try {
    if (required.some((s) => !has(db, s)))
      throw new PhotoError("quota", UPGRADE_REFUSED);
    const present = stores.filter((s) => has(db, s));
    if (!present.length) return undefined as Awaited<T>;
    return await new Promise<Awaited<T>>((resolve, reject) => {
      let result: T;
      let tx: IDBTransaction;
      try {
        tx = db.transaction(present, mode);
        result = body(tx, db);
      } catch (e) {
        reject(classifyStorageError(e));
        return;
      }
      tx.oncomplete = async () => resolve(await result);
      tx.onabort = tx.onerror = () =>
        reject(
          classifyStorageError(
            tx.error ?? new DOMException("Transaction aborted", "AbortError"),
          ),
        );
    });
  } finally {
    db.close();
  }
}

const request = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

async function getFrom<T>(store: string, id: string): Promise<T | undefined> {
  const db = await openDb();
  try {
    if (!has(db, store)) return undefined;
    return (await request(
      db.transaction(store, "readonly").objectStore(store).get(id),
    )) as T | undefined;
  } finally {
    db.close();
  }
}

// ── Base64 helpers (only for API payloads and legacy records) ───────────────

export function base64ToBlob(b64: string, type = "image/jpeg"): Blob {
  const raw = b64.includes(",") ? b64.slice(b64.indexOf(",") + 1) : b64;
  const bin = atob(raw);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

// ── Legacy records ───────────────────────────────────────────────────────────

interface LegacyPhoto {
  id?: string;
  data?: string;
  previewUrl?: string;
  mediaType?: string;
  original?: Blob;
  uploadData?: string;
}

// Photos embedded directly in a very old workspace record. They are kept in
// memory until converted, so they stay usable even if storage is full.
const inlineLegacy = new Map<string, LegacyPhoto>();
export function registerInlineLegacy(id: string, p: LegacyPhoto) {
  inlineLegacy.set(id, {
    data: p.data,
    previewUrl: p.previewUrl,
    uploadData: p.uploadData,
    original: p.original,
  });
}
export const inlineLegacyFor = (id: string) => inlineLegacy.get(id);

async function readLegacy(id: string): Promise<LegacyPhoto | undefined> {
  const inline = inlineLegacy.get(id);
  const db = await openDb();
  try {
    const stores = LEGACY_STORES.filter((s) => has(db, s));
    if (!stores.length) return inline;
    const tx = db.transaction(stores, "readonly");
    const [photo, asset] = await Promise.all(
      stores.map(
        (s) =>
          request(tx.objectStore(s).get(id)) as Promise<
            LegacyPhoto | undefined
          >,
      ),
    );
    if (!photo && !asset && !inline) return undefined;
    return { ...inline, ...photo, ...asset };
  } finally {
    db.close();
  }
}

// ── Writing and reading photos ───────────────────────────────────────────────

export interface PhotoBlobs {
  master: Blob;
  thumb: Blob;
}

export interface PendingPhoto {
  id: string;
  mediaType: string;
  name?: string;
  size?: number;
  addedAt: number;
}

// One transaction: the photo's images and its "pending" marker, so a stored
// photo is never unaccounted for.
export async function savePhoto(
  id: string,
  b: PhotoBlobs,
  meta: { name?: string; size?: number } = {},
): Promise<void> {
  const pending: PendingPhoto = {
    id,
    mediaType: "image/jpeg",
    ...meta,
    addedAt: Date.now(),
  };
  await transact(
    [...PHOTO_STORES, "pending"],
    "readwrite",
    (tx) => {
      tx.objectStore("masters").put(b.master, id);
      tx.objectStore("thumbs").put(b.thumb, id);
      tx.objectStore("pending").put(pending, id);
    },
    [...PHOTO_STORES, "pending"],
  );
}

// Only a converted photo has a master.
export const getMaster = (id: string) => getFrom<Blob>("masters", id);

// Preview image: the thumbnail, else the best smaller image an older
// version stored.
export async function getThumb(id: string): Promise<Blob | undefined> {
  const thumb = await getFrom<Blob>("thumbs", id);
  if (thumb) return thumb;
  const old = await readLegacy(id);
  if (old?.previewUrl || old?.data)
    return base64ToBlob((old.previewUrl ?? old.data)!);
  return (
    (await getFrom<Blob>("analysis", id)) ??
    (await getFrom<Blob>("masters", id))
  );
}

export type SourceKind =
  "master" | "original" | "legacy-original" | "legacy-upload" | "analysis";

// The best stored image of a photo, master first. Photos not yet converted
// use their old data; a photo whose large copies were released or removed
// earlier still has its ~1024 px image.
export async function bestImage(
  id: string,
): Promise<{ kind: SourceKind; blob: Blob } | undefined> {
  const master = await getFrom<Blob>("masters", id);
  if (master) return { kind: "master", blob: master };
  const source = await conversionSource(id);
  if (source) return source;
  const analysis = await getFrom<Blob>("analysis", id);
  if (analysis) return { kind: "analysis", blob: analysis };
  const old = await readLegacy(id);
  if (old?.data) return { kind: "analysis", blob: base64ToBlob(old.data) };
  return undefined;
}

// What a master can be made from: the full-size original first, then an old
// 2400 px upload copy.
async function conversionSource(
  id: string,
): Promise<{ kind: SourceKind; blob: Blob } | undefined> {
  const original = await getFrom<Blob>("originals", id);
  if (original) return { kind: "original", blob: original };
  const old = await readLegacy(id);
  if (old?.original) return { kind: "legacy-original", blob: old.original };
  if (old?.uploadData)
    return { kind: "legacy-upload", blob: base64ToBlob(old.uploadData) };
  return undefined;
}

// ── Inventory and statistics ─────────────────────────────────────────────────

async function keysOf(store: string): Promise<string[]> {
  const db = await openDb();
  try {
    if (!has(db, store)) return [];
    return (
      await request(
        db.transaction(store, "readonly").objectStore(store).getAllKeys(),
      )
    ).map(String);
  } finally {
    db.close();
  }
}

export async function storedPhotoIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const s of PHOTO_DATA_STORES)
    for (const k of await keysOf(s)) ids.add(k);
  return ids;
}

async function allOf<T>(store: string): Promise<T[]> {
  const db = await openDb();
  try {
    if (!has(db, store)) return [];
    return (await request(
      db.transaction(store, "readonly").objectStore(store).getAll(),
    )) as T[];
  } finally {
    db.close();
  }
}

// At startup: stored photos the saved workspace does not list. A photo with
// a usable image saved by this or an earlier version (its workspace save may
// have failed, e.g. when storage filled up) is adopted back into the batch;
// only leftovers without a usable image of their own (partial old-format
// records, a thumbnail alone) are deleted.
export async function sortOutUnreferenced(referenced: Set<string>): Promise<{
  adopted: PendingPhoto[];
  removed: string[];
}> {
  const pending = new Map(
    (await allOf<PendingPhoto>("pending")).map((p) => [p.id, p]),
  );
  const usable = new Set([
    ...(await keysOf("masters")),
    ...(await keysOf("originals")),
  ]);
  const thumbs = new Set(await keysOf("thumbs"));
  // A complete version-3 photo: its "photos" record (analysis image and
  // preview) and its "assets" record (written only with the original file or
  // its upload copy). Version 3 saved each photo on import but listed it in
  // the workspace only when an autosave succeeded, so a complete photo the
  // workspace does not list is an imported photo whose save failed.
  const legacyAssets = new Set(await keysOf("assets"));
  const legacyPhotos = new Set(await keysOf("photos"));
  const adopted: PendingPhoto[] = [];
  const adoptedLegacy: PendingPhoto[] = [];
  const removed: string[] = [];
  for (const id of await storedPhotoIds()) {
    if (referenced.has(id)) continue;
    if (usable.has(id) && thumbs.has(id))
      adopted.push(
        pending.get(id) ?? { id, mediaType: "image/jpeg", addedAt: 0 },
      );
    else if (legacyAssets.has(id) && legacyPhotos.has(id))
      adoptedLegacy.push(await legacyPending(id));
    else removed.push(id);
  }
  for (let i = 0; i < removed.length; i += 50)
    await deletePhotoData(removed.slice(i, i + 50));
  adopted.sort((a, b) => a.addedAt - b.addedAt);
  // Version 3 kept no import time; camera file names (e.g. 20261007_114147)
  // restore the photo order the sorter relies on.
  adoptedLegacy.sort(
    (a, b) =>
      (a.name ?? "").localeCompare(b.name ?? "", undefined, {
        numeric: true,
      }) || a.id.localeCompare(b.id),
  );
  return { adopted: [...adopted, ...adoptedLegacy], removed };
}

// Name and size of a version-3 photo from its stored original file.
async function legacyPending(id: string): Promise<PendingPhoto> {
  const old = await readLegacy(id).catch(() => undefined);
  const original = old?.original as (Blob & { name?: unknown }) | undefined;
  const name =
    typeof original?.name === "string" && original.name
      ? original.name
      : undefined;
  return {
    id,
    mediaType: "image/jpeg",
    addedAt: 0,
    ...(name ? { name } : {}),
    ...(original?.size ? { size: original.size } : {}),
  };
}

// Photos with data still in an older format (or with obsolete copies left).
export async function photosToConvert(): Promise<string[]> {
  const ids = new Set<string>([...inlineLegacy.keys()]);
  for (const s of ["originals", ...LEGACY_STORES])
    for (const k of await keysOf(s)) ids.add(k);
  const masters = new Set(await keysOf("masters"));
  for (const k of await keysOf("analysis")) if (masters.has(k)) ids.add(k);
  return [...ids];
}

export interface PhotoStats {
  masters: number;
  masterBytes: number;
  thumbBytes: number;
  // Average stored bytes of a converted photo (master + thumbnail).
  avgPhotoBytes?: number;
}

async function sizes(store: string): Promise<Map<string, number>> {
  const db = await openDb();
  try {
    const out = new Map<string, number>();
    if (!has(db, store)) return out;
    await new Promise<void>((resolve, reject) => {
      const r = db
        .transaction(store, "readonly")
        .objectStore(store)
        .openCursor();
      r.onsuccess = () => {
        const c = r.result;
        if (!c) return resolve();
        const v = c.value as Blob | undefined;
        if (v && typeof v.size === "number") out.set(String(c.key), v.size);
        c.continue();
      };
      r.onerror = () => reject(r.error);
    });
    return out;
  } finally {
    db.close();
  }
}

export async function photoStats(): Promise<PhotoStats> {
  const masters = await sizes("masters");
  const thumbs = await sizes("thumbs");
  let masterBytes = 0;
  let thumbBytes = 0;
  for (const [id, n] of masters) {
    masterBytes += n;
    thumbBytes += thumbs.get(id) ?? 0;
  }
  return {
    masters: masters.size,
    masterBytes,
    thumbBytes,
    avgPhotoBytes: masters.size
      ? (masterBytes + thumbBytes) / masters.size
      : undefined,
  };
}

// ── Deleting ─────────────────────────────────────────────────────────────────

// Delete every stored copy of these photos. Deletion only frees space, so it
// works even when the browser refuses new writes.
export async function deletePhotoData(ids: string[]): Promise<void> {
  if (!ids.length) return;
  ids.forEach((id) => inlineLegacy.delete(id));
  await transact(PHOTO_DATA_STORES, "readwrite", (tx, db) => {
    for (const s of PHOTO_DATA_STORES)
      if (has(db, s)) for (const id of ids) tx.objectStore(s).delete(id);
  });
}

// Release the large copies of photos whose items are already on eBay: the
// master and any older full-size data go; the thumbnail stays for display.
export async function releasePhotos(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const stores = ["masters", "originals", "analysis", "assets"];
  await transact(stores, "readwrite", (tx, db) => {
    for (const s of stores)
      if (has(db, s)) for (const id of ids) tx.objectStore(s).delete(id);
  });
}

// Remove photo data no workspace references. Never touches referenced ids.
export async function cleanupUnreferenced(
  referenced: Set<string>,
): Promise<string[]> {
  const orphans = [...(await storedPhotoIds())].filter(
    (id) => !referenced.has(id),
  );
  // Small chunks: each is its own transaction, so progress survives failures.
  for (let i = 0; i < orphans.length; i += 50)
    await deletePhotoData(orphans.slice(i, i + 50));
  return orphans;
}

// Every photo and draft; the learned storage limit ("meta") is evidence
// about this browser and is kept.
export async function clearAllPhotoData(): Promise<void> {
  inlineLegacy.clear();
  const stores = ["workspace", ...PHOTO_DATA_STORES];
  await transact(stores, "readwrite", (tx, db) => {
    for (const s of stores) if (has(db, s)) tx.objectStore(s).clear();
  });
}

// ── Converting photos stored by earlier versions ─────────────────────────────

export interface ConvertDeps {
  // A master (and a thumbnail when asked) from an existing image.
  makeMaster: (
    blob: Blob,
    withThumb: boolean,
  ) => Promise<{ blob: Blob; thumb?: Blob }>;
  // A thumbnail from an existing image.
  makeThumb: (blob: Blob) => Promise<Blob>;
  // The stored master decodes as an image.
  verify: (blob: Blob) => Promise<boolean>;
  // Test hook: called between steps; may throw to simulate a closed tab.
  checkpoint?: (step: "before-write" | "after-write", id: string) => void;
  // Chrome credits the space of deleted data only after the page has let go
  // of it; give it time before retrying a write refused as full.
  settle?: (attempt: number) => Promise<void>;
}

// Attempts per photo when a write is refused right after old data was
// deleted (Chrome releases that space a few seconds later).
export const SETTLE_ATTEMPTS = 8;

// A no-op write: lets Chrome finish releasing the space of deleted data.
export async function nudgeCleanup(): Promise<void> {
  await transact(["meta"], "readwrite", (tx) => {
    tx.objectStore("meta").delete("--nothing--");
  }).catch(() => {});
}

export interface ConvertResult {
  converted: number;
  // Photos that still have data in an older format.
  remaining: number;
  // Why conversion stopped early; old data is kept for every unconverted photo.
  paused?: "quota" | "upgrade" | "error";
  // Photos whose old image could not be read; their data is kept as it is.
  unreadable: string[];
  freedRecreatable: number;
  error?: PhotoError;
  busy?: boolean;
}

const LOCK = "listing-writer-photo-conversion";
let localLock = false;

// Only one tab (and one call) converts at a time; a second caller returns
// { busy: true } at once instead of waiting.
async function withConversionLock<T>(
  run: () => Promise<T>,
  busy: () => T,
): Promise<T> {
  const locks = globalThis.navigator?.locks;
  if (locks?.request)
    return locks.request(LOCK, { ifAvailable: true }, async (lock) =>
      lock ? run() : busy(),
    ) as Promise<T>;
  if (localLock) return busy();
  localLock = true;
  try {
    return await run();
  } finally {
    localLock = false;
  }
}

// Recreatable copies first: a ~1024 px "analysis" image is deleted only when
// the photo also has its original or a master, which it can be made from.
async function freeRecreatable(ids: string[]): Promise<number> {
  const analysis = new Set(await keysOf("analysis"));
  const sources = new Set([
    ...(await keysOf("masters")),
    ...(await keysOf("originals")),
  ]);
  const legacy = await keysOf("assets");
  for (const id of legacy) {
    const old = await readLegacy(id);
    if (old?.original || old?.uploadData) sources.add(id);
  }
  const doomed = ids.filter((id) => analysis.has(id) && sources.has(id));
  for (let i = 0; i < doomed.length; i += 50) {
    const chunk = doomed.slice(i, i + 50);
    await transact(["analysis"], "readwrite", (tx) => {
      for (const id of chunk) tx.objectStore("analysis").delete(id);
    });
  }
  return doomed.length;
}

// Old data of a photo whose master is verified. The thumbnail stays.
async function dropOldData(id: string): Promise<void> {
  const stores = [...OLD_STORES, ...LEGACY_STORES];
  await transact(stores, "readwrite", (tx, db) => {
    for (const s of stores) if (has(db, s)) tx.objectStore(s).delete(id);
  });
  inlineLegacy.delete(id);
}

async function hasThumb(id: string): Promise<boolean> {
  return Boolean(await getFrom<Blob>("thumbs", id));
}

async function verifiedMaster(
  id: string,
  expectedSize: number | undefined,
  deps: ConvertDeps,
): Promise<boolean> {
  const stored = await getFrom<Blob>("masters", id);
  if (!stored || !stored.size) return false;
  if (expectedSize !== undefined && stored.size !== expectedSize) return false;
  return deps.verify(stored);
}

type StepResult = "converted" | "skipped" | "unreadable";

async function convertOne(id: string, deps: ConvertDeps): Promise<StepResult> {
  // A master written earlier (e.g. before the tab closed): finish cleanup.
  const existing = await getFrom<Blob>("masters", id);
  if (existing) {
    if (await verifiedMaster(id, undefined, deps)) {
      if (!(await hasThumb(id))) {
        const thumb = await deps.makeThumb(existing);
        await transact(["thumbs"], "readwrite", (tx) =>
          tx.objectStore("thumbs").put(thumb, id),
        );
      }
      await dropOldData(id);
      return "converted";
    } else {
      // Unusable master: remove it and convert again from the old data.
      await transact(["masters"], "readwrite", (tx) =>
        tx.objectStore("masters").delete(id),
      );
    }
  }
  const source = await conversionSource(id);
  if (!source) return "skipped";
  const withThumb = !(await hasThumb(id));
  let made: { blob: Blob; thumb?: Blob };
  try {
    made = await deps.makeMaster(source.blob, withThumb);
  } catch (e) {
    console.warn(`[photo-store] photo ${id} could not be read; kept as is`, e);
    return "unreadable";
  }
  deps.checkpoint?.("before-write", id);
  await transact(
    ["masters", "thumbs"],
    "readwrite",
    (tx) => {
      tx.objectStore("masters").put(made.blob, id);
      if (withThumb && made.thumb) tx.objectStore("thumbs").put(made.thumb, id);
    },
    ["masters"],
  );
  deps.checkpoint?.("after-write", id);
  if (!(await verifiedMaster(id, made.blob.size, deps))) {
    await transact(["masters"], "readwrite", (tx) =>
      tx.objectStore("masters").delete(id),
    );
    return "unreadable";
  }
  if (!(await hasThumb(id))) return "converted"; // old preview stays
  await dropOldData(id);
  return "converted";
}

// Convert photos one at a time. Old data is deleted only after the photo's
// master has been written, read back and decoded. Stops (keeping everything
// not yet converted) at the first storage failure; safe to run again at any
// time, including after the tab closed mid-way.
export function convertPhotos(
  ids: string[],
  deps: ConvertDeps,
  onProgress?: (done: number, total: number) => void,
): Promise<ConvertResult> {
  return withConversionLock(
    async () => {
      const result: ConvertResult = {
        converted: 0,
        remaining: ids.length,
        unreadable: [],
        freedRecreatable: 0,
      };
      if (!ids.length) return result;
      try {
        result.freedRecreatable = await freeRecreatable(ids);
      } catch (e) {
        console.warn("[photo-store] could not free recreatable copies", e);
      }
      let settled = 0; // converted, unreadable, or nothing to convert
      for (let i = 0, attempt = 0; i < ids.length; i++) {
        try {
          const r = await convertOne(ids[i], deps);
          if (r === "converted") result.converted++;
          if (r === "unreadable") result.unreadable.push(ids[i]);
          settled++;
          attempt = 0;
        } catch (e) {
          // Refused as full: space freed moments ago may not be credited
          // yet. Wait, nudge Chrome and retry this photo before pausing.
          if (
            isGenuineQuotaError(e) &&
            deps.settle &&
            attempt < SETTLE_ATTEMPTS
          ) {
            await deps.settle(attempt++);
            await nudgeCleanup();
            i--;
            continue;
          }
          const err = classifyStorageError(e);
          await learnFromError(e, "photo conversion");
          result.error = err;
          result.paused =
            err.message === UPGRADE_REFUSED
              ? "upgrade"
              : err.kind === "quota"
                ? "quota"
                : "error";
          result.remaining = ids.length - settled;
          return result;
        }
        result.remaining = ids.length - settled;
        onProgress?.(i + 1, ids.length);
      }
      return result;
    },
    () => ({
      converted: 0,
      remaining: ids.length,
      unreadable: [],
      freedRecreatable: 0,
      busy: true,
    }),
  );
}

// Very old drafts embedded photos in the workspace record. They are stored
// in the old per-photo format and then converted like any other old photo.
export async function storeEmbeddedPhoto(
  id: string,
  p: {
    original?: Blob;
    uploadData?: string;
    data: string;
    previewUrl?: string;
  },
): Promise<void> {
  await transact(
    ["originals", "analysis", "thumbs"],
    "readwrite",
    (tx) => {
      const original =
        p.original ?? (p.uploadData ? base64ToBlob(p.uploadData) : undefined);
      if (original) tx.objectStore("originals").put(original, id);
      tx.objectStore("analysis").put(base64ToBlob(p.data), id);
      tx.objectStore("thumbs").put(base64ToBlob(p.previewUrl ?? p.data), id);
    },
    ["originals", "analysis", "thumbs"],
  );
}

// ── Learned-limit copy ───────────────────────────────────────────────────────

setLimitMirror({
  read: () =>
    getFrom<LimitRecord>("meta", "storage-limit").catch(() => undefined),
  write: (r) =>
    transact(["meta"], "readwrite", (tx) => {
      tx.objectStore("meta").put(r, "storage-limit");
    }).then(() => undefined),
});
