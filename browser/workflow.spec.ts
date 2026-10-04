import { test, expect, Page } from "@playwright/test";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=",
  "base64",
);
async function setup(page: Page) {
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
          title: "Canon R5 Camera",
          description: "Visible scuff. Untested.",
          brand: "Canon",
          item_type: "Camera",
          condition: "GOOD",
          suggested_price: 200,
          item_specifics: { Brand: "Canon", Model: "R5" },
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
        listing: { ...l, category_id: "625", ebay_condition: "" },
        preparation: {
          categoryId: "625",
          categoryName: "Cameras",
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
          locations: [{ id: "home", name: "My real origin" }],
        },
      },
    }),
  );
  await page.goto("/");
  await expect(page.getByText("Restoring saved work…")).toBeHidden();
}
async function draft(page: Page, categoryName = "Cameras") {
  await page.locator("input[type=file]").setInputFiles([
    { name: "front.png", mimeType: "image/png", buffer: png },
    { name: "label.png", mimeType: "image/png", buffer: png },
  ]);
  await expect(page.locator(".thumb")).toHaveCount(2);
  await page.getByRole("button", { name: "These photos are one item" }).click();
  await page.getByRole("button", { name: /Write.*listing/i }).click();
  await expect(page.getByText(categoryName, { exact: true })).toBeVisible();
}
async function shipping(page: Page) {
  await expect(
    page.getByRole("button", { name: "Post this to eBay" }),
  ).toBeDisabled();
  // SKUs are never generated: the seller enters their inventory number.
  await page.getByLabel("SKU", { exact: true }).fill("TEST-1001");
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
  await page
    .getByText("Package weight and dimensions (optional)", { exact: true })
    .click();
  for (const [label, value] of [
    ["Packed weight (oz)", "24"],
    ["Length (in)", "10"],
    ["Width (in)", "8"],
    ["Height (in)", "6"],
  ])
    await page.getByLabel(label, { exact: true }).fill(value);
}
test("retains good photos when one cannot decode; preserves original blobs across reload", async ({
  page,
}) => {
  await setup(page);
  await page.locator("input[type=file]").setInputFiles([
    { name: "valid.png", mimeType: "image/png", buffer: png },
    { name: "broken.png", mimeType: "image/png", buffer: Buffer.from("bad") },
  ]);
  await expect(page.locator(".thumb")).toHaveCount(1);
  await expect(page.locator(".note-error")).toContainText("broken.png");
  await expect(page.getByRole("status")).toContainText("Saved on this device");
  await page.reload();
  await expect(page.locator(".thumb")).toHaveCount(1);
});
test("restores edited drafts and blocks publication with missing facts", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await setup(page);
  await draft(page);
  await page.locator(".title-input").fill("Seller reviewed camera");
  await page.getByLabel("Brand", { exact: true }).fill("");
  await expect(
    page.getByRole("button", { name: "Post this to eBay" }),
  ).toBeDisabled();
  await expect(page.getByRole("status")).toContainText("Saved on this device");
  await page.reload();
  await expect(page.locator(".title-input")).toHaveValue(
    "Seller reviewed camera",
  );
  await expect(page.getByLabel("Brand", { exact: true })).toHaveValue("");
  expect(errors).toEqual([]);
});
test("partial image upload stops publication; retry preserves reviewed fields", async ({
  page,
}) => {
  let calls = 0;
  let fail = true;
  await setup(page);
  await page.route("**/api/ebay/upload-photos", (r) =>
    r.fulfill({
      json: {
        ok: true,
        urls: fail
          ? ["https://i.ebayimg.com/1.jpg"]
          : ["https://i.ebayimg.com/1.jpg", "https://i.ebayimg.com/2.jpg"],
      },
    }),
  );
  await page.route("**/api/ebay/publish", (r) => {
    calls++;
    const b = r.request().postDataJSON();
    expect(b.listing.title).toBe("Canon R5 Camera");
    expect(b.shipping.weightOz).toBe(24);
    expect(b.expectedPhotoCount).toBe(2);
    return r.fulfill({ json: { success: true, listingId: "12345" } });
  });
  await draft(page);
  await shipping(page);
  await page.getByRole("button", { name: "Post this to eBay" }).click();
  await expect(
    page.getByText(/Some selected photos failed to upload/),
  ).toBeVisible();
  expect(calls).toBe(0);
  fail = false;
  await page.getByRole("button", { name: "Post this to eBay" }).click();
  await expect(
    page.getByText("Posted to eBay", { exact: false }),
  ).toBeVisible();
  expect(calls).toBe(1);
});
test("second tab cannot overwrite the active workspace", async ({
  page,
  context,
}) => {
  await setup(page);
  await expect(page.getByText("Saved on this device")).toBeVisible();
  const other = await context.newPage();
  await other.goto("/");
  await expect(other.getByText(/already open in another tab/)).toBeVisible();
  await other.close();
});

