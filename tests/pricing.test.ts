import { describe, expect, it } from "vitest";
import {
  applyPriceMarkup,
  marketItemPrice,
  myShippingCharge,
  priceMarkupPercent,
  roundTo99,
} from "@/lib/pricing";

describe("priceMarkupPercent", () => {
  it("parses a configured percent", () => {
    expect(priceMarkupPercent("40")).toBe(40);
    expect(priceMarkupPercent("12.5")).toBe(12.5);
    expect(priceMarkupPercent("0")).toBe(0);
  });

  it("returns 0 when unset or blank", () => {
    expect(priceMarkupPercent(undefined)).toBe(0);
    expect(priceMarkupPercent("")).toBe(0);
    expect(priceMarkupPercent("  ")).toBe(0);
  });

  it("returns 0 for invalid values instead of corrupting prices", () => {
    expect(priceMarkupPercent("forty")).toBe(0);
    expect(priceMarkupPercent("-10")).toBe(0);
    expect(priceMarkupPercent("Infinity")).toBe(0);
    expect(priceMarkupPercent("NaN")).toBe(0);
  });
});

describe("applyPriceMarkup", () => {
  it("inflates a numeric price, rounded to cents", () => {
    expect(applyPriceMarkup(10, 40)).toBe(14);
    expect(applyPriceMarkup(34.99, 40)).toBe(48.99);
    expect(applyPriceMarkup(49.99, 40)).toBe(69.99);
  });

  it("parses string prices from the model", () => {
    expect(applyPriceMarkup("49.99", 40)).toBe(69.99);
  });

  it("is a no-op at 0 percent", () => {
    expect(applyPriceMarkup(25, 0)).toBe(25);
    expect(applyPriceMarkup("25", 0)).toBe("25");
  });

  it("leaves the model's 'price manually' zero alone", () => {
    // 0 drives the UI's needs-a-price flag — it must survive markup untouched.
    expect(applyPriceMarkup(0, 40)).toBe(0);
  });

  it("passes through missing or unparseable prices", () => {
    expect(applyPriceMarkup(undefined, 40)).toBeUndefined();
    expect(applyPriceMarkup("", 40)).toBe("");
    expect(applyPriceMarkup("abc", 40)).toBe("abc");
    expect(applyPriceMarkup(-5, 40)).toBe(-5);
  });
});

describe("myShippingCharge", () => {
  it("defaults to 7.99 when unset, blank or invalid", () => {
    expect(myShippingCharge(undefined)).toBe(7.99);
    expect(myShippingCharge("")).toBe(7.99);
    expect(myShippingCharge("free")).toBe(7.99);
    expect(myShippingCharge("-1")).toBe(7.99);
  });

  it("uses a configured charge, rounded to cents", () => {
    expect(myShippingCharge("9.99")).toBe(9.99);
    expect(myShippingCharge("0")).toBe(0);
    expect(myShippingCharge("5.555")).toBe(5.56);
  });
});

describe("roundTo99", () => {
  it("rounds to the nearest .99 ending", () => {
    expect(roundTo99(20)).toBe(19.99);
    expect(roundTo99(12)).toBe(11.99);
    expect(roundTo99(7.01)).toBe(6.99);
    expect(roundTo99(6.2)).toBe(5.99);
    expect(roundTo99(6.5)).toBe(6.99);
    expect(roundTo99(12.49)).toBe(12.99);
    expect(roundTo99(11.48)).toBe(10.99);
  });
});

describe("marketItemPrice", () => {
  const S = 7.99;
  it("matches the median delivered price after the seller's shipping", () => {
    // $20 item + $7.99 shipping median.
    expect(marketItemPrice(27.99, S)).toEqual({
      itemPrice: 19.99,
      rawItemPrice: 20,
      belowFloor: false,
    });
    // Mostly free-shipping comps.
    expect(marketItemPrice(15, S).itemPrice).toBe(6.99);
    // Mixed free and paid shipping comps.
    expect(marketItemPrice(19.99, S).itemPrice).toBe(11.99);
  });

  it("rounds computed prices from 5.00 to 5.49 up to 5.99 without a warning", () => {
    for (const median of [12.99, 13.2, 13.48, 13.6, 14.47]) {
      expect(marketItemPrice(median, S)).toMatchObject({
        itemPrice: 5.99,
        belowFloor: false,
      });
    }
    // Exactly halfway between .99 endings (6.49) rounds up.
    expect(marketItemPrice(14.48, S).itemPrice).toBe(6.99);
    expect(marketItemPrice(14.49, S).itemPrice).toBe(6.99);
  });

  it("offers the $5.00 floor with a warning when the computed price is under $5", () => {
    expect(marketItemPrice(12.98, S)).toEqual({
      itemPrice: 5,
      rawItemPrice: 4.99,
      belowFloor: true,
    });
    expect(marketItemPrice(9.5, S)).toMatchObject({
      itemPrice: 5,
      belowFloor: true,
    });
    // Shipping above the market price never produces a zero or negative price.
    expect(marketItemPrice(7, S)).toEqual({
      itemPrice: 5,
      rawItemPrice: -0.99,
      belowFloor: true,
    });
  });

  it("applies the storewide markup to the item price only", () => {
    expect(marketItemPrice(27.99, S, 20)).toMatchObject({
      itemPrice: 23.99,
      rawItemPrice: 20,
    });
    // Markup can lift a sub-floor price over the floor.
    expect(marketItemPrice(12.49, S, 20)).toMatchObject({
      itemPrice: 5.99,
      belowFloor: false,
    });
  });

  it("uses a configured shipping charge", () => {
    expect(marketItemPrice(29.99, 9.99).itemPrice).toBe(19.99);
  });
});
