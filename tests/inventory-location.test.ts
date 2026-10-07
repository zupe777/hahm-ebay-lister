import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// The eBay connection is mocked; the route, validation and eBay helper are real.
const session = vi.hoisted(() => ({ token: "seller-token" as string | null }));
vi.mock("@/lib/ebay/session", async (orig) => ({
  ...(await orig<typeof import("@/lib/ebay/session")>()),
  accessTokenFromCookie: async () => session.token,
}));

import {
  createInventoryLocation,
  inventoryLocationBody,
} from "@/lib/ebay/publish";
import { inventoryLocationSchema, locationKeyFrom } from "@/lib/validation";
import { POST } from "@/app/api/ebay/location/route";

const input = {
  merchantLocationKey: "zupe-hq-home",
  name: "Zupe HQ Home",
  addressLine1: "123 Example St",
  city: "Springfield",
  stateOrProvince: "ut",
  postalCode: "84095",
};
const fetchMock = vi.fn();
let ip = 0;
const post = (body: unknown) =>
  new NextRequest("https://test.example/api/ebay/location", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-app-secret": "test-secret",
      "x-forwarded-for": `10.1.0.${++ip}`,
    },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.stubEnv("APP_SECRET", "test-secret");
  session.token = "seller-token";
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("shipping origin (eBay inventory location)", () => {
  it("creates an enabled US warehouse at the seller's address", async () => {
    await createInventoryLocation(
      "seller-token",
      inventoryLocationSchema.parse(input),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://api.ebay.com/sell/inventory/v1/location/zupe-hq-home",
    );
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer seller-token");
    expect(JSON.parse(init.body)).toEqual({
      name: "Zupe HQ Home",
      merchantLocationStatus: "ENABLED",
      locationTypes: ["WAREHOUSE"],
      location: {
        address: {
          addressLine1: "123 Example St",
          city: "Springfield",
          stateOrProvince: "UT",
          postalCode: "84095",
          country: "US",
        },
      },
    });
  });

  it("sends address line 2 only when given", () => {
    const withLine2 = inventoryLocationBody(
      inventoryLocationSchema.parse({ ...input, addressLine2: "Unit 4" }),
    );
    expect(withLine2.location.address).toMatchObject({
      addressLine2: "Unit 4",
    });
    expect(
      inventoryLocationBody(inventoryLocationSchema.parse(input)).location
        .address,
    ).not.toHaveProperty("addressLine2");
  });

  it("explains an existing key and passes on other eBay errors", async () => {
    const parsed = inventoryLocationSchema.parse(input);
    fetchMock.mockResolvedValueOnce(
      Response.json(
        { errors: [{ errorId: 25803, message: "Location already exists." }] },
        { status: 409 },
      ),
    );
    await expect(createInventoryLocation("t", parsed)).rejects.toThrow(
      'An eBay location with the key "zupe-hq-home" already exists.',
    );
    fetchMock.mockResolvedValueOnce(
      Response.json(
        { errors: [{ errorId: 25802, message: "Invalid postal code." }] },
        { status: 400 },
      ),
    );
    await expect(createInventoryLocation("t", parsed)).rejects.toThrow(
      "eBay could not create the shipping origin (eBay error 25802): Invalid postal code.",
    );
  });

  it("validates the key and address before calling eBay", () => {
    for (const bad of [
      { merchantLocationKey: "" },
      { merchantLocationKey: "has spaces" },
      { merchantLocationKey: "x".repeat(37) },
      { name: " " },
      { addressLine1: "" },
      { city: "" },
      { stateOrProvince: "Utah" },
      { postalCode: "8409" },
    ])
      expect(
        inventoryLocationSchema.safeParse({ ...input, ...bad }).success,
      ).toBe(false);
    expect(inventoryLocationSchema.safeParse(input).success).toBe(true);
  });

  it("suggests a stable, readable location key from the name", () => {
    expect(locationKeyFrom("Zupe HQ Home")).toBe("zupe-hq-home");
    expect(locationKeyFrom("  Main St. Warehouse #2 ")).toBe(
      "main-st-warehouse-2",
    );
    expect(locationKeyFrom("a".repeat(50))).toHaveLength(36);
  });
});

describe("/api/ebay/location", () => {
  it("creates the location with the connected eBay account", async () => {
    const res = await POST(post(input));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      merchantLocationKey: "zupe-hq-home",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("asks to connect eBay when there is no eBay session", async () => {
    session.token = null;
    const res = await POST(post(input));
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid address without calling eBay", async () => {
    const res = await POST(post({ ...input, postalCode: "abc" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Enter a 5-digit ZIP code.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires the app access code", async () => {
    const req = new NextRequest("https://test.example/api/ebay/location", {
      method: "POST",
      headers: { "x-forwarded-for": "10.1.1.1" },
      body: JSON.stringify(input),
    });
    expect((await POST(req)).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports an eBay failure", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json(
        { errors: [{ errorId: 25802, message: "Invalid postal code." }] },
        { status: 400 },
      ),
    );
    const res = await POST(post(input));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/Invalid postal code/);
  });
});
