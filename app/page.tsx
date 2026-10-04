"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { runBatch, type QueueProgress } from "@/lib/batch-queue";
import { loadDraft, saveDraft, clearDraft } from "@/lib/draft-store";
import {
  cleanupUnreferenced,
  deleteOriginals,
  deletePhotoData,
  legacyPhotoIds,
  migrateLegacyPhotos,
  savePhotoBlobs,
} from "@/lib/photo-store";
import {
  loadPreview,
  revokeAllPreviews,
  revokePreview,
  setPreview,
} from "@/lib/photo-previews";
import {
  analysisImages,
  thumbnailImages,
  uploadImages,
} from "@/lib/photo-payloads";
import {
  classifyStorageError,
  estimateStorage,
  formatBytes,
  importFits,
  reportError,
  requestPersistence,
  type StorageEstimate,
} from "@/lib/storage-health";
import { StoragePanel } from "./StoragePanel";
import { processFiles } from "@/lib/intake";
import { draftIssues } from "@/lib/client-review";
import { apiPost } from "@/lib/api-client";
import { getAnalysisModel, getSortModel } from "@/lib/model-preferences";
import { preparePhoto } from "@/lib/resize";
import { clearGeneratedSku, skuAfterAnalysis } from "@/lib/inventory-sticker";
import { LISTING_PROFILE } from "@/lib/listing-profile";
import { applyListingEdit } from "@/lib/seller-edits";
import { chunkImagesForUpload } from "@/lib/uploadBatches";
import { EbayConnect } from "./EbayConnect";
import { ModelSelector } from "./ModelSelector";
import { ReviewBoard } from "./ReviewBoard";
import { CloudBatch } from "./CloudBatch";
import { ListingsView } from "./ListingsView";
import type {
  AnalyzeResponse,
  CompsSummary,
  ItemGroup,
  ListingResult,
  Photo,
  SortResponse,
} from "@/lib/types";

type Step = "upload" | "review" | "listings";
// Big batches are sorted in chunks of SORT_CHUNK photos per request — each
// chunk's thumbnail payload stays under Vercel's 4.5 MB body limit — then
// reviewed together; items crossing a chunk boundary may need manual merging.
// There is no fixed photo limit: capacity depends on the browser storage
// available on this device (shown in the photo storage panel).
const SORT_CHUNK = 100;
const WRITE_CONCURRENCY = 3;
// eBay accepts at most 24 photos per listing. They ship to eBay in small
// batches (lib/uploadBatches.ts) before publish, so no single request ever
// nears Vercel's 4.5 MB body limit.
const MAX_PUBLISH_PHOTOS = 24;
// HTTP statuses worth waiting out and retrying: rate limits and transient
// platform errors.
const TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `id-${Math.floor(performance.now() * 1000)}-${Math.random()}`;
}

// Parse a fetch response as JSON, but turn non-JSON error bodies (e.g. a 413
// "Request Entity Too Large" plain-text page) into a friendly message instead
// of a cryptic "Unexpected token" error. Callers pass a hint that fits their
// step — "sort fewer photos" advice on a posting error sent sellers down the
// wrong path.
async function readJson(
  res: Response,
  tooLargeHint = "Try again with fewer or smaller photos.",
): Promise<any> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    if (res.status === 413) {
      throw new Error(
        `That was too much photo data to send at once. ${tooLargeHint}`,
      );
    }
    throw new Error(
      text.trim().slice(0, 140) || `Request failed (${res.status}).`,
    );
  }
}

