import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () => ({
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
  }),
  truncateForLog: (value: string) => value,
}));

mock.module("../runtime/agent-wake.js", () => ({
  wakeAgentForOpportunity: mock(() =>
    Promise.resolve({ invoked: true, producedToolCalls: false }),
  ),
}));

mock.module("../home/emit-feed-event.js", () => ({
  emitFeedEvent: mock(() => Promise.resolve()),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({}),
  loadConfig: () => ({}),
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  getConfigReadOnly: () => ({}),
  applyNestedDefaults: (config: unknown) => config,
  deepMergeOverwrite: (base: unknown) => base,
  mergeDefaultWorkspaceConfig: () => {},
  getNestedValue: () => undefined,
  setNestedValue: () => {},
  API_KEY_PROVIDERS: [],
  _appendQuarantineBulletin: () => {},
  invalidateConfigCache: () => {},
}));

let locked = true;
mock.module("../daemon/disk-pressure-background-gate.js", () => ({
  checkDiskPressureBackgroundGate: () =>
    locked
      ? {
          action: "skip",
          reason: "disk_pressure",
          blockedCapability: "background-work",
          status: {
            enabled: true,
            state: "critical",
            locked: true,
            acknowledged: true,
            overrideActive: false,
            effectivelyLocked: true,
            lockId: "disk-pressure-test",
            usagePercent: 98,
            thresholdPercent: 95,
            path: "/",
            lastCheckedAt: "2026-05-05T00:00:00.000Z",
            blockedCapabilities: [
              "agent-turns",
              "background-work",
              "remote-ingress",
            ],
            error: null,
          },
        }
      : {
          action: "allow",
          status: {
            enabled: false,
            state: "disabled",
            locked: false,
            acknowledged: false,
            overrideActive: false,
            effectivelyLocked: false,
            lockId: null,
            usagePercent: null,
            thresholdPercent: 95,
            path: null,
            lastCheckedAt: null,
            blockedCapabilities: [],
            error: null,
          },
        },
  diskPressureBackgroundSkipLogFields: () => ({
    reason: "disk_pressure",
    thresholdPercent: 95,
    usagePercent: 98,
    blockedCapability: "background-work",
    lockId: "disk-pressure-test",
    path: "/",
  }),
  shouldLogDiskPressureBackgroundSkip: () => true,
}));

import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { createSchedule } from "../schedule/schedule-store.js";
import { runScheduleOnce } from "../schedule/scheduler.js";

initializeDb();

function rawDb(): import("bun:sqlite").Database {
  return (getDb() as unknown as { $client: import("bun:sqlite").Database })
    .$client;
}

describe("scheduler disk pressure gate", () => {
  beforeEach(() => {
    locked = true;
    const db = getDb();
    db.run("DELETE FROM cron_runs");
    db.run("DELETE FROM cron_jobs");
    db.run("DELETE FROM task_runs");
    db.run("DELETE FROM tasks");
    db.run("DELETE FROM messages");
    db.run("DELETE FROM conversations");
  });

  test("skips before claiming due schedules while disk pressure is locked", async () => {
    const dueAt = Date.now() - 10_000;
    const schedule = createSchedule({
      name: "Due reminder",
      message: "Do not fire while locked",
      mode: "notify",
      nextRunAt: dueAt,
    });

    const processMessage = mock(() => Promise.resolve());
    const notify = mock(() => Promise.resolve());

    const processed = await runScheduleOnce(processMessage, notify);

    expect(processed).toBe(0);
    expect(processMessage).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();

    const row = rawDb()
      .query("SELECT status, next_run_at FROM cron_jobs WHERE id = ?")
      .get(schedule.id) as { status: string; next_run_at: number } | null;
    expect(row).toEqual({ status: "active", next_run_at: dueAt });

    const runCount = rawDb()
      .query("SELECT COUNT(*) AS count FROM cron_runs")
      .get() as { count: number };
    expect(runCount.count).toBe(0);
  });
});
