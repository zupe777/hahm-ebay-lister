import { test, expect, type Page } from "@playwright/test";

// Inventory-sticker SKUs. Every AI and eBay request is mocked.
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=",
  "base64",
);
const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
type Sticker = Record<string, unknown> | undefined;

async function setup(page: Page, sticker: Sticker) {
  const counts = { analyze: 0, prepare: 0, sticker: 0, publish: 0 };
  const published: Record<string, unknown>[] = [];
  await page.route("**/api/ebay/status", (r) =>
    r.fulfill({ json: { connected: true } }),
  );
  await page.route("**/api/models", (r) =>
    r.fulfill({ json: { sortModels: [], analysisModels: [] } }),
  );
  await page.route("**/api/analyze", (r) => {
    counts.analyze++;
    return r.fulfill({
      json: {
        ok: true,
        listing: {
          title: "Vineyard Vines Tucker Shirt",
          description: "Blue and pink plaid.",
          brand: "Vineyard Vines",
          condition: "EXCELLENT",
          suggested_price: 22,
          item_specifics: { Brand: "Vineyard Vines" },
          ...(sticker ? { inventory_sticker: sticker } : {}),
        },
        usage: [],
      },
    });
  });
  await page.route("**/api/ebay/prepare", (r) => {
    counts.prepare++;
    const l = r.request().postDataJSON().listing;
    return r.fulfill({
      json: {
        ok: true,
        listing: { ...l, category_id: "57991", ebay_condition: "" },
        preparation: {
          categoryId: "57991",
          categoryName: "Casual Button-Down Shirts",
          aspects: [
            {
              name: "Brand",
              required: true,
              usage: "REQUIRED",
              mode: "FREE_TEXT",
              cardinality: "SINGLE",
              values: [],
            },
          ],
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
  await page.route("**/api/ebay/upload-photos", (r) =>
    r.fulfill({
      json: {
        ok: true,
        urls: r
          .request()
          .postDataJSON()
          .images.map(
            (_: unknown, i: number) => `https://i.ebayimg.com/${i}.jpg`,
          ),
      },
    }),
  );
  await page.route("**/api/ebay/publish", (r) => {
    counts.publish++;
    published.push(r.request().postDataJSON());
    return r.fulfill({ json: { success: true, listingId: "406000000001" } });
  });
  await page.goto("/");
  await expect(page.getByText("Restoring saved work…")).toBeHidden();
  return { counts, published };
}

async function write(page: Page, photos = 3) {
  await page.locator("input[type=file]").setInputFiles(
    Array.from({ length: photos }, (_, i) => ({
      name: `photo-${i + 1}.png`,
      mimeType: "image/png",
      buffer: png,
    })),
  );
  await expect(page.locator(".thumb")).toHaveCount(photos);
  await page.getByRole("button", { name: "These photos are one item" }).click();
  await page.getByRole("button", { name: /Write.*listing/i }).click();
  await expect(
    page.getByText("Casual Button-Down Shirts", { exact: true }),
  ).toBeVisible();
}

async function readyToPost(page: Page) {
  await page
    .getByLabel("eBay condition", { exact: true })
    .selectOption("USED_EXCELLENT");
  await page
    .getByRole("button", { name: "Load my eBay policies and locations" })
    .click();
  await page
    .getByLabel("Shipping policy", { exact: true })
    .selectOption("ship");
  await page.getByLabel("Payment policy", { exact: true }).selectOption("pay");
  await page.getByLabel("Return policy", { exact: true }).selectOption("ret");
  await page
    .getByLabel("Shipping origin", { exact: true })
    .selectOption("home");
}

const sku = (page: Page) => page.getByLabel("SKU", { exact: true });
const post = (page: Page) =>
  page.getByRole("button", { name: "Post this to eBay" });

test("no SKU is generated: new items start blank and the bin-code generator is gone", async ({
  page,
}) => {
  await setup(page, undefined);
  await expect(page.locator("#bin")).toHaveCount(0);
  await page
    .locator("input[type=file]")
    .setInputFiles([{ name: "a.png", mimeType: "image/png", buffer: png }]);
  await page.getByRole("button", { name: "These photos are one item" }).click();
  await expect(
    page.getByLabel("Item SKU / bin code", { exact: true }),
  ).toHaveValue("");
  await page.getByRole("button", { name: /Write.*listing/i }).click();
  await expect(sku(page)).toHaveValue("");
  await readyToPost(page);
  await expect(post(page)).toBeDisabled();
  await expect(
    page.getByText(
      "Enter the SKU (Custom Label) from your inventory sticker before publishing.",
    ),
  ).toBeVisible();
});

test("a reading at 85–94 confidence is suggested with its photo; publishing waits for Confirm SKU; it persists", async ({
  page,
}) => {
  const { counts, published } = await setup(page, {
    status: "read",
    value: "A-5547",
    photoIndices: [2],
    confidence: 90,
  });
  await write(page);
  await expect(sku(page)).toHaveValue("A-5547");
  await expect(
    page.getByText(/Suggested from the inventory sticker \(photo 2\)/),
  ).toBeVisible();
  await readyToPost(page);
  await expect(post(page)).toBeDisabled();
  await expect(
    page.getByText("Confirm the SKU before publishing.").first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Confirm SKU" }).click();
  await expect(
    page.getByText("✓ SKU confirmed · from sticker, photo 2"),
  ).toBeVisible();
  // Confirmation and the SKU survive a refresh.
  await expect(page.getByRole("status")).toContainText("Saved on this device");
  await page.reload();
  await expect(sku(page)).toHaveValue("A-5547");
  await expect(
    page.getByText("✓ SKU confirmed · from sticker, photo 2"),
  ).toBeVisible();
  await expect(post(page)).toBeEnabled();
  await post(page).click();
  await expect(page.getByText("Posted to eBay").first()).toBeVisible();
  expect(counts.publish).toBe(1);
  // The exact confirmed SKU is the eBay Custom Label: prefix kept.
  expect(published[0]).toMatchObject({ sku: "A-5547", skuConfirmed: true });
  // A published item's SKU can no longer change.
  await expect(sku(page)).toBeDisabled();
});

test("a numbers-only sticker stays numbers only", async ({ page }) => {
  const { published } = await setup(page, {
    status: "read",
    value: "5547",
    photoIndices: [1],
  });
  await write(page);
  await expect(sku(page)).toHaveValue("5547");
  await page.getByRole("button", { name: "Confirm SKU" }).click();
  await readyToPost(page);
  await post(page).click();
  await expect(page.getByText("Posted to eBay").first()).toBeVisible();
  expect(published[0]).toMatchObject({ sku: "5547" });
});

test("several stickers or an unclear prefix leave the SKU blank until the seller chooses", async ({
  page,
}) => {
  await setup(page, {
    status: "ambiguous",
    candidates: ["5547", "5548"],
    reason:
      "More than one inventory sticker was found. Choose the correct one.",
    photoIndices: [1, 3],
  });
  await write(page);
  await expect(sku(page)).toHaveValue("");
  await expect(
    page.getByText(
      /More than one inventory sticker was found\. Choose the correct one\. \(photo 1, 3\)/,
    ),
  ).toBeVisible();
  await readyToPost(page);
  await expect(post(page)).toBeDisabled();
  await page.getByRole("button", { name: "Use 5548" }).click();
  await expect(sku(page)).toHaveValue("5548");
  // Choosing is the seller's decision, so it counts as confirmed.
  await expect(page.getByText("✓ SKU confirmed")).toBeVisible();
  await expect(post(page)).toBeEnabled();
});

test("Read sticker fills only the SKU suggestion; the listing and seller edits stay", async ({
  page,
}) => {
  const { counts } = await setup(page, { status: "none", photoIndices: [] });
  const stickerBodies: { images: unknown[] }[] = [];
  await page.route("**/api/sticker", (r) => {
    counts.sticker++;
    stickerBodies.push(r.request().postDataJSON());
    return r.fulfill({
      json: {
        ok: true,
        sticker: { status: "read", value: "12345", photoIndices: [3] },
      },
    });
  });
  await write(page);
  await expect(sku(page)).toHaveValue("");
  await page.locator(".title-input").fill("Seller edited title");
  await page.getByLabel("Price", { exact: true }).fill("27");
  await readyToPost(page);
  await page.getByRole("button", { name: "🔎 Read sticker" }).click();
  await expect(sku(page)).toHaveValue("12345");
  await expect(
    page.getByText(/Suggested from the inventory sticker \(photo 3\)/),
  ).toBeVisible();
  // All of the item's photos were inspected; nothing was rewritten.
  expect(stickerBodies[0].images).toHaveLength(3);
  expect(counts).toMatchObject({ analyze: 1, prepare: 1, sticker: 1 });
  await expect(page.locator(".title-input")).toHaveValue("Seller edited title");
  await expect(page.getByLabel("Price", { exact: true })).toHaveValue("27");
  await expect(page.getByLabel("Shipping policy", { exact: true })).toHaveValue(
    "ship",
  );
  await expect(
    page.getByText("Casual Button-Down Shirts", { exact: true }),
  ).toBeVisible();
});

test("a typed SKU is confirmed and never overwritten by a later reading", async ({
  page,
}) => {
  await setup(page, { status: "unreadable", photoIndices: [2] });
  await page.route("**/api/sticker", (r) =>
    r.fulfill({
      json: {
        ok: true,
        sticker: { status: "read", value: "A-9999", photoIndices: [1] },
      },
    }),
  );
  await write(page);
  await expect(sku(page)).toHaveValue("");
  await expect(
    page.getByText(/could not be read confidently/).first(),
  ).toBeVisible();
  await sku(page).fill("A-5547");
  await expect(page.getByText("✓ SKU confirmed")).toBeVisible();
  await page.getByRole("button", { name: "🔎 Read sticker" }).click();
  await expect(
    page.getByRole("button", { name: "🔎 Read sticker" }),
  ).toBeEnabled();
  await expect(sku(page)).toHaveValue("A-5547");
  await expect(page.getByText("✓ SKU confirmed")).toBeVisible();
});

// Saved batches written by earlier versions, and duplicate SKUs.
async function seedSaved(page: Page, groups: Record<string, unknown>[]) {
  await setup(page, undefined);
  await expect(page.getByRole("status")).toContainText("Saved on this device");
  await page.evaluate(
    async ({ groups, photo }) => {
      const photos = groups.map((_, i) => ({
        id: `p${i}`,
        mediaType: "image/png",
        previewUrl: photo,
        data: photo.split(",")[1],
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
              groups: groups.map((g, i) => ({
                name: `Item ${i}`,
                photoIds: [`p${i}`],
                status: "done",
                listing: {
                  title: `Shirt ${i}`,
                  description: "Seller description",
                  size: "M",
                  category_id: "123",
                  ebay_condition: "PRE_OWNED_EXCELLENT",
                  suggested_price: 22,
                  item_specifics: {},
                },
                preparation: {
                  categoryId: "123",
                  categoryName: "Shirts",
                  aspects: [],
                  conditions: [
                    {
                      value: "PRE_OWNED_EXCELLENT",
                      label: "Pre-owned Excellent",
                    },
                  ],
                  expiresAt: Date.now() + 3600000,
                  signature: "test",
                  issues: [],
                },
                shipping: {
                  fulfillmentPolicyId: "ship",
                  paymentPolicyId: "pay",
                  returnPolicyId: "ret",
                  locationKey: "home",
                },
                ...g,
              })),
              orphanIds: [],
              binPrefix: "",
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
    { groups, photo: dataUrl },
  );
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Your listings" }),
  ).toBeVisible();
}

test("old generated SKUs become blank on unpublished items; published SKUs are kept", async ({
  page,
}) => {
  await seedSaved(page, [
    { id: "draft", sku: "C-0123456789ab" },
    {
      id: "live",
      sku: "B-3bac4b907da3",
      postStatus: "posted",
      listingId: "406000000000",
      publicationAttemptSku: "B-3bac4b907da3",
    },
    { id: "typed", sku: "5549" },
  ]);
  const rows = page.locator(".batch-table tbody > tr");
  await expect(rows.nth(0)).toContainText("No SKU yet");
  await expect(rows.nth(0)).toContainText("Shirt 0");
  await expect(rows.nth(1)).toContainText("B-3bac4b907da3");
  await expect(rows.nth(1)).not.toContainText("not confirmed");
  await expect(rows.nth(2)).toContainText("5549 (not confirmed)");
  await rows.nth(0).getByRole("button", { name: "Review details" }).click();
  await expect(
    page.getByText(
      "The SKU C-0123456789ab was generated automatically by an earlier version and has been removed. Enter your inventory number.",
    ),
  ).toBeVisible();
  // Every other field is intact.
  await expect(page.locator(".title-input")).toHaveValue("Shirt 0");
  await expect(page.getByLabel("Price", { exact: true })).toHaveValue("22");
});

test("duplicate SKUs are blocked, ignoring letter case", async ({ page }) => {
  await seedSaved(page, [
    { id: "a", sku: "A-5547", skuSource: "seller", skuConfirmed: true },
    { id: "b", sku: "a-5547", skuSource: "seller", skuConfirmed: true },
    { id: "c", sku: "5548", skuSource: "seller", skuConfirmed: true },
  ]);
  const rows = page.locator(".batch-table tbody > tr");
  await expect(rows.nth(0)).toContainText(
    "Another item in this batch has the same SKU (letter case ignored).",
  );
  await expect(rows.nth(1)).toContainText(
    "Another item in this batch has the same SKU",
  );
  await expect(rows.nth(2)).toContainText("Written · Ready");
  await expect(page.locator(".result-head .badge")).toContainText("1 ready");
});

test("a SKU locked by an interrupted publishing attempt can be confirmed but not changed", async ({
  page,
}) => {
  await seedSaved(page, [
    {
      id: "retry",
      sku: "B-3bac4b907da3",
      postStatus: "error",
      postError:
        "Publication was interrupted. Retry to check eBay before posting again.",
      publicationAttemptSku: "B-3bac4b907da3",
    },
  ]);
  // One item: shown as its listing card. The attempted SKU is never
  // blanked by the earlier-version migration.
  await expect(sku(page)).toBeDisabled();
  await expect(sku(page)).toHaveValue("B-3bac4b907da3");
  await expect(
    page.getByText(/already used in a publishing attempt, so it cannot change/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Confirm SKU" }).click();
  await expect(page.getByText("✓ SKU confirmed")).toBeVisible();
  await expect(sku(page)).toHaveValue("B-3bac4b907da3");
});

test("a confident reading (95+) is auto-confirmed with its photo, persists, publishes exactly and stays editable", async ({
  page,
}) => {
  const { published } = await setup(page, {
    status: "read",
    value: "A-5544",
    photoIndices: [2],
    confidence: 96,
  });
  await write(page);
  await expect(sku(page)).toHaveValue("A-5544");
  await expect(
    page.getByText("✓ SKU auto-confirmed · from sticker, photo 2"),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm SKU" })).toHaveCount(
    0,
  );
  await readyToPost(page);
  await expect(post(page)).toBeEnabled();
  await expect(page.getByRole("status")).toContainText("Saved on this device");
  await page.reload();
  await expect(sku(page)).toHaveValue("A-5544");
  await expect(
    page.getByText("✓ SKU auto-confirmed · from sticker, photo 2"),
  ).toBeVisible();
  // Still editable: typing makes it the seller's own SKU.
  await sku(page).fill("A-5545");
  await expect(
    page.getByText("✓ SKU confirmed", { exact: true }),
  ).toBeVisible();
  await sku(page).fill("A-5544");
  await post(page).click();
  await expect(page.getByText("Posted to eBay").first()).toBeVisible();
  expect(published[0]).toMatchObject({ sku: "A-5544", skuConfirmed: true });
});

test("a confident reading that duplicates another item's SKU is only suggested", async ({
  page,
}) => {
  await seedSaved(page, [
    { id: "first", sku: "A-5544", skuSource: "seller", skuConfirmed: true },
    { id: "second", sku: "" },
  ]);
  await page.route("**/api/sticker", (r) =>
    r.fulfill({
      json: {
        ok: true,
        sticker: {
          status: "read",
          value: "a-5544",
          photoIndices: [1],
          confidence: 99,
        },
      },
    }),
  );
  const row = page.locator(".batch-table tbody > tr").nth(1);
  await row.getByRole("button", { name: "Review details" }).click();
  await page.getByRole("button", { name: "🔎 Read sticker" }).click();
  await expect(sku(page)).toHaveValue("a-5544");
  await expect(page.getByRole("button", { name: "Confirm SKU" })).toBeVisible();
  await expect(
    page.getByText("Another item in this batch has this SKU."),
  ).toBeVisible();
  await expect(page.getByText(/SKU auto-confirmed/)).toHaveCount(0);
});
