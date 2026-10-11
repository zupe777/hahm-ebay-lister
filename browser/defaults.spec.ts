import { test, expect, type Page } from "@playwright/test";

// Default listing settings. Every eBay and AI request is mocked.
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=",
  "base64",
);
const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
const KEY = "zupe:listing-defaults:v1";
type Options = Record<string, { id: string; name: string }[]>;
const account: Options = {
  fulfillment: [
    { id: "ship-795", name: "Zippadoo Clothing Shipping $7.95" },
    { id: "heavy", name: "Zippadoo Heavy Shipping" },
  ],
  payment: [{ id: "pay-1", name: "Zippadoo Payment Policy" }],
  returns: [{ id: "ret-1", name: "Zippadoo Refund Policy" }],
  locations: [
    { id: "zupe-hq", name: "Zupe HQ · 84095 · US" },
    { id: "garage", name: "Garage · 84095 · US" },
  ],
};
const savedDefaults = {
  fulfillmentPolicyId: {
    id: "ship-795",
    name: "Zippadoo Clothing Shipping $7.95",
  },
  paymentPolicyId: { id: "pay-1", name: "Zippadoo Payment Policy" },
  returnPolicyId: { id: "ret-1", name: "Zippadoo Refund Policy" },
  locationKey: { id: "zupe-hq", name: "Zupe HQ · 84095 · US" },
};

async function setup(page: Page, options: Options = account) {
  const published: any[] = [];
  await page.route("**/api/ebay/status", (r) =>
    r.fulfill({ json: { connected: true } }),
  );
  await page.route("**/api/models", (r) =>
    r.fulfill({ json: { sortModels: [], analysisModels: [] } }),
  );
  await page.route("**/api/analyze", (r) =>
    r.fulfill({
      json: {
        ok: true,
        listing: {
          title: "Vineyard Vines Tucker Shirt",
          description: "Plaid shirt.",
          brand: "Vineyard Vines",
          condition: "EXCELLENT",
          suggested_price: 22,
          item_specifics: { Brand: "Vineyard Vines" },
        },
        usage: [],
      },
    }),
  );
  await page.route("**/api/ebay/prepare", (r) => {
    const l = r.request().postDataJSON().listing;
    return r.fulfill({
      json: {
        ok: true,
        listing: {
          ...l,
          category_id: "57991",
          ebay_condition: "USED_EXCELLENT",
        },
        preparation: {
          categoryId: "57991",
          categoryName: "Casual Button-Down Shirts",
          aspects: [],
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
    r.fulfill({ json: { ok: true, options } }),
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
    published.push(r.request().postDataJSON());
    return r.fulfill({ json: { success: true, listingId: "406000000003" } });
  });
  await page.goto("/");
  await expect(page.getByText("Restoring saved work…")).toBeHidden();
  return { published };
}

async function write(page: Page) {
  await page
    .locator("input[type=file]")
    .setInputFiles([{ name: "front.png", mimeType: "image/png", buffer: png }]);
  await expect(page.locator(".thumb")).toHaveCount(1);
  await page.getByRole("button", { name: "These photos are one item" }).click();
  await page.getByRole("button", { name: /Write.*listing/i }).click();
  await expect(
    page.getByText("Casual Button-Down Shirts", { exact: true }),
  ).toBeVisible();
}

const field = (page: Page, label: string) =>
  page.getByLabel(label, { exact: true });
async function expectFields(page: Page, values: string[]) {
  for (const [label, v] of [
    ["Shipping policy", values[0]],
    ["Payment policy", values[1]],
    ["Return policy", values[2]],
    ["Shipping origin", values[3]],
  ])
    await expect(field(page, label)).toHaveValue(v);
}
async function openDefaults(page: Page) {
  const panel = page.locator(".default-settings details");
  if (!(await panel.evaluate((d) => (d as HTMLDetailsElement).open)))
    await panel.locator("summary").click();
}
async function saveDefaults(page: Page, ids: string[]) {
  await openDefaults(page);
  for (const [label, id] of [
    ["Default shipping policy", ids[0]],
    ["Default payment policy", ids[1]],
    ["Default return policy", ids[2]],
    ["Default shipping origin", ids[3]],
  ])
    await field(page, label).selectOption(id);
  await page.getByRole("button", { name: "Save defaults" }).click();
}
const seedDefaults = (page: Page, value: unknown) =>
  page.addInitScript(
    ([k, v]) => {
      if (!sessionStorage.getItem("seeded")) {
        localStorage.setItem(k as string, v as string);
        sessionStorage.setItem("seeded", "1");
      }
    },
    [KEY, JSON.stringify(value)],
  );

test("save the four defaults once: new listings, reloads and new batches get them; eBay receives the exact IDs", async ({
  page,
}) => {
  const { published } = await setup(page);
  await write(page);
  // Two locations and no defaults yet: nothing is chosen for the seller.
  await expectFields(page, ["", "", "", ""]);
  await saveDefaults(page, ["ship-795", "pay-1", "ret-1", "zupe-hq"]);
  await expect(
    page.getByText(/^Defaults saved\. 1 listing with blank fields/),
  ).toBeVisible();
  await expectFields(page, ["ship-795", "pay-1", "ret-1", "zupe-hq"]);
  expect(
    JSON.parse((await page.evaluate((k) => localStorage.getItem(k), KEY))!),
  ).toEqual(savedDefaults);

  // Survives a refresh, in the panel and the listing (once autosaved).
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          new Promise<unknown>((resolve) => {
            const req = indexedDB.open("listing-writer-drafts");
            req.onsuccess = () => {
              const get = req.result
                .transaction("workspace")
                .objectStore("workspace")
                .get("current");
              get.onsuccess = () => {
                req.result.close();
                resolve(get.result?.groups?.[0]?.shipping);
              };
            };
          }),
      ),
    )
    .toEqual({
      fulfillmentPolicyId: "ship-795",
      paymentPolicyId: "pay-1",
      returnPolicyId: "ret-1",
      locationKey: "zupe-hq",
    });
  await page.reload();
  await expectFields(page, ["ship-795", "pay-1", "ret-1", "zupe-hq"]);
  await openDefaults(page);
  await expect(field(page, "Default shipping origin")).toHaveValue("zupe-hq");

  // A new batch: the next listing is filled automatically.
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "Start new batch" }).click();
  await expect(page.locator(".title-input")).toHaveCount(0);
  await write(page);
  await expectFields(page, ["ship-795", "pay-1", "ret-1", "zupe-hq"]);

  // The chosen IDs reach eBay unchanged.
  await field(page, "SKU").fill("5547");
  await page.getByRole("button", { name: "Post this to eBay" }).click();
  await expect(page.getByText("Posted to eBay").first()).toBeVisible();
  expect(published[0].shipping).toEqual({
    fulfillmentPolicyId: "ship-795",
    paymentPolicyId: "pay-1",
    returnPolicyId: "ret-1",
    locationKey: "zupe-hq",
  });
});

