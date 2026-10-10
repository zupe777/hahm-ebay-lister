import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, expect, it } from "vitest";
import { saveDraft, loadDraft, clearDraft } from "@/lib/draft-store";
import { getMaster, getThumb, savePhoto, storedPhotoIds } from "@/lib/photo-store";

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

const blob = (text: string) => new Blob([text], { type: "image/jpeg" });
const base = {
  orphanIds: [],
  binPrefix: "",
  skuStart: 0,
  step: "listings" as const,
};

async function rawWorkspace(): Promise<any> {
  return new Promise((resolve) => {
    const r = indexedDB.open("listing-writer-drafts");
    r.onsuccess = () => {
      const db = r.result;
      const get = db.transaction("workspace").objectStore("workspace").get("current");
      get.onsuccess = () => {
        db.close();
        resolve(get.result);
      };
    };
  });
}

it("restores drafts and interrupted publishing safely; photos stay in photo storage", async () => {
  await savePhoto("p", { master: blob("master photo"), thumb: blob("thumb") });
  await saveDraft({
    ...base,
    photos: [{ id: "p", previewUrl: "blob:x", mediaType: "image/jpeg", name: "a.jpg", size: 14 }],
    groups: [
      {
        id: "g",
        sku: "unique",
        name: "item",
        photoIds: ["p"],
        status: "done",
        listing: { title: "Saved", description: "Edited" },
        postStatus: "posting",
      },
    ],
    updatedAt: 1,
  });
  const d = await loadDraft();
  expect(d?.groups[0].listing?.description).toBe("Edited");
  expect(d?.groups[0].postStatus).toBe("error");
  expect(d?.photos[0]).toEqual({ id: "p", mediaType: "image/jpeg", name: "a.jpg", size: 14 });
  expect(await (await getMaster("p"))?.text()).toBe("master photo");
});

it("autosaves only metadata: a 500-photo workspace record holds no image data", async () => {
  const photos = Array.from({ length: 500 }, (_, i) => ({
    id: `large-${i}`,
    previewUrl: `blob:http://localhost/${i}`,
    mediaType: "image/jpeg",
    size: 4_000_000,
    name: `IMG_${i}.jpg`,
  }));
  await saveDraft({ ...base, photos, groups: [], updatedAt: 1 });
  const manifest = await rawWorkspace();
  expect(manifest.version).toBe(2);
  expect(manifest.photos[0]).toEqual({
    id: "large-0",
    mediaType: "image/jpeg",
    name: "IMG_0.jpg",
    size: 4_000_000,
  });
  const json = JSON.stringify(manifest);
  expect(json).not.toMatch(/blob:|base64|data:image/);
  expect(json.length).toBeLessThan(60_000);
  // Autosave never writes or deletes photo data.
  expect((await storedPhotoIds()).size).toBe(0);
  expect((await loadDraft())?.photos).toHaveLength(500);
});

it("clears the saved workspace and every stored photo, even after a pending save", async () => {
  await savePhoto("clear-me", { master: blob("m"), thumb: blob("t") });
  void saveDraft({
    ...base,
    photos: [{ id: "clear-me", previewUrl: "", mediaType: "image/jpeg" }],
    groups: [{ id: "g", sku: "K1-A", name: "item", photoIds: ["clear-me"], status: "done" }],
    updatedAt: 3,
  });
  await clearDraft();
  expect(await loadDraft()).toBeNull();
  expect(await getMaster("clear-me")).toBeUndefined();
  expect(await getThumb("clear-me")).toBeUndefined();
  expect((await storedPhotoIds()).size).toBe(0);
});
