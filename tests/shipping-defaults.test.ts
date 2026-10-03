import { afterEach, expect, it, vi } from "vitest";
import { applyShippingDefaults } from "@/lib/shipping-defaults";
import { sellerPolicyDefaults } from "@/lib/seller-config";
import { shippingSchema } from "@/lib/validation";
const options = {
  fulfillment: [
    { id: "usual", name: "Light Apparel Shipping" },
    { id: "heavy", name: "Heavy shipping" },
  ],
  payment: [{ id: "payment", name: "Payments Policy" }],
  returns: [{ id: "return", name: "30 Day Returns" }],
  locations: [{ id: "origin", name: "Home Closet · 10001 · US" }],
  defaults: {
    fulfillment: "light apparel shipping",
    payment: "Payments Policy",
    returns: "30 Day Returns",
    locations: "Home Closet",
  },
};
afterEach(() => vi.unstubAllEnvs());
it("uses verified account IDs for the configured defaults, without overwriting overrides", () => {
  const defaults = applyShippingDefaults({}, options);
  expect(defaults).toEqual({
    fulfillmentPolicyId: "usual",
    paymentPolicyId: "payment",
    returnPolicyId: "return",
    locationKey: "origin",
  });
  expect(
    applyShippingDefaults({ fulfillmentPolicyId: "heavy" }, options)
      .fulfillmentPolicyId,
  ).toBe("heavy");
  expect(
    applyShippingDefaults({}, { ...options, fulfillment: [] }),
  ).not.toHaveProperty("fulfillmentPolicyId");
});
it("selects nothing when no defaults are configured", () => {
  expect(
    applyShippingDefaults({}, { ...options, defaults: undefined }),
  ).toEqual({});
  expect(
    applyShippingDefaults({}, { ...options, defaults: { payment: "Other" } }),
  ).toEqual({});
});
it("reads seller default names from the environment", () => {
  vi.stubEnv("EBAY_DEFAULT_SHIPPING_POLICY", " Light Apparel Shipping ");
  vi.stubEnv("EBAY_DEFAULT_PAYMENT_POLICY", "");
  vi.stubEnv("EBAY_DEFAULT_RETURN_POLICY", "30 Day Returns");
  vi.stubEnv("EBAY_DEFAULT_LOCATION", "Home Closet");
  expect(sellerPolicyDefaults()).toEqual({
    fulfillment: "Light Apparel Shipping",
    payment: undefined,
    returns: "30 Day Returns",
    locations: "Home Closet",
  });
});
it("allows absent measurements and rejects partial or invalid provided measurements", () => {
  const defaults = applyShippingDefaults({}, options);
  expect(shippingSchema.safeParse(defaults).success).toBe(true);
  expect(shippingSchema.safeParse({ ...defaults, weightOz: 0 }).success).toBe(
    false,
  );
  expect(shippingSchema.safeParse({ ...defaults, lengthIn: 10 }).success).toBe(
    false,
  );
  expect(shippingSchema.safeParse({ ...defaults, weightOz: 8 }).success).toBe(
    true,
  );
});