test("per-listing overrides and intentional blanks are kept when defaults change", async ({
  page,
}) => {
  await seedDefaults(page, savedDefaults);
  await setup(page);
  await write(page);
  await expectFields(page, ["ship-795", "pay-1", "ret-1", "zupe-hq"]);
  await field(page, "Shipping policy").selectOption("heavy");
  await field(page, "Return policy").selectOption("");
  await field(page, "Shipping origin").selectOption("garage");
  // Change the defaults, reload policies and the page: the listing keeps the
  // seller's choices, including the deliberate blank.
  await saveDefaults(page, ["ship-795", "pay-1", "ret-1", "zupe-hq"]);
  await page
    .getByRole("button", { name: "Load my eBay policies and locations" })
    .click();
  await expectFields(page, ["heavy", "pay-1", "", "garage"]);
  await expect(page.getByRole("status")).toContainText("Saved on this device");
  await page.reload();
  await expectFields(page, ["heavy", "pay-1", "", "garage"]);
  await expect(
    page.getByRole("button", { name: "Post this to eBay" }),
  ).toBeDisabled();
});

test("renamed and deleted policies: renamed still used by ID, deleted never replaced", async ({
  page,
}) => {
  await seedDefaults(page, savedDefaults);
  await setup(page, {
    ...account,
    payment: [{ id: "pay-1", name: "Zippadoo Payments 2026" }],
    // Same name, different ID: a different policy, never substituted.
    returns: [{ id: "ret-NEW", name: "Zippadoo Refund Policy" }],
  });
  await write(page);
  await expectFields(page, ["ship-795", "pay-1", "", "zupe-hq"]);
  await expect(
    page.getByText(
      "Payment policy: renamed on eBay to “Zippadoo Payments 2026” (saved as “Zippadoo Payment Policy”). It is still used.",
    ),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Return policy: saved default “Zippadoo Refund Policy” no longer exists on this eBay account and is not used. Choose a replacement.",
    ),
  ).toBeVisible();
  await expect(field(page, "Default return policy")).toHaveValue("");
});

