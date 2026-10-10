// The saved workspace: groups, listings and the batch's photo list as
// lightweight metadata. Image data lives in the photo stores
// (lib/photo-store.ts) and is never written by an autosave, so ordinary
// listing edits stay small and cheap. Photo cleanup is separate from saving
// (cleanupUnreferenced), so a failed save can never block freeing space.

import type { ItemGroup, Photo } from "./types";
import {
  clearAllPhotoData,
  registerInlineLegacy,
  inlineLegacyFor,
  storeEmbeddedPhoto,
  transact,
} from "./photo-store";
import { classifyStorageError } from "./storage-health";

export interface PhotoMeta {
  id: string;
  mediaType: string;
  name?: string;
  size?: number;
  analysisSelected?: boolean;
  // Large copies released after the item was posted; the thumbnail remains.
  released?: boolean;
}

export interface WorkspaceDraft {
  version: 2;
  photos: PhotoMeta[];
  groups: ItemGroup[];
  orphanIds: string[];
  binPrefix: string;
  skuStart: number;
  step: "upload" | "review" | "listings";
  updatedAt: number;
}

export const photoMeta = (p: Photo | PhotoMeta): PhotoMeta => ({
  id: p.id,
  mediaType: p.mediaType || "image/jpeg",
  ...(p.name ? { name: p.name } : {}),
  ...(p.size ? { size: p.size } : {}),
  ...(p.analysisSelected === false ? { analysisSelected: false } : {}),
  ...(p.released ? { released: true } : {}),
});

let queue: Promise<void> = Promise.resolve();

// Saves only the workspace record (metadata). Image data is never rewritten.
export function saveDraft(
  draft: Omit<WorkspaceDraft, "version" | "photos"> & {
    version?: number;
    photos: (Photo | PhotoMeta)[];
  },
): Promise<void> {
  const record: WorkspaceDraft = {
    ...draft,
    version: 2,
    // An embedded old-format photo that could not be converted yet keeps its
    // data in the record, so it is never dropped.
    photos: draft.photos.map((p) => ({
      ...photoMeta(p),
      ...(inlineLegacyFor(p.id) ?? {}),
    })),
  };
  queue = queue
    .catch(() => {})
    .then(() =>
      transact(
        ["workspace", "pending"],
        "readwrite",
        (tx, db) => {
          tx.objectStore("workspace").put(record, "current");
          // Photos now listed by the saved workspace are no longer pending.
          if (!db.objectStoreNames.contains("pending")) return;
          const listed = new Set(record.photos.map((p) => p.id));
          const keys = tx.objectStore("pending").getAllKeys();
          keys.onsuccess = () => {
            for (const k of keys.result)
              if (listed.has(String(k))) tx.objectStore("pending").delete(k);
          };
        },
        ["workspace"],
      ),
    );
  return queue;
}

interface StoredWorkspace extends Omit<WorkspaceDraft, "version" | "photos"> {
  version: number;
  photos: (PhotoMeta & {
    data?: string;
    previewUrl?: string;
    uploadData?: string;
    original?: Blob;
  })[];
}

export async function loadDraft(): Promise<WorkspaceDraft | null> {
  const d = await transact(["workspace"], "readonly", (tx) => {
    const r = tx.objectStore("workspace").get("current");
    return new Promise<StoredWorkspace | undefined>((resolve, reject) => {
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  });
  if (!d) return null;
  if (
    ![1, 2].includes(d.version) ||
    !Array.isArray(d.photos) ||
    !Array.isArray(d.groups)
  )
    throw new Error("Saved draft version cannot be restored.");
  const photos: PhotoMeta[] = [];
  for (const p of d.photos) {
    // Very old drafts embedded photos (base64) in the workspace record.
    if (p.data) {
      try {
        await storeEmbeddedPhoto(p.id, { ...p, data: p.data });
      } catch (e) {
        // Stays usable from memory and stays embedded in the workspace record
        // (see saveDraft) until a later start converts it.
        registerInlineLegacy(p.id, p);
        console.warn("[draft-store] embedded photo kept in memory", e);
      }
    }
    photos.push(photoMeta({ ...p, mediaType: p.mediaType || "image/jpeg" }));
  }
  return {
    ...d,
    version: 2,
    photos,
    groups: d.groups.map((g: ItemGroup) => ({
      ...g,
      status: g.status === "writing" ? "idle" : g.status,
      postStatus: g.postStatus === "posting" ? "error" : g.postStatus,
      postError:
        g.postStatus === "posting"
          ? "Publication was interrupted. Retry to check eBay before posting again."
          : g.postError,
    })),
  };
}

// Queued behind pending autosaves so an in-flight save cannot resurrect the batch.
export function clearDraft(): Promise<void> {
  queue = queue.catch(() => {}).then(() => clearAllPhotoData());
  return queue;
}

export { classifyStorageError };
