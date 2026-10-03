import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CompsSummary } from "@/lib/types";

const comps = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock("@/lib/ebay/taxonomy", () => ({ appToken: async () => "token" }));
vi.mock("@/lib/ebay/comps", () => ({
  searchComps: async () => comps.current,
}));
import { researchListing } from "@/lib/services/research";

const summary = (count: number, median: number): CompsSummary => ({
  ok: true,
  query: "q",
  count,
  median,
  confidence: 0.3,
  basis: "active asking prices, not sold",
});
const run = async () =>
  (
    await (
      await researchListing({ listing: { title: "Tee", description: "" } })
    ).json()
  ).comps as CompsSummary;

beforeEach(() => {
  vi.stubEnv("EBAY_CLIENT_ID", "id");
  vi.stubEnv("EBAY_CLIENT_SECRET", "secret");
  vi.stubEnv("MY_SHIPPING_CHARGE", "");
  vi.stubEnv("PRICE_MARKUP_PERCENT", "");
});
afterEach(() => vi.unstubAllEnvs());

it("suggests an item price from three or more comps using the shipping setting", async () => {
  comps.current = summary(3, 27.99);
  expect(await run()).toMatchObject({
    shippingCharge: 7.99,
    minComps: 3,
    itemPrice: 19.99,
    belowFloor: false,
  });
  vi.stubEnv("MY_SHIPPING_CHARGE", "9.99");
  comps.current = summary(5, 29.99);
  expect(await run()).toMatchObject({ shippingCharge: 9.99, itemPrice: 19.99 });
});

it("offers no market price with fewer than three comps", async () => {
  comps.current = summary(2, 27.99);
  const r = await run();
  expect(r.itemPrice).toBeUndefined();
  expect(r.belowFloor).toBeUndefined();
  expect(r).not.toHaveProperty("listPrice");
});

it("marks a floor suggestion when shipping exceeds the market margin", async () => {
  comps.current = summary(4, 9.5);
  expect(await run()).toMatchObject({ itemPrice: 5, belowFloor: true });
});
