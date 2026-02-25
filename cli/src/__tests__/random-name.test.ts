import { describe, test, expect } from "bun:test";
import { generateRandomSuffix } from "../lib/random-name.js";

describe("generateRandomSuffix", () => {
  test("returns a string in adjective-noun format", () => {
    const result = generateRandomSuffix();
    expect(result).toMatch(/^[a-z]+-[a-z]+$/);
  });

  test("produces varying results across multiple calls", () => {
    const results = new Set<string>();
    for (let i = 0; i < 20; i++) {
      results.add(generateRandomSuffix());
    }
    // With 62 adjectives * 62 nouns = 3844 combos, 20 calls should produce
    // at least a few unique values
    expect(results.size).toBeGreaterThan(1);
  });
});
