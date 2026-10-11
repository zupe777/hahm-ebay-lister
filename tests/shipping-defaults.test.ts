import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyShippingDefaults,
  checkDefaults,
  defaultsPatch,
  defaultsStorageKey,
  loadSellerDefaults,
  saveSellerDefaults,
  sellerShippingChoice,
  type SellerDefaults,
} from "@/lib/shipping-defaults";
import { shippingSchema } from "@/lib/validation";
import type { ItemGroup } from "@/lib/types";

function stubLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
  });
}

const options = {
  fulfillment: [
    { id: "ship-795", name: "Zippadoo Clothing Shipping $7.95" },
    { id: "heavy", name: "Heavy shipping" },
  ],
  payment: [{ id: "pay-1", name: "Zippadoo Payment Policy" }],
  returns: [{ id: "ret-1", name: "Zippadoo Refund Policy" }],
  locations: [
    { id: "zupe-hq", name: "Zupe HQ · 84095 · US" },
    { id: "garage", name: "Garage · 84095 · US" },
  ],
};
const saved: SellerDefaults = {
  fulfillmentPolicyId: {
    id: "ship-795",
    name: "Zippadoo Clothing Shipping $7.95",
  },
  paymentPolicyId: { id: "pay-1", name: "Zippadoo Payment Policy" },
  returnPolicyId: { id: "ret-1", name: "Zippadoo Refund Policy" },
  locationKey: { id: "zupe-hq", name: "Zupe HQ · 84095 · US" },
};
const all = {
  fulfillmentPolicyId: "ship-795",
  paymentPolicyId: "pay-1",
  returnPolicyId: "ret-1",
  locationKey: "zupe-hq",
};

describe("saved defaults fill blank fields only, by eBay ID", () => {
  it("fills all four blank fields from the saved IDs", () => {
    expect(applyShippingDefaults({}, options, saved)).toEqual(all);
  });

  it("never overwrites a chosen value and keeps package details", () => {
    expect(
      applyShippingDefaults(
        { fulfillmentPolicyId: "heavy", weightOz: 12 },
        options,
        saved,
      ),
    ).toEqual({ ...all, fulfillmentPolicyId: "heavy", weightOz: 12 });
  });

  it("leaves intentional blanks blank", () => {
    expect(
      applyShippingDefaults({ returnPolicyId: "" }, options, saved, [
        "returnPolicyId",
      ]),
    ).toEqual({ ...all, returnPolicyId: "" });
  });

  it("no hard-coded policy names: without saved defaults nothing is chosen", () => {
    const named = {
      ...options,
      fulfillment: [
        { id: "usual", name: "USPS Ground Advantage ($7.95), 2 day handling" },
      ],
      payment: [{ id: "mp", name: "Managed Payments" }],
      returns: [
        { id: "r", name: "Returns Accepted,Seller,30 Days,Money Back#1" },
      ],
    };
    expect(applyShippingDefaults({}, named)).toEqual({});
  });

  it("matches by ID: a renamed policy is still used and reported as renamed", () => {
    const renamed = {
      ...options,
      payment: [{ id: "pay-1", name: "Zippadoo Payments 2026" }],
    };
    const check = checkDefaults(saved, renamed);
    expect(check.fields.paymentPolicyId).toMatchObject({
      status: "renamed",
      currentName: "Zippadoo Payments 2026",
    });
    expect(applyShippingDefaults({}, renamed, saved).paymentPolicyId).toBe(
      "pay-1",
    );
  });

  it("a policy with the same name but another ID is never substituted", () => {
    const replaced = {
      ...options,
      returns: [{ id: "ret-NEW", name: "Zippadoo Refund Policy" }],
    };
    const check = checkDefaults(saved, replaced);
    expect(check.fields.returnPolicyId.status).toBe("missing");
    const filled = applyShippingDefaults({}, replaced, saved);
    expect(filled).not.toHaveProperty("returnPolicyId");
    expect(filled).toMatchObject({
      fulfillmentPolicyId: "ship-795",
      paymentPolicyId: "pay-1",
      locationKey: "zupe-hq",
    });
  });

  it("another eBay account: nothing is applied", () => {
    const other = {
      fulfillment: [{ id: "th-ship", name: "Thrift and Honey Shipping" }],
      payment: [{ id: "th-pay", name: "TH Payment" }],
      returns: [{ id: "th-ret", name: "TH Returns" }],
      locations: [{ id: "th-home", name: "Honey House" }],
    };
    const check = checkDefaults(saved, other);
    expect(check.mismatch).toBe(true);
    expect(check.usable).toEqual({});
    // Not even the single-location fallback: the saved origin is not there.
    expect(applyShippingDefaults({}, other, saved)).toEqual({});
  });

  it("without a saved origin, the account's only location is used as before", () => {
    const sole = { ...options, locations: [{ id: "only", name: "Only" }] };
    expect(applyShippingDefaults({}, sole).locationKey).toBe("only");
    expect(applyShippingDefaults({}, sole, {}, ["locationKey"])).toEqual({});
    expect(applyShippingDefaults({}, options)).not.toHaveProperty(
      "locationKey",
    );
  });

  it("filled defaults pass the publishing schema; partial measurements do not", () => {
    const filled = applyShippingDefaults({}, options, saved);
    expect(shippingSchema.safeParse(filled).success).toBe(true);
    expect(shippingSchema.safeParse({ ...filled, weightOz: 0 }).success).toBe(
      false,
    );
    expect(shippingSchema.safeParse({ ...filled, lengthIn: 10 }).success).toBe(
      false,
    );
  });
});