test("late preparation never overwrites a seller edit", async ({ page }) => {
  await setup(page);
  await draft(page);
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let started!: () => void;
  const called = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route("**/api/ebay/prepare", async (r) => {
    started();
    await pending;
    await r.fulfill({
      json: {
        ok: true,
        listing: {
          ...r.request().postDataJSON().listing,
          title: "Stale AI response",
        },
        preparation: {},
      },
    });
  });
  await page
    .getByRole("button", { name: "Prepare category and specifics" })
    .click();
  await called;
  await page.locator(".title-input").fill("My newer correction");
  finish();
  await expect(
    page.getByText(
      "The draft changed while preparing. Prepare it again to keep your edits.",
    ),
  ).toBeVisible();
  await expect(page.locator(".title-input")).toHaveValue("My newer correction");
});
test("phone review fits the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await draft(page);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: "test-results/phone-review.png",
    fullPage: true,
  });
});

test("eBay sign-in uses an in-page access form and a user-clicked link", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.prompt = () => {
      throw new Error("prompt() is not supported.");
    };
    window.open = () => {
      throw new Error("Automatic popups are not supported.");
    };
  });
  await setup(page);
  await page.route("**/api/ebay/status", (r) =>
    r.fulfill({ json: { configured: true, connected: false } }),
  );
  await page.route("**/api/ebay/auth", (r) => {
    const valid = r.request().headers()["x-app-secret"] === "test-correct-code";
    return r.fulfill({
      status: valid ? 200 : 401,
      json: valid
        ? { ok: true, url: "https://auth.ebay.com/oauth2/authorize?test=1" }
        : { ok: false, code: "ACCESS_CODE_REQUIRED" },
    });
  });
  await page.reload();
  await page.getByRole("button", { name: "Open eBay" }).click();
  const dialog = page.getByRole("dialog", { name: "App access code" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("input")).toHaveAttribute("type", "password");
  await dialog.locator("input").fill("wrong-code");
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(dialog).toContainText("try again");
  await dialog.locator("input").fill("test-correct-code");
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Continue to eBay" }),
  ).toHaveAttribute("href", "https://auth.ebay.com/oauth2/authorize?test=1");
});

