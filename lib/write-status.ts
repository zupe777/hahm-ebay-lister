import type { ItemGroup } from "./types";

// Where an item's listing stands in the writing step.
export type WriteState = "not-written" | "writing" | "written" | "failed";

export function writeState(g: ItemGroup): WriteState {
  if (g.status === "writing") return "writing";
  if (g.status === "done") return "written";
  if (g.status === "error") return "failed";
  return "not-written";
}

export const WRITE_STATE_LABEL: Record<WriteState, string> = {
  "not-written": "Not written",
  writing: "Writing…",
  written: "Written",
  failed: "Writing failed",
};

// Items the seller may send (again) for writing: never written, or failed.
// Written items are never rewritten by a batch or a retry.
export const needsWriting = (g: ItemGroup) =>
  !g.cloudBatchId &&
  g.photoIds.length > 0 &&
  (g.status === "idle" || g.status === "error");

// The chosen items that may actually be written, in batch order.
export const retryTargets = (groups: ItemGroup[], chosen: Iterable<string>) => {
  const ids = new Set(chosen);
  return groups
    .filter((g) => ids.has(g.id) && needsWriting(g))
    .map((g) => g.id);
};
