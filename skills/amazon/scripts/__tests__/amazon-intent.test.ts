import { describe, expect, test } from "bun:test";

import { classifyAmazonIntent } from "../amazon-intent.js";

describe("classifyAmazonIntent", () => {
  test("defaults to search when no strong signals are present", () => {
    const result = classifyAmazonIntent({ request: "find aa batteries" });

    expect(result.step).toBe("search");
    expect(result.needsExplicitConfirmation).toBe(false);
  });

  test("routes to checkout review before order placement when checkout is not reviewed", () => {
    const result = classifyAmazonIntent({ request: "place order now" });

    expect(result.step).toBe("checkout_review");
    expect(result.needsExplicitConfirmation).toBe(false);
  });

  test("routes to place_order when checkout has been reviewed", () => {
    const result = classifyAmazonIntent({
      request: "place order now",
      context: { checkoutReviewed: true },
    });

    expect(result.step).toBe("place_order");
    expect(result.needsExplicitConfirmation).toBe(true);
  });

  test("routes to fresh_slot for fresh request without selected slot", () => {
    const result = classifyAmazonIntent({ request: "order fresh groceries" });

    expect(result.step).toBe("fresh_slot");
  });
});
