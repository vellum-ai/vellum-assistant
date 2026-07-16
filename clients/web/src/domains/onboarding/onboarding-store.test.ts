/**
 * Contract tests for the onboarding store's server-effective verdict fields:
 * in-memory only — boot null, never device-persisted, never cross-tab
 * synced — unlike the device-backed share toggles beside them.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { useOnboardingStore } from "@/domains/onboarding/onboarding-store";

beforeEach(() => {
  localStorage.clear();
  useOnboardingStore.setState({
    shareAnalytics: null,
    shareDiagnostics: null,
    serverAnalyticsEffective: null,
    serverDiagnosticsEffective: null,
  });
});

describe("server-effective verdict fields", () => {
  test("boot null (no sync yet)", () => {
    expect(useOnboardingStore.getState().serverAnalyticsEffective).toBeNull();
    expect(useOnboardingStore.getState().serverDiagnosticsEffective).toBeNull();
  });

  test("setters round-trip booleans and null", () => {
    const store = useOnboardingStore.getState();
    store.setServerAnalyticsEffective(false);
    store.setServerDiagnosticsEffective(true);
    expect(useOnboardingStore.getState().serverAnalyticsEffective).toBe(false);
    expect(useOnboardingStore.getState().serverDiagnosticsEffective).toBe(true);
    store.setServerAnalyticsEffective(null);
    store.setServerDiagnosticsEffective(null);
    expect(useOnboardingStore.getState().serverAnalyticsEffective).toBeNull();
    expect(useOnboardingStore.getState().serverDiagnosticsEffective).toBeNull();
  });

  test("setters write no device keys (in-memory only)", () => {
    useOnboardingStore.getState().setServerAnalyticsEffective(true);
    useOnboardingStore.getState().setServerDiagnosticsEffective(false);
    expect(localStorage.length).toBe(0);
  });

  test("cross-tab share-toggle sync leaves the verdicts untouched (not wired)", () => {
    useOnboardingStore.getState().setServerAnalyticsEffective(false);
    // Simulate another tab flipping the device-persisted analytics toggle:
    // the watcher updates the tri-state, but the server verdict rides no
    // device key, so nothing can sync it across tabs.
    localStorage.setItem("device:share_analytics", "true");
    window.dispatchEvent(
      new CustomEvent("vellum:pref-changed", {
        detail: { key: "device:share_analytics", value: "true" },
      }),
    );
    expect(useOnboardingStore.getState().shareAnalytics).toBe(true);
    expect(useOnboardingStore.getState().serverAnalyticsEffective).toBe(false);
  });
});
