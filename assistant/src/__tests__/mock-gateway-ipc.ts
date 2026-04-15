/**
 * Global test utility for mocking gateway IPC calls via `node:net`.
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
 * Mocks `node:net` at the socket level, but ONLY intercepts connections to
 * `gateway.sock` paths. All other `node:net` exports and non-gateway
 * `connect()` calls pass through to the real implementation so that proxy /
 * tunnel tests continue to work.
 */

import { EventEmitter } from "node:events";
import { mock } from "bun:test";

// ---------------------------------------------------------------------------
// Configurable state
// ---------------------------------------------------------------------------

/** IPC result the fake gateway will return (keyed by method name). */
let ipcResults: Record<string, unknown> = {};

/** Whether the fake socket should simulate a connection error. */
let simulateError = false;

/** Error code to use when simulating an error. */
let simulateErrorCode = "ENOENT";

// ---------------------------------------------------------------------------
// FakeSocket — simulates the gateway IPC protocol
// ---------------------------------------------------------------------------

class FakeSocket extends EventEmitter {
  unref() {
    /* no-op */
  }
  destroy() {
    /* no-op */
  }
  write(data: string) {
    try {
      const req = JSON.parse(data.trim());
      const result =
        req.method in ipcResults ? ipcResults[req.method] : undefined;
      const response = JSON.stringify({ id: req.id, result });
      queueMicrotask(() => {
        this.emit("data", Buffer.from(response + "\n"));
      });
    } catch {
      // Malformed request — ignore
    }
  }
}

// ---------------------------------------------------------------------------
// Register the mock (called once from test-preload.ts)
// ---------------------------------------------------------------------------

export function installGatewayIpcMock(): void {
  // Snapshot the real node:net exports BEFORE mock.module replaces them.
  // require() returns the current (real) module synchronously; after
  // mock.module() the namespace is replaced for all future importers
  // (like gateway-client.ts), but our captured references stay real.
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- require() is intentional: we need a synchronous snapshot of the real module before mock.module() replaces it
  const realNet = require("node:net") as typeof import("node:net");
  const realConnect = realNet.connect;

  mock.module("node:net", () => ({
    ...realNet,
    connect(...args: unknown[]) {
      // Only intercept Unix domain socket connections to gateway.sock.
      // Everything else (TCP ports, other Unix sockets) passes through
      // to the real node:net so proxy / tunnel tests keep working.
      if (
        typeof args[0] === "string" &&
        (args[0] as string).endsWith("gateway.sock")
      ) {
        const socket = new FakeSocket();
        queueMicrotask(() => {
          if (simulateError) {
            const err = new Error(simulateErrorCode) as NodeJS.ErrnoException;
            err.code = simulateErrorCode;
            socket.emit("error", err);
            socket.emit("close");
          } else {
            socket.emit("connect");
          }
        });
        return socket;
      }
      return realConnect(...(args as Parameters<typeof realConnect>));
    },
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
 * @param opts.code — error code (default "ENOENT")
 * @param opts.results — raw method→result map for arbitrary IPC methods
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
    simulateErrorCode = opts.code ?? "ENOENT";
  }
}

/**
 * Reset all IPC mock state back to defaults (empty flags, no errors).
 */
export function resetMockGatewayIpc(): void {
  ipcResults = {};
  simulateError = false;
  simulateErrorCode = "ENOENT";
}
