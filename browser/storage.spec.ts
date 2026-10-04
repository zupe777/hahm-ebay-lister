import { test, expect, type Page } from "@playwright/test";

// Real Chrome IndexedDB, real JPEG decoding/encoding: the photo storage
// architecture end to end. Synthetic photos are generated in the browser.

async function setup(page: Page) {
  await page.route("**/api/ebay/status", (r) =>
    r.fulfill({ json: { connected: true } }),
  );
  await page.route("**/api/models", (r) =>
    r.fulfill({ json: { sortModels: [], analysisModels: [] } }),
  );
  await page.route("**/api/ebay/comps", (r) =>
    r.fulfill({ json: { ok: false, error: "Research unavailable" } }),
  );
  await page.goto("/");
  await expect(page.getByText("Restoring saved work…")).toBeHidden();
}

// Real JPEG files made with a canvas in the page.
async function jpegs(page: Page, count: number, w: number, h: number) {
  const data = await page.evaluate(
    async ({ count, w, h }) => {
      const out: string[] = [];
      for (let i = 0; i < count; i++) {
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const ctx = c.getContext("2d")!;
        ctx.fillStyle = `hsl(${(i * 37) % 360} 70% 50%)`;
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = "#fff";
        ctx.fillRect((i * 7) % w, (i * 11) % h, w / 4, h / 4);
        const blob: Blob = await new Promise((r) =>
          c.toBlob((b) => r(b!), "image/jpeg", 0.9),
        );
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let s = "";
        for (let j = 0; j < bytes.length; j += 0x8000)
          s += String.fromCharCode(...bytes.subarray(j, j + 0x8000));
        out.push(btoa(s));
      }
      return out;
    },
    { count, w, h },
  );
  return data.map((b64, i) => ({
    name: `IMG_${String(i).padStart(4, "0")}.jpg`,
    mimeType: "image/jpeg",
    buffer: Buffer.from(b64, "base64"),
  }));
}

// Counts per store and the raw workspace record, straight from IndexedDB.
async function inspectDb(page: Page) {
  return page.evaluate(
    () =>
      new Promise<{
        counts: Record<string, number>;
        workspace: string;
        version: number;
      }>((resolve) => {
        const r = indexedDB.open("listing-writer-drafts");
        r.onsuccess = async () => {
          const db = r.result;
          const counts: Record<string, number> = {};
          for (const s of Array.from(db.objectStoreNames)) {
            counts[s] = await new Promise<number>((res) => {
              const c = db.transaction(s).objectStore(s).count();
              c.onsuccess = () => res(c.result);
            });
          }
          const w = await new Promise<unknown>((res) => {
            const g = db
              .transaction("workspace")
              .objectStore("workspace")
              .get("current");
            g.onsuccess = () => res(g.result);
          });
          const version = db.version;
          db.close();
          resolve({ counts, workspace: JSON.stringify(w ?? null), version });
        };
      }),
  );
}

// Dimensions of a base64 JPEG, decoded by the browser.
const dims = (page: Page, b64: string) =>
  page.evaluate(async (b64) => {
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes]));
    return [bmp.width, bmp.height];
  }, b64);

test("stress: 320 photos stored as Blobs survive reload; removal frees storage and revokes previews", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await setup(page);
  const files = await jpegs(page, 320, 160, 120);
  await page.locator("input[type=file]").setInputFiles(files);
  await expect(page.locator(".thumb")).toHaveCount(320, { timeout: 120_000 });
  await expect(page.getByRole("status").first()).toContainText(
    "Saved on this device",
  );
  const db = await inspectDb(page);
  expect(db.version).toBe(4);
  expect(db.counts).toMatchObject({
    originals: 320,
    analysis: 320,
    thumbs: 320,
    photos: 0,
    assets: 0,
  });
  // The workspace holds metadata only: no base64 or data URLs.
  expect(db.workspace).not.toMatch(/data:image|;base64,/);
  expect(db.workspace.length).toBeLessThan(80_000);
  // Previews are object URLs, not data URLs.
  const srcs = await page
    .locator(".thumb img")
    .evaluateAll((imgs) => imgs.map((i) => (i as HTMLImageElement).src));
  expect(srcs.every((s) => s.startsWith("blob:"))).toBe(true);
  // Memory stays bounded: no batch of base64 images held in the page.
  const heap = await page.evaluate(
    () => (performance as any).memory?.usedJSHeapSize ?? 0,
  );
  expect(heap).toBeLessThan(150 * 1024 * 1024);
  await expect(page.locator(".storage-panel summary")).toContainText(
    /Photo storage: .* used of .* available/,
  );

  // Reload: every photo and preview restores from storage.
  await page.reload();
  await expect(page.locator(".thumb")).toHaveCount(320, { timeout: 60_000 });
  const firstSrc = await page.locator(".thumb img").first().getAttribute("src");
  expect(firstSrc).toMatch(/^blob:/);
  expect(
    await page
      .locator(".thumb img")
      .first()
      .evaluate((i) => (i as HTMLImageElement).naturalWidth),
  ).toBeGreaterThan(0);

  // Removing a photo deletes its stored data and revokes its preview URL.
  await page.getByRole("button", { name: "Remove photo" }).first().click();
  await expect(page.locator(".thumb")).toHaveCount(319);
  await expect
    .poll(async () => (await inspectDb(page)).counts.originals)
    .toBe(319);
  const revoked = await page.evaluate(async (url) => {
    try {
      await fetch(url!);
      return false;
    } catch {
      return true;
    }
  }, firstSrc);
  expect(revoked).toBe(true);
});

