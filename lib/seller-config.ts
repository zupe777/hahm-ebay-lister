import type { SellerPolicyDefaults } from "./shipping-defaults";

// Seller-specific eBay policy and shipping-origin names, set per deployment.
// Each value is matched by name against the connected account's own policies
// and locations; IDs always come from eBay, never from this config.
export function sellerPolicyDefaults(): SellerPolicyDefaults {
  const name = (v: string | undefined) => v?.trim() || undefined;
  return {
    fulfillment: name(process.env.EBAY_DEFAULT_SHIPPING_POLICY),
    payment: name(process.env.EBAY_DEFAULT_PAYMENT_POLICY),
    returns: name(process.env.EBAY_DEFAULT_RETURN_POLICY),
    locations: name(process.env.EBAY_DEFAULT_LOCATION),
  };
}
