// Browser storage health: what the browser allows this site to store, how
// much is used, persistence, and seller-readable explanations of storage
// errors. Capacity is device- and browser-dependent; nothing here assumes a
// fixed quota.

export type StorageErrorKind =
  | "quota"
  | "unavailable"
  | "transaction"
  | "decode"
  | "unsupported"
  | "unknown";

export class PhotoError extends Error {
  constructor(
    readonly kind: StorageErrorKind,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "PhotoError";
  }
}

const detail = (e: unknown): string => {
  if (!e) return "no error details";
  const name = (e as { name?: string }).name;
  const message = (e as { message?: string }).message;
  return [name, message].filter(Boolean).join(": ") || String(e);
};

// Classify an IndexedDB/storage failure. Browsers report a full quota as
// QuotaExceededError (sometimes with an empty message), and some storage
// failures arrive as a null transaction error.
export function classifyStorageError(e: unknown): PhotoError {
  if (e instanceof PhotoError) return e;
  const name = (e as { name?: string } | null)?.name ?? "";
  const message = String((e as { message?: string } | null)?.message ?? "");
  if (
    name === "QuotaExceededError" ||
    /quota|exceed|no space|disk full/i.test(message)
  )
    return new PhotoError(
      "quota",
      "Browser storage is full. Free photo storage, or free disk space on this computer.",
      e,
    );
  if (
    ["SecurityError", "InvalidAccessError", "NotAllowedError"].includes(name) ||
    /indexeddb is not|not available|blocked|denied/i.test(message)
  )
    return new PhotoError(
      "unavailable",
      "Browser storage is unavailable or blocked for this site (for example a private window or site-data blocking).",
      e,
    );
  if (
    [
      "AbortError",
      "TransactionInactiveError",
      "InvalidStateError",
      "DataError",
      "ConstraintError",
      "VersionError",
      "ReadOnlyError",
    ].includes(name)
  )
    return new PhotoError(
      "transaction",
      `Saving to browser storage failed (${detail(e)}).`,
      e,
    );
  return new PhotoError(
    "unknown",
    `The browser could not store this data (${detail(e)}).`,
    e,
  );
}

// Seller-facing text for any error: never an empty message.
export function describeError(e: unknown): string {
  if (e instanceof PhotoError) return e.message;
  const message = (e as { message?: string } | null)?.message;
  return message?.trim() || classifyStorageError(e).message;
}

// Log the technical error for diagnosis; return the seller-facing text.
export function reportError(context: string, e: unknown): string {
  const friendly = describeError(e);
  console.error(`[${context}] ${friendly}`, (e as PhotoError)?.cause ?? e);
  return friendly;
}

export interface StorageEstimate {
  usage: number;
  quota: number;
}

export async function estimateStorage(): Promise<StorageEstimate | null> {
  try {
    const s = globalThis.navigator?.storage;
    if (!s?.estimate) return null;
    const { usage, quota } = await s.estimate();
    if (typeof usage !== "number" || typeof quota !== "number" || quota <= 0)
      return null;
    return { usage, quota };
  } catch {
    return null;
  }
}

// Ask the browser not to evict this site's data under storage pressure.
// Returns null when the browser has no persistence API. A refusal is normal
// and the app keeps working.
export async function requestPersistence(): Promise<boolean | null> {
  try {
    const s = globalThis.navigator?.storage;
    if (!s?.persist) return null;
    if (s.persisted && (await s.persisted())) return true;
    return await s.persist();
  } catch {
    return null;
  }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown";
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0
    ? `${Math.round(v)} ${units[i]}`
    : `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

// Bytes a photo occupies once stored: the original plus a ~1024 px analysis
// JPEG and a thumbnail (both small).
export const DERIVED_BYTES_PER_PHOTO = 350 * 1024;
export const estimateIncomingBytes = (files: { size: number }[]) =>
  files.reduce((n, f) => n + f.size + DERIVED_BYTES_PER_PHOTO, 0);

export interface StorageSummary {
  text: string;
  free: number;
  approxPhotos?: number;
}

// "Photo storage: 180 MB used of 1.2 GB available · room for about 240 more
// photos (estimate)". The per-photo figure comes from this batch's photos
// when known.
export function summarizeStorage(
  est: StorageEstimate,
  avgPhotoBytes?: number,
): StorageSummary {
  const free = Math.max(0, est.quota - est.usage);
  const per = avgPhotoBytes && avgPhotoBytes > 0 ? avgPhotoBytes : 0;
  const approxPhotos = per ? Math.floor(free / per) : undefined;
  return {
    free,
    approxPhotos,
    text:
      `Photo storage: ${formatBytes(est.usage)} used of ${formatBytes(est.quota)} available` +
      (approxPhotos !== undefined
        ? ` · room for about ${approxPhotos} more photos (estimate)`
        : ""),
  };
}

// Will these files fit? Only answers when the browser reports an estimate.
export function importFits(
  est: StorageEstimate | null,
  files: { size: number }[],
): { fits: boolean; need: number; free: number } | null {
  if (!est) return null;
  const need = estimateIncomingBytes(files);
  const free = Math.max(0, est.quota - est.usage);
  return { fits: need <= free * 0.95, need, free };
}
