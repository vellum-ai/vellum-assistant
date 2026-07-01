/**
 * Scheduler ↔ schedule-worker ownership: while `schedules.worker.enabled` is
 * set, the in-process scheduler must leave script-mode schedules unclaimed
 * (the worker process owns them) while continuing to run every other mode.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
  truncateForLog: (value: string) => value,
}));

mock.module("../background-wake/publisher.js", () => ({
  refreshBackgroundWakeIntent: () => {},
}));

let workerEnabled = false;
mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    schedules: { worker: { enabled: workerEnabled } },
    timeouts: { scheduleTurnTimeoutSec: 1800 },
  }),
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
  _writeQuarantineNotice: () => {},
  invalidateConfigCache: () => {},
}));

mock.module("../daemon/disk-pressure-background-gate.js", () => ({
  checkDiskPressureBackgroundGate: () => ({
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
  }),
  diskPressureBackgroundSkipLogFields: () => ({}),
  shouldLogDiskPressureBackgroundSkip: () => false,
}));

const mockEmitNotificationSignal = mock((..._args: unknown[]) =>
  Promise.resolve(),
);
mock.module("../notifications/emit-signal.js", () => ({
  emitNotificationSignal: mockEmitNotificationSignal,
}));

import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { createSchedule } from "../schedule/schedule-store.js";
import { runScheduleDueWorkOnce } from "../schedule/scheduler.js";

await initializeDb();

function rawDb(): import("bun:sqlite").Database {
  return (getDb() as unknown as { $client: import("bun:sqlite").Database })
    .$client;
}

beforeEach(() => {
  workerEnabled = false;
  mockEmitNotificationSignal.mockClear();
  const db = getDb();
  db.run("DELETE FROM cron_runs");
  db.run("DELETE FROM cron_jobs");
});

describe("scheduler stand-down for the schedule worker", () => {
  async function createDueScriptAndNotifyJobs() {
    const script = await createSchedule({
      name: "Script job",
      cronExpression: "* * * * *",
      message: "run script",
      mode: "script",
      script: "echo daemon-ran",
    });
    const notify = await createSchedule({
      name: "Notify job",
      cronExpression: "* * * * *",
      message: "ping",
      mode: "notify",
    });
    rawDb().run("UPDATE cron_jobs SET next_run_at = ?", [Date.now() - 1000]);
    return { script, notify };
  }

  test("flag on: leaves script-mode schedules unclaimed, still runs other modes", async () => {
    workerEnabled = true;
    const { script } = await createDueScriptAndNotifyJobs();
    const dueBefore = (
      rawDb()
        .query("SELECT next_run_at FROM cron_jobs WHERE id = ?")
        .get(script.id) as { next_run_at: number }
    ).next_run_at;

    const result = await runScheduleDueWorkOnce();

    // Only the notify job was claimed; the script job stays due for the worker.
    expect(result.claimed).toBe(1);
    expect(mockEmitNotificationSignal).toHaveBeenCalledTimes(1);
    const scriptRow = rawDb()
      .query("SELECT next_run_at FROM cron_jobs WHERE id = ?")
      .get(script.id) as { next_run_at: number };
    expect(scriptRow.next_run_at).toBe(dueBefore);
    const scriptRuns = rawDb()
      .query("SELECT COUNT(*) AS count FROM cron_runs WHERE job_id = ?")
      .get(script.id) as { count: number };
    expect(scriptRuns.count).toBe(0);
  });

  test("flag off: the in-process scheduler claims script-mode schedules itself", async () => {
    workerEnabled = false;
    const { script } = await createDueScriptAndNotifyJobs();

    const result = await runScheduleDueWorkOnce();

    expect(result.claimed).toBe(2);
    const scriptRuns = rawDb()
      .query("SELECT status FROM cron_runs WHERE job_id = ?")
      .all(script.id) as Array<{ status: string }>;
    expect(scriptRuns).toHaveLength(1);
    expect(scriptRuns[0].status).toBe("ok");
  });
});