export default function Home() {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [binPrefix, setBinPrefix] = useState("");
  const [step, setStep] = useState<Step>("upload");
  const [groups, setGroups] = useState<ItemGroup[]>([]);
  const [orphanIds, setOrphanIds] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [sorting, setSorting] = useState(false);
  const [sortProgress, setSortProgress] = useState<string | null>(null);
  // Where bin lettering starts — continues after SKUs already on eBay, so a
  // second batch from bin K31 gets K31-N… instead of colliding with K31-A.
  const [skuStart, setSkuStart] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [ebayConnected, setEbayConnected] = useState(false);
  const [restored, setRestored] = useState(false);
  const [saveStatus, setSaveStatus] = useState("Loading saved work…");
  const [readOnly, setReadOnly] = useState(false);
  // Browser storage health for the photo storage panel.
  const [storage, setStorage] = useState<{
    est: StorageEstimate | null;
    persisted: boolean | null;
    legacyRemaining: number;
    legacyNote?: string;
    note?: string;
  }>({ est: null, persisted: null, legacyRemaining: 0 });
  const refreshStorage = useCallback(async () => {
    const est = await estimateStorage();
    setStorage((s) => ({ ...s, est }));
  }, []);
  const inFlight = useRef(new Set<string>());
  const queueBusy = useRef(false);
  const queuePause = useRef(false);
  const queueIds = useRef<string[]>([]);
  const [queue, setQueue] = useState<
    | (QueueProgress & {
        kind: "write" | "post";
        running: boolean;
        paused: boolean;
      })
    | null
  >(null);
  async function startQueue(
    ids: string[],
    kind: "write" | "post",
    worker: (id: string) => Promise<void>,
  ) {
    if (queueBusy.current || !ids.length) return;
    queueBusy.current = true;
    queueIds.current = ids;
    queuePause.current = false;
    try {
      await runBatch(ids, kind === "write" ? WRITE_CONCURRENCY : 2, worker, {
        paused: () => queuePause.current,
        progress: (p) =>
          setQueue({ ...p, kind, running: true, paused: queuePause.current }),
      });
    } finally {
      queueBusy.current = false;
      setQueue(
        (q) => q && { ...q, running: false, paused: queuePause.current },
      );
    }
  }
  const inputRef = useRef<HTMLInputElement>(null);
  const importing = useRef(false);
  const [importProgress, setImportProgress] = useState("");

  const photoMap = useMemo(() => {
    const m = new Map<string, Photo>();
    photos.forEach((p) => m.set(p.id, p));
    return m;
  }, [photos]);
  const photoById = useCallback((id: string) => photoMap.get(id), [photoMap]);

  useEffect(() => {
    let active = true;
    let release: () => void = () => {};
    const restore = async () => {
      try {
        const d = await loadDraft();
        const ids = new Set(d?.photos.map((p) => p.id) ?? []);
        // Free space first: delete photo data the workspace no longer uses.
        // Deletion works even when the browser refuses new writes, and never
        // touches a photo the workspace references.
        try {
          const removed = await cleanupUnreferenced(ids);
          if (removed.length)
            console.info(
              `[storage] removed ${removed.length} unused photo records`,
            );
        } catch (e) {
          reportError("storage cleanup", e);
        }
        if (d && active) {
          const restoredPhotos: Photo[] = [];
          for (const p of d.photos) {
            let previewUrl = "";
            try {
              previewUrl = await loadPreview(p.id);
            } catch (e) {
              reportError("photo preview", e);
            }
            restoredPhotos.push({ ...p, previewUrl, missing: !previewUrl });
          }
          setPhotos(restoredPhotos);
          const missing = restoredPhotos.filter((p) => p.missing).length;
          if (missing)
            setError(
              `${missing} saved photo${missing === 1 ? " is" : "s are"} missing from browser storage. Add ${missing === 1 ? "it" : "them"} again before writing or posting.`,
            );
          // SKUs generated by older versions are not the seller's; clear them.
          setGroups(d.groups.map(clearGeneratedSku));
          setOrphanIds(d.orphanIds);
          setBinPrefix(d.binPrefix);
          setSkuStart(d.skuStart);
          setStep(d.step);
          // Convert old-format photos in the background, one at a time.
          void (async () => {
            const legacy = (await legacyPhotoIds()).filter((id) =>
              ids.has(id),
            );
            if (!legacy.length) return;
            const r = await migrateLegacyPhotos(legacy, (done, total) => {
              if (active)
                setStorage((s) => ({ ...s, legacyRemaining: total - done }));
            });
            if (!active) return;
            if (r.error) reportError("photo storage upgrade", r.error);
            setStorage((s) => ({
              ...s,
              legacyRemaining: r.remaining,
              legacyNote: r.error
                ? `${r.remaining} older photo${r.remaining === 1 ? " is" : "s are"} still in the old, larger format and remain usable. ${r.error.message}`
                : undefined,
            }));
            void refreshStorage();
          })();
        }
      } catch (e) {
        if (active) {
          setError(reportError("restore", e));
          setSaveStatus(
            "Autosave unavailable — keep this tab open and export drafts.",
          );
        }
      } finally {
        if (active) {
          setRestored(true);
          void refreshStorage();
          void requestPersistence().then((persisted) =>
            setStorage((s) => ({ ...s, persisted })),
          );
        }
      }
    };
    if (navigator.locks)
      void navigator.locks.request(
        "listing-writer-workspace",
        { ifAvailable: true },
        async (lock) => {
          if (!active) return;
          if (!lock) {
            setReadOnly(true);
            setRestored(true);
            return;
          }
          await restore();
          await new Promise<void>((resolve) => {
            release = resolve;
            if (!active) resolve();
          });
        },
      );
    else void restore();
    return () => {
      active = false;
      release();
      revokeAllPreviews();
    };
  }, []);
  // Mark changed work unsaved before paint; older save completions cannot clear it.
  useLayoutEffect(() => {
    if (!restored || readOnly) return;
    let current = true;
    setSaveStatus("Saving…");
    const timer = setTimeout(() => {
      void saveDraft({
        photos,
        groups,
        orphanIds,
        binPrefix,
        skuStart,
        step,
        updatedAt: Date.now(),
      })
        .then(() => {
          if (current) setSaveStatus("Saved on this device");
        })
        .catch((e) => {
          const message = reportError("autosave", e);
          if (current)
            setSaveStatus(
              classifyStorageError(e).kind === "quota"
                ? "Could not save: browser storage is full. Use Free photo storage below, or free disk space; keep this tab open meanwhile."
                : `Could not save: ${message} Keep this tab open.`,
            );
        });
    }, 300);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [
    restored,
    readOnly,
    photos,
    groups,
    orphanIds,
    binPrefix,
    skuStart,
    step,
  ]);

  // Latest groups, readable inside async workers without stale closures.
  const groupsRef = useRef(groups);
  useEffect(() => {
    groupsRef.current = groups;
  }, [groups]);

  // Keep eBay connection status in sync (also after the connect bar updates).
  useEffect(() => {
    const check = () =>
      fetch("/api/ebay/status", { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => setEbayConnected(Boolean(d.connected)))
        .catch(() => setEbayConnected(false));
    check();
    const onFocus = () => check();
    window.addEventListener("focus", onFocus);
    window.addEventListener("ebay-connection-changed", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("ebay-connection-changed", onFocus);
    };
  }, []);

  // ── Upload ──────────────────────────────────────────────
  const addFiles = useCallback(
    async (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0 || importing.current) return;
      setError(null);
      const files = Array.from(fileList).filter(
        (f) =>
          f.type.startsWith("image/") ||
          /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name),
      );
      if (files.length === 0) {
        setError("Those didn't look like photos. Use JPG, PNG, or WebP.");
        return;
      }
      importing.current = true;
      try {
        // Warn before processing when the batch will not fit.
        const fit = importFits(await estimateStorage(), files);
        if (
          fit &&
          !fit.fits &&
          !window.confirm(
            `These ${files.length} photos need about ${formatBytes(fit.need)} of browser storage, but only about ${formatBytes(fit.free)} is free.\n\nPhotos that do not fit will not be added. Use "Free photo storage", or free disk space on this computer, to make room.\n\nImport anyway?`,
          )
        )
          return;
        void requestPersistence().then((persisted) =>
          setStorage((s) => ({ ...s, persisted })),
        );
        let processed = 0;
        setImportProgress(`Preparing 0 of ${files.length} photos…`);
        const result = await processFiles(
          files,
          files.length,
          async (file) => {
            const id = newId();
            const prepared = await preparePhoto(file);
            await savePhotoBlobs(id, prepared);
            processed++;
            setImportProgress(`Prepared ${processed} of ${files.length} photos…`);
            const photo: Photo = {
              id,
              mediaType: prepared.mediaType,
              name: file.name,
              size: file.size,
              previewUrl: setPreview(id, prepared.thumb),
            };
            return photo;
          },
          {
            describe: (e) => reportError("photo import", e),
            // A full or unavailable storage fails every remaining photo too.
            stopOn: (e) =>
              ["quota", "unavailable"].includes(classifyStorageError(e).kind),
          },
        );
        if (result.errors.length) setError(result.errors.join("; "));
        setPhotos((prev) => [...prev, ...result.values]);
      } catch (e) {
        setError(reportError("photo import", e));
      } finally {
        importing.current = false;
        setImportProgress("");
        void refreshStorage();
      }
    },
    [refreshStorage],
  );

  const removePhoto = (id: string) => {
    setPhotos((prev) => prev.filter((p) => p.id !== id));
    revokePreview(id);
    // Removing a photo frees its storage independently of autosave.
    void deletePhotoData([id])
      .catch((e) => reportError("remove photo", e))
      .finally(() => void refreshStorage());
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void addFiles(e.dataTransfer.files);
  };

  // ── Sort ────────────────────────────────────────────────
  const sort = async () => {
    if (photos.length === 0) return;
    setSorting(true);
    setError(null);
    try {
      // Sort in chunks so each request's thumbnail payload stays small.
      type RawGroup = { name: string; photoIds: string[] };
      const chunkResults: RawGroup[][] = [];
      const orphanIdsAll: string[] = [];
      for (let off = 0; off < photos.length; off += SORT_CHUNK) {
        const chunk = photos.slice(off, off + SORT_CHUNK);
        if (photos.length > SORT_CHUNK) {
          setSortProgress(
            `Sorting photos ${off + 1}–${off + chunk.length} of ${photos.length}…`,
          );
        }
        const res = await apiPost("/api/sort", {
          // Use the small thumbnail for sorting to keep the payload small.
          images: await thumbnailImages(chunk.map((p) => p.id)),
          sortModel: getSortModel() ?? undefined,
        });
        const data = (await readJson(
          res,
          "Try sorting fewer photos per batch.",
        )) as SortResponse;
        if (!data.ok || !data.groups) {
          throw new Error(data.error || "Could not sort the photos.");
        }
        const idxToId = (i: number) => chunk[i]?.id;
        chunkResults.push(
          data.groups
            .map((g) => ({
              name: g.name,
              photoIds: g.photoIndices.map(idxToId).filter(Boolean) as string[],
            }))
            .filter((g) => g.photoIds.length > 0),
        );
        orphanIdsAll.push(
          ...((data.orphanIndices ?? [])
            .map(idxToId)
            .filter(Boolean) as string[]),
        );
      }

      // Cross-chunk identity requires review; never join physical items from one thumbnail.
      const merged: RawGroup[] = chunkResults.flat();
      const assigned = new Set<string>();
      merged.forEach((g) => g.photoIds.forEach((id) => assigned.add(id)));
      orphanIdsAll.forEach((id) => assigned.add(id));
      // Any photo the sorter never placed shouldn't vanish — surface it.
      const leftover = photos
        .filter((p) => !assigned.has(p.id))
        .map((p) => p.id);

      // Items are identified by their internal id. The SKU (eBay Custom
      // Label) stays blank until the seller, their card or their inventory
      // sticker supplies one; it is never generated.
      const nextGroups: ItemGroup[] = merged.map((g) => ({
        id: newId(),
        sku: "",
        name: g.name,
        photoIds: g.photoIds,
        status: "idle",
      }));
      setGroups(nextGroups);
      setOrphanIds([...orphanIdsAll, ...leftover]);
      setStep("review");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSorting(false);
      setSortProgress(null);
    }
  };

  // ── Review edits ────────────────────────────────────────
  const rename = (groupId: string, name: string) =>
    setGroups((prev) =>
      prev.map((g) => (g.id === groupId ? { ...g, name } : g)),
    );

  const renameSku = (groupId: string, sku: string) =>
    setGroups((prev) =>
      prev.map((g) =>
        g.id === groupId &&
        !inFlight.current.has(g.id) &&
        !g.publicationAttemptSku &&
        g.postStatus !== "posted"
          ? // The seller's SKU, including a cleared one, is final.
            { ...g, sku, skuSource: "seller" }
          : g,
      ),
    );

  const movePhoto = (photoId: string, toGroupId: string | "orphans") => {
    setGroups((prev) =>
      prev.map((g) => {
        const nextIds =
          g.id === toGroupId
            ? g.photoIds.includes(photoId)
              ? g.photoIds
              : [...g.photoIds, photoId]
            : g.photoIds.filter((id) => id !== photoId);
        // A gained/lost photo invalidates an already-written listing — reset
        // it so "Write all listings" knows to redo this one (and only this one).
        const changed = nextIds.length !== g.photoIds.length;
        return {
          ...g,
          photoIds: nextIds,
          ...(changed
            ? {
                status: "idle" as const,
                listing: undefined,
                analysisPhotoIds: undefined,
                preparation: undefined,
                comps: undefined,
                imageUrls: undefined,
                uploadedPhotoIds: undefined,
              }
            : {}),
        };
      }),
    );
    setOrphanIds((prev) => {
      const without = prev.filter((id) => id !== photoId);
      return toGroupId === "orphans" ? [...without, photoId] : without;
    });
  };

  // Reorder photos within a group. The array order is the eBay photo order
  // (index 0 = cover/gallery image), so this is all that's needed — `writeGroup`
  // and `postGroup` re-derive their image order from `photoIds` at call time.
  const reorderPhoto = (
    groupId: string,
    fromIndex: number,
    toIndex: number,
  ) => {
    if (fromIndex === toIndex) return;
    setGroups((prev) =>
      prev.map((g) => {
        if (g.id !== groupId) return g;
        if (
          fromIndex < 0 ||
          toIndex < 0 ||
          fromIndex >= g.photoIds.length ||
          toIndex >= g.photoIds.length
        ) {
          return g;
        }
        const next = [...g.photoIds];
        const [moved] = next.splice(fromIndex, 1);
        next.splice(toIndex, 0, moved);
        return {
          ...g,
          photoIds: next,
          imageUrls: undefined,
          uploadedPhotoIds: undefined,
        };
      }),
    );
  };

  const deleteGroup = (groupId: string) =>
    setGroups((prev) => {
      const target = prev.find((g) => g.id === groupId);
      if (target && target.photoIds.length > 0) {
        setOrphanIds((o) => [...o, ...target.photoIds]);
      }
      return prev.filter((g) => g.id !== groupId);
    });

  const addGroup = () =>
    setGroups((prev) => [
      ...prev,
      {
        id: newId(),
        sku: "",
        name: `new-item-${prev.length + 1}`,
        photoIds: [],
        status: "idle",
      },
    ]);

  // ── Write listings ──────────────────────────────────────
  const writeGroup = useCallback(
    async (groupId: string) => {
      // Snapshot this group's photos from the latest state (no stale closure).
      const group = groupsRef.current.find((g) => g.id === groupId);
      if (!group || group.cloudBatchId || inFlight.current.has(groupId)) return;
      inFlight.current.add(groupId);
      setGroups((prev) =>
        prev.map((g) =>
          g.id === groupId ? { ...g, status: "writing", error: undefined } : g,
        ),
      );
      try {
        // ~1024 px analysis images, read from storage for this request only.
        const imgs = await analysisImages(
          (group.analysisPhotoIds ?? group.photoIds).filter(
            (id) => photoMap.get(id)?.analysisSelected !== false,
          ),
        );
        const res = await apiPost("/api/analyze", {
          profile: LISTING_PROFILE,
          images: imgs,
          analysisModel: getAnalysisModel() ?? undefined,
          routerModel: getSortModel() ?? undefined,
        });
        const data = (await readJson(res)) as AnalyzeResponse;
        if (!data.ok || !data.listing) {
          throw new Error(data.error || "Could not write this listing.");
        }
        setGroups((prev) =>
          prev.map((g) =>
            g.id === groupId
              ? {
                  ...g,
                  // Inventory sticker → SKU, unless the seller set one.
                  ...skuAfterAnalysis(g, data.listing!),
                  status: "writing",
                  listing: data.listing,
                  evidencePhotoIds: [
                    ...(group.analysisPhotoIds ?? group.photoIds),
                  ],
                  usage: (data as any).usage ?? [],
                  preparation: undefined,
                  comps: undefined,
                  compsStatus: "loading",
                }
              : g,
          ),
        );
        // Resolve final category/schema before review, never during publication.
        let researchListing = data.listing;
        try {
          const pr = await apiPost("/api/ebay/prepare", {
            listing: data.listing,
            images: imgs,
            enrich: true,
          });
          const pd = await readJson(pr);
          if (pd.ok) researchListing = pd.listing;
          setGroups((prev) =>
            prev.map((g) =>
              g.id === groupId
                ? pd.ok
                  ? {
                      ...g,
                      status: "done",
                      listing: pd.listing,
                      preparation: pd.preparation,
                      usage: [...(g.usage ?? []), ...(pd.usage ?? [])],
                    }
                  : { ...g, status: "done", preparationError: pd.error }
                : g,
            ),
          );
        } catch (e) {
          setGroups((prev) =>
            prev.map((g) =>
              g.id === groupId
                ? {
                    ...g,
                    status: "done",
                    preparationError: (e as Error).message,
                  }
                : g,
            ),
          );
        }
        // Market price check — advisory and best-effort, so it runs in the
        // background and silently stays hidden if it can't answer.
        void (async () => {
          try {
            const res = await apiPost("/api/ebay/comps", {
              listing: researchListing,
            });
            const d = (await readJson(res)) as {
              ok?: boolean;
              comps?: CompsSummary;
            };
            if (d.ok && d.comps?.ok) {
              setGroups((prev) =>
                prev.map((g) =>
                  g.id === groupId && g.listing === researchListing
                    ? { ...g, comps: d.comps, compsStatus: "ready" }
                    : g,
                ),
              );
            } else {
              setGroups((prev) =>
                prev.map((g) =>
                  g.id === groupId && g.listing === researchListing
                    ? { ...g, compsStatus: "unavailable" }
                    : g,
                ),
              );
            }
          } catch {
            setGroups((prev) =>
              prev.map((g) =>
                g.id === groupId && g.listing === researchListing
                  ? { ...g, compsStatus: "unavailable" }
                  : g,
              ),
            );
          }
        })();
      } catch (e) {
        setGroups((prev) =>
          prev.map((g) =>
            g.id === groupId
              ? { ...g, status: "error", error: reportError("write listing", e) }
              : g,
          ),
        );
      } finally {
        inFlight.current.delete(groupId);
      }
    },
    [photoMap],
  );

  const writeAll = async () => {
    // Only write listings that don't exist yet. Re-running everything after a
    // trip back to the review step re-billed the AI for unchanged listings
    // (issue #30) — groups whose photos changed are reset to "idle" by
    // movePhoto, so they (and only they) get rewritten here.
    const usable = groups
      .filter(
        (g) =>
          g.photoIds.length > 0 &&
          !g.cloudBatchId &&
          (g.status === "idle" || g.status === "error"),
      )
      .map((g) => g.id);
    setStep("listings");
    if (usable.length === 0) return;
    await startQueue(usable, "write", writeGroup);
  };

  const editGroup = (id: string, patch: Partial<ItemGroup>) =>
    setGroups((prev) =>
      prev.map((g) => (g.id === id ? { ...g, ...patch } : g)),
    );
  const editListing = (groupId: string, patch: Partial<ListingResult>) =>
    setGroups((prev) =>
      prev.map((g) =>
        g.id === groupId &&
        g.listing &&
        g.status !== "writing" &&
        g.postStatus !== "posted" &&
        g.postStatus !== "posting"
          ? {
              ...g,
              // Shared seller-edit rules: only the edited specific loses
              // provenance; mirrored fields and builder titles follow.
              listing: applyListingEdit(g.listing, patch),
              comps: undefined,
              compsStatus: "stale",
            }
          : g,
      ),
    );

  const postGroup = useCallback(
    async (groupId: string) => {
      const group = groupsRef.current.find((g) => g.id === groupId);
      if (
        !group ||
        !group.listing ||
        group.postStatus === "posted" ||
        inFlight.current.has(groupId)
      )
        return;
      const issues = draftIssues(group);
      if (
        group.sku.trim() &&
        groupsRef.current.some((g) => g.id !== groupId && g.sku === group.sku)
      )
        issues.push("Another item in this batch has the same SKU.");
      if (issues.length) {
        editGroup(groupId, {
          postStatus: "error",
          postError: issues.join("; "),
        });
        return;
      }
      inFlight.current.add(groupId);
      setGroups((prev) =>
        prev.map((g) =>
          g.id === groupId
            ? { ...g, postStatus: "posting", postError: undefined }
            : g,
        ),
      );
      try {
        // eBay upload copies are generated from the stored originals now,
        // with the same size rules as before; they are never stored.
        const alreadyDone =
          group.uploadedPhotoIds?.join(",") === group.photoIds.join(",");
        const images = alreadyDone
          ? group.photoIds.map(() => ({ mediaType: "image/jpeg", data: "" }))
          : await uploadImages(group.photoIds);
        // 1. Ship the photos to eBay first, in batches small enough that no
        // single request can hit Vercel's 4.5 MB body limit — the old
        // all-in-one publish request 413-failed on photo-heavy listings.
        const alreadyUploaded =
          group.uploadedPhotoIds?.join(",") === group.photoIds.join(",")
            ? group.imageUrls
            : undefined;
        const imageUrls: string[] = alreadyUploaded ? [...alreadyUploaded] : [];
        let uploadedCount = 0;
        for (const batch of chunkImagesForUpload(
          alreadyUploaded ? [] : images,
        )) {
          for (let attempt = 0; ; attempt++) {
            const res = await apiPost("/api/ebay/upload-photos", {
              sku: group.sku,
              images: batch,
              startIndex: uploadedCount,
            });
            if (attempt < 2 && TRANSIENT_STATUSES.has(res.status)) {
              await sleep(res.status === 429 ? 65_000 : 8_000);
              continue;
            }
            const d = (await readJson(res)) as {
              ok?: boolean;
              error?: string;
              urls?: string[];
            };
            if (!d.ok)
              throw new Error(d.error || "Could not upload photos to eBay.");
            if (!Array.isArray(d.urls) || d.urls.length !== batch.length)
              throw new Error(
                "Some selected photos failed to upload. Nothing was published. Retry the upload.",
              );
            imageUrls.push(...d.urls);
            break;
          }
          uploadedCount += batch.length;
        }
        if (imageUrls.length === 0) {
          throw new Error("Could not upload any photos to eBay.");
        }
        if (imageUrls.length !== images.length)
          throw new Error("All selected photos must upload before posting.");
        const uploadWarnings: string[] = [];
        const uploaded = {
          ...group,
          imageUrls,
          uploadedPhotoIds: [...group.photoIds],
          postStatus: "posting" as const,
          publicationAttemptSku: group.sku,
        };
        editGroup(groupId, uploaded);
        await saveDraft({
          photos: [...photoMap.values()],
          groups: groupsRef.current.map((g) =>
            g.id === groupId ? uploaded : g,
          ),
          orphanIds,
          binPrefix,
          skuStart,
          step: "listings",
          updatedAt: Date.now(),
        });
        // 2. Publish with the eBay-hosted URLs (a few KB instead of megabytes).
        let data: {
          success: boolean;
          listingId?: string;
          error?: string;
          alreadyListed?: boolean;
          warnings?: string[];
        } | null = null;
        let hadTransientRetry = false;
        for (let attempt = 0; ; attempt++) {
          const res = await apiPost("/api/ebay/publish", {
            sku: group.sku,
            listing: group.listing,
            imageUrls,
            shipping: group.shipping,
            review: group.preparation,
            expectedPhotoCount: group.photoIds.length,
          });
          // Wait out rate limits / transient platform errors instead of dying
          // mid-batch with "try again later".
          if (attempt < 2 && TRANSIENT_STATUSES.has(res.status)) {
            hadTransientRetry = true;
            await sleep(res.status === 429 ? 65_000 : 8_000);
            continue;
          }
          data = await readJson(res);
          break;
        }
        // A retried publish that finds the SKU already live means the earlier
        // attempt actually landed before the timeout — that's a success.
        if (
          data &&
          !data.success &&
          data.alreadyListed &&
          (hadTransientRetry || group.publicationAttemptSku === group.sku) &&
          data.listingId
        ) {
          data = { success: true, listingId: data.listingId };
        }
        if (!data?.success)
          throw new Error(data?.error || "eBay rejected the listing.");
        const allWarnings = [...uploadWarnings, ...(data.warnings ?? [])];
        setGroups((prev) =>
          prev.map((g) =>
            g.id === groupId
              ? {
                  ...g,
                  postStatus: "posted",
                  listingId: data!.listingId,
                  postWarnings: allWarnings.length ? allWarnings : undefined,
                }
              : g,
          ),
        );
      } catch (e) {
        setGroups((prev) =>
          prev.map((g) =>
            g.id === groupId
              ? { ...g, postStatus: "error", postError: (e as Error).message }
              : g,
          ),
        );
      } finally {
        inFlight.current.delete(groupId);
      }
    },
    [photoMap, orphanIds, binPrefix, skuStart],
  );

  const postAll = async (selected?: string[]) => {
    const ready = groupsRef.current
      .filter(
        (g) =>
          (!selected || selected.includes(g.id)) &&
          g.status === "done" &&
          g.postStatus !== "posted" &&
          !draftIssues(g).length,
      )
      .map((g) => g.id);
    await startQueue(ready, "post", postGroup);
  };

  const hasWork = photos.length > 0 || groups.length > 0;
  const busy =
    sorting ||
    Boolean(queue?.running) ||
    groups.some((g) => g.status === "writing" || g.postStatus === "posting");
  async function startNewBatch() {
    const unposted = groups.filter(
      (g) => g.listing && g.postStatus !== "posted",
    ).length;
    const warning = unposted
      ? `${unposted} written listing${unposted === 1 ? " has" : "s have"} not been posted to eBay and will be deleted.\n\n`
      : "";
    if (
      !window.confirm(
        `${warning}Start a new batch? This clears every photo and draft saved on this device.`,
      )
    )
      return;
    try {
      await clearDraft();
      revokeAllPreviews();
      setPhotos([]);
      setGroups([]);
      setOrphanIds([]);
      setBinPrefix("");
      setSkuStart(0);
      setStep("upload");
      setQueue(null);
      setSortProgress(null);
      setError(null);
    } catch {
      setError(
        "Could not clear saved work. Close other lister tabs and try again.",
      );
    }
  }

  // Photos used only by items already on eBay: their full-size originals
  // can be removed to free storage (thumbnails and listings stay).
  const postedOnlyPhotoIds = useMemo(() => {
    const active = new Set([
      ...orphanIds,
      ...groups
        .filter((g) => g.postStatus !== "posted")
        .flatMap((g) => g.photoIds),
    ]);
    return [
      ...new Set(
        groups
          .filter((g) => g.postStatus === "posted")
          .flatMap((g) => g.photoIds)
          .filter((id) => !active.has(id)),
      ),
    ];
  }, [groups, orphanIds]);
  async function removeUnusedPhotoData() {
    if (
      !window.confirm(
        "Remove stored photo data that no photo or item in this batch uses?\n\nEvery photo in your current batch is kept.",
      )
    )
      return;
    try {
      const removed = await cleanupUnreferenced(
        new Set(photos.map((p) => p.id)),
      );
      setStorage((s) => ({
        ...s,
        note: removed.length
          ? `Removed unused data for ${removed.length} photo${removed.length === 1 ? "" : "s"}.`
          : "No unused photo data was found.",
      }));
    } catch (e) {
      setStorage((s) => ({ ...s, note: reportError("free storage", e) }));
    } finally {
      void refreshStorage();
    }
  }
  async function removePostedOriginals() {
    const n = postedOnlyPhotoIds.length;
    if (
      !n ||
      !window.confirm(
        `Remove the full-size original files of ${n} photo${n === 1 ? "" : "s"} used only by items already posted to eBay?\n\nTheir thumbnails, listing details and the live eBay listings are kept. "Save original" will no longer work for these photos. Unposted items are not touched.`,
      )
    )
      return;
    try {
      await deleteOriginals(postedOnlyPhotoIds);
      setStorage((s) => ({
        ...s,
        note: `Removed originals of ${n} posted photo${n === 1 ? "" : "s"}.`,
      }));
    } catch (e) {
      setStorage((s) => ({ ...s, note: reportError("free storage", e) }));
    } finally {
      void refreshStorage();
    }
  }

  const usableGroups = useMemo(
    () => groups.filter((g) => g.photoIds.length > 0),
    [groups],
  );

  if (!restored) return <main className="wrap">Restoring saved work…</main>;
  if (readOnly)
    return (
      <main className="wrap">
        This workspace is already open in another tab. Close that tab and reload
        here to avoid conflicting edits.
      </main>
    );
  return (
    <main className="wrap">
      <div className="save-bar">
        <p role="status">{saveStatus}</p>
        <StoragePanel
          estimate={storage.est}
          persisted={storage.persisted}
          photos={photos}
          legacyRemaining={storage.legacyRemaining}
          legacyNote={storage.legacyNote}
          note={storage.note}
          storageError={/browser storage is full/i.test(saveStatus)}
          postedOriginals={postedOnlyPhotoIds.length}
          busy={busy || Boolean(importProgress)}
          onRemoveUnused={removeUnusedPhotoData}
          onRemovePostedOriginals={removePostedOriginals}
        />
        {hasWork && (
          <button
            type="button"
            className="btn btn-ghost danger"
            onClick={startNewBatch}
            disabled={busy}
            title={busy ? "Wait for writing or posting to finish" : undefined}
          >
            Start new batch
          </button>
        )}
      </div>
      <header className="masthead">
        <span className="logo-mark" aria-hidden="true">
          🪄
        </span>
        <div>
          <h1>Listing Writer</h1>
          <p>
            Clothing resale · upload a pile of photos · auto-sort into items
            · write every listing.
          </p>
        </div>
      </header>

      <EbayConnect />

      {step === "upload" && (
        <>
          <section className="hero">
            <h2>
              Dump every photo. <em>We&rsquo;ll sort it out.</em>
            </h2>
            <p>
              Add all your clothing, shoe and accessory photos for the whole
              batch at once. The app groups them into separate items, then
              writes a polished eBay listing for each one.
            </p>
          </section>

          <section className="panel" aria-labelledby="upload-heading">
            <h2 id="upload-heading" className="section-label">
              1 · Add all your photos
            </h2>

            <div
              className={`dropzone${dragging ? " dragging" : ""}`}
              role="button"
              tabIndex={0}
              onClick={() => inputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ")
                  inputRef.current?.click();
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
            >
              <span className="icon" aria-hidden="true">
                📸
              </span>
              <strong>Tap to choose photos, or drag them all here</strong>
              <span>
                Large batches supported · capacity depends on available browser
                storage · JPG, PNG, WebP
              </span>
              <input
                ref={inputRef}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => void addFiles(e.target.files)}
              />
            </div>

            {importProgress && <p aria-live="polite">{importProgress}</p>}
            {photos.length > 0 && (
              <div className="thumbs" aria-label="Selected photos">
                {photos.map((p) => (
                  <div className="thumb" key={p.id}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={p.previewUrl} alt="" />
                    <button
                      type="button"
                      aria-label="Remove photo"
                      onClick={() => removePhoto(p.id)}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div
              className="result-actions"
              style={{ borderTop: "none", paddingTop: 0 }}
            >
              <ModelSelector />
              <button
                type="button"
                className="btn btn-ghost"
                disabled={
                  !photos.length ||
                  photos.length > 24 ||
                  sorting ||
                  Boolean(importProgress)
                }
                onClick={() => {
                  const id = newId();
                  setGroups([
                    {
                      id,
                      sku: "",
                      name: "Single item",
                      photoIds: photos.map((p) => p.id),
                      status: "idle",
                    },
                  ]);
                  setOrphanIds([]);
                  setStep("review");
                }}
              >
                These photos are one item
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={sort}
                disabled={
                  photos.length === 0 || sorting || Boolean(importProgress)
                }
              >
                {sorting ? (
                  <>
                    <span className="spinner" aria-hidden="true" /> Sorting{" "}
                    {photos.length} photos…
                  </>
                ) : (
                  <>🔀 Sort {photos.length || ""} photos into items</>
                )}
              </button>
            </div>

            {error && (
              <p className="note note-error" role="alert">
                {error}
              </p>
            )}
          </section>

          {sorting && (
            <section className="panel">
              <div className="loading-card">
                <span className="spinner" aria-hidden="true" />
                <span>
                  {sortProgress ??
                    "Grouping photos by item, then double-checking for mixed-up or split items. This takes a little while for big batches."}
                </span>
              </div>
            </section>
          )}
        </>
      )}

      {(step === "review" || step === "listings") && (
        <CloudBatch
          groups={usableGroups}
          photos={photos}
          onResult={editGroup}
          onOpen={() => setStep("listings")}
        />
      )}
      {step === "review" && (
        <ReviewBoard
          groups={groups}
          orphanIds={orphanIds}
          photoById={photoById}
          onRename={rename}
          onRenameSku={renameSku}
          onMovePhoto={movePhoto}
          onReorderPhoto={reorderPhoto}
          onDeleteGroup={deleteGroup}
          onAddGroup={addGroup}
          onWriteAll={writeAll}
          onBack={() => setStep("upload")}
        />
      )}

      {step === "listings" && (
        <ListingsView
          groups={usableGroups}
          photoById={photoById}
          ebayConnected={ebayConnected}
          onEdit={editListing}
          onGroupEdit={(id, patch) => {
            const current = groupsRef.current.find((g) => g.id === id);
            if (
              current &&
              !inFlight.current.has(id) &&
              current.postStatus !== "posted"
            )
              editGroup(id, patch);
          }}
          onRenameSku={renameSku}
          onRetry={writeGroup}
          onPost={postGroup}
          onPostAll={postAll}
          onWriteAll={writeAll}
          onResume={() =>
            queue?.kind === "post"
              ? void postAll(queueIds.current)
              : void writeAll()
          }
          queue={queue}
          onPause={() => {
            queuePause.current = true;
            setQueue((q) => q && { ...q, paused: true });
          }}
          onBack={() => setStep("review")}
        />
      )}

      <p className="footnote">
        Drafts and photos are saved on this device. Keep this tab open while a
        batch is processing.
      </p>
    </main>
  );
}
