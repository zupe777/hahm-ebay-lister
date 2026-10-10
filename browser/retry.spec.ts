import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=",
  "base64",
);

async function base(page: Page) {
  await page.addInitScript(() =>
    localStorage.setItem(
      "listing-writer:access-code",
      "browser-test-access-code",
    ),
  );
  await page.route("**/api/ebay/status", (r) =>
    r.fulfill({ json: { connected: true } }),
  );
  await page.route("**/api/models", (r) =>
    r.fulfill({ json: { sortModels: [], analysisModels: [] } }),
  );
}

// Phone-like 4032 × 3024 JPEGs with fine fabric-like texture, all distinct:
// at 1024 px each is about 245 KB of base64, like a detailed clothing photo.
async function realisticPhotos(page: Page, n: number, dir: string) {
  const data: string[] = await page.evaluate(async (n) => {
    const out: string[] = [];
    for (let k = 0; k < n; k++) {
      const c = document.createElement("canvas");
      c.width = 4032;
      c.height = 3024;
      const ctx = c.getContext("2d")!;
      const g = ctx.createLinearGradient(0, 0, 4032, 3024);
      g.addColorStop(0, `hsl(${(k * 53) % 360} 55% 55%)`);
      g.addColorStop(1, `hsl(${(k * 53 + 160) % 360} 45% 40%)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 4032, 3024);
      for (let i = 0; i < 300; i++) {
        ctx.fillStyle = `hsla(${(i * 47 + k * 11) % 360} 60% ${30 + (i % 40)}% / 0.5)`;
        ctx.fillRect(
          (i * 131 + k * 17) % 4032,
          (i * 197 + k * 29) % 3024,
          40 + ((i * 13) % 400),
          30 + ((i * 29) % 300),
        );
      }
      const img = ctx.getImageData(0, 0, 4032, 3024);
      const d = img.data;
      let s = 12345 + k;
      for (let i = 0; i < d.length; i += 4) {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        const v = ((s >> 16) % 140) - 70;
        d[i] += v;
        d[i + 1] += v;
        d[i + 2] += v;
      }
      ctx.putImageData(img, 0, 0);
      out.push(c.toDataURL("image/jpeg", 0.92).split(",")[1]);
    }
    return out;
  }, n);
  fs.mkdirSync(dir, { recursive: true });
  return data.map((b, i) => {
    const f = path.join(dir, `IMG_${String(i + 1).padStart(4, "0")}.jpg`);
    fs.writeFileSync(f, Buffer.from(b, "base64"));
    return f;
  });
}

test("an 18-photo clothing item now fits one analysis request with all 18 photos", async ({
  page,
}) => {
  test.setTimeout(600_000);
  await base(page);
  // /api/analyze is NOT mocked: the real server checks the request.
  const sent: { count: number; base64: number }[] = [];
  const answers: { status: number; error: string }[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/api/analyze")) {
      const images: { data: string }[] = r.postDataJSON().images;
      sent.push({
        count: images.length,
        base64: images.reduce((n, i) => n + i.data.length, 0),
      });
    }
  });
  page.on("response", async (r) => {
    if (r.url().endsWith("/api/analyze"))
      answers.push({ status: r.status(), error: (await r.json()).error });
  });
  await page.goto("/");
  await expect(page.getByText("Restoring saved work…")).toBeHidden();
  const files = await realisticPhotos(
    page,
    18,
    test.info().outputPath("photos"),
  );
  await page.locator("input[type=file]").setInputFiles(files);
  await expect(page.locator(".thumb")).toHaveCount(18, { timeout: 300_000 });
  await page.getByRole("button", { name: "These photos are one item" }).click();
  await page.getByRole("button", { name: /Write.*listing/i }).click();
  await expect.poll(() => answers.length, { timeout: 120_000 }).toBe(1);
  // All 18 photos were sent, inside the safe budget (3.0 M base64
  // characters), well under the server's 3.8 M limit.
  expect(sent[0].count).toBe(18);
  expect(sent[0].base64).toBeLessThanOrEqual(3_000_000);
  // The server accepted the photo set and went on to the AI (which this
  // test environment cannot reach: no real API key) — not the size refusal.
  expect(answers[0].status).not.toBe(400);
  expect(answers[0].error).toMatch(/API key/);
  console.log(
    `[measure] 18-photo item: ${sent[0].count} photos, ${(sent[0].base64 / 1e6).toFixed(2)} MB base64 (${Math.round(sent[0].base64 / sent[0].count / 1e3)} KB each); budget 3.00 MB, server limit 3.80 MB`,
  );
});

test("Retry selected listings writes only the chosen failed items, never touches written ones, never posts", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await base(page);
  // 7 items with 1–7 photos; items of 3, 5 and 7 photos fail at first.
  const sizes = [1, 2, 3, 4, 5, 6, 7];
  let start = 0;
  const groups = sizes.map((n, k) => {
    const g = {
      name: `item-${k + 1}`,
      photoIndices: Array.from({ length: n }, (_, i) => start + i),
    };
    start += n;
    return g;
  });
  await page.route("**/api/sort", (r) =>
    r.fulfill({ json: { ok: true, groups, orphanIndices: [] } }),
  );
  const analyzed: number[] = [];
  let failing = new Map<number, string>([
    [
      3,
      "These photos are too much data for one AI request. Deselect some photos for AI analysis, then retry.",
    ],
    [
      5,
      "These photos are too much data for one AI request. Deselect some photos for AI analysis, then retry.",
    ],
    [
      7,
      "These photos are too much data for one AI request. Deselect some photos for AI analysis, then retry.",
    ],
  ]);
  await page.route("**/api/analyze", (r) => {
    const n = r.request().postDataJSON().images.length;
    analyzed.push(n);
    const error = failing.get(n);
    if (error) return r.fulfill({ status: 400, json: { ok: false, error } });
    return r.fulfill({
      json: {
        ok: true,
        listing: {
          title: `Listing with ${n} photos`,
          description: "Shorts.",
          brand: "Nike",
          item_type: "Shorts",
          condition: "GOOD",
          suggested_price: 20 + n,
          item_specifics: { Brand: "Nike", Size: "L" },
        },
        usage: [],
      },
    });
  });
  await page.route("**/api/ebay/prepare", (r) => {
    const l = r.request().postDataJSON().listing;
    return r.fulfill({
      json: {
        ok: true,
        listing: { ...l, category_id: "15690", ebay_condition: "" },
        preparation: {
          categoryId: "15690",
          categoryName: "Shorts",
          aspects: [],
          conditions: [{ value: "USED_EXCELLENT", label: "Used" }],
          expiresAt: Date.now() + 3600000,
          signature: "test",
          issues: [],
        },
      },
    });
  });
  await page.route("**/api/ebay/comps", (r) =>
    r.fulfill({ json: { ok: false, error: "Research unavailable" } }),
  );
  await page.route("**/api/ebay/options", (r) =>
    r.fulfill({
      json: {
        ok: true,
        options: {
          fulfillment: [{ id: "ship", name: "My shipping" }],
          payment: [{ id: "pay", name: "My payment" }],
          returns: [{ id: "ret", name: "My returns" }],
          locations: [{ id: "home", name: "My origin" }],
        },
      },
    }),
  );
  const posted: string[] = [];
  for (const route of ["**/api/ebay/upload-photos", "**/api/ebay/publish"])
    await page.route(route, (r) => {
      posted.push(r.request().url());
      return r.fulfill({ status: 500, json: { ok: false } });
    });

  await page.goto("/");
  await expect(page.getByText("Restoring saved work…")).toBeHidden();
  await page.locator("input[type=file]").setInputFiles(
    Array.from({ length: start }, (_, i) => ({
      name: `IMG_${i}.png`,
      mimeType: "image/png",
      buffer: png,
    })),
  );
  await expect(page.locator(".thumb")).toHaveCount(start);
  await page.getByRole("button", { name: /Sort 28 photos into items/ }).click();
  await page.getByRole("button", { name: "Write 7 listings" }).click();
  await expect(page.getByText("Writing failed", { exact: true })).toHaveCount(
    3,
    { timeout: 60_000 },
  );
  await expect(page.getByText(/^Written · /)).toHaveCount(4);
  // The failure reason is shown on each failed item.
  await expect(
    page.getByText(
      "These photos are too much data for one AI request. Deselect some photos for AI analysis, then retry.",
    ),
  ).toHaveCount(3);
  // The failed ones are listed together.
  await page.getByLabel("Show").selectOption("unwritten");
  await expect(page.getByText("Writing failed", { exact: true })).toHaveCount(
    3,
  );
  await page.getByLabel("Show").selectOption("all");

  // A seller edit on a written listing, then a snapshot of every written row.
  // Rows are in batch order: written items 1, 2, 4 and 6 have title boxes.
  const titleBoxes = page.locator("textarea[aria-label^='Title ']");
  await titleBoxes.nth(1).fill("My own title");
  const titles = async () =>
    page
      .locator("textarea[aria-label^='Title ']")
      .evaluateAll((els) =>
        els.map((e) => [
          e.getAttribute("aria-label"),
          (e as HTMLTextAreaElement).value,
        ]),
      );
  const before = await titles();
  expect(before).toHaveLength(4);
  expect(before[1][1]).toBe("My own title");

  // Retry two of the three failed items; one fails again.
  analyzed.length = 0;
  failing = new Map([
    [5, "The AI service is busy right now. Try again shortly."],
  ]);
  await expect(
    page.getByRole("button", { name: /Retry selected listings/ }),
  ).toHaveCount(0);
  // The failed items (3, 5 and 7, in order) have "write again" boxes.
  const writeAgain = page.getByLabel(/ to write again$/);
  await expect(writeAgain).toHaveCount(3);
  await writeAgain.nth(0).check();
  await writeAgain.nth(1).check();
  await page
    .getByRole("button", { name: "Retry selected listings (2)" })
    .click();
  // Both retries finish: one written, one failed again.
  await expect(page.getByText(/^Written · /)).toHaveCount(5, {
    timeout: 60_000,
  });
  await expect(
    page.getByText("The AI service is busy right now. Try again shortly."),
  ).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Writing…")).toHaveCount(0);
  // Only the two chosen items were sent to the AI.
  expect(analyzed.sort()).toEqual([3, 5]);
  // item-3 is written; item-5 failed again with the new reason, keeping its
  // name; item-7 was not selected and is unchanged.
  await expect(titleBoxes).toHaveCount(5);
  await expect(titleBoxes.nth(2)).toHaveValue("Listing with 3 photos");
  await expect(
    page.getByText("The AI service is busy right now. Try again shortly."),
  ).toBeVisible();
  await expect(page.getByText("Writing failed", { exact: true })).toHaveCount(
    2,
  );
  const row = (name: string) =>
    page.getByRole("row").filter({ has: page.getByRole("img", { name }) });
  await expect(row("item-5")).toContainText("Writing failed");
  await expect(row("item-5")).toContainText(
    "The AI service is busy right now. Try again shortly.",
  );
  await expect(row("item-7")).toContainText("Writing failed");
  await expect(row("item-7")).toContainText(
    "These photos are too much data for one AI request.",
  );
  // Every previously written listing is exactly as it was, edit included.
  const after = await titles();
  for (const row of before) expect(after).toContainEqual(row);
  // Nothing was posted or uploaded to eBay.
  expect(posted).toEqual([]);
});

test("an item with more than 24 photos is stopped with a clear reason; unticking one lets it write", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await base(page);
  await page.route("**/api/sort", (r) =>
    r.fulfill({
      json: {
        ok: true,
        groups: [
          {
            name: "big-coat",
            photoIndices: Array.from({ length: 25 }, (_, i) => i),
          },
          { name: "small-tee", photoIndices: [25] },
        ],
        orphanIndices: [],
      },
    }),
  );
  const analyzed: number[] = [];
  await page.route("**/api/analyze", (r) => {
    const n = r.request().postDataJSON().images.length;
    analyzed.push(n);
    return r.fulfill({
      json: {
        ok: true,
        listing: {
          title: `Listing with ${n} photos`,
          description: "Coat.",
          condition: "GOOD",
          suggested_price: 40,
          item_specifics: {},
        },
        usage: [],
      },
    });
  });
  await page.route("**/api/ebay/prepare", (r) =>
    r.fulfill({ json: { ok: false, error: "Not needed here" } }),
  );
  await page.route("**/api/ebay/comps", (r) =>
    r.fulfill({ json: { ok: false, error: "Research unavailable" } }),
  );
  await page.goto("/");
  await expect(page.getByText("Restoring saved work…")).toBeHidden();
  await page.locator("input[type=file]").setInputFiles(
    Array.from({ length: 26 }, (_, i) => ({
      name: `IMG_${i}.png`,
      mimeType: "image/png",
      buffer: png,
    })),
  );
  await expect(page.locator(".thumb")).toHaveCount(26);
  await page.getByRole("button", { name: /Sort 26 photos into items/ }).click();
  await page.getByRole("button", { name: "Write 2 listings" }).click();
  const reason =
    "This item has 25 photos selected for AI analysis; the AI can analyze at most 24 per item. Untick 1 or more of this item's photos for AI analysis (keep labels, tags and flaws), then retry.";
  await expect(page.getByText(reason)).toBeVisible({ timeout: 60_000 });
  // The small item was written; the big one was never sent.
  await expect.poll(() => analyzed).toEqual([1]);
  // Untick one photo in the big item's picker, then retry it alone.
  await page.getByRole("button", { name: "Review details" }).first().click();
  const picker = page.getByRole("group", { name: /Photos for AI analysis/ });
  await expect(picker).toContainText("25 of 25 selected");
  await picker.getByRole("checkbox").last().uncheck();
  await expect(picker).toContainText("Ready: 24 photos will be analyzed.");
  // The row and its open card share one "write again" choice.
  const choice = page.getByLabel(/ to write again$/);
  await expect(choice).toHaveCount(2);
  await choice.first().check();
  await expect(choice.last()).toBeChecked();
  await page
    .getByRole("button", { name: "Retry selected listings (1)" })
    .click();
  await expect.poll(() => analyzed).toEqual([1, 24]);
  await expect(page.getByText("Writing failed", { exact: true })).toHaveCount(
    0,
  );
});
