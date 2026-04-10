import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { parseAmazonSearchCandidates } from "../amazon-parse-search.js";

const SEARCH_FIXTURE = readFileSync(
  new URL("../__fixtures__/search-sample.txt", import.meta.url),
  "utf8",
);

describe("parseAmazonSearchCandidates", () => {
  test("parses ASIN, title, and price candidates", () => {
    const results = parseAmazonSearchCandidates({
      query: "aa batteries",
      text: SEARCH_FIXTURE,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title.toLowerCase()).toContain("batteries");
    expect(results.some((item) => item.asin === "B08XGDN3TZ")).toBe(true);
  });

  test("falls back to title+price candidates when asin is missing", () => {
    const text = [
      "Energizer AA Max 24 Count",
      "$18.99",
      "Prime",
    ].join("\n");

    const results = parseAmazonSearchCandidates({
      query: "energizer aa",
      text,
    });

    expect(results).toHaveLength(1);
    expect(results[0].asin).toBeUndefined();
    expect(results[0].priceValue).toBe(18.99);
  });
});
