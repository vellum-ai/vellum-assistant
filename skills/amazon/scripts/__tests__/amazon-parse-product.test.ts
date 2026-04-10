import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { parseAmazonProduct } from "../amazon-parse-product.js";

const PRODUCT_FIXTURE = readFileSync(
  new URL("../__fixtures__/product-sample.txt", import.meta.url),
  "utf8",
);

describe("parseAmazonProduct", () => {
  test("parses title, asin, price, and variation hints", () => {
    const result = parseAmazonProduct({ text: PRODUCT_FIXTURE });

    expect(result.asin).toBe("B0CDE12345");
    expect(result.title).toContain("Trail Running Shoes");
    expect(result.priceValue).toBe(79.99);
    expect(result.variationHints.some((hint) => hint.dimension === "color")).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  test("returns warnings when key fields are missing", () => {
    const result = parseAmazonProduct({ text: "Lightweight travel backpack" });

    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.priceValue).toBeUndefined();
  });
});
