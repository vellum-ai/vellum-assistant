/**
 * Tests for the shared CES RPC session helper used by assistant boot and
 * child-process credential resolution.
 */
import { describe, expect, test } from "bun:test";

import { openCesRpcSession, reconnectCesRpcSession } from "./ces-connect.js";
import { createCesProcessManager } from "./process-manager.js";

describe("openCesRpcSession", () => {
  test("returns undefined when discovery fails without polling", async () => {
    const start = Date.now();
    const pm = createCesProcessManager({
      discover: async () => ({
        mode: "unavailable",
        reason: "missing test socket",
      }),
    });

    const session = await openCesRpcSession({ processManager: pm });

    expect(session).toBeUndefined();
    expect(pm.isRunning()).toBe(false);
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  test("returns undefined when the abort signal is already fired", async () => {
    const abort = new AbortController();
    abort.abort();
    const pm = createCesProcessManager({
      discover: async () => {
        throw new Error("discover should not run after abort");
      },
    });

    const session = await openCesRpcSession({
      processManager: pm,
      signal: abort.signal,
    });

    expect(session).toBeUndefined();
    expect(pm.isRunning()).toBe(false);
  });

  test("creates a process manager when none is provided", async () => {
    const session = await openCesRpcSession({
      discover: async () => ({
        mode: "unavailable",
        reason: "missing test socket",
      }),
    });

    expect(session).toBeUndefined();
  });

  test("reconnectCesRpcSession stops the manager and returns undefined when discovery fails", async () => {
    const pm = createCesProcessManager({
      discover: async () => ({
        mode: "unavailable",
        reason: "missing test socket",
      }),
    });

    const client = await reconnectCesRpcSession(pm);

    expect(client).toBeUndefined();
    expect(pm.isRunning()).toBe(false);
  });
});
