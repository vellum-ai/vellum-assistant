/**
 * Shared test helper: mock the IPC transport layer so tests can run
 * without a live gateway Unix socket.
 *
 * Mocks `@vellumai/gateway-client/ipc-client` — the lowest transport
 * layer — so that `gateway-client.ts` and everything above it (including
 * `ipcClassifyRisk`, response validation, singleton management) runs
 * for real.
 *
 * Tests register expected IPC responses via `mockIpcResponse()` before
 * exercising the code under test. Unmatched calls return undefined
 * (one-shot `ipcCall`) or reject (persistent client).
 *
 * @example
 *   // In your test file:
 *   import { installIpcMock, mockIpcResponse } from "./helpers/gateway-classify-mock.js";
 *   installIpcMock();
 *
 *   mockIpcResponse("classify_risk",
 *     { risk: "low", reason: "ls", matchType: "registry", scopeOptions: [] });
 *
 *   const result = await classifyRisk("bash", { command: "ls" });
 */

import { mock } from "bun:test";

// ── Response registry ───────────────────────────────────────────────────────

const responses = new Map<string, unknown>();

/**
 * Register a static response for an IPC method. Every call to that method
 * returns the same response regardless of params.
 */
export function mockIpcResponse(method: string, response: unknown): void {
  responses.set(method, response);
}

/** Clear all registered responses and captured params. */
export function clearIpcMocks(): void {
  responses.clear();
  lastParams.clear();
}

const lastParams = new Map<string, Record<string, unknown> | undefined>();

/**
 * The params of the most recent call to `method`, for asserting what the
 * daemon sent rather than what it did with the answer.
 */
export function lastIpcParams(
  method: string,
): Record<string, unknown> | undefined {
  return lastParams.get(method);
}

function handleCall(method: string, params?: Record<string, unknown>): unknown {
  lastParams.set(method, params);
  const response = responses.get(method);
  if (response !== undefined) {
    return response;
  }
  return undefined;
}

// ── Mock installation ───────────────────────────────────────────────────────

/**
 * Install the IPC transport mock. Call this at the top of your test file
 * (before any imports that transitively load gateway-client.ts).
 */
export function installIpcMock(): void {
  mock.module("@vellumai/gateway-client/ipc-client", () => ({
    ipcCall: async (
      _socketPath: string,
      method: string,
      params?: Record<string, unknown>,
    ) => handleCall(method, params),

    PersistentIpcClient: class MockPersistentIpcClient {
      async call(
        method: string,
        params?: Record<string, unknown>,
      ): Promise<unknown> {
        return handleCall(method, params);
      }
      destroy(): void {}
    },
  }));
}
