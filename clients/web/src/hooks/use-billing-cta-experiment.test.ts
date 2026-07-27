/**
 * Tests for the `experiment-billing-cta-2026-07-23` read seam: the pure arm
 * predicate and the store-backed hook that defaults to "control" until flags
 * hydrate.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import {
  isBillingCtaUpgradeArm,
  useBillingCtaExperimentArm,
} from "@/hooks/use-billing-cta-experiment";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";

beforeEach(() => {
  // Reset the arm to its "control" default before each test so a value set by
  // an earlier test can't leak in.
  useClientFeatureFlagStore
    .getState()
    .setStringFlags({ experimentBillingCta20260723: "control" });
});

afterEach(() => {
  cleanup();
});

describe("isBillingCtaUpgradeArm", () => {
  test("is true only for the upgrade-cta arm", () => {
    expect(isBillingCtaUpgradeArm("upgrade-cta")).toBe(true);
  });

  test("is false for control, empty, and unknown arms", () => {
    expect(isBillingCtaUpgradeArm("control")).toBe(false);
    expect(isBillingCtaUpgradeArm("")).toBe(false);
    expect(isBillingCtaUpgradeArm("something-else")).toBe(false);
  });
});

describe("useBillingCtaExperimentArm", () => {
  test("defaults to control", () => {
    const { result } = renderHook(() => useBillingCtaExperimentArm());
    expect(result.current).toBe("control");
  });

  test("reflects the arm set on the store", () => {
    useClientFeatureFlagStore
      .getState()
      .setStringFlags({ experimentBillingCta20260723: "upgrade-cta" });
    const { result } = renderHook(() => useBillingCtaExperimentArm());
    expect(result.current).toBe("upgrade-cta");
  });
});
