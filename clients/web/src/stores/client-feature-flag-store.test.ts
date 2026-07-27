/**
 * Tests for the two ways the client flag store leaves the pre-hydration
 * window: claiming a new evaluation scope, and settling when no server values
 * are coming.
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

describe("settleWithoutServerValues", () => {
  test("settles an unhydrated scope on the registry defaults", () => {
    // A value left over from somewhere other than this scope's own response.
    useClientFeatureFlagStore.setState({
      marketingPricingTakeover: true,
      hydrated: false,
    });

    useClientFeatureFlagStore.getState().settleWithoutServerValues();

    const state = useClientFeatureFlagStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.marketingPricingTakeover).toBe(
      CLIENT_FLAG_DEFAULTS.marketingPricingTakeover,
    );
  });

  test("keeps the last server values when a refresh fails after a success", () => {
    // A failed background refresh must not switch a legitimately-enabled
    // feature off mid-session — potentially while the user is in checkout.
    useClientFeatureFlagStore
      .getState()
      .setFlags({ marketingPricingTakeover: true });
    expect(useClientFeatureFlagStore.getState().hydrated).toBe(true);

    useClientFeatureFlagStore.getState().settleWithoutServerValues();

    const state = useClientFeatureFlagStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.marketingPricingTakeover).toBe(true);
  });

  test("keeps a local override rather than the registry default", () => {
    localStorage.setItem("vellum:ff:marketingPricingTakeover", "true");

    useClientFeatureFlagStore.getState().settleWithoutServerValues();

    expect(
      useClientFeatureFlagStore.getState().marketingPricingTakeover,
    ).toBe(true);
  });
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
