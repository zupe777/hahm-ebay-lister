// Browser storage health: how much is used, persistence, and seller-readable
// explanations of storage errors. The practical limit is learned from real
// failures (lib/storage-limit.ts); the browser's reported quota is padded and
// is never shown or used as capacity.

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

// Bytes in use by this site right now (real usage, unlike the padded quota).
export async function currentUsage(): Promise<number | null> {
  return (await estimateStorage())?.usage ?? null;
}
