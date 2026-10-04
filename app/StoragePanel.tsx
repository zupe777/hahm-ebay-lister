"use client";
// Photo storage health: what is used, the practical limit on this computer
// (learned from real "storage full" errors, or a clearly labelled assumption
// until one happens), the safe room left, photo conversion progress, and
// deliberate actions for freeing space. Chrome's own figures appear only
// under Technical details: its reported quota is padded and is never shown
// as available space. Collapsed unless storage needs attention.

import {
  effectiveLimit,
  storagePlan,
  type LimitRecord,
} from "@/lib/storage-limit";
import { formatBytes } from "@/lib/storage-health";
import type { PhotoStats } from "@/lib/photo-store";

interface Props {
  usage: number | null;
  reportedQuota: number | null;
  limitRecord: LimitRecord;
  photoCount: number;
  stats: PhotoStats | null;
  persisted: boolean | null;
  converting: number;
  conversionNote?: string;
  note?: string;
  storageError: boolean;
  releasable: number;
  busy: boolean;
  onRemoveUnused: () => void;
  onReleasePosted: () => void;
  onForgetLimit: () => void;
}

const day = (at?: number) =>
  at ? new Date(at).toLocaleDateString(undefined, { dateStyle: "medium" }) : "";
const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

export function StoragePanel(p: Props) {
  const limit = effectiveLimit(p.limitRecord, p.reportedQuota);
  const plan =
    p.usage === null
      ? null
      : storagePlan(p.usage, limit, p.stats?.avgPhotoBytes);
  const attention =
    p.storageError ||
    plan?.state === "full" ||
    plan?.state === "low" ||
    Boolean(p.conversionNote) ||
    Boolean(p.note);
  const failures = p.limitRecord.failures;
  return (
    <details className="storage-panel" open={attention || undefined}>
      <summary>
        {plan
          ? `Photo storage: ${formatBytes(plan.usage)} used · ${plural(p.photoCount, "photo")}`
          : `Photo storage: ${plural(p.photoCount, "photo")} (this browser does not report usage)`}
        {plan?.state === "full"
          ? " · full"
          : plan?.state === "low"
            ? " · running low"
            : ""}
      </summary>
      <p>
        {limit.kind === "learned"
          ? limit.raised
            ? `Practical limit on this computer: about ${formatBytes(limit.bytes)} — raised on ${day(limit.at)} after a successful save above the earlier learned limit.`
            : `Practical limit on this computer: about ${formatBytes(limit.bytes)} — learned on ${day(limit.at)} from a real "storage full" error.`
          : limit.kind === "browser"
            ? `Practical limit: about ${formatBytes(limit.bytes)} (reported by this browser).`
            : `Practical limit: about ${formatBytes(limit.bytes)} (assumed — Chrome does not report the real limit; the app learns it if storage ever fills).`}
      </p>
      {plan && (
        <p>
          {plan.state === "full"
            ? `No safe room for more photos. ${formatBytes(plan.reserve)} is kept free so listing edits can still be saved. Release photos of posted items or remove photos you no longer need.`
            : `Safe room for about ${plural(plan.photosLeft, "more photo")} (about ${formatBytes(plan.photoBytes)} each${p.stats?.avgPhotoBytes ? ", based on your stored photos" : ", typical size"}; ${formatBytes(plan.reserve)} is kept free for saving your work).`}
        </p>
      )}
      <p>
        Photos are kept in this browser until the batch is cleared.
        {p.persisted === true
          ? " The browser has agreed to keep this data even under storage pressure."
          : p.persisted === false
            ? " The browser has not granted persistent storage, so it may clear this data if the disk gets very full; post or export finished work promptly."
            : ""}
      </p>
      {p.converting > 0 && !p.conversionNote && (
        <p role="status">
          Converting {plural(p.converting, "photo")} to the smaller storage
          format…
        </p>
      )}
      {p.conversionNote && <p role="alert">{p.conversionNote}</p>}
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
        {p.releasable > 0 && (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={p.busy}
            onClick={p.onReleasePosted}
          >
            Release {plural(p.releasable, "photo")} of posted items
          </button>
        )}
      </div>
      <details className="storage-technical">
        <summary>Technical details</summary>
        <ul>
          <li>
            Chrome-reported usage:{" "}
            {p.usage === null ? "not reported" : formatBytes(p.usage)}
          </li>
          <li>
            Chrome-reported quota:{" "}
            {p.reportedQuota === null
              ? "not reported"
              : formatBytes(p.reportedQuota)}{" "}
            (Chrome pads this figure; it is not a real limit and the app does
            not use it as available space)
          </li>
          {plan && <li>Reserve kept free: {formatBytes(plan.reserve)}</li>}
          <li>
            Highest usage saved successfully:{" "}
            {p.limitRecord.highestSuccess
              ? `${formatBytes(p.limitRecord.highestSuccess)} (${day(p.limitRecord.highestSuccessAt)})`
              : "none recorded yet"}
          </li>
          <li>
            Storage-full errors:{" "}
            {failures.length
              ? failures
                  .map(
                    (f) =>
                      `${formatBytes(f.usage)} on ${day(f.at)} (${f.context})`,
                  )
                  .join("; ")
              : "none recorded"}
          </li>
          {p.stats && p.stats.masters > 0 && (
            <li>
              Stored photos: {plural(p.stats.masters, "photo")},{" "}
              {formatBytes(p.stats.masterBytes + p.stats.thumbBytes)} (average{" "}
              {formatBytes(p.stats.avgPhotoBytes ?? 0)} per photo)
            </li>
          )}
        </ul>
        {p.limitRecord.learned && (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={p.onForgetLimit}
          >
            Forget learned limit
          </button>
        )}
      </details>
    </details>
  );
}
