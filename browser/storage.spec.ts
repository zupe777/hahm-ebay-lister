import {
  chromium,
  test,
  expect,
  type BrowserContext,
  type Page,
  type CDPSession,
  type TestInfo,
} from "@playwright/test";

// Real Chrome IndexedDB, real JPEG decoding/encoding and Chrome's own storage
// quota (simulated with DevTools' quota override, which raises genuine
// QuotaExceededErrors): the photo storage architecture end to end.
//
// The user's Chrome reports navigator.storage.estimate().quota as usage +
// 10 GiB; padEstimate() makes this test browser do the same, so the app is
// tested against exactly that misleading figure.

const MB = 1024 * 1024;

async function routes(page: Page) {
  await page.route("**/api/ebay/status", (r) =>
    r.fulfill({ json: { connected: true } }),
  );
  await page.route("**/api/models", (r) =>
    r.fulfill({ json: { sortModels: [], analysisModels: [] } }),
  );
  await page.route("**/api/ebay/comps", (r) =>
    r.fulfill({ json: { ok: false, error: "Research unavailable" } }),
  );
}
async function setup(page: Page) {
  await routes(page);
  await page.goto("/");
  await expect(page.getByText("Restoring saved work…")).toBeHidden();
}

const PAD_ESTIMATE = () => {
  const real = navigator.storage.estimate.bind(navigator.storage);
  navigator.storage.estimate = async () => {
    const e = await real();
    return { ...e, quota: (e.usage ?? 0) + 10 * 1024 ** 3 };
  };
};
async function padEstimate(page: Page) {
  await page.addInitScript(PAD_ESTIMATE);
}

// A real on-disk Chrome profile (like the seller's): deleted data frees
// space at once, unlike a throwaway in-memory test profile. Chrome applies a
// quota to a site's database when the database is first opened in a browser
// session, so the limit is set before the app loads — and a "restart" is a
// new session on the same profile directory.
interface Session {
  ctx: BrowserContext;
  page: Page;
  cdp: CDPSession;
  usage: () => Promise<number>;
  setQuota: (bytes: number) => Promise<void>;
}
async function session(
  info: TestInfo,
  dir: string,
  quota?: number,
): Promise<Session> {
  const use = info.project.use as { launchOptions?: object; baseURL?: string };
  const ctx = await chromium.launchPersistentContext(dir, {
    ...(use.launchOptions ?? {}),
    baseURL: use.baseURL,
  });
  await ctx.addInitScript(PAD_ESTIMATE);
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await routes(page);
  await page.goto("/privacy");
  const cdp = await ctx.newCDPSession(page);
  const origin = new URL(page.url()).origin;
  const setQuota = async (bytes: number) => {
    await cdp.send("Storage.overrideQuotaForOrigin", {
      origin,
      quotaSize: Math.round(bytes),
    });
  };
  if (quota) await setQuota(quota);
  return {
    ctx,
    page,
    cdp,
    setQuota,
    usage: async () =>
      (await cdp.send("Storage.getUsageAndQuota", { origin })).usage,
  };
}
async function openApp(page: Page) {
  await page.goto("/");
  await expect(page.getByText("Restoring saved work…")).toBeHidden();
}
// Fill the rest of the quota with filler data in a separate database (same
// site, same quota) until Chrome refuses: storage is then truly full.
async function fillUp(page: Page) {
  return page.evaluate(async () => {
    const db: IDBDatabase = await new Promise((res) => {
      const o = indexedDB.open("filler", 1);
      o.onupgradeneeded = () => o.result.createObjectStore("s");
      o.onsuccess = () => res(o.result);
    });
    let n = 0;
    for (const size of [1024 * 1024, 64 * 1024, 4 * 1024]) {
      for (;;) {
        const ok = await new Promise<boolean>((res) => {
          const tx = db.transaction("s", "readwrite");
          tx.objectStore("s").put(new Blob([new Uint8Array(size)]), n++);
          tx.oncomplete = () => res(true);
          tx.onabort = () => res(false);
        });
        if (!ok) break;
      }
    }
    db.close();
    return n;
  });
}
const realUsage = (page: Page) =>
  page.evaluate(async () => {
    // The page's estimate() is padded; usage is real.
    return (await navigator.storage.estimate()).usage ?? 0;
  });
// Phone-like photos, generated in the page: a 4032 × 3024 scene with fabric-
// like texture, JPEG 0.92 (about 4–5 MB each). `distinct` different images
// are made once and reused under different file names.
async function makePhotos(
  page: Page,
  opts: { distinct: number; w?: number; h?: number; texture?: number },
) {
  await page.evaluate(
    async ({ distinct, w, h, texture }) => {
      const out: Blob[] = [];
      for (let k = 0; k < distinct; k++) {
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const ctx = c.getContext("2d")!;
        const g = ctx.createLinearGradient(0, 0, w, h);
        g.addColorStop(0, `hsl(${(k * 53) % 360} 55% 55%)`);
        g.addColorStop(1, `hsl(${(k * 53 + 160) % 360} 45% 40%)`);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
        for (let i = 0; i < 300; i++) {
          ctx.fillStyle = `hsla(${(i * 47 + k * 11) % 360} 60% ${30 + (i % 40)}% / 0.5)`;
          ctx.fillRect(
            (i * 131 + k * 17) % w,
            (i * 197 + k * 29) % h,
            40 + ((i * 13) % 400),
            30 + ((i * 29) % 300),
          );
        }
        if (texture) {
          const img = ctx.getImageData(0, 0, w, h);
          const d = img.data;
          let s = 12345 + k;
          for (let i = 0; i < d.length; i += 4) {
            s = (s * 1103515245 + 12345) & 0x7fffffff;
            const n = ((s >> 16) % (2 * texture)) - texture;
            d[i] += n;
            d[i + 1] += n;
            d[i + 2] += n;
          }
          ctx.putImageData(img, 0, 0);
        }
        out.push(
          await new Promise<Blob>((r) =>
            c.toBlob((b) => r(b!), "image/jpeg", 0.92),
          ),
        );
      }
      (window as any).__photos = out;
    },
    { w: 4032, h: 3024, texture: 20, ...opts },
  );
}
// Select `count` of the generated photos in the file picker.
async function addPhotos(page: Page, count: number, prefix = "IMG") {
  await page.evaluate(
    ({ count, prefix }) => {
      const photos: Blob[] = (window as any).__photos;
      const dt = new DataTransfer();
      for (let i = 0; i < count; i++)
        dt.items.add(
          new File([photos[i % photos.length]], `${prefix}_${i + 1}.jpg`, {
            type: "image/jpeg",
          }),
        );
      const input = document.querySelector(
        "input[type=file]",
      ) as HTMLInputElement;
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    },
    { count, prefix },
  );
}

