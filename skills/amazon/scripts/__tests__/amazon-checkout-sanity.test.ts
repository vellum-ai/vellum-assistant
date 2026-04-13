import { describe, expect, test } from "bun:test";

import { evaluateCheckoutSanity } from "../amazon-checkout-sanity.js";

describe("evaluateCheckoutSanity", () => {
  test("marks ready when required checkout markers are present", () => {
    const text = [
      "Deliver to 123 Main St",
      "Payment method Visa ending in 1234",
      "Order total: $45.90",
      "Place your order",
    ].join("\n");

    const result = evaluateCheckoutSanity({
      text,
      context: { cartConfirmed: true },
    });

    expect(result.ready).toBe(true);
    expect(result.missing).toHaveLength(0);
    expect(result.riskFlags).toHaveLength(0);
  });

  test("marks missing fields and risk flags when checkout data is incomplete", () => {
    const result = evaluateCheckoutSanity({ text: "Payment method only" });

    expect(result.ready).toBe(false);
    expect(result.missing).toContain("shipping_address");
    expect(result.riskFlags).toContain("cart_not_explicitly_confirmed");
  });
});
