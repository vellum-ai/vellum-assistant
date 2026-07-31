import { describe, expect, test } from "bun:test";

import {
  allowedMachineSizesForTier,
  lowersMachineCeiling,
  MACHINE_FLOOR_SIZE,
  MACHINE_SIZE_ORDER,
  machineCeilingForTier,
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

describe("machineCeilingForTier", () => {
  test("resolves a known tier to its largest allowed size", () => {
    expect(machineCeilingForTier("medium")).toBe("medium");
    expect(machineCeilingForTier("large")).toBe("large");
    expect(machineCeilingForTier("xl")).toBe("extra_large");
  });

  test("resolves a tier naming no machine to no ceiling", () => {
    expect(machineCeilingForTier(null)).toBeNull();
    expect(machineCeilingForTier(undefined)).toBeNull();
  });

  test("resolves a tier this bundle doesn't know to no ceiling", () => {
    expect(machineCeilingForTier("gargantuan")).toBeNull();
  });
});

describe("lowersMachineCeiling", () => {
  test("a step down the tier ladder lowers the ceiling", () => {
    expect(lowersMachineCeiling("xl", "large")).toBe(true);
    expect(lowersMachineCeiling("large", "medium")).toBe(true);
  });

  test("a step up, or no step at all, does not", () => {
    expect(lowersMachineCeiling("medium", "large")).toBe(false);
    expect(lowersMachineCeiling("large", "xl")).toBe(false);
    expect(lowersMachineCeiling("large", "large")).toBe(false);
  });

  test("moving to a tier naming no machine drops to the floor", () => {
    // A machine-less package (Mighty) settles at the floor, so anything above
    // it shrinks and the floor itself stays put.
    expect(lowersMachineCeiling("medium", null)).toBe(true);
    expect(lowersMachineCeiling(null, null)).toBe(false);
  });

  test("moving off a tier naming no machine only ever raises", () => {
    expect(lowersMachineCeiling(null, "medium")).toBe(false);
    expect(lowersMachineCeiling(null, "xl")).toBe(false);
  });

  test("the floor is the size a machine-less tier resolves to", () => {
    // The comparison above rests on this, and `machineFloor` in the
    // provisioning hook displays the same size.
    expect(MACHINE_SIZE_ORDER[0]).toBe(MACHINE_FLOOR_SIZE);
  });

  test("a tier it cannot rank reads as able to lower, on either side", () => {
    // Guessing here would hand the fast no-op inference to a move that may
    // really be shrinking the pod.
    expect(lowersMachineCeiling("gargantuan", "medium")).toBe(true);
    expect(lowersMachineCeiling("medium", "gargantuan")).toBe(true);
  });
});