// Counts per store, master sizes and the workspace record, from IndexedDB.
async function inspectDb(page: Page) {
  return page.evaluate(
    () =>
      new Promise<{
        counts: Record<string, number>;
        workspace: string;
        version: number;
        masterSizes: number[];
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
          const all = <T>(s: string) =>
            new Promise<T[]>((res) => {
              if (!db.objectStoreNames.contains(s)) return res([]);
              const g = db.transaction(s).objectStore(s).getAll();
              g.onsuccess = () => res(g.result as T[]);
            });
          const w = await new Promise<unknown>((res) => {
            const g = db
              .transaction("workspace")
              .objectStore("workspace")
              .get("current");
            g.onsuccess = () => res(g.result);
          });
          const masterSizes = (await all<Blob>("masters")).map((b) => b.size);
          const version = db.version;
          db.close();
          resolve({
            counts,
            workspace: JSON.stringify(w ?? null),
            version,
            masterSizes,
          });
        };
      }),
  );
}

// A stored master as base64 (to compare with what is sent to eBay or AI).
const masterBase64 = (page: Page, index: number) =>
  page.evaluate(async (index) => {
    const req = <T>(r: IDBRequest<T>) =>
      new Promise<T>((res, rej) => {
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    const db = await req(indexedDB.open("listing-writer-drafts"));
    const ws: any = await req(
      db.transaction("workspace").objectStore("workspace").get("current"),
    );
    const blob = (await req(
      db.transaction("masters").objectStore("masters").get(ws.photos[index].id),
    )) as Blob;
    db.close();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = "";
    for (let j = 0; j < bytes.length; j += 0x8000)
      s += String.fromCharCode(...bytes.subarray(j, j + 0x8000));
    return btoa(s);
  }, index);

const dims = (page: Page, b64: string) =>
  page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes]), {
      imageOrientation: "from-image",
    });
    return [bmp.width, bmp.height];
  }, b64);

// A landscape JPEG with EXIF orientation 6 ("rotate 90° to view"), as a
// phone camera writes for portrait shots.
async function exifPortrait(page: Page): Promise<Buffer> {
  const b64 = await page.evaluate(async () => {
    const c = document.createElement("canvas");
    c.width = 3200;
    c.height = 2400;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#468";
    ctx.fillRect(0, 0, 3200, 2400);
    ctx.fillStyle = "#fc0";
    ctx.fillRect(0, 0, 800, 600);
    const blob: Blob = await new Promise((r) =>
      c.toBlob((b) => r(b!), "image/jpeg", 0.9),
    );
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = "";
    for (let j = 0; j < bytes.length; j += 0x8000)
      s += String.fromCharCode(...bytes.subarray(j, j + 0x8000));
    return btoa(s);
  });
  const jpeg = Buffer.from(b64, "base64");
  const exif = Buffer.from([
    0xff,
    0xe1,
    0x00,
    0x22, // APP1, length 34
    0x45,
    0x78,
    0x69,
    0x66,
    0x00,
    0x00, // "Exif\0\0"
    0x4d,
    0x4d,
    0x00,
    0x2a,
    0x00,
    0x00,
    0x00,
    0x08, // TIFF header (MM)
    0x00,
    0x01, // one IFD entry
    0x01,
    0x12,
    0x00,
    0x03,
    0x00,
    0x00,
    0x00,
    0x01,
    0x00,
    0x06,
    0x00,
    0x00, // Orientation = 6
    0x00,
    0x00,
    0x00,
    0x00, // no next IFD
  ]);
  return Buffer.concat([jpeg.subarray(0, 2), exif, jpeg.subarray(2)]);
}

const meter = (page: Page) => page.locator(".storage-panel").first();
// Open the storage panel (it opens by itself when storage needs attention).
const openMeter = (page: Page) =>
  meter(page).evaluate((d) => ((d as HTMLDetailsElement).open = true));

