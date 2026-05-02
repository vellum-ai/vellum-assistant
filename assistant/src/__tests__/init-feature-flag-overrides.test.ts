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

    // Disable retries — production retries the IPC fetch on failure to
    // dodge the daemon-vs-gateway startup race, but here we're explicitly
    // testing the no-gateway fallback and don't want the test to wait
    // through the backoff schedule.
    await initFeatureFlagOverrides({ retryBackoffsMs: [] });

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

    // Disable retries — this test explicitly simulates a sustained empty
    // response (gateway up but reporting zero flags) and should not wait
    // through the production backoff schedule.
    await initFeatureFlagOverrides({ retryBackoffsMs: [] });

    // Undeclared flags without overrides default to true (not false from
    // a cached empty map)
    const config = {} as any;
    expect(isAssistantFeatureFlagEnabled("foo-enabled", config)).toBe(true);
  });

  it("retries empty gateway responses and picks up flags once they become available", async () => {
    // Simulate the daemon-vs-gateway startup race: the first IPC call
    // returns empty (gateway not yet ready), but a later attempt sees
    // the populated flag map. The retry loop in init should bridge this
    // gap without losing the flag.
    mockGatewayIpc({});
    setTimeout(() => {
      resetMockGatewayIpc();
      mockGatewayIpc({ "retry-test-flag": true });
    }, 50);

    await initFeatureFlagOverrides({ retryBackoffsMs: [200] });

    const config = {} as any;
    expect(isAssistantFeatureFlagEnabled("retry-test-flag", config)).toBe(true);
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
