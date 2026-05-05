/**
 * Global test utility for mocking gateway IPC calls via
 * `@vellumai/gateway-client/ipc-client`.
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
 *     mockGatewayIpc(null, { error: true, code: "ENOENT" });
 *     ...
 *   });
 *
 * The mock is registered in the test preload (test-preload.ts) so every test
 * file gets a no-op IPC layer by default — no test accidentally connects to
 * a real gateway socket. Call `mockGatewayIpc()` to configure specific
 * responses when the test cares about the IPC result.
 *
 * Mocks `@vellumai/gateway-client/ipc-client` at the package level so the
 * assistant's thin wrapper in `ipc/gateway-client.ts` (which delegates to
 * the package) gets the fake implementation. Non-gateway IPC paths (e.g.
 * CLI IPC) are unaffected since they don't import from the package.
 */

import { EventEmitter } from "node:events";
import { mock } from "bun:test";

// ---------------------------------------------------------------------------
// Configurable state
// ---------------------------------------------------------------------------

/** IPC result the fake gateway will return (keyed by method name). */

let ipcResults: Record<string, unknown> = {};

/** Whether the fake ipcCall should simulate a connection error. */
let simulateError = false;

// ---------------------------------------------------------------------------
// FakePersistentIpcClient — mirrors PersistentIpcClient API
// ---------------------------------------------------------------------------

class FakePersistentIpcClient extends EventEmitter {
  async call(
    method: string,
    _params?: Record<string, unknown>,
  ): Promise<unknown> {
    if (simulateError) {
      throw new Error("Mock IPC socket error");
    }
    return method in ipcResults ? ipcResults[method] : undefined;
  }

  destroy(): void {
    /* no-op */
  }
}

// ---------------------------------------------------------------------------
// Register the mock (called once from test-preload.ts)
// ---------------------------------------------------------------------------

export function installGatewayIpcMock(): void {
  mock.module("@vellumai/gateway-client/ipc-client", () => ({
    ipcCall: async (
      _socketPath: string,
      method: string,
      _params?: Record<string, unknown>,
    ): Promise<unknown> => {
      if (simulateError) {
        // Real ipcCall returns undefined on failure — mirror that behavior.
        return undefined;
      }
      return method in ipcResults ? ipcResults[method] : undefined;
    },
    PersistentIpcClient: FakePersistentIpcClient,
  }));
}

// ---------------------------------------------------------------------------
// Public API for tests
// ---------------------------------------------------------------------------

/**
 * Configure the fake gateway IPC response.
 *
 * @param flags — feature flag map returned by `get_feature_flags`. Pass
 *   `null` to skip setting a result (useful when only simulating errors).
 * @param opts.error — simulate a socket connection error
 * @param opts.code — error code (kept for API compat, unused by package mock)
 * @param opts.results — raw method->result map for arbitrary IPC methods
 */
export function mockGatewayIpc(
  flags?: Record<string, boolean> | null,
  opts?: { error?: boolean; code?: string; results?: Record<string, unknown> },
): void {
  if (flags != null) {
    ipcResults["get_feature_flags"] = flags;
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
  ipcResults = {};
  simulateError = false;
}
