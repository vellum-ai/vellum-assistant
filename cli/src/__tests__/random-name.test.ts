import { describe, test, expect } from "bun:test";
import {
  generateRandomSuffix,
  generateInstanceName,
} from "../lib/random-name.js";

describe("generateRandomSuffix", () => {
  test("returns a string in adjective-noun-nanoid format", () => {
    const result = generateRandomSuffix();
    expect(result).toMatch(/^[a-z]+-[a-z]+-[A-Za-z0-9_-]{6}$/);
  });

  test("produces varying results across multiple calls", () => {
    const results = new Set<string>();
    for (let i = 0; i < 20; i++) {
      results.add(generateRandomSuffix());
    }
    // With 62 adjectives * 62 nouns * nanoid(6) the combinatorial space is
    // enormous (~56 billion+), so 20 calls should always produce unique values
    expect(results.size).toBeGreaterThan(1);
  });
});

describe("generateInstanceName", () => {
  test("returns explicit name when provided", () => {
    expect(generateInstanceName("vellum", "my-custom")).toBe("my-custom");
  });

  test("generates species-prefixed name when no explicit name", () => {
    const result = generateInstanceName("vellum");
    expect(result).toMatch(/^vellum-[a-z]+-[a-z]+-[A-Za-z0-9_-]{6}$/);
  });

  test("treats null as no explicit name", () => {
    const result = generateInstanceName("openclaw", null);
    expect(result).toMatch(/^openclaw-[a-z]+-[a-z]+-[A-Za-z0-9_-]{6}$/);
  });
});
