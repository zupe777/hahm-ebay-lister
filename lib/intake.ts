// Process selected photo files two at a time. Every selected file ends in
// exactly one outcome — added, failed (with its reason) or not started
// because the import stopped — so the summary accounts for all of them. A
// failure that will repeat for every remaining file (e.g. browser storage
// full) stops the import; files already in progress that fail the same way
// are counted under the same reason as the files never started.

import { classifyStorageError, describeError } from "./storage-health";

export type FileOutcome<T> =
  | { status: "added"; name: string; value: T }
  | { status: "failed"; name: string; reason: string }
  | { status: "skipped"; name: string; reason: string };

export interface ProcessOptions {
  // The "because …" reason for a failure, e.g. "browser storage is full".
  reasonOf?: (e: unknown) => string;
  stopOn?: (e: unknown) => boolean;
}

export interface ProcessResult<T> {
  values: T[];
  outcomes: FileOutcome<T>[];
  summary: string | null;
}

export async function processFiles<T>(
  files: File[],
  process: (file: File) => Promise<T>,
  opts: ProcessOptions = {},
): Promise<ProcessResult<T>> {
  const reasonOf = opts.reasonOf ?? describeError;
  const outcomes: (FileOutcome<T> | undefined)[] = new Array(files.length);
  let cursor = 0;
  let stopReason: string | undefined;
  await Promise.all(
    Array.from({ length: Math.min(2, files.length) }, async () => {
      while (cursor < files.length && stopReason === undefined) {
        const i = cursor++;
        const name = files[i].name;
        try {
          outcomes[i] = {
            status: "added",
            name,
            value: await process(files[i]),
          };
        } catch (e) {
          const reason = reasonOf(e);
          outcomes[i] = { status: "failed", name, reason };
          if (opts.stopOn?.(e) && stopReason === undefined) stopReason = reason;
        }
      }
    }),
  );
  // Array.from visits every index (map would skip never-started holes).
  const all: FileOutcome<T>[] = Array.from(
    outcomes,
    (o, i) =>
      o ?? {
        status: "skipped" as const,
        name: files[i].name,
        reason: stopReason ?? "the import stopped",
      },
  );
  return {
    values: all.flatMap((o) => (o.status === "added" ? [o.value] : [])),
    outcomes: all,
    summary: summarizeImport(all),
  };
}

// "Added 6 of 34 photos. 28 were not added because browser storage is full."
// Null when every photo was added.
export function summarizeImport(
  outcomes: FileOutcome<unknown>[],
  extra: { count: number; reason: string }[] = [],
): string | null {
  const total = outcomes.length + extra.reduce((n, x) => n + x.count, 0);
  const added = outcomes.filter((o) => o.status === "added").length;
  if (added === total) return null;
  const byReason = new Map<string, string[]>();
  for (const o of outcomes)
    if (o.status !== "added")
      byReason.set(o.reason, [...(byReason.get(o.reason) ?? []), o.name]);
  for (const x of extra)
    byReason.set(x.reason, [
      ...(byReason.get(x.reason) ?? []),
      ...Array<string>(x.count).fill(""),
    ]);
  const parts = [`Added ${added} of ${total} photo${total === 1 ? "" : "s"}.`];
  for (const [reason, names] of byReason) {
    const n = names.length;
    const listed = names.filter(Boolean);
    const which =
      n <= 5 && listed.length === n ? ` (${listed.join(", ")})` : "";
    parts.push(
      `${n} ${n === 1 ? "was" : "were"} not added${which} because ${reason}.`,
    );
  }
  return parts.join(" ");
}

// ── Reasons shown in the import summary ──────────────────────────────────────

// Thrown before a write that would eat into the space kept free for saving.
export class ReserveReached extends Error {
  constructor() {
    super("The safe storage limit on this computer was reached.");
    this.name = "ReserveReached";
  }
}

export const RESERVE_REASON =
  "the safe storage limit on this computer was reached (space is kept free so your listing edits can still be saved)";
export const FULL_REASON = "browser storage is full";

export function importReason(e: unknown): string {
  if (e instanceof ReserveReached) return RESERVE_REASON;
  const err = classifyStorageError(e);
  if (err.kind === "quota") return FULL_REASON;
  if (err.kind === "unavailable")
    return "browser storage is unavailable or blocked for this site";
  if (err.kind === "unsupported")
    return "this browser cannot read HEIC photos (export them as JPG and add them again)";
  if (err.kind === "decode")
    return "the files could not be read as photos (unsupported or damaged image files)";
  return `of an error: ${err.message.replace(/\.$/, "")}`;
}

// Failures that would repeat for every remaining photo stop the import.
export const stopsImport = (e: unknown) =>
  e instanceof ReserveReached ||
  ["quota", "unavailable"].includes(classifyStorageError(e).kind);
