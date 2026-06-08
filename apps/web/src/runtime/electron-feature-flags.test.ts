/**
 * Tests for the Electron feature-flag bridge hook. The Zustand store and the
 * Electron platform check are mocked so the hook runs without a real store or
 * desktop host. The contract under test: it publishes the renderer's flag map
 * to main on Electron, no-ops off Electron, and — critically — does not throw
 * when an older preload predates the `featureFlags` channel, since the hook
 * mounts in `RootLayout` for every Electron session before first render.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import { cleanup, renderHook } from "@testing-library/react";

let runningInElectron = false;
mock.module("@/runtime/is-electron", () => ({
  isElectron: () => runningInElectron,
}));

const flagState: Record<string, boolean> = { betaThing: true };
mock.module("@/stores/assistant-feature-flag-store", () => ({
  useAssistantFeatureFlagStore: {
    getState: () => flagState,
    subscribe: () => () => {},
  },
}));

mock.module("@/stores/client-feature-flag-store", () => ({
  useClientFeatureFlagStore: {
    getState: () => ({}),
    subscribe: () => () => {},
  },
}));

mock.module("@/lib/feature-flags/feature-flag-catalog", () => ({
  ASSISTANT_FLAG_DEFAULTS: { betaThing: false },
  CLIENT_FLAG_DEFAULTS: {},
  storeKeyToFlagKey: (key: string) => key,
}));

const { useElectronFeatureFlagBridge } = await import(
  "./electron-feature-flags"
);

afterEach(() => {
  cleanup();
  runningInElectron = false;
  delete (window as { vellum?: unknown }).vellum;
});

describe("useElectronFeatureFlagBridge", () => {
  test("no-ops off Electron", () => {
    const set = mock(() => {});
    (window as { vellum?: unknown }).vellum = { featureFlags: { set } };

    renderHook(() => useElectronFeatureFlagBridge());

    expect(set).not.toHaveBeenCalled();
  });

  test("publishes the flag map over the bridge on Electron", () => {
    runningInElectron = true;
    const set = mock(() => {});
    (window as { vellum?: unknown }).vellum = { featureFlags: { set } };

    renderHook(() => useElectronFeatureFlagBridge());

    expect(set).toHaveBeenCalledWith({ betaThing: true });
  });

  // Version skew: a newer web bundle can run against an older preload whose
  // platform is still "electron" but which predates the featureFlags channel.
  // The mount-time sync must no-op rather than throw before first render.
  test("no-ops when the older preload lacks the featureFlags channel", () => {
    runningInElectron = true;
    (window as { vellum?: unknown }).vellum = { platform: "electron" };

    expect(() =>
      renderHook(() => useElectronFeatureFlagBridge()),
    ).not.toThrow();
  });
});
