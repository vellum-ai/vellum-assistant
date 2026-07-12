/**
 * `runDueSchedulesOnce` — the schedule worker's tick — claims and executes
 * every due schedule across modes. Schedule execution is owned by the schedule
 * worker process; the daemon's own scheduler tick runs only watchers and
 * sequences.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../background-wake/publisher.js", () => ({
  refreshBackgroundWakeIntent: () => {},
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
import { runDueSchedulesOnce } from "../schedule/scheduler.js";

await initializeDb();

function rawDb(): import("bun:sqlite").Database {
  return (getDb() as unknown as { $client: import("bun:sqlite").Database })
    .$client;
}

beforeEach(() => {
  mockEmitNotificationSignal.mockClear();
  const db = getDb();
  db.run("DELETE FROM cron_runs");
  db.run("DELETE FROM cron_jobs");
});

/** One due recurring script schedule + one due recurring notify schedule. */
async function createDueScriptAndNotifyJobs() {
  const script = await createSchedule({
    name: "Script job",
    cronExpression: "* * * * *",
    message: "run script",
    mode: "script",
    script: "echo ran",
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

function runsFor(jobId: string): Array<{ status: string }> {
  return rawDb()
    .query("SELECT status FROM cron_runs WHERE job_id = ?")
    .all(jobId) as Array<{ status: string }>;
}

describe("runDueSchedulesOnce (the schedule worker's tick)", () => {
  test("claims and executes due schedules across modes", async () => {
    const { script } = await createDueScriptAndNotifyJobs();

    const result = await runDueSchedulesOnce();

    expect(result.claimed).toBe(2);
    expect(result.completed).toBe(2);
    const scriptRuns = runsFor(script.id);
    expect(scriptRuns).toHaveLength(1);
    expect(scriptRuns[0].status).toBe("ok");
    // Notify mode fired through the notification pipeline.
    expect(mockEmitNotificationSignal).toHaveBeenCalledTimes(1);
  });

  test("completes a one-shot script schedule after a successful run", async () => {
    const oneShot = await createSchedule({
      name: "One-shot script",
      cronExpression: null,
      message: "run once",
      mode: "script",
      script: "true",
      nextRunAt: Date.now() - 1000,
    });

    const result = await runDueSchedulesOnce();

    expect(result.completed).toBe(1);
    const row = rawDb()
      .query("SELECT status, enabled FROM cron_jobs WHERE id = ?")
      .get(oneShot.id) as { status: string; enabled: number };
    expect(row.status).toBe("fired");
    expect(row.enabled).toBe(0);
  });

  test("records an error run and schedules a retry when a script fails", async () => {
    const failing = await createSchedule({
      name: "Failing script",
      cronExpression: "* * * * *",
      message: "fail",
      mode: "script",
      script: "echo boom >&2; exit 1",
    });
    rawDb().run("UPDATE cron_jobs SET next_run_at = ?", [Date.now() - 1000]);

    const result = await runDueSchedulesOnce();

    expect(result.failed).toBe(1);
    const runs = rawDb()
      .query("SELECT status, error FROM cron_runs WHERE job_id = ?")
      .all(failing.id) as Array<{ status: string; error: string | null }>;
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("error");
    expect(runs[0].error).toContain("boom");
    const row = rawDb()
      .query("SELECT retry_count, next_run_at FROM cron_jobs WHERE id = ?")
      .get(failing.id) as { retry_count: number; next_run_at: number };
    expect(row.retry_count).toBe(1);
    expect(row.next_run_at).toBeGreaterThan(Date.now());
  });
});