const group = (patch: Partial<ItemGroup> = {}): ItemGroup => ({
  id: "g",
  sku: "5547",
  name: "shirt",
  photoIds: ["p"],
  status: "done",
  listing: { title: "Shirt", description: "Shirt" },
  ...patch,
});

describe("which listings take defaults", () => {
  it("only editable, unpublished written listings", () => {
    expect(defaultsPatch(group(), options, saved)).toEqual({ shipping: all });
    for (const g of [
      group({ postStatus: "posted", listingId: "1" }),
      group({ postStatus: "posting" }),
      group({ status: "writing" }),
      group({ status: "idle", listing: undefined }),
    ])
      expect(defaultsPatch(g, options, saved)).toBeNull();
    // Nothing to change: null.
    expect(defaultsPatch(group({ shipping: all }), options, saved)).toBeNull();
  });

  it("a seller's choice in a listing: values are kept; a blank becomes intentional", () => {
    const g = group({ shipping: all });
    const blank = sellerShippingChoice(g, "returnPolicyId", "");
    expect(blank).toEqual({
      shipping: { ...all, returnPolicyId: "" },
      shippingCleared: ["returnPolicyId"],
    });
    expect(defaultsPatch(group(blank), options, saved)).toBeNull();
    const chosen = sellerShippingChoice(
      group(blank),
      "returnPolicyId",
      "ret-1",
    );
    expect(chosen.shippingCleared).toEqual([]);
  });
});

describe("saved in this browser, per instance", () => {
  beforeEach(() => {
    stubLocalStorage();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("saves and loads IDs and names", () => {
    expect(loadSellerDefaults()).toEqual({});
    expect(saveSellerDefaults(saved)).toBe(true);
    expect(loadSellerDefaults()).toEqual(saved);
    expect(localStorage.getItem("zupe:listing-defaults:v1")).toContain(
      "ship-795",
    );
  });

  it("ignores malformed data", () => {
    localStorage.setItem(defaultsStorageKey(), "{not json");
    expect(loadSellerDefaults()).toEqual({});
    localStorage.setItem(
      defaultsStorageKey(),
      JSON.stringify({
        fulfillmentPolicyId: { id: "", name: "x" },
        paymentPolicyId: { id: 5 },
        returnPolicyId: { id: "ret-1", name: "Zippadoo Refund Policy" },
        other: { id: "x", name: "y" },
      }),
    );
    expect(loadSellerDefaults()).toEqual({
      returnPolicyId: { id: "ret-1", name: "Zippadoo Refund Policy" },
    });
  });

  it("each instance has its own key", () => {
    expect(defaultsStorageKey("")).toBe("zupe:listing-defaults:v1");
    expect(defaultsStorageKey("Thrift and Honey")).toBe(
      "zupe:listing-defaults:v1:thrift-and-honey",
    );
    vi.stubEnv("NEXT_PUBLIC_ZUPE_INSTANCE", "thrift-and-honey");
    expect(loadSellerDefaults()).toEqual({});
    saveSellerDefaults({ locationKey: { id: "th-home", name: "Honey House" } });
    vi.unstubAllEnvs();
    // The default instance does not see Thrift and Honey's defaults.
    expect(loadSellerDefaults()).toEqual({});
    expect(
      localStorage.getItem("zupe:listing-defaults:v1:thrift-and-honey"),
    ).toContain("th-home");
  });

  it("storage that throws counts as no defaults and a failed save", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(loadSellerDefaults()).toEqual({});
    expect(saveSellerDefaults(saved)).toBe(false);
    vi.unstubAllGlobals();
  });
});
