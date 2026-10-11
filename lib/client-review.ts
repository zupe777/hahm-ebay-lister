import type { ItemGroup } from "./types";
import { shippingSchema } from "./validation";
import { skuIssues } from "./inventory-sticker";
import { validateAspects } from "./ebay/draft";
export function draftIssues(g: ItemGroup): string[] {
  const l = g.listing;
  if (!l) return ["Generate a draft first."];
  const issues: string[] = [];
  // The SKU (eBay Custom Label) is the seller's: blank, invalid or
  // unconfirmed SKUs block publishing.
  issues.push(...skuIssues(g));
  if (!l.title.trim() || l.title.length > 80)
    issues.push("Title must be 1–80 characters.");
  if (!l.description.trim()) issues.push("Enter a description.");
  if (
    !Number.isFinite(Number(l.suggested_price)) ||
    Number(l.suggested_price) <= 0
  )
    issues.push("Enter a positive price.");
  if (
    !g.preparation ||
    g.preparation.categoryId !== l.category_id ||
    g.preparation.expiresAt < Date.now()
  )
    issues.push("Prepare this category before publishing.");
  else {
    if (!g.preparation.conditions.some((c) => c.value === l.ebay_condition))
      issues.push("Choose an eBay condition.");
    issues.push(
      ...validateAspects(
        Object.fromEntries(
          Object.entries(l.item_specifics ?? {})
            .filter(([, v]) => v.trim())
            .map(([k, v]) => [k, v.split(" | ").map((x) => x.trim())]),
        ),
        g.preparation.aspects,
      ),
    );
  }
  issues.push(...shippingIssues(g.shipping));
  if (!g.photoIds.length || g.photoIds.length > 24)
    issues.push("Select 1–24 photos for this item.");
  return issues;
}

const REQUIRED_SHIPPING = [
  ["fulfillmentPolicyId", "a shipping policy"],
  ["paymentPolicyId", "a payment policy"],
  ["returnPolicyId", "a return policy"],
  ["locationKey", "a shipping origin"],
] as const;

// The missing policy / shipping-origin fields by name; package measurements
// are optional and only reported when entered but invalid.
export function shippingIssues(
  shipping: ItemGroup["shipping"] | undefined,
): string[] {
  const s = shipping ?? {};
  const missing = REQUIRED_SHIPPING.filter(([key]) => !s[key]?.trim());
  const issues: string[] = [];
  if (missing.length) {
    const names = missing.map(([, name]) => name);
    const list =
      names.length === 1
        ? names[0]
        : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
    issues.push(
      `Choose ${list}. Saved Default listing settings fill these automatically.`,
    );
  }
  // Measurements: checked with the required fields treated as present.
  const filled = Object.fromEntries(
    REQUIRED_SHIPPING.map(([key]) => [key, s[key]?.trim() || "x"]),
  );
  if (!shippingSchema.safeParse({ ...s, ...filled }).success)
    issues.push(
      "Package measurements are optional, but the ones entered are not valid: enter a positive weight and all three dimensions, or leave them blank.",
    );
  return issues;
}
