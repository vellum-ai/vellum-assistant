import { describe, expect, test } from "bun:test";

import { MemoryV3ConfigSchema } from "../memory-v3.js";

describe("MemoryV3ConfigSchema", () => {
  test("parses an empty object to documented defaults", () => {
    const parsed = MemoryV3ConfigSchema.parse({});
    expect(parsed).toEqual({
      workingSet: { maxPages: 150, evictWindow: 5 },
      prune: { maxResidentBytes: 393216, targetResidentBytes: 262144 },
      hotSet: { k: 40, halfLifeDays: 14 },
      spotlight: { n: 6, windowTurns: 2 },
      needleK: 100,
      denseK: 100,
      edge: { hubDegree: 30, seedCount: 18, perSeed: 6, cap: 45 },
    });
  });

  test("prune: accepts partial overrides and enforces target < max", () => {
    const parsed = MemoryV3ConfigSchema.parse({
      prune: { maxResidentBytes: 500000 },
    });
    expect(parsed.prune).toEqual({
      maxResidentBytes: 500000,
      targetResidentBytes: 262144,
    });
    // target must be strictly below max (defaults included in the check).
    expect(() =>
      MemoryV3ConfigSchema.parse({
        prune: { maxResidentBytes: 100000 },
      }),
    ).toThrow();
    expect(() =>
      MemoryV3ConfigSchema.parse({
        prune: { maxResidentBytes: 1000, targetResidentBytes: 1000 },
      }),
    ).toThrow();
    expect(() =>
      MemoryV3ConfigSchema.parse({
        prune: { maxResidentBytes: 0 },
      }),
    ).toThrow();
    expect(() =>
      MemoryV3ConfigSchema.parse({
        prune: { targetResidentBytes: 1.5 },
      }),
    ).toThrow();
  });

  test("accepts a partial spotlight override and rejects invalid knobs", () => {
    const parsed = MemoryV3ConfigSchema.parse({ spotlight: { n: 3 } });
    expect(parsed.spotlight).toEqual({ n: 3, windowTurns: 2 });
    // windowTurns: 0 is valid — current turn only, no carried window.
    expect(
      MemoryV3ConfigSchema.parse({ spotlight: { windowTurns: 0 } }).spotlight,
    ).toEqual({ n: 6, windowTurns: 0 });
    expect(() => MemoryV3ConfigSchema.parse({ spotlight: { n: 0 } })).toThrow();
    expect(() =>
      MemoryV3ConfigSchema.parse({ spotlight: { windowTurns: -1 } }),
    ).toThrow();
    expect(() =>
      MemoryV3ConfigSchema.parse({ spotlight: { n: 1.5 } }),
    ).toThrow();
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
