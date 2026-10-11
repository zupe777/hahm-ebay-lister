// The seller's default listing settings: shipping, payment and return
// policies and the shipping origin, chosen once from the connected eBay
// account and saved in this browser (eBay IDs plus the names shown then).
// Defaults only fill blank fields of editable, unpublished listings; they
// are matched by eBay ID, never by name, and a default that the connected
// account does not have is never replaced by another policy.

import type { AccountOptions } from "./ebay/publish";
import type { ItemGroup } from "./types";
import type { ShippingSelection } from "./validation";

export type DefaultKey =
  "fulfillmentPolicyId" | "paymentPolicyId" | "returnPolicyId" | "locationKey";
export const DEFAULT_FIELDS: readonly {
  key: DefaultKey;
  kind: keyof AccountOptions;
  label: string;
}[] = [
  { key: "fulfillmentPolicyId", kind: "fulfillment", label: "Shipping policy" },
  { key: "paymentPolicyId", kind: "payment", label: "Payment policy" },
  { key: "returnPolicyId", kind: "returns", label: "Return policy" },
  { key: "locationKey", kind: "locations", label: "Shipping origin" },
];

export interface SavedChoice {
  id: string;
  name: string;
}
export type SellerDefaults = Partial<Record<DefaultKey, SavedChoice>>;

// One key per Zupe instance (NEXT_PUBLIC_ZUPE_INSTANCE, optional). Browser
// storage is already separate for each origin, including its port.
export function defaultsStorageKey(
  instance = process.env.NEXT_PUBLIC_ZUPE_INSTANCE ?? "",
): string {
  const clean = instance
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `zupe:listing-defaults:v1${clean ? `:${clean}` : ""}`;
}
export const DEFAULTS_CHANGED_EVENT = "zupe-listing-defaults-changed";

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

// Saved defaults; anything unreadable or malformed counts as not set.
export function loadSellerDefaults(): SellerDefaults {
  try {
    const raw = storage()?.getItem(defaultsStorageKey());
    if (!raw) return {};
    const data = JSON.parse(raw) as Record<string, unknown>;
    const out: SellerDefaults = {};
    for (const { key } of DEFAULT_FIELDS) {
      const v = data?.[key] as Partial<SavedChoice> | undefined;
      if (
        v &&
        typeof v.id === "string" &&
        v.id.trim() &&
        v.id.length <= 100 &&
        typeof v.name === "string"
      )
        out[key] = { id: v.id, name: v.name.slice(0, 200) };
    }
    return out;
  } catch {
    return {};
  }
}

export function saveSellerDefaults(defaults: SellerDefaults): boolean {
  try {
    const s = storage();
    if (!s) return false;
    s.setItem(defaultsStorageKey(), JSON.stringify(defaults));
    return true;
  } catch {
    return false;
  }
}

export type DefaultStatus = "unset" | "ok" | "renamed" | "missing";
export interface DefaultsCheck {
  fields: Record<
    DefaultKey,
    { status: DefaultStatus; saved?: SavedChoice; currentName?: string }
  >;
  // Defaults are saved but none exists on the connected account: most
  // likely another eBay account. Nothing is applied.
  mismatch: boolean;
  // The IDs that may be applied.
  usable: Partial<Record<DefaultKey, string>>;
}

// Saved defaults checked against the connected account's options, by ID.
export function checkDefaults(
  saved: SellerDefaults,
  options: AccountOptions,
): DefaultsCheck {
  const fields = {} as DefaultsCheck["fields"];
  let savedCount = 0;
  let found = 0;
  for (const { key, kind } of DEFAULT_FIELDS) {
    const s = saved[key];
    if (!s) {
      fields[key] = { status: "unset" };
      continue;
    }
    savedCount++;
    const match = options[kind].find((o) => o.id === s.id);
    if (!match) {
      fields[key] = { status: "missing", saved: s };
      continue;
    }
    found++;
    fields[key] = {
      status: match.name === s.name ? "ok" : "renamed",
      saved: s,
      currentName: match.name,
    };
  }
  const mismatch = savedCount > 0 && found === 0;
  const usable: DefaultsCheck["usable"] = {};
  if (!mismatch)
    for (const { key } of DEFAULT_FIELDS) {
      const f = fields[key];
      if ((f.status === "ok" || f.status === "renamed") && f.saved)
        usable[key] = f.saved.id;
    }
  return { fields, mismatch, usable };
}

// Fill only blank fields that the seller has not deliberately left blank.
// Without a saved default origin, the account's only enabled location is
// used, as before.
export function applyShippingDefaults(
  current: Partial<ShippingSelection>,
  options: AccountOptions,
  saved: SellerDefaults = {},
  cleared: readonly DefaultKey[] = [],
): Partial<ShippingSelection> {
  const { usable } = checkDefaults(saved, options);
  const next = { ...current };
  for (const { key } of DEFAULT_FIELDS) {
    if (next[key] || cleared.includes(key)) continue;
    const id = usable[key];
    if (id) next[key] = id;
  }
  if (
    !next.locationKey &&
    !cleared.includes("locationKey") &&
    !saved.locationKey &&
    options.locations.length === 1
  )
    next.locationKey = options.locations[0].id;
  return next;
}

// Only editable, unpublished written listings take defaults.
export function takesDefaults(g: ItemGroup): boolean {
  return (
    g.status === "done" &&
    g.postStatus !== "posted" &&
    g.postStatus !== "posting" &&
    Boolean(g.listing)
  );
}

// The change defaults would make to this listing, or null for none.
export function defaultsPatch(
  g: ItemGroup,
  options: AccountOptions,
  saved: SellerDefaults,
): Pick<ItemGroup, "shipping"> | null {
  if (!takesDefaults(g)) return null;
  const shipping = applyShippingDefaults(
    g.shipping ?? {},
    options,
    saved,
    g.shippingCleared,
  );
  return JSON.stringify(shipping) === JSON.stringify(g.shipping ?? {})
    ? null
    : { shipping };
}

// A seller's own selection in a listing: a value is theirs; a blank is an
// intentional blank that defaults never refill.
export function sellerShippingChoice(
  g: ItemGroup,
  key: DefaultKey,
  value: string,
): Pick<ItemGroup, "shipping" | "shippingCleared"> {
  const others = (g.shippingCleared ?? []).filter((k) => k !== key);
  return {
    shipping: { ...g.shipping, [key]: value },
    shippingCleared: value ? others : [...others, key],
  };
}
