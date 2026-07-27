/**
 * Tests for the `marketing-pricing-takeover` read seam — in particular the
 * three-state result, which keeps the default-off flag from reading as
 * "disabled" before its real value has landed.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import { useMarketingPricingTakeover } from "@/hooks/use-marketing-pricing-takeover";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";

beforeEach(() => {
  useClientFeatureFlagStore.setState({
    marketingPricingTakeover: false,
    hydrated: false,
  });
});

afterEach(() => {
  cleanup();
  useClientFeatureFlagStore.setState({
    marketingPricingTakeover: false,
    hydrated: false,
  });
});

describe("useMarketingPricingTakeover", () => {
  test("is pending before the flag values land", () => {
    const { result } = renderHook(() => useMarketingPricingTakeover());
    expect(result.current).toBe("pending");
  });

  test("is disabled once the flags hydrate off", () => {
    useClientFeatureFlagStore.getState().setFlags({
      marketingPricingTakeover: false,
    });
    const { result } = renderHook(() => useMarketingPricingTakeover());
    expect(result.current).toBe("disabled");
  });

  test("is enabled once the flags hydrate on", () => {
    useClientFeatureFlagStore.getState().setFlags({
      marketingPricingTakeover: true,
    });
    const { result } = renderHook(() => useMarketingPricingTakeover());
    expect(result.current).toBe("enabled");
  });

  test("an override reads enabled without waiting for hydration", () => {
    // Local/env overrides apply synchronously at store init, so a `true` value
    // is decisive on its own.
    useClientFeatureFlagStore.setState({
      marketingPricingTakeover: true,
      hydrated: false,
    });
    const { result } = renderHook(() => useMarketingPricingTakeover());
    expect(result.current).toBe("enabled");
  });
});
