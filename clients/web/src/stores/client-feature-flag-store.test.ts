/**
 * Tests for how the client flag store handles a change of evaluation scope.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import {
  CLIENT_FLAG_DEFAULTS,
  CLIENT_STRING_FLAG_DEFAULTS,
} from "@/lib/feature-flags/feature-flag-catalog";

const initialState = useClientFeatureFlagStore.getState();

beforeEach(() => {
  localStorage.clear();
  useClientFeatureFlagStore.setState(initialState, true);
});

describe("beginScope", () => {
  test("drops the previous identity's values and re-opens hydration", () => {
    useClientFeatureFlagStore.getState().beginScope("anonymous:org:none");
    useClientFeatureFlagStore
      .getState()
      .setFlags({ marketingPricingTakeover: true });

    useClientFeatureFlagStore.getState().beginScope("user:user-123:org:org-abc");

    const state = useClientFeatureFlagStore.getState();
    expect(state.hydrated).toBe(false);
    expect(state.marketingPricingTakeover).toBe(
      CLIENT_FLAG_DEFAULTS.marketingPricingTakeover,
    );
  });

  test("drops the previous identity's string values too", () => {
    useClientFeatureFlagStore.getState().beginScope("anonymous:org:none");
    useClientFeatureFlagStore
      .getState()
      .setStringFlags({ proactiveTips: "on" });

    useClientFeatureFlagStore.getState().beginScope("user:user-123:org:org-abc");

    expect(
      useClientFeatureFlagStore.getState().stringFlags.proactiveTips,
    ).toBe(CLIENT_STRING_FLAG_DEFAULTS.proactiveTips);
  });

  test("is a no-op for the scope already claimed", () => {
    useClientFeatureFlagStore.getState().beginScope("user:user-123:org:org-abc");
    useClientFeatureFlagStore
      .getState()
      .setFlags({ marketingPricingTakeover: true });

    useClientFeatureFlagStore.getState().beginScope("user:user-123:org:org-abc");

    const state = useClientFeatureFlagStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.marketingPricingTakeover).toBe(true);
  });

  test("keeps local overrides across a scope change", () => {
    localStorage.setItem("vellum:ff:marketingPricingTakeover", "true");
    useClientFeatureFlagStore.getState().beginScope("anonymous:org:none");

    useClientFeatureFlagStore.getState().beginScope("user:user-123:org:org-abc");

    expect(
      useClientFeatureFlagStore.getState().marketingPricingTakeover,
    ).toBe(true);
  });
});