test("imports keep one 2000 px master + thumbnail per photo; reload restores; removal frees and revokes", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await padEstimate(page);
  await setup(page);
  await makePhotos(page, { distinct: 8 });
  const originals = await page.evaluate(() =>
    (window as any).__photos.map((b: Blob) => b.size),
  );
  await addPhotos(page, 40);
  await expect(page.locator(".thumb")).toHaveCount(40, { timeout: 180_000 });
  await expect(page.getByRole("status").first()).toContainText(
    "Saved on this device",
  );
  const db = await inspectDb(page);
  expect(db.version).toBe(5);
  expect(db.counts).toMatchObject({
    masters: 40,
    thumbs: 40,
    originals: 0,
    analysis: 0,
    photos: 0,
    assets: 0,
  });
  // Masters: at most 2000 px, about 0.9 MB or less.
  const [w, h] = await dims(page, await masterBase64(page, 0));
  expect([w, h]).toEqual([2000, 1500]);
  expect(Math.max(...db.masterSizes)).toBeLessThanOrEqual(900 * 1024);
  const avgMaster = db.masterSizes.reduce((a, b) => a + b, 0) / 40;
  const avgOriginal =
    originals.reduce((a: number, b: number) => a + b, 0) / originals.length;
  console.log(
    `[measure] original ${(avgOriginal / MB).toFixed(2)} MB → master ${(avgMaster / MB).toFixed(2)} MB avg (min ${(Math.min(...db.masterSizes) / MB).toFixed(2)}, max ${(Math.max(...db.masterSizes) / MB).toFixed(2)}); Chrome usage ${((await realUsage(page)) / MB).toFixed(1)} MB for 40 photos`,
  );
  // The workspace holds metadata only.
  expect(db.workspace).not.toMatch(/data:image|;base64,/);
  // The meter: real usage and photo count; never Chrome's padded quota.
  await expect(meter(page).locator(":scope > summary")).toContainText(
    /Photo storage: [\d.]+ MB used · 40 photos/,
  );
  await openMeter(page);
  await expect(meter(page)).toContainText(
    "Practical limit: about 300 MB (assumed",
  );
  await expect(meter(page)).toContainText(
    /Safe room for about \d+ more photos/,
  );
  const text = await meter(page).innerText();
  expect(text).not.toMatch(/10 GB available|GB available|thousand/);
  const room = Number(/Safe room for about (\d+)/.exec(text)![1]);
  expect(room).toBeGreaterThan(200);
  expect(room).toBeLessThan(500);

  // Reload: every photo and preview restores from storage.
  const firstSrc = await page.locator(".thumb img").first().getAttribute("src");
  await page.reload();
  await expect(page.locator(".thumb")).toHaveCount(40, { timeout: 60_000 });
  expect(
    await page
      .locator(".thumb img")
      .first()
      .evaluate((i) => (i as HTMLImageElement).naturalWidth),
  ).toBeGreaterThan(0);
  // Removing a photo deletes its stored data and revokes its preview URL.
  const shownSrc = await page.locator(".thumb img").first().getAttribute("src");
  await page.getByRole("button", { name: "Remove photo" }).first().click();
  await expect(page.locator(".thumb")).toHaveCount(39);
  await expect
    .poll(async () => (await inspectDb(page)).counts.masters)
    .toBe(39);
  for (const url of [firstSrc, shownSrc]) {
    const revoked = await page.evaluate(async (url) => {
      try {
        await fetch(url!);
        return false;
      } catch {
        return true;
      }
    }, url);
    expect(revoked).toBe(true);
  }
});

