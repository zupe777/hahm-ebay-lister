import { describe, expect, it } from "vitest";
import { draftIssues, shippingIssues } from "@/lib/client-review";
import type { ItemGroup } from "@/lib/types";

const all = {
  fulfillmentPolicyId: "ship-795",
  paymentPolicyId: "pay-1",
  returnPolicyId: "ret-1",
  locationKey: "zippadoo-hq",
};
const hint = "Saved Default listing settings fill these automatically.";

describe("policy and shipping-origin messages name what is missing", () => {
  it("the three policies missing, origin chosen (the seller's screenshot)", () => {
    expect(shippingIssues({ locationKey: "zippadoo-hq" })).toEqual([
      `Choose a shipping policy, a payment policy and a return policy. ${hint}`,
    ]);
  });

  it("one, two or all four missing", () => {
    expect(shippingIssues({ ...all, returnPolicyId: "" })).toEqual([
      `Choose a return policy. ${hint}`,
    ]);
    expect(
      shippingIssues({ ...all, paymentPolicyId: undefined, locationKey: " " }),
    ).toEqual([`Choose a payment policy and a shipping origin. ${hint}`]);
    expect(shippingIssues(undefined)).toEqual([
      `Choose a shipping policy, a payment policy, a return policy and a shipping origin. ${hint}`,
    ]);
  });

  it("package measurements stay optional; only invalid ones are reported", () => {
    expect(shippingIssues(all)).toEqual([]);
    expect(shippingIssues({ ...all, weightOz: 12 })).toEqual([]);
    expect(
      shippingIssues({
        ...all,
        weightOz: 12,
        lengthIn: 10,
        widthIn: 8,
        heightIn: 2,
      }),
    ).toEqual([]);
    const measurements =
      "Package measurements are optional, but the ones entered are not valid: enter a positive weight and all three dimensions, or leave them blank.";
    expect(shippingIssues({ ...all, lengthIn: 10 })).toEqual([measurements]);
    expect(shippingIssues({ ...all, weightOz: 0 })).toEqual([measurements]);
    // Both problems at once.
    expect(shippingIssues({ lengthIn: 10 })).toEqual([
      `Choose a shipping policy, a payment policy, a return policy and a shipping origin. ${hint}`,
      measurements,
    ]);
  });

  it("the old generic message is gone from the listing's issues", () => {
    const g: ItemGroup = {
      id: "g",
      sku: "5544",
      skuSource: "seller",
      skuConfirmed: true,
      name: "shirt",
      photoIds: ["p"],
      status: "done",
      listing: { title: "Shirt", description: "Shirt", suggested_price: 22 },
      shipping: { locationKey: "zippadoo-hq" },
    };
    const issues = draftIssues(g);
    expect(issues).toContain(
      `Choose a shipping policy, a payment policy and a return policy. ${hint}`,
    );
    expect(issues.join(" ")).not.toContain(
      "Choose policies and shipping origin",
    );
    expect(draftIssues({ ...g, shipping: all }).join(" ")).not.toMatch(
      /Choose a|Package measurements/,
    );
  });
});
