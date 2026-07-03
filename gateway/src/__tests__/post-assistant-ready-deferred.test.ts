/**
 * Tests for the background retry path of the post-assistant-ready lifecycle.
 *
 * When the bounded startup wait times out (slow migration, failed migration
 * awaiting a restart), the gateway opens traffic but must NOT permanently skip
 * the deferred tasks (gateway data migrations, guardian binding backfill,
 * voice verification syncs). `runDeferredTasksWhenAssistantReady` keeps
 * polling the assistant and runs the tasks exactly once when it finally
 * reports migrations ready.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

type HealthResponder = () => unknown;

let healthResponder: HealthResponder = () => ({ status: "healthy" });
let ipcCalls = 0;

// Spread the actual module so untouched exports stay importable by
// later-loaded files when suites share a bun process.
const actualAssistantClient = await import("../ipc/assistant-client.js");
mock.module("../ipc/assistant-client.js", () => ({
  ...actualAssistantClient,
  ipcCallAssistant: async (method: string) => {
    if (method !== "health") throw new Error(`unexpected method: ${method}`);
    ipcCalls++;
    return healthResponder();
  },
}));

let runDataMigrationsMock = mock(async () => {});
mock.module("../db/data-migrations/index.js", () => ({
  runDataMigrations: (...args: unknown[]) =>
    (runDataMigrationsMock as (...a: unknown[]) => Promise<void>)(...args),
}));

mock.module("../db/connection.js", () => ({
  getGatewayDb: () => ({ $client: {} }),
}));

let guardianBindingMock = mock(async () => {});
mock.module("../auth/guardian-bootstrap.js", () => ({
  ensureVellumGuardianBinding: () => guardianBindingMock(),
}));

let outboundVoiceSyncMock = mock(() => {});
mock.module("../verification/outbound-voice-verification-sync.js", () => ({
  startOutboundVoiceVerificationSync: () => outboundVoiceSyncMock(),
}));

const {
  resetPostAssistantReadyForTest,
  runDeferredTasksWhenAssistantReady,
  waitForAssistant,
} = await import("../post-assistant-ready.js");

const MIGRATING_HEALTH = {
  status: "MIGRATING",
  dbMigrations: { ready: false, state: "running" },
};
const READY_HEALTH = { status: "healthy" };

beforeEach(() => {
  resetPostAssistantReadyForTest();
  ipcCalls = 0;
  healthResponder = () => READY_HEALTH;
  runDataMigrationsMock = mock(async () => {});
  guardianBindingMock = mock(async () => {});
  outboundVoiceSyncMock = mock(() => {});
});

describe("runDeferredTasksWhenAssistantReady", () => {
  test("polls until migrations report ready, then runs the deferred tasks", async () => {
    healthResponder = () => (ipcCalls < 3 ? MIGRATING_HEALTH : READY_HEALTH);

    await runDeferredTasksWhenAssistantReady(5);

    expect(ipcCalls).toBeGreaterThanOrEqual(3);
    expect(runDataMigrationsMock).toHaveBeenCalledTimes(1);
    expect(guardianBindingMock).toHaveBeenCalledTimes(1);
    expect(outboundVoiceSyncMock).toHaveBeenCalledTimes(1);
  });

  test("keeps polling through transport errors while the assistant is down", async () => {
    healthResponder = () => {
      if (ipcCalls < 3) throw new Error("socket not found");
      return READY_HEALTH;
    };

    await runDeferredTasksWhenAssistantReady(5);

    expect(runDataMigrationsMock).toHaveBeenCalledTimes(1);
  });

  test("deferred tasks are one-shot per process", async () => {
    await runDeferredTasksWhenAssistantReady(5);
    await runDeferredTasksWhenAssistantReady(5);

    expect(runDataMigrationsMock).toHaveBeenCalledTimes(1);
    expect(guardianBindingMock).toHaveBeenCalledTimes(1);
    expect(outboundVoiceSyncMock).toHaveBeenCalledTimes(1);
  });

  test("waitForAssistant returns unready immediately on terminally failed migrations", async () => {
    // Failed is terminal until the assistant restarts — waiting out the full
    // 5-minute deadline would keep every gateway route 503ing for nothing.
    // Fast-returning false opens traffic (so the CLI's migration-repair
    // rollback/restore can reach the daemon) and hands off to the background
    // poller.
    healthResponder = () => ({
      status: "ERROR",
      dbMigrations: { ready: false, state: "failed" },
    });

    const started = Date.now();
    const ready = await waitForAssistant();

    expect(ready).toBe(false);
    // Nowhere near the 5-minute deadline (or even one 2s poll interval).
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  test("stops polling immediately once the tasks have run elsewhere", async () => {
    await runDeferredTasksWhenAssistantReady(5);
    const callsAfterFirstRun = ipcCalls;

    // Even against an assistant that never reports ready, a redundant poller
    // must exit via the latch instead of spinning forever.
    healthResponder = () => {
      throw new Error("assistant is down");
    };
    await runDeferredTasksWhenAssistantReady(5);

    expect(ipcCalls).toBe(callsAfterFirstRun);
    expect(runDataMigrationsMock).toHaveBeenCalledTimes(1);
  });
});
