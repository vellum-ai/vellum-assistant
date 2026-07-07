/**
 * Tests for the background retry path of the post-assistant-ready lifecycle.
 *
 * When the bounded startup wait times out (slow migration, failed migration
 * awaiting a restart), the gateway opens traffic but must NOT permanently skip
 * the deferred tasks (gateway data migrations, guardian binding backfill,
 * voice verification syncs). `runDeferredTasksWhenAssistantReady` keeps
 * polling the assistant and runs the tasks exactly once when it finally
 * reports migrations ready.
 *
 * The task implementations are substituted via
 * `resetPostAssistantReadyForTest` rather than `mock.module`: suite runs
 * share one bun process, so module mocks here are both unreliable (an
 * earlier file materializing the real modules pins them into
 * post-assistant-ready's bindings) and hazardous (they leak into later
 * files that need the real modules).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { sql } from "drizzle-orm";

import "./test-preload.js";

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

const {
  resetPostAssistantReadyForTest,
  runDeferredTasksWhenAssistantReady,
  waitForAssistant,
} = await import("../post-assistant-ready.js");
const { initGatewayDb, getGatewayDb, resetGatewayDb } = await import(
  "../db/connection.js"
);
const { contacts, contactChannels } = await import("../db/schema.js");
const { MIGRATIONS } = await import("../db/data-migrations/index.js");
const { bustGuardianIntegrityCache } = await import(
  "../auth/guardian-integrity.js"
);
const {
  resetGuardianIntegrityReporterForTesting,
  setGuardianIntegrityReporterOverridesForTesting,
} = await import("../guardian-integrity-reporter.js");
const { seedContact } = await import("./helpers/contact-fixtures.js");

const MIGRATING_HEALTH = {
  status: "MIGRATING",
  dbMigrations: { ready: false, state: "running" },
};
const READY_HEALTH = { status: "healthy" };

let deferredTasksMock = mock(async () => {});

beforeEach(() => {
  deferredTasksMock = mock(async () => {});
  resetPostAssistantReadyForTest(() => deferredTasksMock());
  ipcCalls = 0;
  healthResponder = () => READY_HEALTH;
});

describe("runDeferredTasksWhenAssistantReady", () => {
  test("polls until migrations report ready, then runs the deferred tasks", async () => {
    healthResponder = () => (ipcCalls < 3 ? MIGRATING_HEALTH : READY_HEALTH);

    await runDeferredTasksWhenAssistantReady(5);

    expect(ipcCalls).toBeGreaterThanOrEqual(3);
    expect(deferredTasksMock).toHaveBeenCalledTimes(1);
  });

  test("keeps polling through transport errors while the assistant is down", async () => {
    healthResponder = () => {
      if (ipcCalls < 3) throw new Error("socket not found");
      return READY_HEALTH;
    };

    await runDeferredTasksWhenAssistantReady(5);

    expect(deferredTasksMock).toHaveBeenCalledTimes(1);
  });

  test("deferred tasks are one-shot per process", async () => {
    await runDeferredTasksWhenAssistantReady(5);
    await runDeferredTasksWhenAssistantReady(5);

    expect(deferredTasksMock).toHaveBeenCalledTimes(1);
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

  test("real deferred run resolves when the guardian backfill refuses to mint", async () => {
    await initGatewayDb();
    try {
      // Pre-record every data-migration key so the real executor's migration
      // step no-ops against the test DB — the refusing guardian backfill is
      // the code under test.
      for (const { key } of MIGRATIONS) {
        getGatewayDb().run(
          sql`INSERT OR IGNORE INTO one_time_migrations (key, ran_at) VALUES (${key}, ${Date.now()})`,
        );
      }
      // Evidence of prior onboarding with no guardian row →
      // ensureVellumGuardianBinding throws VellumGuardianMintRefusedError.
      seedContact({ id: "invited-contact" });
      bustGuardianIntegrityCache();
      setGuardianIntegrityReporterOverridesForTesting({
        fetchImpl: async () => new Response("{}"),
        mintToken: () => "svc-token",
        baseUrl: "http://127.0.0.1:7821",
        log: { error: () => {}, warn: () => {} },
      });
      resetPostAssistantReadyForTest(); // restore the REAL executor

      // The refusal is warn-and-continue inside the executor: the deferred
      // run resolves instead of rejecting or crashing boot.
      await runDeferredTasksWhenAssistantReady(5);

      // Refused, not minted: no vellum guardian binding appeared.
      expect(
        getGatewayDb().select().from(contactChannels).all(),
      ).toHaveLength(0);
      expect(getGatewayDb().select().from(contacts).all()).toHaveLength(1);
    } finally {
      resetGuardianIntegrityReporterForTesting();
      resetGatewayDb();
    }
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
    expect(deferredTasksMock).toHaveBeenCalledTimes(1);
  });
});
