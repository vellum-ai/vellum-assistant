/**
 * Tests for initFeatureFlagOverrides() — the async IPC call that
 * pre-populates the feature flag cache before CLI program construction.
 *
 * Uses the shared mock-gateway-ipc utility (installed in test-preload.ts)
 * which mocks node:net so no test connects to a real gateway socket.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  mockGatewayIpc,
  resetMockGatewayIpc,
} from "../__tests__/mock-gateway-ipc.js";
import {
  clearFeatureFlagOverridesCache,
  initFeatureFlagOverrides,
  isAssistantFeatureFlagEnabled,
} from "../config/assistant-feature-flags.js";

beforeEach(() => {
  clearFeatureFlagOverridesCache();
  resetMockGatewayIpc();
});

afterEach(() => {
  clearFeatureFlagOverridesCache();
  resetMockGatewayIpc();
});

describe("initFeatureFlagOverrides", () => {
  it("populates cache from gateway IPC response", async () => {
    mockGatewayIpc({ "foo-enabled": true, "bar-enabled": true });

    await initFeatureFlagOverrides();

    const config = {} as any;
    expect(isAssistantFeatureFlagEnabled("foo-enabled", config)).toBe(true);
    expect(isAssistantFeatureFlagEnabled("bar-enabled", config)).toBe(true);
  });

  it("falls back gracefully when gateway socket is unavailable", async () => {
    mockGatewayIpc(null, { error: true });

    // Should not throw
    await initFeatureFlagOverrides();

    // Without gateway data or file, undeclared flags default to true
    const config = {} as any;
    expect(isAssistantFeatureFlagEnabled("foo-enabled", config)).toBe(true);
  });

  it("respects false values from gateway IPC", async () => {
    mockGatewayIpc({ "gated-feature": true, "disabled-feature": false });

    await initFeatureFlagOverrides();

    const config = {} as any;
    expect(isAssistantFeatureFlagEnabled("gated-feature", config)).toBe(true);
    expect(isAssistantFeatureFlagEnabled("disabled-feature", config)).toBe(
      false,
    );
  });

  it("does not cache empty gateway response", async () => {
    mockGatewayIpc({});

    await initFeatureFlagOverrides();

    // Undeclared flags without overrides default to true (not false from
    // a cached empty map)
    const config = {} as any;
    expect(isAssistantFeatureFlagEnabled("foo-enabled", config)).toBe(true);
  });

  it("does not re-fetch when cache is already populated", async () => {
    mockGatewayIpc({ "first-call": true });

    await initFeatureFlagOverrides();

    // Change what IPC would return — if the guard is broken and init
    // re-fetches, "first-call" would flip to false.
    resetMockGatewayIpc();
    mockGatewayIpc({ "first-call": false, "second-call": true });

    await initFeatureFlagOverrides();

    const config = {} as any;
    // first-call must still be true (from the cached first fetch)
    expect(isAssistantFeatureFlagEnabled("first-call", config)).toBe(true);
    // second-call should not be in the cache since init was a no-op
    expect(isAssistantFeatureFlagEnabled("second-call", config)).toBe(true); // defaults to true (undeclared)
  });
});
