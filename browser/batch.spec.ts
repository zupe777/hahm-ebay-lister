import { test, expect, type Page } from "@playwright/test";
const photo =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=";
async function seed(
  page: Page,
  count: number,
  unfinished = false,
  comps: Record<number, unknown> = {},
  skus?: string[],
) {
  let optionsCalls = 0;
  await page.route("**/api/ebay/status", (r) =>
    r.fulfill({ json: { connected: true } }),
  );
  await page.route("**/api/models", (r) =>
    r.fulfill({ json: { sortModels: [], analysisModels: [] } }),
  );
  await page.route("**/api/ebay/options", (r) => {
    optionsCalls++;
    return r.fulfill({
      json: {
        ok: true,
        options: {
          fulfillment: [
            { id: "usual", name: "Light Apparel Shipping" },
            { id: "heavy", name: "Heavy Apparel Shipping" },
          ],
          payment: [{ id: "pay", name: "Payments Policy" }],
          returns: [{ id: "ret", name: "30 Day Returns" }],
          locations: [{ id: "home", name: "Home Closet · 10001 · US" }],
          defaults: {
            fulfillment: "Light Apparel Shipping",
            payment: "Payments Policy",
            returns: "30 Day Returns",
            locations: "Home Closet",
          },
        },
      },
    });
  });
  await page.goto("/");
  await expect(page.getByText("Restoring saved work…")).toBeHidden();
  await expect(page.getByRole("status")).toContainText("Saved on this device");
  await page.evaluate(
    async ({ count, photo, unfinished, comps, skus }) => {
      const photos = Array.from({ length: count * 5 }, (_, i) => ({
        id: `p${i}`,
        mediaType: "image/png",
        previewUrl: photo,
        data: photo.split(",")[1],
        uploadData: photo.split(",")[1],
      }));
      const groups = Array.from({ length: count }, (_, i) => ({
        id: `g${i}`,
        sku: skus ? skus[i] : `BATCH-${i}`,
        name: `Item ${i}`,
        photoIds: photos.slice(i * 5, i * 5 + 5).map((p) => p.id),
        status: unfinished ? "idle" : "done",
        comps: comps[i],
        listing: {
          title: `Item ${i}`,
          description: "Seller description",
          size: "M",
          category_id: "123",
          ebay_condition: "PRE_OWNED_EXCELLENT",
          suggested_price: 30,
          item_specifics: { "Size Type": "Regular" },
        },
        preparation: {
          categoryId: "123",
          categoryName: "Shirts",
          aspects: [],
          conditions: [
            { value: "PRE_OWNED_EXCELLENT", label: "Pre-owned Excellent" },
          ],
          expiresAt: Date.now() + 3600000,
          signature: "test",
          issues: [],
        },
      }));
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.open("listing-writer-drafts");
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction("workspace", "readwrite");
          tx.objectStore("workspace").put(
            {
              version: 1,
              photos,
              groups,
              orphanIds: [],
              binPrefix: "BATCH",
              skuStart: 0,
              step: "listings",
              updatedAt: Date.now(),
            },
            "current",
          );
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      });
    },
    { count, photo, unfinished, comps, skus },
  );
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Your listings" }),
  ).toBeVisible();
  return () => optionsCalls;
}
for (const count of [10, 25, 100])
  test(`${count} items: one policy load, edits persist, bounded publication with no duplicates`, async ({
    page,
  }, testInfo) => {
    const started = Date.now();
    const optionsCalls = await seed(page, count);
    await expect(
      page.getByRole("button", {
        name: `🚀 Post all ${count} to eBay`,
        exact: true,
      }),
    ).toBeEnabled();
    expect(optionsCalls()).toBe(1);
    await expect(page.locator(".batch-table tbody > tr")).toHaveCount(
      Math.min(count, 25),
    );
    await page
      .getByLabel("Title BATCH-0", { exact: true })
      .fill("Reviewed first item");
    await page.getByLabel("Select BATCH-0", { exact: true }).check();
    await page
      .getByLabel("Shipping for selected", { exact: true })
      .selectOption("heavy");
    await page
      .getByRole("button", { name: "Apply shipping", exact: true })
      .click();
    await expect(
      page.getByLabel("Shipping BATCH-0", { exact: true }),
    ).toHaveValue("heavy");
    await expect(page.getByRole("status")).toContainText(
      "Saved on this device",
    );
    await page.reload();
    await expect(page.getByLabel("Title BATCH-0", { exact: true })).toHaveValue(
      "Reviewed first item",
    );
    await expect(
      page.getByLabel("Shipping BATCH-0", { exact: true }),
    ).toHaveValue("heavy");
    const skus: string[] = [];
    let active = 0,
      maximum = 0;
    await page.route("**/api/ebay/upload-photos", async (r) => {
      const { images } = r.request().postDataJSON();
      return r.fulfill({
        json: {
          ok: true,
          urls: images.map(
            (_: unknown, i: number) => `https://i.ebayimg.com/${i}.jpg`,
          ),
        },
      });
    });
    await page.route("**/api/ebay/publish", async (r) => {
      const body = r.request().postDataJSON();
      active++;
      maximum = Math.max(maximum, active);
      skus.push(body.sku);
      if (body.sku === "BATCH-0") {
        expect(body.listing.title).toBe("Reviewed first item");
        expect(body.shipping.fulfillmentPolicyId).toBe("heavy");
      }
      expect(body.expectedPhotoCount).toBe(5);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active--;
      return r.fulfill({
        json: { success: true, listingId: `listing-${body.sku}` },
      });
    });
    await page
      .getByRole("button", {
        name: `🚀 Post all ${count} to eBay`,
        exact: true,
      })
      .click();
    await expect(page.locator(".result-head .badge")).toContainText(
      `${count} posted`,
      { timeout: 30000 },
    );
    expect(skus).toHaveLength(count);
    expect(new Set(skus).size).toBe(count);
    expect(maximum).toBe(2);
    await testInfo.attach("simulated-batch-metrics", {
      body: JSON.stringify({
        items: count,
        photos: count * 5,
        policyRequestsPerLoad: optionsCalls() / 2,
        maxConcurrentPublish: maximum,
        published: skus.length,
        totalTestMs: Date.now() - started,
        externalAPIs: "mocked; not real AI/eBay throughput",
      }),
      contentType: "application/json",
    });
  });
