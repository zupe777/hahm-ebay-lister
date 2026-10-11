import { test, expect, type Page } from "@playwright/test";
import { descriptionHtml } from "../lib/description";

// Descriptions: structure, buyer preview and "Improve description". Every AI
// and eBay request is mocked.
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=",
  "base64",
);
const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
const written = `Vineyard Vines Slim Fit Tucker shirt in blue and pink plaid.

Product Details:
- Brand: Vineyard Vines
- Tagged size: M

Condition:
Pre-owned with a small light mark on the left cuff.`;
const proposed = `Vineyard Vines Slim Fit Tucker shirt in a blue and pink plaid, a classic button-down (button-up) shirt.

Product Details:
- Brand: Vineyard Vines
- Tagged size: M
- Fit: Slim
- Pattern: Plaid
- Fabric: 100% cotton <per tag> & soft

Condition:
Pre-owned with a small light mark on the left cuff.`;

async function setup(page: Page) {
  const calls = { analyze: 0, describe: 0, publish: 0 };
  const bodies: { describe: any[]; publish: any[] } = {
    describe: [],
    publish: [],
  };
  await page.route("**/api/ebay/status", (r) =>
    r.fulfill({ json: { connected: true } }),
  );
  await page.route("**/api/models", (r) =>
    r.fulfill({ json: { sortModels: [], analysisModels: [] } }),
  );
  await page.route("**/api/analyze", (r) => {
    calls.analyze++;
    return r.fulfill({
      json: {
        ok: true,
        listing: {
          title: "Vineyard Vines Tucker Shirt",
          description: written,
          brand: "Vineyard Vines",
          condition: "EXCELLENT",
          suggested_price: 22,
          item_specifics: { Brand: "Vineyard Vines" },
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
          conditions: [
            { value: "USED_EXCELLENT", label: "Pre-owned Excellent" },
          ],
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
  await page.route("**/api/describe", (r) => {
    calls.describe++;
    bodies.describe.push(r.request().postDataJSON());
    return r.fulfill({ json: { ok: true, description: proposed, usage: [] } });
  });
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
    calls.publish++;
    bodies.publish.push(r.request().postDataJSON());
    return r.fulfill({ json: { success: true, listingId: "406000000002" } });
  });
  await page.goto("/");
  await expect(page.getByText("Restoring saved work…")).toBeHidden();
  return { calls, bodies };
}

async function write(page: Page) {
  await page.locator("input[type=file]").setInputFiles([
    { name: "front.png", mimeType: "image/png", buffer: png },
    { name: "tag.png", mimeType: "image/png", buffer: png },
  ]);
  await expect(page.locator(".thumb")).toHaveCount(2);
  await page.getByRole("button", { name: "These photos are one item" }).click();
  await page.getByRole("button", { name: /Write.*listing/i }).click();
  await expect(
    page.getByText("Casual Button-Down Shirts", { exact: true }),
  ).toBeVisible();
}

async function readyToPost(page: Page) {
  await page.getByLabel("SKU", { exact: true }).fill("5547");
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

const description = (page: Page) =>
  page.getByLabel("Description", { exact: true });

// The saved item as stored in the browser.
async function savedGroup(page: Page) {
  return page.evaluate(
    () =>
      new Promise<any>((resolve, reject) => {
        const req = indexedDB.open("listing-writer-drafts");
        req.onsuccess = () => {
          const get = req.result
            .transaction("workspace")
            .objectStore("workspace")
            .get("current");
          get.onsuccess = () => {
            req.result.close();
            resolve(get.result.groups[0]);
          };
          get.onerror = () => reject(get.error);
        };
      }),
  );
}
// Everything except the description fields.
const withoutDescription = (g: any) => {
  const { descriptionSource: _s, listing, ...rest } = g;
  const { description: _d, ...facts } = listing;
  return { ...rest, listing: facts };
};
// Browsers serialize HTML in their own way: compare as the browser parses it.
async function sameHtml(page: Page, actual: string, expected: string) {
  const [a, b] = await page.evaluate(
    ([x, y]) =>
      [x, y].map((h) => {
        const d = document.createElement("div");
        d.innerHTML = h;
        return d.innerHTML;
      }),
    [actual, expected],
  );
  expect(a).toBe(b);
}

test("a written description keeps its sections and the buyer preview is exactly the published HTML", async ({
  page,
}) => {
  const { bodies } = await setup(page);
  await write(page);
  await expect(description(page)).toHaveValue(written);
  await page.getByRole("button", { name: "👁 Buyer preview" }).click();
  const preview = page.getByRole("region", { name: "Buyer preview" });
  await expect(preview.locator("h3")).toHaveText([
    "Product Details",
    "Condition",
  ]);
  await expect(preview.locator("li")).toHaveText([
    "Brand: Vineyard Vines",
    "Tagged size: M",
  ]);
  await sameHtml(page, await preview.innerHTML(), descriptionHtml(written));
  // Special characters are shown as text, never as markup.
  await description(page).fill(
    "Tee <b>bold</b> & more\n\n- <script>x</script>",
  );
  await expect(preview.locator("b, script")).toHaveCount(0);
  await expect(preview).toContainText("Tee <b>bold</b> & more");
  await sameHtml(
    page,
    await preview.innerHTML(),
    descriptionHtml("Tee <b>bold</b> & more\n\n- <script>x</script>"),
  );
  // Publishing sends the same text the preview was made from.
  await readyToPost(page);
  await page.getByRole("button", { name: "Post this to eBay" }).click();
  await expect(page.getByText("Posted to eBay").first()).toBeVisible();
  expect(bodies.publish[0].listing.description).toBe(
    "Tee <b>bold</b> & more\n\n- <script>x</script>",
  );
});

test("Improve description: compare, Cancel changes nothing, Use changes only the description", async ({
  page,
}) => {
  const { calls, bodies } = await setup(page);
  await write(page);
  await readyToPost(page);
  // The seller's own edits before improving.
  await page
    .locator(".title-input")
    .fill("Vineyard Vines Tucker Shirt Plaid M");
  await page.getByLabel("Price", { exact: true }).fill("24");
  await description(page).fill(`${written}\nSeller note: one spare button.`);
  await expect(page.getByRole("status")).toContainText("Saved on this device");
  await expect
    .poll(async () => (await savedGroup(page)).listing.description)
    .toContain("Seller note");
  const before = await savedGroup(page);

  await page.getByRole("button", { name: "✨ Improve description" }).click();
  const compare = page.getByRole("group", { name: "Proposed description" });
  await expect(compare).toBeVisible();
  await expect(compare.getByLabel("Current description")).toHaveText(
    `${written}\nSeller note: one spare button.`,
  );
  await expect(compare.getByLabel("Proposed description text")).toHaveText(
    proposed,
  );
  await expect(
    compare.getByText(
      "You edited this description. Using the proposal replaces your edits; Cancel keeps them.",
    ),
  ).toBeVisible();
  // The request used the latest draft facts and the item's photos.
  expect(bodies.describe[0]).toMatchObject({
    listing: {
      title: "Vineyard Vines Tucker Shirt Plaid M",
      suggested_price: 24,
      description: `${written}\nSeller note: one spare button.`,
      ebay_condition: "USED_EXCELLENT",
    },
    condition: "Pre-owned Excellent",
    category: "Casual Button-Down Shirts",
  });
  expect(bodies.describe[0].images).toHaveLength(2);
  // Proposed buyer preview escapes the special characters.
  await expect(
    compare.getByRole("region", {
      name: "Buyer preview of the proposed description",
    }),
  ).toContainText("Fabric: 100% cotton <per tag> & soft");

  // Cancel: nothing changes.
  await compare.getByRole("button", { name: "Cancel" }).click();
  await expect(compare).toBeHidden();
  await expect(description(page)).toHaveValue(
    `${written}\nSeller note: one spare button.`,
  );
  expect(await savedGroup(page)).toEqual(before);

  // Use This Description: only the description changes.
  await page.getByRole("button", { name: "✨ Improve description" }).click();
  await compare.getByRole("button", { name: "Use This Description" }).click();
  await expect(compare).toBeHidden();
  await expect(description(page)).toHaveValue(proposed);
  await expect
    .poll(async () => (await savedGroup(page)).listing.description)
    .toBe(proposed);
  const after = await savedGroup(page);
  expect(after.descriptionSource).toBe("improved");
  expect(withoutDescription(after)).toEqual(withoutDescription(before));
  expect(calls).toMatchObject({ analyze: 1, describe: 2, publish: 0 });

  // It survives a refresh, and publishing uses it.
  await page.reload();
  await expect(description(page)).toHaveValue(proposed);
  await expect(page.locator(".title-input")).toHaveValue(
    "Vineyard Vines Tucker Shirt Plaid M",
  );
  await expect(page.getByLabel("SKU", { exact: true })).toHaveValue("5547");
  await page.getByRole("button", { name: "Post this to eBay" }).click();
  await expect(page.getByText("Posted to eBay").first()).toBeVisible();
  expect(bodies.publish[0]).toMatchObject({
    sku: "5547",
    skuConfirmed: true,
    listing: { description: proposed, suggested_price: 24 },
    shipping: {
      fulfillmentPolicyId: "ship",
      paymentPolicyId: "pay",
      returnPolicyId: "ret",
      locationKey: "home",
    },
  });
  // Published: no more improvement, and the description cannot change.
  await expect(
    page.getByRole("button", { name: "✨ Improve description" }),
  ).toHaveCount(0);
  await expect(description(page)).toBeDisabled();
});

test("saved descriptions are never regenerated; published listings stay untouched", async ({
  page,
}) => {
  const { calls } = await setup(page);
  await expect(page.getByRole("status")).toContainText("Saved on this device");
  const old =
    "Blue shirt. Small mark on the cuff. See photos for measurements.";
  await page.evaluate(
    async ({ photo, old }) => {
      const base = (i: number) => ({
        photoIds: [`p${i}`],
        status: "done",
        sku: `555${i}`,
        skuSource: "seller",
        skuConfirmed: true,
        name: `Item ${i}`,
        listing: {
          title: `Shirt ${i}`,
          description: old,
          category_id: "123",
          suggested_price: 22,
          item_specifics: {},
        },
      });
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.open("listing-writer-drafts");
        req.onsuccess = () => {
          const tx = req.result.transaction("workspace", "readwrite");
          tx.objectStore("workspace").put(
            {
              version: 1,
              photos: [0, 1].map((i) => ({
                id: `p${i}`,
                mediaType: "image/png",
                previewUrl: photo,
                data: photo.split(",")[1],
              })),
              groups: [
                { id: "draft", ...base(0) },
                {
                  id: "live",
                  ...base(1),
                  postStatus: "posted",
                  listingId: "406000000000",
                  publicationAttemptSku: "5551",
                },
              ],
              orphanIds: [],
              binPrefix: "",
              skuStart: 0,
              step: "listings",
              updatedAt: Date.now(),
            },
            "current",
          );
          tx.oncomplete = () => {
            req.result.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      });
    },
    { photo: dataUrl, old },
  );
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Your listings" }),
  ).toBeVisible();
  const rows = page.locator(".batch-table tbody > tr");
  await rows.nth(0).getByRole("button", { name: "Review details" }).click();
  await expect(description(page)).toHaveValue(old);
  await expect(
    page.getByRole("button", { name: "✨ Improve description" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close details" }).click();
  await page
    .locator(".batch-table tbody > tr")
    .filter({ hasText: "Shirt 1" })
    .getByRole("button", { name: "Review details" })
    .click();
  await expect(description(page)).toHaveValue(old);
  await expect(description(page)).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "✨ Improve description" }),
  ).toHaveCount(0);
  expect(calls).toMatchObject({ analyze: 0, describe: 0, publish: 0 });
});
