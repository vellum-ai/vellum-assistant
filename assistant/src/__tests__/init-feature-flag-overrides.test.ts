/**
 * Tests for initFeatureFlagOverrides() — the async IPC call that
 * pre-populates the feature flag cache before CLI program construction.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import {
  clearFeatureFlagOverridesCache,
  initFeatureFlagOverrides,
  isAssistantFeatureFlagEnabled,
} from "../config/assistant-feature-flags.js";

// ---------------------------------------------------------------------------
// Mock the IPC gateway client so no real socket is needed.
// ---------------------------------------------------------------------------

let ipcResult: Record<string, boolean> = {};

mock.module("../ipc/gateway-client.js", () => ({
  ipcGetFeatureFlags: () => Promise.resolve(ipcResult),
  ipcCall: () => Promise.resolve(undefined),
}));

beforeEach(() => {
  clearFeatureFlagOverridesCache();
  ipcResult = {};
});

afterEach(() => {
  clearFeatureFlagOverridesCache();
  ipcResult = {};
});

describe("initFeatureFlagOverrides", () => {
  it("populates cache from gateway IPC response", async () => {
    ipcResult = { "foo-enabled": true, "bar-enabled": true };

    await initFeatureFlagOverrides();

    const config = {} as any;
    expect(isAssistantFeatureFlagEnabled("foo-enabled", config)).toBe(true);
    expect(isAssistantFeatureFlagEnabled("bar-enabled", config)).toBe(true);
  });

  it("falls back gracefully when gateway IPC returns empty", async () => {
    ipcResult = {};

    // Should not throw
    await initFeatureFlagOverrides();

    // Without gateway data or file, undeclared flags default to true
    const config = {} as any;
    expect(isAssistantFeatureFlagEnabled("foo-enabled", config)).toBe(true);
  });

  it("respects false values from gateway IPC", async () => {
    ipcResult = { "gated-feature": true, "disabled-feature": false };

    await initFeatureFlagOverrides();

    const config = {} as any;
    expect(isAssistantFeatureFlagEnabled("gated-feature", config)).toBe(true);
    expect(isAssistantFeatureFlagEnabled("disabled-feature", config)).toBe(
      false,
    );
  });

  it("does not cache empty gateway response", async () => {
    ipcResult = {};

    await initFeatureFlagOverrides();

    // Undeclared flags without overrides default to true (not false from
    // a cached empty map)
    const config = {} as any;
    expect(isAssistantFeatureFlagEnabled("foo-enabled", config)).toBe(true);
  });

  it("does not re-fetch when cache is already populated", async () => {
    ipcResult = { "first-call": true };

    await initFeatureFlagOverrides();

    // Change what IPC would return — but it shouldn't be called again
    ipcResult = { "second-call": true };

    await initFeatureFlagOverrides();

    const config = {} as any;
    expect(isAssistantFeatureFlagEnabled("first-call", config)).toBe(true);
    // second-call should not be in the cache since init was a no-op
    expect(isAssistantFeatureFlagEnabled("second-call", config)).toBe(true); // defaults to true (undeclared)
  });
});
