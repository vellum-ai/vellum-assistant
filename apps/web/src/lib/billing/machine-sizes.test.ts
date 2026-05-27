import { describe, expect, test } from "bun:test";

import {
  allowedMachineSizesForTier,
  MACHINE_SIZE_ORDER,
  machineSizeRank,
  SIZE_DESCRIPTION,
  SIZE_LABEL,
  TIER_TO_SIZES,
} from "@/lib/billing/machine-sizes";

describe("machine-sizes", () => {
  test("TIER_TO_SIZES maps medium→[small,medium]", () => {
    expect(TIER_TO_SIZES.medium).toEqual(["small", "medium"]);
  });

  test("TIER_TO_SIZES maps xl→[small,medium,large,extra_large]", () => {
    expect(TIER_TO_SIZES.xl).toEqual([
      "small",
      "medium",
      "large",
      "extra_large",
    ]);
  });

  test("allowedMachineSizesForTier returns sizes for known tier", () => {
    expect(allowedMachineSizesForTier("large")).toEqual([
      "small",
      "medium",
      "large",
    ]);
  });

  test("allowedMachineSizesForTier returns empty list for null", () => {
    expect(allowedMachineSizesForTier(null)).toEqual([]);
  });

  test("allowedMachineSizesForTier returns empty list for undefined", () => {
    expect(allowedMachineSizesForTier(undefined)).toEqual([]);
  });

  test("allowedMachineSizesForTier returns empty list for unknown tier", () => {
    expect(allowedMachineSizesForTier("gargantuan")).toEqual([]);
  });

  test("SIZE_LABEL maps extra_large to Extra Large", () => {
    expect(SIZE_LABEL.extra_large).toBe("Extra Large");
  });

  test("SIZE_DESCRIPTION includes GiB for medium", () => {
    expect(SIZE_DESCRIPTION.medium).toContain("5 GiB");
  });

  test("machineSizeRank is strictly increasing across the order", () => {
    const ranks = MACHINE_SIZE_ORDER.map(machineSizeRank);
    for (let i = 1; i < ranks.length; i++) {
      expect(ranks[i]).toBeGreaterThan(ranks[i - 1]);
    }
  });
});