test("cancelling access entry closes the form and allows another attempt", async ({
  page,
}) => {
  await setup(page);
  await page.route("**/api/ebay/status", (r) =>
    r.fulfill({ json: { configured: true, connected: false } }),
  );
  await page.route("**/api/ebay/auth", (r) =>
    r.fulfill({
      status: 401,
      json: {
        ok: false,
        code: "ACCESS_CODE_REQUIRED",
        error: "Access code required.",
      },
    }),
  );
  await page.reload();
  await page.getByRole("button", { name: "Open eBay" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel" })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Open eBay" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("defaults the seller policies and allows review without package measurements", async ({
  page,
}) => {
  await setup(page);
  await page.route("**/api/ebay/options", (r) =>
    r.fulfill({
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
    }),
  );
  await draft(page);
  await expect(page.getByLabel("Shipping policy", { exact: true })).toHaveValue(
    "usual",
  );
  await expect(page.getByLabel("Shipping origin", { exact: true })).toHaveValue(
    "home",
  );
  await page
    .getByLabel("eBay condition", { exact: true })
    .selectOption("USED_EXCELLENT");
  // Without a SKU the item cannot post.
  await expect(
    page.getByRole("button", { name: "Post this to eBay" }),
  ).toBeDisabled();
  await page.getByLabel("SKU", { exact: true }).fill("TEST-1001");
  await expect(
    page.getByRole("button", { name: "Post this to eBay" }),
  ).toBeEnabled();
  await page
    .getByLabel("Shipping policy", { exact: true })
    .selectOption("heavy");
  await page
    .getByRole("button", { name: "Load my eBay policies and locations" })
    .click();
  await expect(page.getByLabel("Shipping policy", { exact: true })).toHaveValue(
    "heavy",
  );
});
test("start new batch warns about unposted drafts, then clears saved work across reload", async ({
  page,
}) => {
  await setup(page);
  await draft(page);
  await expect(page.getByRole("status")).toContainText("Saved on this device");
  const messages: string[] = [];
  page.once("dialog", (d) => {
    messages.push(d.message());
    void d.dismiss();
  });
  await page.getByRole("button", { name: "Start new batch" }).click();
  expect(messages[0]).toContain("1 written listing has not been posted");
  await expect(page.locator(".title-input")).toBeVisible();
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "Start new batch" }).click();
  await expect(page.locator(".title-input")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Start new batch" }),
  ).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("Saved on this device");
  await page.reload();
  await expect(page.getByText("Restoring saved work…")).toBeHidden();
  await expect(page.locator(".thumb")).toHaveCount(0);
  await expect(page.locator(".title-input")).toHaveCount(0);
});
async function marketDraft(page: Page, comps: Record<string, unknown>) {
  await setup(page);
  await page.route("**/api/analyze", (r) =>
    r.fulfill({
      json: {
        ok: true,
        listing: {
          title: "Faherty Pocket Tee",
          description: "Pre-owned tee.",
          brand: "Faherty",
          condition: "GOOD",
          suggested_price: 14,
          price_source: "ai",
          item_specifics: { Brand: "Faherty" },
        },
        usage: [],
      },
    }),
  );
  await page.route("**/api/ebay/comps", (r) =>
    r.fulfill({
      json: {
        ok: true,
        comps: {
          ok: true,
          query: "faherty tee m",
          confidence: 0.3,
          basis: "active asking prices, not sold",
          low: 8,
          high: 30,
          shippingCharge: 7.99,
          minComps: 3,
          ...comps,
        },
      },
    }),
  );
  await draft(page);
}
test("market price is offered behind a button and labeled as asking prices", async ({
  page,
}) => {
  await marketDraft(page, {
    count: 3,
    median: 27.99,
    itemPrice: 19.99,
    rawItemPrice: 20,
    belowFloor: false,
  });
  const price = page.getByLabel("Price", { exact: true });
  const use = page.getByRole("button", { name: "Use $19.99 + $7.99 shipping" });
  await expect(use).toBeVisible();
  await expect(
    page.getByText("Market (active asking prices, not sold): 3 comparable"),
  ).toBeVisible();
  // Never applied automatically.
  await expect(price).toHaveValue("14");
  await expect(
    page.getByText("AI estimate: unverified, from photos only"),
  ).toBeVisible();
  await use.click();
  await expect(price).toHaveValue("19.99");
  await expect(
    page.getByText("From active asking prices (not sold)"),
  ).toBeVisible();
  await price.fill("18");
  await expect(page.getByText("Your price", { exact: true })).toBeVisible();
});
test("below-floor market price is button-only with an above-market warning", async ({
  page,
}) => {
  await marketDraft(page, {
    count: 5,
    median: 9.5,
    itemPrice: 5,
    rawItemPrice: 1.51,
    belowFloor: true,
  });
  const price = page.getByLabel("Price", { exact: true });
  await expect(
    page.getByText(
      "At $5.00, your delivered price ($12.99) is above the market median ($9.50).",
      { exact: false },
    ),
  ).toBeVisible();
  await expect(price).toHaveValue("14");
  await page
    .getByRole("button", { name: "Use $5.00 + $7.99 shipping" })
    .click();
  await expect(price).toHaveValue("5");
});
test("fewer than three comps keep the AI estimate without a market button", async ({
  page,
}) => {
  await marketDraft(page, { count: 2, median: 27.99 });
  await expect(
    page.getByText(
      "Fewer than 3 comparable listings: keeping the AI’s unverified estimate.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /^Use \$/ })).toHaveCount(0);
  await expect(page.getByLabel("Price", { exact: true })).toHaveValue("14");
});
async function clothingDraft(page: Page) {
  await setup(page);
  await page.route("**/api/analyze", (r) =>
    r.fulfill({
      json: {
        ok: true,
        listing: {
          title: "Patagonia Mens Fleece Pullover Sz M Gray",
          title_source: "auto",
          description: "Pre-owned fleece.",
          brand: "Patagonia",
          category: "mens_sweater",
          item_type: "Fleece Pullover",
          size: "M",
          color: ["Gray"],
          condition: "GOOD",
          suggested_price: 40,
          item_specifics: { Brand: "Patagonia", Pattern: "Striped" },
          evidence: { Brand: [1], Pattern: [1] },
          estimates: {},
        },
        usage: [],
      },
    }),
  );
  await draft(page);
}
test("rebuild title uses item details and protects a typed title", async ({
  page,
}) => {
  await clothingDraft(page);
  const title = page.locator(".title-input");
  await expect(title).toHaveValue("Patagonia Mens Fleece Pullover Sz M Gray");
  await page
    .getByRole("button", { name: "Rebuild title from details" })
    .click();
  await expect(title).toHaveValue(
    "Patagonia Mens Fleece Pullover Sz M Gray Striped",
  );
  await title.fill("My own fleece title");
  // A typed title is only replaced after explicit confirmation.
  page.once("dialog", (d) => d.dismiss());
  await page
    .getByRole("button", { name: "Rebuild title from details" })
    .click();
  await expect(title).toHaveValue("My own fleece title");
  page.once("dialog", (d) => d.accept());
  await page
    .getByRole("button", { name: "Rebuild title from details" })
    .click();
  await expect(title).toHaveValue(
    "Patagonia Mens Fleece Pullover Sz M Gray Striped",
  );
});
test("non-clothing items have no rebuild button", async ({ page }) => {
  await setup(page);
  await draft(page);
  await expect(page.locator(".title-input")).toHaveValue("Canon R5 Camera");
  await expect(
    page.getByRole("button", { name: "Rebuild title from details" }),
  ).toHaveCount(0);
});
test("review keeps unrelated citations, estimate markers, defaults and removal notes visible", async ({
  page,
}) => {
  await setup(page);
  await page.route("**/api/analyze", (r) =>
    r.fulfill({
      json: {
        ok: true,
        listing: {
          title: "Acme Mens Shirt Sz M Blue",
          title_source: "auto",
          description: "Pre-owned shirt.",
          brand: "Acme",
          category: "mens_top",
          item_type: "Shirt",
          size: "M",
          color: ["Blue"],
          condition: "VERY_GOOD",
          suggested_price: 20,
          item_specifics: { Brand: "Acme", Pattern: "Striped" },
          evidence: { Brand: [1], Pattern: [2] },
          estimates: {},
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
          category_id: "57990",
          ebay_condition: "PRE_OWNED_EXCELLENT",
          ai_condition: "VERY_GOOD",
          defaulted: ["Size Type", "condition"],
          item_specifics: {
            ...l.item_specifics,
            "Size Type": "Regular",
            "Sleeve Length": "Long Sleeve",
          },
          // A record still under the model's spelling must keep its marker.
          estimates: { "sleeve length": 80 },
          evidence: { ...l.evidence, "sleeve length": [2] },
        },
        preparation: {
          categoryId: "57990",
          categoryName: "Casual Shirts",
          aspects: ["Brand", "Pattern", "Size Type", "Sleeve Length"].map(
            (name) => ({
              name,
              required: false,
              usage: "RECOMMENDED",
              mode: "FREE_TEXT",
              cardinality: "SINGLE",
              values: [],
            }),
          ),
          conditions: [
            {
              value: "PRE_OWNED_EXCELLENT",
              label: "Pre-owned Excellent (2990)",
            },
          ],
          expiresAt: Date.now() + 3600000,
          signature: "test",
          issues: [],
          removed: [
            {
              name: "Sleeve Style",
              value: "Cap Sleeve",
              reason: "Not accepted by eBay for this category",
            },
          ],
        },
      },
    });
  });
  await draft(page, "Casual Shirts");
  const label = (name: string) =>
    page
      .locator("label.specific-edit")
      .filter({ has: page.getByLabel(name, { exact: true }) });
  await expect(label("Brand")).toContainText("AI cites photo 1");
  await expect(label("Pattern")).toContainText("AI cites photo 2");
  await expect(label("Sleeve Length")).toContainText("AI estimate · 80% sure");
  await expect(label("Size Type")).toContainText("Default: Regular");
  await expect(
    page.getByText(
      "Default condition: Pre-owned Excellent (2990) · AI grade: Very Good",
    ),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Not accepted by eBay for this category: Sleeve Style = Cap Sleeve",
    ),
  ).toBeVisible();
  // Editing one specific keeps every other citation.
  await page.getByLabel("Pattern", { exact: true }).fill("Plaid");
  await expect(label("Pattern")).toContainText("Your value");
  await expect(label("Pattern")).not.toContainText("AI cites photo");
  await expect(label("Brand")).toContainText("AI cites photo 1");
  await expect(label("Sleeve Length")).toContainText("AI estimate · 80% sure");
});
test("review shows seller card facts, flaw, conflicts and every source label", async ({
  page,
}) => {
  await setup(page);
  await page.route("**/api/analyze", (r) =>
    r.fulfill({
      json: {
        ok: true,
        listing: {
          title: "Polo Ralph Lauren Mens Shirt Sz L Blue",
          title_source: "auto",
          description: "Pre-owned shirt. Flaw: 1-inch tear under right arm.",
          condition_notes: "Flaw: 1-inch tear under right arm.",
          brand: "Polo Ralph Lauren",
          category: "mens_top",
          item_type: "Shirt",
          size: "L",
          color: ["Blue"],
          condition: "VERY_GOOD",
          suggested_price: 20,
          item_specifics: {
            Brand: "Polo Ralph Lauren",
            Size: "L",
            Pattern: "Striped",
            Pockets: "Chest Pocket",
            Material: "100% Cotton",
          },
          evidence: { Pattern: [1], Pockets: [1], Material: [1] },
          estimates: { Pattern: 82, Pockets: 88 },
          visible: ["Pockets"],
          card_specifics: ["Brand", "Size"],
          seller_card: {
            photoIndices: [2],
            fields: {
              BRAND: "Polo Ralph Lauren",
              SIZE: "L",
              FLAW: "1-inch tear under right arm",
              NOTES: "color looks slightly darker in person",
            },
          },
          conflicts: [
            {
              name: "Brand",
              kept: "Polo Ralph Lauren",
              keptSource: "seller card",
              other: "Lauren Ralph Lauren",
              otherSource: "the label",
            },
          ],
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
          category_id: "57990",
          ebay_condition: "USED_EXCELLENT",
          defaulted: ["Size Type", "condition"],
          condition_review:
            "Pre-owned Good because the seller card lists a flaw.",
          item_specifics: { ...l.item_specifics, "Size Type": "Regular" },
        },
        preparation: {
          categoryId: "57990",
          categoryName: "Casual Shirts",
          aspects: ["Brand", "Size", "Pattern", "Material", "Size Type"].map(
            (name) => ({
              name,
              required: false,
              usage: "RECOMMENDED",
              mode: "FREE_TEXT",
              cardinality: "SINGLE",
              values: [],
            }),
          ),
          conditions: [
            {
              value: "PRE_OWNED_EXCELLENT",
              label: "Pre-owned Excellent (2990)",
            },
            { value: "USED_EXCELLENT", label: "Pre-owned Good (3000)" },
          ],
          expiresAt: Date.now() + 3600000,
          signature: "test",
          issues: [],
        },
      },
    });
  });
  await draft(page, "Casual Shirts");
  const label = (name: string) =>
    page
      .locator("label.specific-edit")
      .filter({ has: page.getByLabel(name, { exact: true }) });
  const card = page.getByRole("region", { name: "Seller card" });
  await expect(card).toContainText("Seller card (photo 2)");
  await expect(card).toContainText("not read from a manufacturer label");
  await expect(card).toContainText(
    "Seller-noted flaw: 1-inch tear under right arm",
  );
  await expect(card).toContainText(
    "Seller notes: color looks slightly darker in person",
  );
  await expect(
    page.getByText("Pre-owned Good because the seller card lists a flaw."),
  ).toBeVisible();
  await expect(
    page.getByText("Default condition: Pre-owned Good (3000)"),
  ).toBeVisible();
  await expect(label("Brand")).toContainText("Seller card");
  await expect(label("Brand")).not.toContainText("AI cites");
  await expect(label("Size")).toContainText("Seller card");
  await expect(label("Material")).toContainText("AI cites photo 1");
  await expect(label("Pattern")).toContainText("AI estimate · 82% sure");
  await expect(label("Pockets")).toContainText("Visible in photo · 88% sure");
  await expect(label("Size Type")).toContainText("Default: Regular");
  const conflicts = page.getByRole("list", { name: "Conflicts to review" });
  await expect(conflicts).toContainText(
    "Resolve before posting: Seller card says Polo Ralph Lauren; the label appears to say Lauren Ralph Lauren — please review Brand.",
  );
  // Confirming the card value makes it the seller's and clears the conflict;
  // other sources keep their labels.
  await conflicts
    .getByRole("button", { name: "Keep Polo Ralph Lauren" })
    .click();
  await expect(conflicts).toHaveCount(0);
  await expect(label("Brand")).toContainText("Your value");
  await expect(label("Size")).toContainText("Seller card");
  await expect(label("Material")).toContainText("AI cites photo 1");
  // A manual condition choice keeps the flaw disclosed.
  await page
    .getByLabel("eBay condition", { exact: true })
    .selectOption("PRE_OWNED_EXCELLENT");
  await expect(card).toContainText("1-inch tear under right arm");
  await expect(
    page.getByRole("textbox", {
      name: "Condition / testing notes",
      exact: true,
    }),
  ).toHaveValue("Flaw: 1-inch tear under right arm.");
});
test("inventory sticker fills the SKU, shows its source, and yields to the seller", async ({
  page,
}) => {
  await setup(page);
  const label = {
    status: "read",
    value: "1009",
    photoIndices: [2],
    confidence: 96,
  };
  await page.route("**/api/analyze", (r) =>
    r.fulfill({
      json: {
        ok: true,
        listing: {
          title: "Canon R5 Camera",
          description: "Visible scuff. Untested.",
          brand: "Canon",
          item_type: "Camera",
          condition: "GOOD",
          suggested_price: 200,
          item_specifics: { Brand: "Canon", Model: "R5" },
          inventory_label: label,
        },
        usage: [],
      },
    }),
  );
  await draft(page);
  const sku = page.getByLabel("SKU", { exact: true });
  await expect(sku).toHaveValue("1009");
  await expect(page.getByText("Inventory sticker · photo 2")).toBeVisible();
  // The seller's own value wins and is labelled as theirs.
  await sku.fill("A-1013");
  await expect(sku).toHaveValue("A-1013");
  await expect(page.getByText("Inventory sticker · photo 2")).toHaveCount(0);
  await expect(page.getByText("Your value").first()).toBeVisible();
});
test("an unreadable inventory sticker leaves the SKU blank with a warning", async ({
  page,
}) => {
  await setup(page);
  await page.route("**/api/analyze", (r) =>
    r.fulfill({
      json: {
        ok: true,
        listing: {
          title: "Canon R5 Camera",
          description: "Visible scuff. Untested.",
          brand: "Canon",
          item_type: "Camera",
          condition: "GOOD",
          suggested_price: 200,
          item_specifics: { Brand: "Canon", Model: "R5" },
          inventory_label: { status: "unreadable", photoIndices: [2] },
        },
        usage: [],
      },
    }),
  );
  await draft(page);
  await expect(page.getByLabel("SKU", { exact: true })).toHaveValue("");
  await expect(
    page.getByRole("note").filter({
      hasText:
        "Inventory sticker detected but Custom Label could not be read confidently.",
    }),
  ).toBeVisible();
  await page.getByLabel("SKU", { exact: true }).fill("A-1013");
  await expect(
    page.getByText(
      "Inventory sticker detected but Custom Label could not be read confidently.",
    ),
  ).toHaveCount(0);
});
test("sorting creates items with blank SKUs and no generated codes", async ({
  page,
}) => {
  await setup(page);
  await page.route("**/api/sort", (r) =>
    r.fulfill({
      json: {
        ok: true,
        groups: [
          { name: "red-shorts", photoIndices: [0, 1] },
          { name: "gray-pants", photoIndices: [2, 3] },
        ],
        orphanIndices: [],
      },
    }),
  );
  // No bin / generated-SKU setting remains.
  await expect(page.getByLabel(/Bin \/ SKU code/)).toHaveCount(0);
  await page.locator("input[type=file]").setInputFiles(
    ["a", "b", "c", "d"].map((n) => ({
      name: `${n}.png`,
      mimeType: "image/png",
      buffer: png,
    })),
  );
  await expect(page.locator(".thumb")).toHaveCount(4);
  await page.getByRole("button", { name: /Sort 4 photos into items/ }).click();
  const skus = page.getByLabel("Item SKU / bin code", { exact: true });
  await expect(skus).toHaveCount(2);
  await expect(skus.nth(0)).toHaveValue("");
  await expect(skus.nth(1)).toHaveValue("");
  await expect(
    page.getByLabel("Item name", { exact: true }).nth(0),
  ).toHaveValue("red-shorts");
  await expect(
    page.getByLabel("Item name", { exact: true }).nth(1),
  ).toHaveValue("gray-pants");
  // A seller SKU typed here belongs to that item only.
  await skus.nth(1).fill("A-1001");
  await expect(skus.nth(0)).toHaveValue("");
  await expect(skus.nth(1)).toHaveValue("A-1001");
});