test("AI and eBay images keep their sizes: 1024 px for analysis, 2400 px generated for upload", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await setup(page);
  let analysisImage = "";
  const uploaded: string[] = [];
  await page.route("**/api/analyze", (r) => {
    analysisImage = r.request().postDataJSON().images[0].data;
    return r.fulfill({
      json: {
        ok: true,
        listing: {
          title: "Canon R5 Camera",
          description: "Visible scuff.",
          brand: "Canon",
          item_type: "Camera",
          condition: "GOOD",
          suggested_price: 200,
          item_specifics: { Brand: "Canon" },
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
        listing: { ...l, category_id: "625", ebay_condition: "" },
        preparation: {
          categoryId: "625",
          categoryName: "Cameras",
          aspects: [],
          conditions: [{ value: "USED_EXCELLENT", label: "Used" }],
          expiresAt: Date.now() + 3600000,
          signature: "test",
          issues: [],
        },
      },
    });
  });
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
  await page.route("**/api/ebay/upload-photos", (r) => {
    const { images } = r.request().postDataJSON();
    uploaded.push(...images.map((i: { data: string }) => i.data));
    return r.fulfill({
      json: {
        ok: true,
        urls: images.map(
          (_: unknown, i: number) => `https://i.ebayimg.com/${i}.jpg`,
        ),
      },
    });
  });
  await page.route("**/api/ebay/publish", (r) =>
    r.fulfill({ json: { success: true, listingId: "123" } }),
  );
  // A full-size 4000 × 3000 photo.
  const [big] = await jpegs(page, 1, 4000, 3000);
  await page.locator("input[type=file]").setInputFiles([big]);
  await expect(page.locator(".thumb")).toHaveCount(1, { timeout: 60_000 });
  await page.getByRole("button", { name: "These photos are one item" }).click();
  await page.getByRole("button", { name: /Write.*listing/i }).click();
  await expect(page.getByText("Cameras", { exact: true })).toBeVisible();
  expect(await dims(page, analysisImage)).toEqual([1024, 768]);

  await page.getByLabel("SKU", { exact: true }).fill("A-1001");
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
  await page.getByRole("button", { name: "Post this to eBay" }).click();
  await expect.poll(() => uploaded.length, { timeout: 60_000 }).toBe(1);
  // Same rules as before: 2400 px long side, within the request-size bound.
  expect(await dims(page, uploaded[0])).toEqual([2400, 1800]);
  expect(uploaded[0].length).toBeLessThanOrEqual(2_700_000);
  // The upload copy was generated, not stored.
  const db = await inspectDb(page);
  expect(db.counts).toMatchObject({ originals: 1, analysis: 1, thumbs: 1 });
});

test("a full browser quota stops the import with a clear reason for each photo", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value: any, key?: any) {
      if (value instanceof Blob)
        throw new DOMException("", "QuotaExceededError");
      return put.call(this, value, key);
    };
  });
  await setup(page);
  const files = await jpegs(page, 6, 80, 60);
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.locator("input[type=file]").setInputFiles(files);
  const alert = page.getByRole("alert").filter({ hasText: "IMG_" });
  await expect(alert).toContainText(/IMG_\d{4}\.jpg: Browser storage is full/);
  await expect(alert).toContainText(/more photos? (was|were) not added/);
  await expect(alert).not.toContainText(/\.jpg: ;|\.jpg: $/);
  await expect(page.locator(".thumb")).toHaveCount(0);
  // The technical error is logged for diagnosis.
  expect(errors.some((e) => /QuotaExceededError|storage is full/.test(e))).toBe(
    true,
  );
});

