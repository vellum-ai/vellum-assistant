import { describe, expect, test } from "bun:test";

import { MemoryV3ConfigSchema } from "../memory-v3.js";

describe("MemoryV3ConfigSchema", () => {
  test("parses an empty object to documented defaults", () => {
    const parsed = MemoryV3ConfigSchema.parse({});
    expect(parsed).toEqual({
      workingSet: { maxPages: 150, evictWindow: 5 },
      l2Concurrency: 16,
    });
  });

  test("accepts an explicit l2Concurrency override", () => {
    expect(MemoryV3ConfigSchema.parse({ l2Concurrency: 8 }).l2Concurrency).toBe(
      8,
    );
  });

  test("rejects a non-positive or non-integer l2Concurrency", () => {
    expect(() => MemoryV3ConfigSchema.parse({ l2Concurrency: 0 })).toThrow();
    expect(() => MemoryV3ConfigSchema.parse({ l2Concurrency: -4 })).toThrow();
    expect(() => MemoryV3ConfigSchema.parse({ l2Concurrency: 1.5 })).toThrow();
  });
});
