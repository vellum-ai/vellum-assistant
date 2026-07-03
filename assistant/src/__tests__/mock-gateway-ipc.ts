/**
 * Global test utility for mocking gateway IPC calls via
 * `@vellumai/gateway-client/ipc-client`.
 *
 * Usage:
 *   import { mockGatewayIpc, resetMockGatewayIpc } from "./mock-gateway-ipc.js";
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
    if (method in ipcResults) return ipcResults[method];
    if (method === "get_feature_flags") return GET_FEATURE_FLAGS_DEFAULT;
    return undefined;
  }

  destroy(): void {
    /* no-op */
  }
}

// ---------------------------------------------------------------------------
// Register the mock (called once from test-preload.ts)
// ---------------------------------------------------------------------------

/**
 * Sentinel returned by the mock for `get_feature_flags` when a test has not
 * explicitly configured a result. Keeps the response non-empty so
 * `initFeatureFlagOverrides()` does not enter its 7.75 s empty-result retry
 * loop during tests that build the CLI program or otherwise trigger flag
 * initialization. The sentinel key starts with a double underscore so it
 * cannot collide with any real registry-declared flag.
 */
const GET_FEATURE_FLAGS_DEFAULT: Record<string, boolean> = {
  __test_default__: false,
};

class FakeIpcCallError extends Error {
  readonly statusCode?: number;
  readonly errorCode?: string;
  readonly errorDetails?: unknown;

  constructor(
    message: string,
    fields: {
      statusCode?: number;
      errorCode?: string;
      errorDetails?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "IpcCallError";
    if (fields.statusCode !== undefined) this.statusCode = fields.statusCode;
    if (fields.errorCode !== undefined) this.errorCode = fields.errorCode;
    if (fields.errorDetails !== undefined)
      this.errorDetails = fields.errorDetails;
  }
}

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
      if (method in ipcResults) return ipcResults[method];
      if (method === "get_feature_flags") return GET_FEATURE_FLAGS_DEFAULT;
      return undefined;
    },
    IpcCallError: FakeIpcCallError,
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