test("eBay receives the exact master bytes; AI gets 1024 px on demand; orientation is kept", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await setup(page);
  const analysisImages: string[] = [];
  const uploaded: string[] = [];
  await page.route("**/api/analyze", (r) => {
    analysisImages.push(
      ...r
        .request()
        .postDataJSON()
        .images.map((i: any) => i.data),
    );
    return r.fulfill({
      json: {
        ok: true,
        listing: {
          title: "Nike Mens Shorts",
          description: "Shorts.",
          brand: "Nike",
          item_type: "Shorts",
          condition: "GOOD",
          suggested_price: 20,
          item_specifics: { Brand: "Nike" },
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
    r.fulfill({ json: { success: true, listingId: "1234567890" } }),
  );
  await makePhotos(page, { distinct: 1 });
  const landscape = await page.evaluate(async () => {
    const bytes = new Uint8Array(
      await (window as any).__photos[0].arrayBuffer(),
    );
    let s = "";
    for (let j = 0; j < bytes.length; j += 0x8000)
      s += String.fromCharCode(...bytes.subarray(j, j + 0x8000));
    return btoa(s);
  });
  await page.locator("input[type=file]").setInputFiles([
    {
      name: "front.jpg",
      mimeType: "image/jpeg",
      buffer: Buffer.from(landscape, "base64"),
    },
    {
      name: "portrait.jpg",
      mimeType: "image/jpeg",
      buffer: await exifPortrait(page),
    },
  ]);
  await expect(page.locator(".thumb")).toHaveCount(2, { timeout: 60_000 });
  await expect(page.getByRole("status").first()).toContainText(
    "Saved on this device",
  );
  // Orientation: the portrait shot is stored upright.
  const masters = [await masterBase64(page, 0), await masterBase64(page, 1)];
  expect(await dims(page, masters[0])).toEqual([2000, 1500]);
  expect(await dims(page, masters[1])).toEqual([1500, 2000]);
  const thumbDims = await page
    .locator(".thumb img")
    .evaluateAll((imgs) =>
      imgs.map((i) => [
        (i as HTMLImageElement).naturalWidth,
        (i as HTMLImageElement).naturalHeight,
      ]),
    );
  expect(thumbDims).toEqual([
    [360, 270],
    [270, 360],
  ]);

  await page.getByRole("button", { name: "These photos are one item" }).click();
  await page.getByRole("button", { name: /Write.*listing/i }).click();
  await expect(page.getByText("Shorts", { exact: true })).toBeVisible();
  // AI: 1024 px images made from the masters (never stored).
  expect(await dims(page, analysisImages[0])).toEqual([1024, 768]);
  expect(await dims(page, analysisImages[1])).toEqual([768, 1024]);
  expect((await inspectDb(page)).counts.analysis).toBe(0);
  await expect(page.locator(".title-input")).toHaveValue("Nike Mens Shorts");

  await page.getByLabel("SKU", { exact: true }).fill("A-1013");
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
  await expect.poll(() => uploaded.length, { timeout: 60_000 }).toBe(2);
  // eBay receives the stored master bytes exactly — compressed only once.
  expect(uploaded).toEqual(masters);
  expect(uploaded.every((u) => u.length <= 2_700_000)).toBe(true);

  // Release photos of the posted item: masters go, thumbnails and the
  // listing stay.
  await expect(page.getByText("Posted to eBay").first()).toBeVisible({
    timeout: 30_000,
  });
  await openMeter(page);
  let message = "";
  page.once("dialog", (d) => {
    message = d.message();
    return d.accept();
  });
  await page
    .getByRole("button", { name: "Release 2 photos of posted items" })
    .click();
  await expect(meter(page)).toContainText("Released 2 photos of posted items.");
  expect(message).toContain(
    "eBay keeps its own copies of these listing photos",
  );
  expect(message).toContain("you may need to add its source photos again");
  expect(message).toContain("Unpublished items are never touched.");
  await expect
    .poll(async () => (await inspectDb(page)).counts)
    .toMatchObject({
      masters: 0,
      thumbs: 2,
    });
  await page.reload();
  await expect(page.locator(".title-input")).toHaveValue("Nike Mens Shorts");
  await expect(
    page.getByRole("button", { name: /Release .* photos? of posted items/ }),
  ).toHaveCount(0);
});

test("a genuine QuotaExceededError mid-import: every photo accounted for, limit learned and kept after reload", async ({}, info) => {
  test.setTimeout(300_000);
  // Chrome's limit has room for about 6 phone photos — far below the app's
  // 300 MB assumption, as on the seller's computer.
  const perPhoto = 0.62 * MB;
  const s = await session(
    info,
    info.outputPath("profile"),
    6.5 * perPhoto + 200 * 1024,
  );
  const { page } = s;
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await openApp(page);
  await makePhotos(page, { distinct: 6 });
  await addPhotos(page, 34);
  const alert = page
    .getByRole("alert")
    .filter({ hasText: /Added \d+ of 34 photos/ });
  await expect(alert).toBeVisible({ timeout: 180_000 });
  const summary = await alert.innerText();
  const m =
    /Added (\d+) of 34 photos\. (\d+) were not added because browser storage is full\./.exec(
      summary,
    );
  expect(m, summary).not.toBeNull();
  const added = Number(m![1]);
  expect(added + Number(m![2])).toBe(34);
  console.log(
    `[measure] real quota error: ${summary.split(" To make room")[0]}`,
  );
  expect(added).toBeGreaterThanOrEqual(4);
  expect(added).toBeLessThanOrEqual(9);
  await expect(page.locator(".thumb")).toHaveCount(added);
  expect((await inspectDb(page)).counts.masters).toBe(added);
  expect(
    errors.some(
      (e) =>
        /\[photo import\] Browser storage is full/.test(e) &&
        /QuotaExceededError/.test(e),
    ),
  ).toBe(true);
  // The genuine failure was learned.
  const record = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("listing-writer-storage-limit")!),
  );
  expect(record.learned.bytes).toBeGreaterThan(0);
  expect(record.failures[0].context).toBe("photo import");

  // Reload: the learned limit is still in force; the meter never shows the
  // padded quota as available space.
  await page.reload();
  await expect(page.locator(".thumb")).toHaveCount(added, { timeout: 60_000 });
  await openMeter(page);
  // Learned from the error — or raised a little by a later successful save
  // just above it (also real evidence).
  await expect(meter(page)).toContainText(
    /Practical limit on this computer: about [\d.]+ MB — (learned on .* from a real "storage full" error|raised on .* after a successful save above the earlier learned limit)\./,
  );
  await expect(meter(page)).toContainText("No safe room for more photos");
  expect(await meter(page).innerText()).not.toMatch(/GB available|10 GB/);
  // Technical details show Chrome's own figures, labelled as unreliable.
  await meter(page)
    .locator(".storage-technical")
    .evaluate((d) => ((d as HTMLDetailsElement).open = true));
  await expect(meter(page)).toContainText(
    "Chrome pads this figure; it is not a real limit",
  );
  await expect(meter(page)).toContainText(
    /Storage-full errors: [\d.]+ MB on .* \(photo import\)/,
  );

  // A new selection is refused up front with an exact count.
  await makePhotos(page, { distinct: 1, w: 800, h: 600, texture: 0 });
  await addPhotos(page, 3, "LATER");
  await expect(
    page.getByRole("alert").filter({ hasText: "Added 0 of 3 photos" }),
  ).toContainText(
    "3 were not added because the safe storage limit on this computer was reached",
  );
  // Removing photos frees space; autosave keeps working.
  for (let i = 0; i < 2; i++)
    await page.getByRole("button", { name: "Remove photo" }).first().click();
  await expect(page.getByRole("status").first()).toContainText(
    "Saved on this device",
  );
  await s.ctx.close();
});

test("autosave at the limit: a classified, learned error, and recovery once a photo is removed", async ({}, info) => {
  test.setTimeout(240_000);
  const s = await session(info, info.outputPath("profile"), 40 * MB);
  const { page } = s;
  await openApp(page);
  await makePhotos(page, { distinct: 3 });
  await addPhotos(page, 3);
  await expect(page.locator(".thumb")).toHaveCount(3, { timeout: 60_000 });
  await expect(page.getByRole("status").first()).toContainText(
    "Saved on this device",
  );
  // Something else fills the rest of the site's storage to the brim.
  await fillUp(page);
  await page.getByRole("button", { name: "These photos are one item" }).click();
  await expect(page.getByRole("status").first()).toContainText(
    "Could not save: browser storage is full",
    { timeout: 30_000 },
  );
  const record = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("listing-writer-storage-limit")!),
  );
  expect(record.failures.at(-1).context).toBe("autosave");
  await page.getByRole("button", { name: "← Back to photos" }).click();
  // Removing a photo frees its master; the waiting save goes through.
  await page.getByRole("button", { name: "Remove photo" }).first().click();
  await expect(page.getByRole("status").first()).toContainText(
    "Saved on this device",
    {
      timeout: 30_000,
    },
  );
  await s.ctx.close();
});

