/**
 * Global test utility for mocking gateway IPC calls.
 *
 * Usage:
 *   import { mockGatewayIpc, resetMockGatewayIpc } from "../__tests__/mock-gateway-ipc.js";
 *
 *   beforeEach(() => resetMockGatewayIpc());
 *   afterEach(() => resetMockGatewayIpc());
 *
 *   it("uses IPC flags", async () => {
 *     mockGatewayIpc({ "my-flag": true });
 *     await initFeatureFlagOverrides();
 *     ...
 *   });
 *
 *   it("simulates socket error", async () => {
 *     mockGatewayIpc(null, { error: true });
 *     ...
 *   });
 *
 * The mock is registered in the test preload (test-preload.ts) so every test
 * file gets a no-op IPC layer by default — no test accidentally connects to
 * a real gateway socket. Call `mockGatewayIpc()` to configure specific
 * responses when the test cares about the IPC result.
 *
 * Mocks `gateway-client.ts` (not `node:net`) so that proxy / tunnel tests
 * that need real TCP sockets continue to work.
 */

import { mock } from "bun:test";

// ---------------------------------------------------------------------------
// Configurable state
// ---------------------------------------------------------------------------

/** Feature flag values the fake gateway IPC will return. */
let featureFlags: Record<string, boolean> = {};

/** Raw IPC results keyed by method name (for non-feature-flag methods). */
let ipcResults: Record<string, unknown> = {};

/** Whether ipcCall / ipcGetFeatureFlags should return empty / error-like. */
let simulateError = false;

// ---------------------------------------------------------------------------
// Register the mock (called once from test-preload.ts)
// ---------------------------------------------------------------------------

export function installGatewayIpcMock(): void {
  mock.module("../ipc/gateway-client.js", () => ({
    async ipcCall(method: string) {
      if (simulateError) {
        return undefined;
      }
      if (method in ipcResults) {
        return ipcResults[method];
      }
      if (method === "get_feature_flags") {
        return featureFlags;
      }
      return undefined;
    },
    async ipcGetFeatureFlags() {
      if (simulateError) {
        return {};
      }
      return { ...featureFlags };
    },
  }));
}

// ---------------------------------------------------------------------------
// Public API for tests
// ---------------------------------------------------------------------------

/**
 * Configure the fake gateway IPC response.
 *
 * @param flags — feature flag map returned by `get_feature_flags` /
 *   `ipcGetFeatureFlags`. Pass `null` to skip setting flags (useful when
 *   only simulating errors or setting raw results).
 * @param opts.error — simulate a socket connection error (ipcCall returns
 *   undefined, ipcGetFeatureFlags returns {})
 * @param opts.results — raw method->result map for arbitrary IPC methods
 */
export function mockGatewayIpc(
  flags?: Record<string, boolean> | null,
  opts?: { error?: boolean; results?: Record<string, unknown> },
): void {
  if (flags != null) {
    featureFlags = { ...flags };
  }
  if (opts?.results) {
    Object.assign(ipcResults, opts.results);
  }
  if (opts?.error) {
    simulateError = true;
  }
}

/**
 * Reset all IPC mock state back to defaults (empty flags, no errors).
 */
export function resetMockGatewayIpc(): void {
  featureFlags = {};
  ipcResults = {};
  simulateError = false;
}
