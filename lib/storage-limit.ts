// The practical storage limit for this browser and site, learned from real
// "storage full" errors.
//
// Chrome reports navigator.storage.estimate().quota as usage + 10 GiB (or
// similar padding) to every page, so it says nothing about how much a site
// can really store; one Chrome profile refused writes at about 311 MB. The
// app therefore never treats the reported quota as capacity. Instead:
//   • before any failure it assumes about 300 MB (labelled as assumed);
//   • a genuine QuotaExceededError sets the limit to the usage at that moment
//     (the most recent failure wins, so a lower later failure lowers it);
//   • a successful save above the limit raises it to that usage;
//   • the evidence never expires on a timer.
// The record lives in localStorage, which stays writable when IndexedDB is
// full, with a best-effort copy in IndexedDB.

import { currentUsage } from "./storage-health";

const KEY = "listing-writer-storage-limit";
const MB = 1024 * 1024;
export const ASSUMED_LIMIT = 300 * MB;
export const MIN_RESERVE = 24 * MB;
// What a stored photo (master + thumbnail) costs before real averages exist.
export const DEFAULT_PHOTO_BYTES = 930 * 1024;
const MAX_FAILURES = 10;

export const reserveFor = (limit: number) =>
  Math.max(MIN_RESERVE, Math.round(limit * 0.1));

export interface LimitFailure {
  usage: number;
  at: number;
  context: string;
}

export interface LimitRecord {
  version: 1;
  // Limit learned from evidence; absent until the first genuine failure.
  learned?: { bytes: number; at: number; raised?: boolean };
  failures: LimitFailure[];
  highestSuccess: number;
  highestSuccessAt?: number;
  updatedAt: number;
}

const empty = (): LimitRecord => ({
  version: 1,
  failures: [],
  highestSuccess: 0,
  updatedAt: 0,
});

function valid(r: unknown): r is LimitRecord {
  const x = r as LimitRecord;
  return (
    !!x &&
    x.version === 1 &&
    Array.isArray(x.failures) &&
    typeof x.highestSuccess === "number" &&
    (x.learned === undefined || typeof x.learned.bytes === "number")
  );
}

// ── Persistence ──────────────────────────────────────────────────────────────

export interface LimitMirror {
  read: () => Promise<unknown>;
  write: (r: LimitRecord) => Promise<void>;
}
let mirror: LimitMirror | undefined;
export function setLimitMirror(m: LimitMirror | undefined) {
  mirror = m;
}