// The seller's database: version 4, full-size originals + 1024 px analysis
// copies + thumbnails, with listing data.
async function seedV4(
  page: Page,
  count: number,
  {
    analysis = true,
    step = "review",
    listed = count,
  }: { analysis?: boolean; step?: string; listed?: number } = {},
) {
  await page.goto("/privacy");
  await makePhotos(page, { distinct: Math.min(count, 4), texture: 10 });
  await page.evaluate(
    async ({ count, analysis, step, listed }) => {
      await new Promise<void>((resolve) => {
        const d = indexedDB.deleteDatabase("listing-writer-drafts");
        d.onsuccess = d.onerror = d.onblocked = () => resolve();
      });
      const photos: Blob[] = (window as any).__photos;
      const resized = async (b: Blob, dim: number, q: number) => {
        const bmp = await createImageBitmap(b);
        const s = Math.min(1, dim / Math.max(bmp.width, bmp.height));
        const c = document.createElement("canvas");
        c.width = Math.round(bmp.width * s);
        c.height = Math.round(bmp.height * s);
        c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
        return new Promise<Blob>((r) =>
          c.toBlob((x) => r(x!), "image/jpeg", q),
        );
      };
      const small = await Promise.all(
        photos.map(async (p) => ({
          analysis: await resized(p, 1024, 0.82),
          thumb: await resized(p, 360, 0.5),
        })),
      );
      const db: IDBDatabase = await new Promise((resolve, reject) => {
        const r = indexedDB.open("listing-writer-drafts", 4);
        r.onupgradeneeded = () => {
          for (const s of [
            "workspace",
            "photos",
            "assets",
            "originals",
            "analysis",
            "thumbs",
          ])
            r.result.createObjectStore(s);
        };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      const ids = Array.from({ length: count }, (_, i) => `v4-${i}`);
      for (let i = 0; i < count; i++) {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(
            ["originals", "analysis", "thumbs"],
            "readwrite",
          );
          // A distinct original per photo (copies of the generated images).
          tx.objectStore("originals").put(
            new Blob([photos[i % photos.length]], { type: "image/jpeg" }),
            ids[i],
          );
          if (analysis)
            tx.objectStore("analysis").put(
              small[i % photos.length].analysis,
              ids[i],
            );
          tx.objectStore("thumbs").put(small[i % photos.length].thumb, ids[i]);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      }
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("workspace", "readwrite");
        tx.objectStore("workspace").put(
          {
            version: 2,
            // The last saves may have failed: only `listed` are recorded.
            photos: ids.slice(0, listed).map((id, i) => ({
              id,
              mediaType: "image/jpeg",
              name: `IMG_${i}.jpg`,
              size: photos[i % photos.length].size,
            })),
            groups: [
              {
                id: "g",
                sku: "A-1013",
                skuSource: "seller",
                name: "red-shorts",
                photoIds: ids.slice(0, listed),
                status: "idle",
              },
            ],
            orphanIds: [],
            binPrefix: "",
            skuStart: 0,
            step,
            updatedAt: 1,
          },
          "current",
        );
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    { count, analysis, step, listed },
  );
}

test("the version-4 database converts while already full: masters verified before originals are deleted", async ({}, info) => {
  test.setTimeout(300_000);
  const dir = info.outputPath("profile");
  // The seller's old database, then a Chrome restart with the site full.
  let s = await session(info, dir);
  await seedV4(s.page, 16);
  const before = await s.usage();
  await s.ctx.close();
  s = await session(info, dir, before + 64 * 1024);
  const { page } = s;
  const info2: string[] = [];
  page.on("console", (m) => info2.push(m.text()));
  await openApp(page);
  await expect
    .poll(async () => (await inspectDb(page)).counts, { timeout: 180_000 })
    .toMatchObject({ masters: 16, thumbs: 16, originals: 0, analysis: 0 });
  await expect
    .poll(() => s.usage(), { timeout: 60_000 })
    .toBeLessThan(before * 0.4);
  const after = await s.usage();
  console.log(
    `[measure] conversion while full: ${(before / MB).toFixed(1)} MB → ${(after / MB).toFixed(1)} MB for 16 photos`,
  );
  expect(info2.some((t) => /\[storage\] converted 16 photos/.test(t))).toBe(
    true,
  );
  // Listing data is untouched; every photo shows.
  await expect(
    page.getByLabel("Item SKU / bin code", { exact: true }),
  ).toHaveValue("A-1013");
  await expect(page.locator(".board-item img")).toHaveCount(16);
  const db = await inspectDb(page);
  expect(db.version).toBe(5);
  expect(JSON.parse(db.workspace).groups[0]).toMatchObject({
    sku: "A-1013",
    skuSource: "seller",
  });
  const [w, h] = await dims(page, await masterBase64(page, 0));
  expect(Math.max(w, h)).toBe(2000);
  // After a further restart everything is still there.
  await s.ctx.close();
  s = await session(info, dir, before + 64 * 1024);
  await openApp(s.page);
  await expect(s.page.locator(".board-item img")).toHaveCount(16);
  await s.ctx.close();
});

test("the seller's exact state: full storage, failed last autosave — every stored photo is kept, then converted", async ({}, info) => {
  test.setTimeout(300_000);
  const dir = info.outputPath("profile");
  // 12 photos stored, but the last autosave failed: the saved batch lists 10
  // (on the seller's computer: 91 stored, 85 listed, about 311 MB, full).
  let s = await session(info, dir);
  await seedV4(s.page, 12, { step: "upload", listed: 10 });
  const full = await s.usage();
  await s.ctx.close();
  s = await session(info, dir, full + 64 * 1024);
  const { page } = s;
  const logs: string[] = [];
  page.on("console", (m) => logs.push(m.text()));
  await openApp(page);
  // All 12 are shown; the 2 unrecorded ones were added back, not deleted.
  await expect(page.locator(".thumb")).toHaveCount(12);
  await expect(meter(page)).toContainText(
    '2 saved photos were missing from your batch (for example after a "storage full" error) and have been added back. Remove any you do not need.',
  );
  expect(
    logs.some((t) =>
      /\[storage\] restored 2 saved photos missing from the batch/.test(t),
    ),
  ).toBe(true);
  expect(logs.some((t) => /removed \d+ unused photo records/.test(t))).toBe(
    false,
  );
  await expect
    .poll(async () => (await inspectDb(page)).counts, { timeout: 180_000 })
    .toMatchObject({ masters: 12, thumbs: 12, originals: 0, analysis: 0 });
  await expect(page.getByRole("status").first()).toContainText(
    "Saved on this device",
  );
  await expect
    .poll(() => s.usage(), { timeout: 60_000 })
    .toBeLessThan(full * 0.4);
  console.log(
    `[measure] seller's state: ${(full / MB).toFixed(1)} MB full → ${((await s.usage()) / MB).toFixed(1)} MB, 12 of 12 photos kept`,
  );
  // A restart: the batch now lists all 12 and nothing is pending.
  await s.ctx.close();
  s = await session(info, dir, full + 64 * 1024);
  await openApp(s.page);
  await expect(s.page.locator(".thumb")).toHaveCount(12);
  expect(JSON.parse((await inspectDb(s.page)).workspace).photos).toHaveLength(
    12,
  );
  expect((await inspectDb(s.page)).counts.pending).toBe(0);
  await s.ctx.close();
});

// The exact version-3 data this branch stored before the storage rebuild,
// written the way its resizeImage + savePhoto did: "photos" holds the 1024 px
// base64 analysis image and a 360 px data-URL preview; "assets" holds the
// selected File itself and a 2400 px q0.9 base64 upload copy. The workspace
// (version 1) lists `listed` of them: its autosaves failed.
async function seedV3Unlisted(page: Page, names: string[], listed = 0) {
  await page.goto("/privacy");
  await makePhotos(page, { distinct: 4, texture: 10 });
  await page.evaluate(
    async ({ names, listed }) => {
      await new Promise<void>((resolve) => {
        const d = indexedDB.deleteDatabase("listing-writer-drafts");
        d.onsuccess = d.onerror = d.onblocked = () => resolve();
      });
      const photos: Blob[] = (window as any).__photos;
      const dataUrl = async (b: Blob, dim: number, q: number) => {
        const bmp = await createImageBitmap(b);
        const s = Math.min(1, dim / Math.max(bmp.width, bmp.height));
        const c = document.createElement("canvas");
        c.width = Math.round(bmp.width * s);
        c.height = Math.round(bmp.height * s);
        c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
        return c.toDataURL("image/jpeg", q);
      };
      const copies = await Promise.all(
        photos.map(async (p) => ({
          data: (await dataUrl(p, 1024, 0.82)).split(",")[1],
          previewUrl: await dataUrl(p, 360, 0.5),
          uploadData: (await dataUrl(p, 2400, 0.9)).split(",")[1],
        })),
      );
      const db: IDBDatabase = await new Promise((resolve, reject) => {
        const r = indexedDB.open("listing-writer-drafts", 3);
        r.onupgradeneeded = () => {
          for (const s of ["workspace", "photos", "assets"])
            r.result.createObjectStore(s);
        };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      // Random ids, stored in an order unrelated to the photo order.
      const entries = names
        .map((name, i) => ({ id: crypto.randomUUID(), name, i }))
        .sort((a, b) => a.id.localeCompare(b.id));
      for (const e of entries) {
        const k = e.i % photos.length;
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(["photos", "assets"], "readwrite");
          tx.objectStore("photos").put(
            {
              id: e.id,
              mediaType: "image/jpeg",
              data: copies[k].data,
              previewUrl: copies[k].previewUrl,
            },
            e.id,
          );
          tx.objectStore("assets").put(
            {
              original: new File([photos[k]], e.name, { type: "image/jpeg" }),
              uploadData: copies[k].uploadData,
            },
            e.id,
          );
          tx.oncomplete = () => resolve();
          tx.onabort = tx.onerror = () => reject(tx.error);
        });
      }
      const listedIds = entries
        .filter((e) => e.i < listed)
        .map((e) => ({ id: e.id }));
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("workspace", "readwrite");
        tx.objectStore("workspace").put(
          {
            version: 1,
            photos: listedIds,
            groups: [],
            orphanIds: [],
            binPrefix: "",
            skuStart: 0,
            step: "upload",
            updatedAt: Date.now(),
          },
          "current",
        );
        tx.oncomplete = () => resolve();
        tx.onabort = tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    { names, listed },
  );
}

test("the seller's port-3001 state: 44 version-3 photos, workspace lists none — all recovered in order, converted, nothing lost", async ({}, info) => {
  test.setTimeout(600_000);
  const dir = info.outputPath("profile");
  const names = Array.from(
    { length: 44 },
    (_, i) => `20261007_${String(114100 + i * 7).padStart(6, "0")}.jpg`,
  );
  let s = await session(info, dir);
  await seedV3Unlisted(s.page, names);
  const before = await inspectDb(s.page);
  expect(before.version).toBe(3);
  expect(before.counts).toMatchObject({ photos: 44, assets: 44 });
  expect(JSON.parse(before.workspace).photos).toEqual([]);
  const oldUsage = await s.usage();
  const logs: string[] = [];
  s.page.on("console", (m) => logs.push(m.text()));
  await openApp(s.page);
  const { page } = s;
  // All 44 are back in the batch; none was deleted.
  await expect(page.locator(".thumb")).toHaveCount(44);
  await expect(meter(page)).toContainText(
    '44 saved photos were missing from your batch (for example after a "storage full" error) and have been added back. Remove any you do not need.',
  );
  expect(logs.some((t) => /removed \d+ unused photo records/.test(t))).toBe(
    false,
  );
  await expect(
    page.getByRole("button", { name: /Sort 44 photos into items/ }),
  ).toBeVisible();
  // Converted one by one: a master and thumbnail each; old data removed.
  await expect
    .poll(async () => (await inspectDb(page)).counts, { timeout: 480_000 })
    .toMatchObject({ masters: 44, thumbs: 44, photos: 0, assets: 0 });
  const after = await inspectDb(page);
  expect(after.version).toBe(5);
  expect(Math.max(...after.masterSizes)).toBeLessThanOrEqual(900 * 1024);
  // The autosave lists all 44, in camera file-name order.
  await expect(page.getByRole("status").first()).toContainText(
    "Saved on this device",
  );
  await expect
    .poll(async () =>
      JSON.parse((await inspectDb(page)).workspace).photos.map(
        (p: { name?: string }) => p.name,
      ),
    )
    .toEqual(names);
  await expect
    .poll(() => s.usage(), { timeout: 60_000 })
    .toBeLessThan(oldUsage * 0.5);
  console.log(
    `[measure] 44 version-3 photos: ${(oldUsage / MB).toFixed(1)} MB → ${((await s.usage()) / MB).toFixed(1)} MB, 44 of 44 kept`,
  );
  // A restart keeps all 44; nothing is adopted or removed again.
  await s.ctx.close();
  s = await session(info, dir);
  const restartLogs: string[] = [];
  s.page.on("console", (m) => restartLogs.push(m.text()));
  await openApp(s.page);
  await expect(s.page.locator(".thumb")).toHaveCount(44);
  expect(
    restartLogs.some((t) =>
      /restored \d+ saved photos|removed \d+ unused/.test(t),
    ),
  ).toBe(false);
  expect((await inspectDb(s.page)).counts.pending).toBe(0);
  await s.ctx.close();
});

test("with no working space at all, conversion pauses with instructions and resumes after a photo is removed", async ({}, info) => {
  test.setTimeout(300_000);
  const dir = info.outputPath("profile");
  let s = await session(info, dir);
  await seedV4(s.page, 6, { analysis: false, step: "upload" });
  const full = await s.usage();
  await s.ctx.close();
  s = await session(info, dir, full);
  const { page } = s;
  await openApp(page);
  await expect(page.locator(".thumb")).toHaveCount(6);
  const note = page
    .getByRole("alert")
    .filter({ hasText: "Photo conversion paused" });
  await expect(note).toBeVisible({ timeout: 60_000 });
  await expect(note).toContainText(
    "browser storage is full. 6 photos still use the older, larger format and remain fully usable — nothing was deleted. To continue, remove a few photos you no longer need",
  );
  await expect(note).toContainText("Do not clear site data.");
  expect((await inspectDb(page)).counts.originals).toBe(6);
  // Every photo stays usable while paused.
  expect(
    await page
      .locator(".thumb img")
      .first()
      .evaluate((i) => (i as HTMLImageElement).naturalWidth),
  ).toBeGreaterThan(0);
  // The seller removes one photo: conversion resumes by itself.
  await page.getByRole("button", { name: "Remove photo" }).first().click();
  await expect
    .poll(async () => (await inspectDb(page)).counts, { timeout: 180_000 })
    .toMatchObject({ masters: 5, originals: 0 });
  await expect(note).toBeHidden();
  await expect(page.locator(".thumb")).toHaveCount(5);
  await s.ctx.close();
});

test("a second tab does not convert or write", async ({ page, context }) => {
  test.setTimeout(120_000);
  await routes(page);
  await seedV4(page, 2);
  await page.goto("/");
  await expect(page.getByText("Restoring saved work…")).toBeHidden();
  const second = await context.newPage();
  await routes(second);
  await second.goto("/");
  await expect(second.getByText("already open in another tab")).toBeVisible();
  await expect
    .poll(async () => (await inspectDb(page)).counts, { timeout: 60_000 })
    .toMatchObject({ masters: 2, originals: 0 });
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
  await expect(meter(page).locator(":scope > summary")).toContainText(
    "this browser does not report usage",
  );
  await makePhotos(page, { distinct: 1, w: 800, h: 600, texture: 0 });
  await addPhotos(page, 3);
  await expect(page.locator(".thumb")).toHaveCount(3);
  await expect(page.getByRole("status").first()).toContainText(
    "Saved on this device",
  );
  await openMeter(page);
  await expect(meter(page)).toContainText("has not granted persistent storage");
});

test("stress: 400 phone photos against a ~311 MB Chrome limit", async ({}, info) => {
  test.setTimeout(1_800_000);
  const s = await session(info, info.outputPath("profile"), 311 * MB);
  const { page } = s;
  await openApp(page);
  const dialogs: string[] = [];
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    return d.accept();
  });
  const consoleErrors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  await makePhotos(page, { distinct: 8 });
  const started = Date.now();
  await addPhotos(page, 400);
  // The plan (assumed 300 MB, typical 0.93 MB per photo) asks first.
  await expect.poll(() => dialogs.length, { timeout: 60_000 }).toBe(1);
  const planned = Number(
    /Only about (\d+) of these 400 photos fit safely/.exec(dialogs[0])![1],
  );
  expect(planned).toBeGreaterThan(250);
  const first = page
    .getByRole("alert")
    .filter({ hasText: /Added \d+ of 400 photos/ });
  await expect(first).toBeVisible({ timeout: 1_200_000 });
  const firstText = await first.innerText();
  const added = Number(/Added (\d+) of 400/.exec(firstText)![1]);
  expect(firstText).toContain(
    `${400 - added} were not added because the safe storage limit`,
  );
  expect(added).toBe(planned);
  await expect(page.locator(".thumb")).toHaveCount(added);
  await expect(page.getByRole("status").first()).toContainText(
    "Saved on this device",
  );
  // Top up: the plan now uses the real average stored photo size, shown as
  // the safe room left; ask for 40 more than that.
  await openMeter(page);
  // The meter refreshes its photo statistics after the import; use its
  // settled figure (the same reading on two checks a second apart).
  let room = -1;
  await expect
    .poll(
      async () => {
        const now = Number(
          /Safe room for about (\d+) more photo/.exec(
            await meter(page).innerText(),
          )?.[1],
        );
        const settled = now === room;
        room = now;
        return settled;
      },
      { intervals: [1_000], timeout: 60_000 },
    )
    .toBe(true);
  const extra = room + 40;
  await addPhotos(page, extra, "TOPUP");
  await expect.poll(() => dialogs.length, { timeout: 60_000 }).toBe(2);
  expect(dialogs[1]).toContain(
    `Only about ${room} of these ${extra} photos fit safely`,
  );
  const second = page
    .getByRole("alert")
    .filter({ hasText: new RegExp(`Added \\d+ of ${extra} photos`) });
  await expect(second).toBeVisible({ timeout: 600_000 });
  // Every photo accounted for; the per-photo reserve check during import may
  // stop one photo earlier than the plan's estimate, never later.
  const m2 =
    /Added (\d+) of (\d+) photos\. (\d+) were not added because the safe storage limit/.exec(
      await second.innerText(),
    )!;
  expect(Number(m2[1]) + Number(m2[3])).toBe(extra);
  expect(Number(m2[1])).toBeGreaterThanOrEqual(room - 2);
  expect(Number(m2[1])).toBeLessThanOrEqual(room);
  const total = await page.locator(".thumb").count();
  const usage = await s.usage();
  const seconds = (Date.now() - started) / 1000;
  const db = await inspectDb(page);
  const avg = db.masterSizes.reduce((a, b) => a + b, 0) / db.masterSizes.length;
  console.log(
    `[measure] stress: ${total} photos stored, Chrome usage ${(usage / MB).toFixed(1)} MB, master avg ${(avg / MB).toFixed(2)} MB, ${seconds.toFixed(0)} s; 1st plan ${planned}/400, 2nd: ${(await second.innerText()).split(" To make room")[0]}`,
  );
  // Never reached Chrome's limit: the reserve was kept for saving.
  expect(usage).toBeLessThan(300 * MB - 24 * MB);
  expect(total).toBeGreaterThan(300);
  expect(consoleErrors.filter((e) => /QuotaExceededError/.test(e))).toEqual([]);
  // Listing edits still save.
  await page.getByRole("button", { name: "Remove photo" }).first().click();
  await expect(page.getByRole("status").first()).toContainText(
    "Saved on this device",
  );
  // Memory stays bounded; previews are object URLs, one per photo.
  const heap = await page.evaluate(
    () => (performance as any).memory?.usedJSHeapSize ?? 0,
  );
  console.log(
    `[measure] JS heap with ${total - 1} photos: ${(heap / MB).toFixed(0)} MB`,
  );
  expect(heap).toBeLessThan(250 * MB);
  const srcs = await page
    .locator(".thumb img")
    .evaluateAll((imgs) => imgs.map((i) => (i as HTMLImageElement).src));
  expect(srcs.every((x) => x.startsWith("blob:"))).toBe(true);
  expect(new Set(srcs).size).toBe(total - 1);
  // A restart restores every photo.
  await s.ctx.close();
  const again = await session(info, info.outputPath("profile"), 311 * MB);
  await openApp(again.page);
  await expect(again.page.locator(".thumb")).toHaveCount(total - 1, {
    timeout: 180_000,
  });
  await again.ctx.close();
});