test("defaults from another eBay account are never applied", async ({
  page,
}) => {
  await seedDefaults(page, savedDefaults);
  await setup(page, {
    fulfillment: [{ id: "th-ship", name: "Thrift and Honey Shipping" }],
    payment: [{ id: "th-pay", name: "Thrift and Honey Payment" }],
    returns: [{ id: "th-ret", name: "Thrift and Honey Returns" }],
    locations: [
      { id: "th-home", name: "Honey House" },
      { id: "th-2", name: "Second" },
    ],
  });
  await write(page);
  await expect(
    page.getByText(
      /None of your saved defaults exist on the connected eBay account/,
    ),
  ).toBeVisible();
  await expectFields(page, ["", "", "", ""]);
});

test("published listings and chosen fields stay unchanged; only blank drafts are filled", async ({
  page,
}) => {
  await seedDefaults(page, savedDefaults);
  await setup(page);
  await expect(page.getByRole("status")).toContainText("Saved on this device");
  await page.evaluate(
    async ({ photo }) => {
      const listing = (i: number) => ({
        title: `Shirt ${i}`,
        description: "Shirt",
        category_id: "123",
        ebay_condition: "PRE_OWNED_EXCELLENT",
        suggested_price: 22,
        item_specifics: {},
      });
      const groups = [
        {
          id: "live",
          sku: "5551",
          postStatus: "posted",
          listingId: "406000000000",
          publicationAttemptSku: "5551",
        },
        {
          id: "chosen",
          sku: "5552",
          shipping: {
            fulfillmentPolicyId: "heavy",
            paymentPolicyId: "pay-1",
            returnPolicyId: "ret-1",
            locationKey: "garage",
          },
        },
        { id: "blank", sku: "5553" },
      ].map((g, i) => ({
        photoIds: [`p${i}`],
        status: "done",
        skuSource: "seller",
        skuConfirmed: true,
        name: `Item ${i}`,
        listing: listing(i),
        ...g,
      }));
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.open("listing-writer-drafts");
        req.onsuccess = () => {
          const tx = req.result.transaction("workspace", "readwrite");
          tx.objectStore("workspace").put(
            {
              version: 1,
              photos: groups.map((_, i) => ({
                id: `p${i}`,
                mediaType: "image/png",
                previewUrl: photo,
                data: photo.split(",")[1],
              })),
              groups,
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
    { photo: dataUrl },
  );
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Your listings" }),
  ).toBeVisible();
  const saved = () =>
    page.evaluate(
      () =>
        new Promise<any[]>((resolve) => {
          const req = indexedDB.open("listing-writer-drafts");
          req.onsuccess = () => {
            const get = req.result
              .transaction("workspace")
              .objectStore("workspace")
              .get("current");
            get.onsuccess = () => {
              req.result.close();
              resolve(get.result.groups);
            };
          };
        }),
    );
  await expect
    .poll(async () => (await saved()).find((g) => g.id === "blank")?.shipping)
    .toEqual({
      fulfillmentPolicyId: "ship-795",
      paymentPolicyId: "pay-1",
      returnPolicyId: "ret-1",
      locationKey: "zupe-hq",
    });
  const groups = await saved();
  expect(groups.find((g) => g.id === "live").shipping).toBeUndefined();
  expect(groups.find((g) => g.id === "chosen").shipping).toEqual({
    fulfillmentPolicyId: "heavy",
    paymentPolicyId: "pay-1",
    returnPolicyId: "ret-1",
    locationKey: "garage",
  });
});