test("works when persistence is denied and the browser reports no storage estimate", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "storage", {
      value: { persist: async () => false, persisted: async () => false },
      configurable: true,
    });
  });
  await setup(page);
  await expect(page.locator(".storage-panel summary")).toContainText(
    "this browser does not report storage usage",
  );
  await page
    .locator("input[type=file]")
    .setInputFiles(await jpegs(page, 3, 120, 90));
  await expect(page.locator(".thumb")).toHaveCount(3);
  await expect(page.getByRole("status").first()).toContainText(
    "Saved on this device",
  );
  await page.locator(".storage-panel summary").click();
  await expect(page.locator(".storage-panel")).toContainText(
    "has not granted persistent storage",
  );
});

test("old-format storage migrates: listings kept, base64 copies replaced by Blobs, unused data freed", async ({
  page,
}) => {
  await setup(page);
  const [a, b, c] = await jpegs(page, 3, 600, 400);
  // Recreate the previous database format on a page that does not open it.
  await page.goto("/privacy");
  await page.evaluate(
    async ({ files }) => {
      await new Promise<void>((resolve) => {
        const d = indexedDB.deleteDatabase("listing-writer-drafts");
        d.onsuccess = d.onerror = d.onblocked = () => resolve();
      });
      const toBytes = (b64: string) =>
        Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
      await new Promise<void>((resolve, reject) => {
        const r = indexedDB.open("listing-writer-drafts", 3);
        r.onupgradeneeded = () => {
          for (const s of ["workspace", "photos", "assets"])
            r.result.createObjectStore(s);
        };
        r.onsuccess = () => {
          const db = r.result;
          const tx = db.transaction(
            ["workspace", "photos", "assets"],
            "readwrite",
          );
          files.forEach((b64: string, i: number) => {
            const id = `old-${i}`;
            tx.objectStore("photos").put(
              {
                id,
                data: b64,
                previewUrl: `data:image/jpeg;base64,${b64}`,
                mediaType: "image/jpeg",
              },
              id,
            );
            tx.objectStore("assets").put(
              {
                original: new Blob([toBytes(b64)], { type: "image/jpeg" }),
                uploadData: b64,
              },
              id,
            );
          });
          tx.objectStore("workspace").put(
            {
              version: 1,
              // old-2 is not part of the batch any more.
              photos: [{ id: "old-0" }, { id: "old-1" }],
              groups: [
                {
                  id: "g",
                  sku: "1001",
                  skuSource: "card",
                  name: "red-shorts",
                  photoIds: ["old-0", "old-1"],
                  status: "idle",
                },
              ],
              orphanIds: [],
              binPrefix: "",
              skuStart: 0,
              step: "review",
              updatedAt: 1,
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
    { files: [a, b, c].map((f) => f.buffer.toString("base64")) },
  );
  await page.goto("/");
  await expect(page.getByText("Restoring saved work…")).toBeHidden();
  await expect(
    page.getByLabel("Item SKU / bin code", { exact: true }),
  ).toHaveValue("1001");
  await expect(page.locator(".board-item img")).toHaveCount(2);
  await expect
    .poll(async () => (await inspectDb(page)).counts, { timeout: 30_000 })
    .toMatchObject({
      photos: 0,
      assets: 0,
      originals: 2,
      analysis: 2,
      thumbs: 2,
    });
  const srcs = await page
    .locator(".board-item img")
    .evaluateAll((imgs) => imgs.map((i) => (i as HTMLImageElement).src));
  expect(srcs.every((s) => s.startsWith("blob:"))).toBe(true);
  // The deliberate free-storage action explains itself and keeps the batch.
  await page.locator(".storage-panel summary").click();
  let message = "";
  page.once("dialog", (d) => {
    message = d.message();
    return d.accept();
  });
  await page
    .getByRole("button", { name: "Free photo storage: remove unused data" })
    .click();
  await expect(page.locator(".storage-panel")).toContainText(
    "No unused photo data was found.",
  );
  expect(message).toContain("Every photo in your current batch is kept.");
  expect((await inspectDb(page)).counts.originals).toBe(2);
});
