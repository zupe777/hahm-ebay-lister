// Reconciling sort results across chunk boundaries.
//
// Big batches are sorted in chunks (one /api/sort request each), so an item
// photographed across a boundary — photos 100/101, 200/201, … — comes back
// as two groups. At every boundary, the group just before it and the group
// just after it are compared (their photos nearest the boundary, at most
// MAX_SEAM_PHOTOS in total) with the same decision the sorter uses to merge
// adjacent groups within a request. A boundary whose check fails or times
// out is never guessed: the groups stay separate and the seller is told.

// Photos per boundary check: the same 24-photo bound the in-request merge
// step uses for a pair of groups. (Kept here, free of server code, so the
// browser can import it.)
export const MAX_SEAM_PHOTOS = 24;

export interface SortedChunk {
  // This chunk's photos, in batch order.
  photoIds: string[];
  groups: { name: string; photoIds: string[] }[];
  orphanIds: string[];
}

// Same item? true / false; null when the check could not be completed.
export type SeamCheck = (
  left: string[],
  right: string[],
) => Promise<boolean | null>;

export interface ReconciledSort {
  groups: { name: string; photoIds: string[] }[];
  orphanIds: string[];
  warnings: string[];
  seamsChecked: number;
  seamsMerged: number;
}

// The photos of each boundary group nearest the boundary: the end of the
// group before it and the start of the group after it, half of the budget
// each, with any share one side cannot use given to the other.
export function seamRepresentatives(
  left: string[],
  right: string[],
  max = MAX_SEAM_PHOTOS,
): { left: string[]; right: string[] } {
  const half = Math.floor(max / 2);
  const l = Math.min(left.length, Math.max(half, max - right.length));
  const r = Math.min(right.length, max - l);
  return { left: left.slice(left.length - l), right: right.slice(0, r) };
}

// Rejects after `ms`: a hung boundary check counts as a failed one.
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error("The boundary check timed out.")),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export async function reconcileSeams(
  chunks: SortedChunk[],
  check: SeamCheck,
  onSeam?: (photoNumber: number) => void,
): Promise<ReconciledSort> {
  const position = new Map<string, number>();
  chunks
    .flatMap((c) => c.photoIds)
    .forEach((id, i) => {
      if (!position.has(id)) position.set(id, i);
    });
  const pos = (id: string) => position.get(id) ?? Number.MAX_SAFE_INTEGER;

  // Every group of every chunk, joined by union-find as boundaries merge.
  const groups = chunks.flatMap((c) =>
    c.groups.map((g) => ({ name: g.name, photoIds: [...g.photoIds] })),
  );
  const parent = groups.map((_, i) => i);
  const find = (i: number): number =>
    parent[i] === i ? i : (parent[i] = find(parent[i]));
  const groupOf = new Map<string, number>();
  groups.forEach((g, i) =>
    g.photoIds.forEach((id) => {
      if (!groupOf.has(id)) groupOf.set(id, i);
    }),
  );
  const members = (root: number) =>
    groups
      .flatMap((g, i) => (find(i) === root ? g.photoIds : []))
      .sort((a, b) => pos(a) - pos(b));

  const result: ReconciledSort = {
    groups: [],
    orphanIds: [],
    warnings: [],
    seamsChecked: 0,
    seamsMerged: 0,
  };
  let photoNumber = 0;
  for (let c = 0; c < chunks.length - 1; c++) {
    photoNumber += chunks[c].photoIds.length;
    // The grouped photo nearest the boundary on each side (photos left for
    // review at the boundary are skipped, never moved).
    const before = [...chunks[c].photoIds]
      .reverse()
      .find((id) => groupOf.has(id));
    const after = chunks[c + 1].photoIds.find((id) => groupOf.has(id));
    if (before === undefined || after === undefined) continue;
    const L = find(groupOf.get(before)!);
    const R = find(groupOf.get(after)!);
    if (L === R) continue;
    const reps = seamRepresentatives(members(L), members(R));
    onSeam?.(photoNumber);
    let same: boolean | null;
    try {
      same = await check(reps.left, reps.right);
    } catch {
      same = null;
    }
    result.seamsChecked++;
    if (same === true) {
      parent[R] = L;
      result.seamsMerged++;
    } else if (same === null) {
      result.warnings.push(
        `Photos ${photoNumber} and ${photoNumber + 1}: the check whether "${groups[L].name}" and "${groups[R].name}" are the same item could not be completed, so they were kept separate. If they are one item, move the photos together.`,
      );
    }
  }

  // Combined groups, in batch order; every photo exactly once.
  const seen = new Set<string>();
  const roots = [...new Set(groups.map((_, i) => find(i)))];
  for (const root of roots) {
    const photoIds = members(root).filter((id) => !seen.has(id));
    photoIds.forEach((id) => seen.add(id));
    if (photoIds.length)
      result.groups.push({ name: groups[root].name, photoIds });
  }
  result.groups.sort((a, b) => pos(a.photoIds[0]) - pos(b.photoIds[0]));
  for (const id of chunks.flatMap((c) => c.orphanIds))
    if (!seen.has(id)) {
      seen.add(id);
      result.orphanIds.push(id);
    }
  return result;
}