test("paused publication resumes only the selected items", async ({ page }) => {
  await seed(page, 10);
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  const skus: string[] = [];
  await page.route("**/api/ebay/upload-photos", async (r) => {
    await hold;
    return r.fulfill({
      json: {
        ok: true,
        urls: Array.from(
          { length: r.request().postDataJSON().images.length },
          (_, i) => `https://i.ebayimg.com/${i}.jpg`,
        ),
      },
    });
  });
  await page.route("**/api/ebay/publish", (r) => {
    const sku = r.request().postDataJSON().sku;
    skus.push(sku);
    return r.fulfill({ json: { success: true, listingId: sku } });
  });
  for (const i of [0, 1, 2])
    await page.getByLabel(`Select BATCH-${i}`, { exact: true }).check();
  await page
    .getByRole("button", { name: "Post selected ready (3)", exact: true })
    .click();
  await page.getByRole("button", { name: "Pause batch", exact: true }).click();
  release();
  await expect(
    page.getByRole("button", { name: "Resume batch", exact: true }),
  ).toBeVisible();
  expect(skus).toHaveLength(2);
  await page.getByRole("button", { name: "Resume batch", exact: true }).click();
  await expect(page.locator(".result-head .badge")).toContainText("3 posted");
  expect(skus.sort()).toEqual(["BATCH-0", "BATCH-1", "BATCH-2"]);
});
test("batch table fits a phone and exposes missing fields through attention filter", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seed(page, 100);
  await page.getByLabel("Price BATCH-0", { exact: true }).fill("");
  await page.getByLabel("Show", { exact: true }).selectOption("attention");
  await expect(page.locator(".batch-table tbody > tr")).toHaveCount(1);
  await expect(
    page.getByText("Enter a positive price.", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: "test-results/batch-phone.png",
    fullPage: true,
  });
});

