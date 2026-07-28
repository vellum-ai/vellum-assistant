/**
 * Tests for the `marketing-pricing-takeover` read seam — in particular the
 * three-state result, which keeps the default-off flag from reading as
 * "disabled" before its real value has landed.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

import { useMarketingPricingTakeover } from "@/hooks/use-marketing-pricing-takeover";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";

const initialState = useClientFeatureFlagStore.getState();

beforeEach(() => {
  useClientFeatureFlagStore.setState(initialState, true);
});

afterEach(() => {
  cleanup();
  useClientFeatureFlagStore.setState(initialState, true);
});

describe("useMarketingPricingTakeover", () => {
  test("is pending before the flag values land", () => {
    const { result } = renderHook(() => useMarketingPricingTakeover());
    expect(result.current).toBe("pending");
  });

  test("is disabled once the flags hydrate off", () => {
    useClientFeatureFlagStore
      .getState()
      .setFlags({ marketingPricingTakeover: false }, null);
    const { result } = renderHook(() => useMarketingPricingTakeover());
    expect(result.current).toBe("disabled");
  });

  test("is enabled once the flags hydrate on", () => {
    useClientFeatureFlagStore
      .getState()
      .setFlags({ marketingPricingTakeover: true }, null);
    const { result } = renderHook(() => useMarketingPricingTakeover());
    expect(result.current).toBe("enabled");
  });

  test("a signed-out `false` does not read as disabled once the visitor signs in", () => {
    // The marketing page evaluates this flag for an anonymous visitor and the
    // app evaluates it for the signed-in user + org, so the two answers
    // legitimately differ. Reading the pre-auth answer as settled would bounce
    // a checkout deep link the signed-in user is entitled to.
    const store = useClientFeatureFlagStore.getState();
    store.beginScope("anonymous:org:none");
    store.setFlags({ marketingPricingTakeover: false }, "anonymous:org:none");

    useClientFeatureFlagStore
      .getState()
      .beginScope("user:user-123:org:org-abc");

    const { result } = renderHook(() => useMarketingPricingTakeover());
    expect(result.current).toBe("pending");

    act(() => {
      useClientFeatureFlagStore
        .getState()
        .setFlags(
          { marketingPricingTakeover: true },
          "user:user-123:org:org-abc",
        );
    });
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
