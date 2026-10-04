"use client";
// Photo storage health: usage against what this browser allows, an estimate
// of remaining room, persistence, old-format photos still to convert, and
// deliberate actions for freeing space. Collapsed unless storage needs
// attention.

import type { Photo } from "@/lib/types";
import {
  DERIVED_BYTES_PER_PHOTO,
  summarizeStorage,
  type StorageEstimate,
} from "@/lib/storage-health";

interface Props {
  estimate: StorageEstimate | null;
  persisted: boolean | null;
  photos: Photo[];
  legacyRemaining: number;
  legacyNote?: string;
  note?: string;
  storageError: boolean;
  postedOriginals: number;
  busy: boolean;
  onRemoveUnused: () => void;
  onRemovePostedOriginals: () => void;
}

export function StoragePanel(p: Props) {
  const sized = p.photos.filter((x) => x.size);
  const avg = sized.length
    ? sized.reduce((n, x) => n + (x.size ?? 0), 0) / sized.length +
      DERIVED_BYTES_PER_PHOTO
    : undefined;
  const summary = p.estimate ? summarizeStorage(p.estimate, avg) : null;
  const low = Boolean(
    p.estimate && p.estimate.quota - p.estimate.usage < p.estimate.quota * 0.1,
  );
  const attention = p.storageError || low || Boolean(p.legacyNote);
  return (
    <details className="storage-panel" open={attention || undefined}>
      <summary>
        {summary
          ? summary.text
          : "Photo storage: this browser does not report storage usage"}
        {low ? " · running low" : ""}
      </summary>
      <p>
        Photos are kept in this browser until the batch is cleared. Capacity
        depends on the free disk space on this computer and on the browser.
        {p.persisted === true
          ? " The browser has agreed to keep this data even under storage pressure."
          : p.persisted === false
            ? " The browser has not granted persistent storage, so it may clear this data if the disk gets very full; post or export finished work promptly."
            : ""}
      </p>
      {p.legacyRemaining > 0 && (
        <p>
          Converting {p.legacyRemaining} older photo
          {p.legacyRemaining === 1 ? "" : "s"} to the smaller storage format…
        </p>
      )}
      {p.legacyNote && <p role="alert">{p.legacyNote}</p>}
      {p.note && <p role="status">{p.note}</p>}
      <div className="storage-actions">
        <button
          type="button"
          className="btn btn-ghost"
          disabled={p.busy}
          onClick={p.onRemoveUnused}
        >
          Free photo storage: remove unused data
        </button>
        {p.postedOriginals > 0 && (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={p.busy}
            onClick={p.onRemovePostedOriginals}
          >
            Remove originals of {p.postedOriginals} posted photo
            {p.postedOriginals === 1 ? "" : "s"}
          </button>
        )}
      </div>
    </details>
  );
}
