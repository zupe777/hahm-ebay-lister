import type { AccountOptions } from "./ebay/publish";
import type { ShippingSelection } from "./validation";
const keys = {
  fulfillmentPolicyId: "fulfillment",
  paymentPolicyId: "payment",
  returnPolicyId: "returns",
  locationKey: "locations",
} as const;
export type SellerPolicyDefaults = Partial<
  Record<(typeof keys)[keyof typeof keys], string>
>;
const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
// Fill empty selections with the seller's configured default names
// (lib/seller-config.ts). Unset, missing or ambiguous names stay unselected.
export function applyShippingDefaults(
  current: Partial<ShippingSelection>,
  options: AccountOptions,
): Partial<ShippingSelection> {
  const next = { ...current };
  for (const key of Object.keys(keys) as (keyof typeof keys)[]) {
    const wanted = options.defaults?.[keys[key]];
    if (next[key] || !wanted) continue;
    const matches = options[keys[key]].filter((o) =>
      key === "locationKey"
        ? normalize(o.name.split("·")[0]) === normalize(wanted)
        : normalize(o.name) === normalize(wanted),
    );
    if (matches.length === 1) next[key] = matches[0].id;
  }
  return next;
}
