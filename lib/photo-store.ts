// Photo storage in IndexedDB, as binary Blobs.
//
// Per photo the store keeps exactly three things:
//   originals — the photo file as selected (needed for eBay upload copies and
//               "Save original");
//   analysis  — a ~1024 px JPEG for the AI;
//   thumbs    — a ~360 px JPEG for previews and photo sorting.
// The eBay upload copy is generated from the original when publishing and is
// never stored. Workspace metadata (groups, listings) lives in the separate
// "workspace" store and never contains image data.
//
// Older versions stored base64 strings: "photos" (analysis data + preview data
// URL) and "assets" (original Blob + a 2400 px upload copy as base64). Those
// records stay readable, are converted one photo at a time, and are removed as
// they are converted.

import { classifyStorageError, PhotoError } from "./storage-health";

export const DB_NAME = "listing-writer-drafts";
export const DB_VERSION = 4;
export const PHOTO_STORES = ["originals", "analysis", "thumbs"] as const;
export const LEGACY_STORES = ["photos", "assets"] as const;
export type PhotoKind = "original" | "analysis" | "thumb";
const STORE_FOR: Record<PhotoKind, (typeof PHOTO_STORES)[number]> = {
  original: "originals",
  analysis: "analysis",
  thumb: "thumbs",
};

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
      for (const s of ["workspace", ...LEGACY_STORES, ...PHOTO_STORES])
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
// example a site already over its storage quota) the existing database is
// opened as it is, so old photos stay readable and can still be deleted.
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

// Run one transaction; resolves on commit, rejects with a classified error.
export const UPGRADE_REFUSED =
  "Photo storage could not be upgraded because browser storage is full. Use Free photo storage, or free disk space on this computer, then reload.";

export async function transact<T>(
  stores: string[],
  mode: IDBTransactionMode,
  body: (tx: IDBTransaction, db: IDBDatabase) => T,
  // Stores that must exist (new-format writes); others are used if present.
  required: string[] = [],
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
    if (!has(db, "photos") && !has(db, "assets")) return inline;
    const stores = LEGACY_STORES.filter((s) => has(db, s));
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

// ── Reading and writing photos ───────────────────────────────────────────────

export interface PhotoBlobs {
  original?: Blob;
  analysis: Blob;
  thumb: Blob;
}

export async function savePhotoBlobs(id: string, b: PhotoBlobs): Promise<void> {
  await transact(
    [...PHOTO_STORES],
    "readwrite",
    (tx) => {
      if (b.original) tx.objectStore("originals").put(b.original, id);
      tx.objectStore("analysis").put(b.analysis, id);
      tx.objectStore("thumbs").put(b.thumb, id);
    },
    [...PHOTO_STORES],
  );
}

async function getNew(id: string, kind: PhotoKind): Promise<Blob | undefined> {
  const db = await openDb();
  try {
    const store = STORE_FOR[kind];
    if (!has(db, store)) return undefined;
    return (await request(
      db.transaction(store, "readonly").objectStore(store).get(id),
    )) as Blob | undefined;
  } finally {
    db.close();
  }
}

// A stored image, falling back to an old-format record when not converted.
export async function getPhotoBlob(
  id: string,
  kind: PhotoKind,
): Promise<Blob | undefined> {
  const fresh = await getNew(id, kind);
  if (fresh) return fresh;
  const old = await readLegacy(id);
  if (!old) return undefined;
  if (kind === "original") return old.original;
  if (kind === "analysis")
    return old.data ? base64ToBlob(old.data, "image/jpeg") : undefined;
  return old.previewUrl
    ? base64ToBlob(old.previewUrl, "image/jpeg")
    : old.data
      ? base64ToBlob(old.data, "image/jpeg")
      : undefined;
}

// Where an eBay upload copy comes from: the original, or for an old photo
// whose original is gone, its previously generated upload copy.
export async function getUploadSource(
  id: string,
): Promise<{ original?: Blob; legacyUpload?: string; analysis?: Blob }> {
  const original = await getPhotoBlob(id, "original");
  if (original) return { original };
  const old = await readLegacy(id);
  if (old?.uploadData) return { legacyUpload: old.uploadData };
  return { analysis: await getPhotoBlob(id, "analysis") };
}

// ── Inventory, cleanup and migration ─────────────────────────────────────────

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
  for (const s of [...PHOTO_STORES, ...LEGACY_STORES])
    for (const k of await keysOf(s)) ids.add(k);
  return ids;
}