test("batch table offers market prices behind a button and flags floor prices for attention", async ({
  page,
}) => {
  const comps = (itemPrice: number, belowFloor: boolean, median: number) => ({
    ok: true,
    query: "q",
    count: 4,
    median,
    low: median - 2,
    high: median + 2,
    confidence: 0.3,
    basis: "active asking prices, not sold",
    shippingCharge: 7.99,
    minComps: 3,
    itemPrice,
    rawItemPrice: median - 7.99,
    belowFloor,
  });
  await seed(page, 3, false, {
    0: comps(19.99, false, 27.99),
    1: comps(5, true, 9.5),
  });
  const price = page.getByLabel("Price BATCH-0", { exact: true });
  const before = await price.inputValue();
  await expect(page.getByRole("button", { name: "Use $19.99" })).toBeVisible();
  expect(await price.inputValue()).toBe(before);
  await expect(
    page.getByText(/4 asking-price matches \(not sold\)/).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Use $19.99" }).click();
  await expect(price).toHaveValue("19.99");
  await page.getByLabel("Show", { exact: true }).selectOption("attention");
  await expect(page.locator(".batch-table tbody > tr")).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Use $5.00 ⚠️" }),
  ).toBeVisible();
});

test("100 draft writes use three workers; failed items retry without rewriting successes", async ({
  page,
}) => {
  await seed(page, 100, true);
  let analyzeCalls = 0,
    active = 0,
    maximum = 0,
    failOnce = true;
  await page.route("**/api/analyze", async (r) => {
    analyzeCalls++;
    active++;
    maximum = Math.max(maximum, active);
    const fail = analyzeCalls === 7 && failOnce;
    await new Promise((resolve) => setTimeout(resolve, 15));
    active--;
    if (fail) {
      failOnce = false;
      return r.fulfill({
        status: 422,
        json: { ok: false, error: "Simulated analysis failure" },
      });
    }
    return r.fulfill({
      json: {
        ok: true,
        listing: {
          title: "Generated shirt",
          description: "Reviewed description",
          suggested_price: 30,
          size: "M",
          item_specifics: {},
        },
      },
    });
  });
  await page.route("**/api/ebay/prepare", (r) =>
    r.fulfill({
      json: {
        ok: true,
        listing: {
          ...r.request().postDataJSON().listing,
          category_id: "123",
          ebay_condition: "PRE_OWNED_EXCELLENT",
        },
        preparation: {
          categoryId: "123",
          categoryName: "Shirts",
          aspects: [],
          conditions: [
            { value: "PRE_OWNED_EXCELLENT", label: "Pre-owned Excellent" },
          ],
          signature: "test",
          expiresAt: Date.now() + 3600000,
          issues: [],
        },
      },
    }),
  );
  await page.route("**/api/ebay/comps", (r) =>
    r.fulfill({ json: { ok: false } }),
  );
  await page
    .getByRole("button", { name: "Write / retry 100 remaining", exact: true })
    .click();
  await expect(page.locator(".result-head .badge")).toContainText(
    "99/100 drafts written",
    { timeout: 30000 },
  );
  await expect(
    page.getByRole("button", {
      name: "Write / retry 1 remaining",
      exact: true,
    }),
  ).toBeEnabled();
  expect(analyzeCalls).toBe(100);
  expect(maximum).toBe(3);
  await page
    .getByRole("button", { name: "Write / retry 1 remaining", exact: true })
    .click();
  await expect(page.locator(".result-head .badge")).toContainText(
    "100/100 drafts written",
  );
  expect(analyzeCalls).toBe(101);
});

test("blank and duplicate seller SKUs need attention and are never posted", async ({
  page,
}) => {
  await seed(page, 3, false, {}, ["", "1001", "1001"]);
  const rows = page.locator(".batch-table tbody > tr");
  await expect(rows).toHaveCount(3);
  // Items stay identified by their internal ids: each row keeps its own item.
  await expect(rows.nth(0)).toContainText("No Custom Label");
  await expect(rows.nth(0)).toContainText(
    "Custom Label (SKU) is missing. Enter your inventory number before publishing.",
  );
  await expect(rows.nth(1)).toContainText("Another item has this SKU.");
  await expect(rows.nth(2)).toContainText("Another item has this SKU.");
  await expect(page.getByLabel("Title Item 0", { exact: true })).toHaveValue(
    "Item 0",
  );
  await expect(
    page.getByRole("button", { name: /Post all .* to eBay/ }),
  ).toHaveCount(0);
});
