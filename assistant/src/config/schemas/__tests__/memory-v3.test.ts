import { describe, expect, test } from "bun:test";

import { MemoryV3ConfigSchema } from "../memory-v3.js";

describe("MemoryV3ConfigSchema", () => {
  test("parses an empty object to documented defaults", () => {
    const parsed = MemoryV3ConfigSchema.parse({});
    expect(parsed).toEqual({
      workingSet: { maxPages: 150, evictWindow: 5 },
      needleK: 100,
      denseK: 100,
      edge: { hubDegree: 30, seedCount: 18, perSeed: 6, cap: 45 },
    });
  });

  test("accepts explicit lane-K overrides", () => {
    const parsed = MemoryV3ConfigSchema.parse({ needleK: 50, denseK: 75 });
    expect(parsed.needleK).toBe(50);
    expect(parsed.denseK).toBe(75);
  });

  test("accepts a partial edge override, defaulting the rest", () => {
    const parsed = MemoryV3ConfigSchema.parse({ edge: { hubDegree: 10 } });
    expect(parsed.edge).toEqual({
      hubDegree: 10,
      seedCount: 18,
      perSeed: 6,
      cap: 45,
    });
  });

  test("rejects non-positive or non-integer lane knobs", () => {
    expect(() => MemoryV3ConfigSchema.parse({ needleK: 0 })).toThrow();
    expect(() => MemoryV3ConfigSchema.parse({ denseK: -4 })).toThrow();
    expect(() => MemoryV3ConfigSchema.parse({ needleK: 1.5 })).toThrow();
    expect(() =>
      MemoryV3ConfigSchema.parse({ edge: { perSeed: 0 } }),
    ).toThrow();
    expect(() => MemoryV3ConfigSchema.parse({ edge: { cap: -1 } })).toThrow();
  });
});
