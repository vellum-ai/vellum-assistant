import { describe, test, expect } from "bun:test";
import {
  FUN_NAME_SLUGS,
  generateRandomSuffix,
  generateInstanceName,
} from "../lib/random-name.js";

describe("generateRandomSuffix", () => {
  test("uses exactly 40 lowercase name slugs", () => {
    expect(FUN_NAME_SLUGS).toHaveLength(40);
    expect(new Set(FUN_NAME_SLUGS).size).toBe(FUN_NAME_SLUGS.length);
    for (const slug of FUN_NAME_SLUGS) {
      expect(slug).toMatch(/^[a-z]+$/);
    }
  });

  test("returns a string in name-nanoid format", () => {
    const result = generateRandomSuffix();
    expect(result).toMatch(/^[a-z]+-[a-z0-9]{6}$/);
    const slug = result.replace(/-[a-z0-9]{6}$/, "");
    expect(FUN_NAME_SLUGS).toContain(slug as (typeof FUN_NAME_SLUGS)[number]);
  });

  test("produces varying results across multiple calls", () => {
    const results = new Set<string>();
    for (let i = 0; i < 20; i++) {
      results.add(generateRandomSuffix());
    }
    // With 40 name slugs * nanoid(6), the combinatorial space is enormous
    // (~87 billion), so 20 calls should always produce unique values.
    expect(results.size).toBeGreaterThan(1);
  });
});

describe("generateInstanceName", () => {
  test("returns explicit name when provided", () => {
    expect(generateInstanceName("vellum", "my-custom")).toBe("my-custom");
  });

  test("generates species-prefixed name when no explicit name", () => {
    const result = generateInstanceName("vellum");
    expect(result).toMatch(/^vellum-[a-z]+-[a-z0-9]{6}$/);
  });

  test("treats null as no explicit name", () => {
    const result = generateInstanceName("openclaw", null);
    expect(result).toMatch(/^openclaw-[a-z]+-[a-z0-9]{6}$/);
  });
});
