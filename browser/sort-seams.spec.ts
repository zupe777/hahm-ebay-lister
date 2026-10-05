import { test, expect, type Page } from "@playwright/test";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=",
  "base64",
);
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

// Sort requests are answered by chunk size: `chunks[n]` is the reply for a
// request of n photos. Boundary checks answer `merge` (or fail with 503).
async function setup(
  page: Page,
  chunks: Record<number, { name: string; photoIndices: number[] }[]>,
  merge: boolean | "fail",
) {
  const checks: { a: number; b: number }[] = [];
  await page.route("**/api/ebay/status", (r) =>
    r.fulfill({ json: { connected: true } }),
  );
  await page.route("**/api/models", (r) =>
    r.fulfill({ json: { sortModels: [], analysisModels: [] } }),
  );
  await page.route("**/api/sort", (r) => {
    const n = r.request().postDataJSON().images.length;
    return r.fulfill({
      json: { ok: true, groups: chunks[n], orphanIndices: [] },
    });
  });
  await page.route("**/api/merge-check", (r) => {
    const body = r.request().postDataJSON();
    checks.push({ a: body.a.length, b: body.b.length });
    return merge === "fail"
      ? r.fulfill({
          status: 503,
          json: {
            ok: false,
            error: "The boundary check could not be completed.",
          },
        })
      : r.fulfill({ json: { ok: true, merge } });
  });
  return checks;
}

async function sortPhotos(page: Page, count: number) {
  await page.goto("/");
  await page.locator("input[type=file]").setInputFiles(
    range(1, count).map((n) => ({
      name: `${String(n).padStart(3, "0")}.png`,
      mimeType: "image/png",
      buffer: png,
    })),
  );
  await expect(page.locator(".thumb")).toHaveCount(count, { timeout: 60_000 });
  await page
    .getByRole("button", {
      name: new RegExp(`Sort ${count} photos into items`),
    })
    .click();
}

const names = (page: Page) => page.getByLabel("Item name", { exact: true });
const items = (page: Page) => page.locator(".board-item:not(.needs-review)");
const warnings = (page: Page) =>
  page.getByRole("region", { name: "Sorting warnings" }).getByRole("alert");

// 130 photos: red shorts 1–95, a blue tee 96–108 crossing the 100/101
// boundary, gray pants 109–130.
const crossing130 = {
  100: [
    { name: "red-shorts", photoIndices: range(0, 94) },
    { name: "blue-tee", photoIndices: range(95, 99) },
  ],
  30: [
    { name: "blue-tee-back", photoIndices: range(0, 7) },
    { name: "gray-pants", photoIndices: range(8, 29) },
  ],
};

test.describe("chunk-boundary reconciliation", () => {
  test.setTimeout(120_000);

  test("130 photos: an item crossing photo 100/101 becomes one item", async ({
    page,
  }) => {
    const checks = await setup(page, crossing130, true);
    await sortPhotos(page, 130);
    await expect(items(page)).toHaveCount(3);
    await expect(names(page).nth(0)).toHaveValue("red-shorts");
    await expect(names(page).nth(1)).toHaveValue("blue-tee");
    await expect(names(page).nth(2)).toHaveValue("gray-pants");
    await expect(items(page).nth(1).locator(".board-thumb")).toHaveCount(13);
    await expect(page.locator(".needs-review")).toHaveCount(0);
    await expect(warnings(page)).toHaveCount(0);
    // One check, with several photos from each side.
    expect(checks).toEqual([{ a: 5, b: 8 }]);
  });

  test("130 photos: different items at the boundary stay separate", async ({
    page,
  }) => {
    await setup(page, crossing130, false);
    await sortPhotos(page, 130);
    await expect(items(page)).toHaveCount(4);
    await expect(names(page).nth(2)).toHaveValue("blue-tee-back");
    await expect(warnings(page)).toHaveCount(0);
  });

  test("a failed boundary check keeps the items separate and says so", async ({
    page,
  }) => {
    await setup(page, crossing130, "fail");
    await sortPhotos(page, 130);
    await expect(items(page)).toHaveCount(4);
    await expect(warnings(page)).toHaveText(
      'Photos 100 and 101: the check whether "blue-tee" and "blue-tee-back" are the same item could not be completed, so they were kept separate. If they are one item, move the photos together.',
    );
  });

  test("regression: the 103-photo duplicate-jacket batch is one item", async ({
    page,
  }) => {
    const checks = await setup(
      page,
      {
        100: [{ name: "r-plus-red-track-jacket", photoIndices: range(0, 99) }],
        3: [{ name: "red-track-jacket", photoIndices: range(0, 2) }],
      },
      true,
    );
    await sortPhotos(page, 103);
    await expect(items(page)).toHaveCount(1);
    await expect(names(page).nth(0)).toHaveValue("r-plus-red-track-jacket");
    await expect(items(page).nth(0).locator(".board-thumb")).toHaveCount(103);
    await expect(page.locator(".needs-review")).toHaveCount(0);
    // Only the 24 photos nearest the boundary are sent, never all 103.
    expect(checks).toEqual([{ a: 21, b: 3 }]);
  });
});
