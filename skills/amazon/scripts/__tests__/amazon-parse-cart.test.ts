import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { parseAmazonCartSummary } from "../amazon-parse-cart.js";

const CART_FIXTURE = readFileSync(
  new URL("../__fixtures__/cart-sample.txt", import.meta.url),
  "utf8",
);

describe("parseAmazonCartSummary", () => {
  test("parses item lines and totals", () => {
    const result = parseAmazonCartSummary({ text: CART_FIXTURE });

    expect(result.items.length).toBe(2);
    expect(result.subtotal).toBe("$22.48");
    expect(result.total).toBe("$23.83");
    expect(result.itemCount).toBe(2);
    expect(result.warnings).toHaveLength(0);
  });

  test("emits warnings when totals are missing", () => {
    const result = parseAmazonCartSummary({ text: "Cart appears empty" });

    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