const listeners = new Set<(r: LimitRecord) => void>();
export function onLimitChange(cb: (r: LimitRecord) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

export function loadLimitRecord(): LimitRecord {
  try {
    const raw = storage()?.getItem(KEY);
    const r = raw ? JSON.parse(raw) : undefined;
    return valid(r) ? r : empty();
  } catch {
    return empty();
  }
}

function saveLimitRecord(r: LimitRecord): LimitRecord {
  try {
    storage()?.setItem(KEY, JSON.stringify(r));
  } catch (e) {
    console.warn("[storage-limit] could not save the learned limit", e);
  }
  void mirror?.write(r).catch(() => {
    /* IndexedDB may be full; localStorage holds the record */
  });
  listeners.forEach((cb) => cb(r));
  return r;
}

// At startup: if localStorage lost the record but IndexedDB kept a newer
// copy, restore it.
export async function restoreLimitRecord(): Promise<LimitRecord> {
  const local = loadLimitRecord();
  try {
    const copy = await mirror?.read();
    if (valid(copy) && copy.updatedAt > local.updatedAt)
      return saveLimitRecord(copy);
  } catch {
    /* keep the local record */
  }
  return local;
}

// ── Evidence ─────────────────────────────────────────────────────────────────

// Only the browser's own QuotaExceededError counts — never a guess from an
// error message, a missing database, a decode failure or an unknown error.
export function isGenuineQuotaError(e: unknown): boolean {
  for (let x = e, depth = 0; x && depth < 5; depth++) {
    const err = x as { name?: string; code?: number; cause?: unknown };
    if (err.name === "QuotaExceededError") return true;
    if (typeof DOMException !== "undefined" && x instanceof DOMException)
      if (err.code === 22) return true;
    x = err.cause;
  }
  return false;
}

export function recordQuotaFailure(
  usage: number,
  context: string,
  now = Date.now(),
): LimitRecord {
  const r = loadLimitRecord();
  if (!Number.isFinite(usage) || usage <= 0) return r;
  return saveLimitRecord({
    ...r,
    learned: { bytes: usage, at: now },
    failures: [...r.failures, { usage, at: now, context }].slice(-MAX_FAILURES),
    updatedAt: now,
  });
}

export function recordSuccess(usage: number, now = Date.now()): LimitRecord {
  const r = loadLimitRecord();
  if (!Number.isFinite(usage) || usage <= 0) return r;
  const higher = usage > r.highestSuccess;
  const raise = r.learned && usage > r.learned.bytes;
  if (!higher && !raise) return r;
  return saveLimitRecord({
    ...r,
    ...(higher ? { highestSuccess: usage, highestSuccessAt: now } : {}),
    ...(raise ? { learned: { bytes: usage, at: now, raised: true } } : {}),
    updatedAt: now,
  });
}

// Forget the learned limit (seller's explicit choice in Technical details).
export function forgetLearnedLimit(now = Date.now()): LimitRecord {
  return saveLimitRecord({ ...empty(), updatedAt: now });
}

// ── The limit and the room left ──────────────────────────────────────────────

export type LimitKind = "learned" | "assumed" | "browser";

export interface EffectiveLimit {
  bytes: number;
  kind: LimitKind;
  at?: number;
  raised?: boolean;
}

// The reported quota only ever lowers the limit (a browser that genuinely
// reports less than the evidence); a padded quota is far above and ignored.
export function effectiveLimit(
  r: LimitRecord,
  reportedQuota?: number | null,
): EffectiveLimit {
  const base: EffectiveLimit = r.learned
    ? {
        bytes: r.learned.bytes,
        kind: "learned",
        at: r.learned.at,
        raised: r.learned.raised,
      }
    : { bytes: Math.max(ASSUMED_LIMIT, r.highestSuccess), kind: "assumed" };
  if (
    typeof reportedQuota === "number" &&
    Number.isFinite(reportedQuota) &&
    reportedQuota > 0 &&
    reportedQuota < base.bytes
  )
    return { bytes: reportedQuota, kind: "browser" };
  return base;
}

export interface StoragePlan {
  usage: number;
  limit: EffectiveLimit;
  reserve: number;
  // Bytes photos may still use while keeping the reserve free.
  safeBytes: number;
  photoBytes: number;
  photosLeft: number;
  state: "ok" | "low" | "full";
}

export function storagePlan(
  usage: number,
  limit: EffectiveLimit,
  avgPhotoBytes?: number,
): StoragePlan {
  const reserve = reserveFor(limit.bytes);
  const room = Math.max(0, limit.bytes - reserve);
  const safeBytes = Math.max(0, room - usage);
  const photoBytes =
    avgPhotoBytes && avgPhotoBytes > 0 ? avgPhotoBytes : DEFAULT_PHOTO_BYTES;
  const photosLeft = Math.floor(safeBytes / photoBytes);
  return {
    usage,
    limit,
    reserve,
    safeBytes,
    photoBytes,
    photosLeft,
    state: photosLeft < 1 ? "full" : safeBytes < room * 0.15 ? "low" : "ok",
  };
}

// How many of `count` selected photos fit before the reserve.
export const photosThatFit = (count: number, plan: StoragePlan) =>
  Math.max(0, Math.min(count, plan.photosLeft));

// Whether one more photo of this size may be written now.
export const roomForAnother = (
  usage: number,
  limit: EffectiveLimit,
  photoBytes: number,
) => usage + photoBytes <= limit.bytes - reserveFor(limit.bytes);

// ── Wiring to real storage events ────────────────────────────────────────────

// After any storage error: learn only from a genuine QuotaExceededError.
// Returns true when the error was one.
export async function learnFromError(
  e: unknown,
  context: string,
  usage: () => Promise<number | null> = currentUsage,
): Promise<boolean> {
  if (!isGenuineQuotaError(e)) return false;
  const u = await usage().catch(() => null);
  if (u) recordQuotaFailure(u, context);
  return true;
}

// After a successful write: evidence that this much fits.
export async function learnFromSuccess(
  usage: () => Promise<number | null> = currentUsage,
): Promise<number | null> {
  const u = await usage().catch(() => null);
  if (u) recordSuccess(u);
  return u;
}