export async function legacyPhotoIds(): Promise<string[]> {
  const ids = new Set<string>([...inlineLegacy.keys()]);
  for (const s of LEGACY_STORES) for (const k of await keysOf(s)) ids.add(k);
  return [...ids];
}

// Delete every stored copy of these photos. Deletion only frees space, so it
// works even when the browser refuses new writes.
export async function deletePhotoData(ids: string[]): Promise<void> {
  if (!ids.length) return;
  ids.forEach((id) => inlineLegacy.delete(id));
  await transact([...PHOTO_STORES, ...LEGACY_STORES], "readwrite", (tx, db) => {
    for (const s of [...PHOTO_STORES, ...LEGACY_STORES])
      if (has(db, s)) for (const id of ids) tx.objectStore(s).delete(id);
  });
}

// Delete only the stored originals (e.g. photos of items already on eBay).
// Old-format records hold the original together with the upload copy; both
// go, the analysis image and thumbnail stay.
export async function deleteOriginals(ids: string[]): Promise<void> {
  if (!ids.length) return;
  await transact(["originals", "assets"], "readwrite", (tx, db) => {
    for (const s of ["originals", "assets"])
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

// Convert one old-format photo: write its Blobs to the new stores and delete
// the old base64 records in the same transaction, so a photo is never lost or
// duplicated. Safe to repeat; an interrupted migration resumes at the next
// unconverted photo.
export async function migrateLegacyPhoto(id: string): Promise<boolean> {
  const old = await readLegacy(id);
  if (!old) return false;
  const analysis = old.data ? base64ToBlob(old.data) : undefined;
  const thumb = old.previewUrl ? base64ToBlob(old.previewUrl) : analysis;
  let original = old.original;
  // An old photo without its original keeps its generated upload copy as the
  // best available source for eBay.
  if (!original && old.uploadData) original = base64ToBlob(old.uploadData);
  if (!analysis && !original) {
    // Nothing usable left: drop the empty legacy records.
    await deletePhotoData([id]);
    return false;
  }
  await transact(
    [...PHOTO_STORES, ...LEGACY_STORES],
    "readwrite",
    (tx, db) => {
      if (original) tx.objectStore("originals").put(original, id);
      if (analysis) tx.objectStore("analysis").put(analysis, id);
      if (thumb) tx.objectStore("thumbs").put(thumb, id);
      for (const s of LEGACY_STORES)
        if (has(db, s)) tx.objectStore(s).delete(id);
    },
    [...PHOTO_STORES],
  );
  inlineLegacy.delete(id);
  return true;
}

export interface MigrationResult {
  migrated: number;
  remaining: number;
  error?: PhotoError;
}

// Convert old-format photos one at a time, stopping at the first failure
// (typically a full quota). Photos not yet converted remain readable.
export async function migrateLegacyPhotos(
  ids?: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<MigrationResult> {
  const todo = ids ?? (await legacyPhotoIds());
  let migrated = 0;
  for (let i = 0; i < todo.length; i++) {
    try {
      if (await migrateLegacyPhoto(todo[i])) migrated++;
    } catch (e) {
      return {
        migrated,
        remaining: todo.length - i,
        error: classifyStorageError(e),
      };
    }
    onProgress?.(i + 1, todo.length);
  }
  return { migrated, remaining: 0 };
}

export async function clearAllPhotoData(): Promise<void> {
  inlineLegacy.clear();
  await transact(
    ["workspace", ...PHOTO_STORES, ...LEGACY_STORES],
    "readwrite",
    (tx, db) => {
      for (const s of ["workspace", ...PHOTO_STORES, ...LEGACY_STORES])
        if (has(db, s)) tx.objectStore(s).clear();
    },
  );
}
