import { describe, expect, it, vi } from "vitest";
import {
  MAX_SEAM_PHOTOS,
  reconcileSeams,
  seamRepresentatives,
  withTimeout,
  type SeamCheck,
  type SortedChunk,
} from "@/lib/sort-seams";

// Photo ids p0, p1, … in batch order.
const ids = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `p${from + i}`);
const chunk = (
  from: number,
  to: number,
  groups: [string, number, number][],
  orphans: number[] = [],
): SortedChunk => ({
  photoIds: ids(from, to),
  groups: groups.map(([name, a, b]) => ({ name, photoIds: ids(a, b) })),
  orphanIds: orphans.map((n) => `p${n}`),
});
// Every photo of the batch appears exactly once, in a group or for review.
function expectAllAccounted(
  r: { groups: { photoIds: string[] }[]; orphanIds: string[] },
  total: number,
) {
  const all = [...r.groups.flatMap((g) => g.photoIds), ...r.orphanIds];
  expect(all).toHaveLength(total);
  expect(new Set(all)).toEqual(new Set(ids(0, total - 1)));
}
const names = (r: { groups: { name: string; photoIds: string[] }[] }) =>
  r.groups.map((g) => [g.name, g.photoIds.length]);

describe("chunk-boundary reconciliation", () => {
  it("an item crossing photo 100/101 becomes one item", async () => {
    const check = vi.fn<SeamCheck>(async () => true);
    const r = await reconcileSeams(
      [
        chunk(0, 99, [
          ["red-shorts", 0, 94],
          ["blue-tee", 95, 99],
        ]),
        chunk(100, 129, [
          ["blue-shirt", 100, 107],
          ["gray-pants", 108, 129],
        ]),
      ],
      check,
    );
    expect(check).toHaveBeenCalledTimes(1);
    // The two groups next to the boundary, nearest photos first.
    expect(check).toHaveBeenCalledWith(ids(95, 99), ids(100, 107));
    expect(names(r)).toEqual([
      ["red-shorts", 95],
      ["blue-tee", 13],
      ["gray-pants", 22],
    ]);
    expect(r.groups[1].photoIds).toEqual(ids(95, 107));
    expect(r).toMatchObject({ seamsChecked: 1, seamsMerged: 1, warnings: [] });
    expectAllAccounted(r, 130);
  });

  it("different items on either side of the boundary stay separate", async () => {
    const r = await reconcileSeams(
      [
        chunk(0, 99, [
          ["red-shorts", 0, 94],
          ["blue-tee", 95, 99],
        ]),
        chunk(100, 129, [
          ["black-jeans", 100, 107],
          ["gray-pants", 108, 129],
        ]),
      ],
      async () => false,
    );
    expect(names(r)).toEqual([
      ["red-shorts", 95],
      ["blue-tee", 5],
      ["black-jeans", 8],
      ["gray-pants", 22],
    ]);
    expect(r).toMatchObject({ seamsChecked: 1, seamsMerged: 0, warnings: [] });
    expectAllAccounted(r, 130);
  });

  it.each([
    ["could not be completed", async () => null],
    [
      "failed",
      async () => {
        throw new Error("503");
      },
    ],
  ] as [string, SeamCheck][])(
    "a check that %s keeps the groups separate and warns",
    async (_, check) => {
      const r = await reconcileSeams(
        [
          chunk(0, 99, [["blue-tee", 0, 99]]),
          chunk(100, 102, [["blue-shirt", 100, 102]]),
        ],
        check,
      );
      expect(names(r)).toEqual([
        ["blue-tee", 100],
        ["blue-shirt", 3],
      ]);
      expect(r.warnings).toEqual([
        'Photos 100 and 101: the check whether "blue-tee" and "blue-shirt" are the same item could not be completed, so they were kept separate. If they are one item, move the photos together.',
      ]);
      expect(r.seamsMerged).toBe(0);
      expectAllAccounted(r, 103);
    },
  );

  it("a check that times out counts as failed: separate, with a warning", async () => {
    vi.useFakeTimers();
    const hung: SeamCheck = () =>
      withTimeout(new Promise<boolean>(() => {}), 90_000);
    const pending = reconcileSeams(
      [
        chunk(0, 99, [["blue-tee", 0, 99]]),
        chunk(100, 105, [["blue-shirt", 100, 105]]),
      ],
      hung,
    );
    await vi.advanceTimersByTimeAsync(90_000);
    const r = await pending;
    vi.useRealTimers();
    expect(r.groups).toHaveLength(2);
    expect(r.warnings[0]).toMatch(/^Photos 100 and 101: .* kept separate/);
  });

  it("checks every boundary (100 and 200) and chains an item across both", async () => {
    // A 110-photo item spans photo 95 to photo 204.
    const seen: [string[], string[]][] = [];
    const r = await reconcileSeams(
      [
        chunk(0, 99, [
          ["red-shorts", 0, 94],
          ["jacket", 95, 99],
        ]),
        chunk(100, 199, [["jacket", 100, 199]]),
        chunk(200, 249, [
          ["jacket", 200, 204],
          ["hat", 205, 249],
        ]),
      ],
      async (left, right) => {
        seen.push([left, right]);
        return true;
      },
    );
    expect(seen).toHaveLength(2);
    // Boundary 200: the already-merged group sends its photos nearest photo
    // 200 (19, as the other side has only 5); 24 in total.
    expect(seen[1][0]).toEqual(ids(181, 199));
    expect(seen[1][1]).toEqual(ids(200, 204));
    expect(names(r)).toEqual([
      ["red-shorts", 95],
      ["jacket", 110],
      ["hat", 45],
    ]);
    expect(r.seamsMerged).toBe(2);
    expectAllAccounted(r, 250);
  });

  it("each boundary is decided on its own: one merges, the next does not", async () => {
    const r = await reconcileSeams(
      [
        chunk(0, 99, [["a", 0, 99]]),
        chunk(100, 199, [
          ["a-rest", 100, 105],
          ["b", 106, 199],
        ]),
        chunk(200, 210, [["c", 200, 210]]),
      ],
      async (left) => left.includes("p99"),
    );
    expect(names(r)).toEqual([
      ["a", 106],
      ["b", 94],
      ["c", 11],
    ]);
    expectAllAccounted(r, 211);
  });

  it("photos left for review at the boundary stay for review and are skipped over", async () => {
    const check = vi.fn<SeamCheck>(async () => true);
    const r = await reconcileSeams(
      [
        chunk(0, 99, [["tee", 0, 97]], [98, 99]),
        chunk(100, 119, [["tee", 101, 119]], [100]),
      ],
      check,
    );
    expect(check).toHaveBeenCalledWith(ids(86, 97), ids(101, 112));
    expect(names(r)).toEqual([["tee", 117]]);
    expect(r.orphanIds).toEqual(["p98", "p99", "p100"]);
    expectAllAccounted(r, 120);
  });

  it("a chunk with no groups at all is not checked", async () => {
    const check = vi.fn<SeamCheck>(async () => true);
    const r = await reconcileSeams(
      [chunk(0, 99, [["tee", 0, 99]]), chunk(100, 101, [], [100, 101])],
      check,
    );
    expect(check).not.toHaveBeenCalled();
    expect(r.orphanIds).toEqual(["p100", "p101"]);
    expectAllAccounted(r, 102);
  });

  it("a single chunk makes no checks and changes nothing", async () => {
    const check = vi.fn<SeamCheck>(async () => true);
    const r = await reconcileSeams(
      [
        chunk(
          0,
          39,
          [
            ["a", 0, 19],
            ["b", 20, 37],
          ],
          [38, 39],
        ),
      ],
      check,
    );
    expect(check).not.toHaveBeenCalled();
    expect(names(r)).toEqual([
      ["a", 20],
      ["b", 18],
    ]);
    expect(r.orphanIds).toEqual(["p38", "p39"]);
  });

  it("regression: the 103-photo duplicate-jacket batch becomes one item", async () => {
    const check = vi.fn<SeamCheck>(async () => true);
    const r = await reconcileSeams(
      [
        chunk(0, 99, [["r-plus-red-track-jacket", 0, 99]]),
        chunk(100, 102, [["red-track-jacket", 100, 102]]),
      ],
      check,
    );
    // The 21 photos nearest the boundary + the 3 on the other side (24 in
    // total), never all 103.
    expect(check).toHaveBeenCalledWith(ids(79, 99), ids(100, 102));
    expect(names(r)).toEqual([["r-plus-red-track-jacket", 103]]);
    expect(r.orphanIds).toEqual([]);
    expectAllAccounted(r, 103);
  });

  it("every photo is accounted for exactly once across many boundaries", async () => {
    // 5 chunks of 100 with items of 7–19 photos crossing boundaries, a few
    // photos for review, and alternating same/different answers.
    let start = 0;
    const items: [string, number, number][] = [];
    for (let n = 0; start < 500; n++) {
      const len = 7 + ((n * 5) % 13);
      items.push([`item-${n}`, start, Math.min(499, start + len - 1)]);
      start += len;
    }
    const chunks: SortedChunk[] = [];
    for (let c = 0; c < 5; c++) {
      const from = c * 100;
      const to = from + 99;
      const orphans = [from + 50];
      const groups = items
        .map(
          ([name, a, b]) =>
            [name, Math.max(a, from), Math.min(b, to)] as [
              string,
              number,
              number,
            ],
        )
        .filter(([, a, b]) => a <= b)
        .flatMap(([name, a, b]) =>
          // Split around the photo left for review.
          a <= from + 50 && from + 50 <= b
            ? ([
                [name, a, from + 49],
                [`${name}-b`, from + 51, b],
              ].filter(([, x, y]) => (x as number) <= (y as number)) as [
                string,
                number,
                number,
              ][])
            : [[name, a, b] as [string, number, number]],
        );
      chunks.push(chunk(from, to, groups, orphans));
    }
    let k = 0;
    const r = await reconcileSeams(chunks, async () => k++ % 2 === 0);
    expect(r.seamsChecked).toBe(4);
    expectAllAccounted(r, 500);
  });
});

describe("boundary representatives", () => {
  it("sends at most 24 photos: those nearest the boundary on each side", () => {
    const left = ids(0, 39);
    const right = ids(40, 69);
    const reps = seamRepresentatives(left, right);
    expect(MAX_SEAM_PHOTOS).toBe(24);
    expect(reps.left).toEqual(ids(28, 39));
    expect(reps.right).toEqual(ids(40, 51));
  });

  it("gives a short side's unused share to the other side", () => {
    expect(seamRepresentatives(ids(0, 2), ids(3, 60))).toEqual({
      left: ids(0, 2),
      right: ids(3, 23),
    });
    expect(seamRepresentatives(ids(0, 60), ids(61, 64))).toEqual({
      left: ids(41, 60),
      right: ids(61, 64),
    });
    // Small groups are sent whole.
    expect(seamRepresentatives(ids(0, 4), ids(5, 12))).toEqual({
      left: ids(0, 4),
      right: ids(5, 12),
    });
  });
});
