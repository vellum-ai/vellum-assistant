/**
 * `conceptPageCount` decides whether the identity Memory card shows a number
 * at all. The card is now unconditional, so this is the only thing standing
 * between a v1 or memory-off assistant and a "0 memories" stat that reads as
 * "I remember nothing about you".
 */
import { describe, expect, test } from "bun:test";

import {
  conceptPageCount,
  type MemoryStatsResult,
  type MemoryTier,
} from "./get-memory-stats";

const ready = (
  tier: MemoryTier,
  concepts = 7,
  graphSupported = tier === "v3",
): MemoryStatsResult => ({
  kind: "ready",
  concepts,
  graphSupported,
  tier,
});

describe("conceptPageCount", () => {
  test.each(["v2", "v3"] as const)(
    "reports the count on tier %s, where concept pages are the substrate",
    (tier) => {
      expect(conceptPageCount(ready(tier))).toBe(7);
    },
  );

  test("reports zero as a real measurement on a v3 assistant", () => {
    // An empty v3 corpus genuinely holds nothing — "0 memories" is true here.
    expect(conceptPageCount(ready("v3", 0))).toBe(0);
  });

  test.each(["off", "v1"] as const)(
    "reports nothing on tier %s, where the count is a meaningless zero",
    (tier) => {
      expect(conceptPageCount(ready(tier, 0))).toBeUndefined();
    },
  );

  test("falls back to the capability bit when the daemon omits tier", () => {
    // Daemons predating `tier` still send `graph_supported`.
    expect(
      conceptPageCount({
        kind: "ready",
        concepts: 4,
        graphSupported: true,
        tier: undefined,
      }),
    ).toBe(4);
    expect(
      conceptPageCount({
        kind: "ready",
        concepts: 4,
        graphSupported: false,
        tier: undefined,
      }),
    ).toBeUndefined();
  });

  test("reports nothing while loading or against an unsupported daemon", () => {
    expect(conceptPageCount(undefined)).toBeUndefined();
    expect(conceptPageCount({ kind: "unsupported" })).toBeUndefined();
  });
});
