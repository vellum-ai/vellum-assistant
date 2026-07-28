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

// Scripted quiesce-lease answers, consumed one per isLifecycleQuiesced()
// call; empty means "no lease" (the real fail-open default), so existing
// tests run ungated. Lets a test arm the lease BETWEEN the claim-site check
// and the per-job re-check, which no real interleaving can do determinstically.
let quiesceAnswers: boolean[] = [];
const realLifecycleQuiesce =
  await import("../persistence/lifecycle-quiesce.js");
mock.module("../persistence/lifecycle-quiesce.js", () => ({
  ...realLifecycleQuiesce,
  isLifecycleQuiesced: () => quiesceAnswers.shift() ?? false,
}));

import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import {
  createSchedule,
  deferClaimedSchedule,
} from "../schedule/schedule-store.js";
import { runDueSchedulesOnce } from "../schedule/scheduler.js";

await initializeDb();

function rawDb(): import("bun:sqlite").Database {
  return (getDb() as unknown as { $client: import("bun:sqlite").Database })
    .$client;
}

beforeEach(() => {
  mockEmitNotificationSignal.mockClear();
  quiesceAnswers = [];
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

  test("a lease armed between claim and start defers the job back to the queue", async () => {
    const oneShot = await createSchedule({
      name: "Deferred notify",
      cronExpression: null,
      message: "ping",
      mode: "notify",
      nextRunAt: Date.now() - 1000,
    });

    // Call 1 is the claim-site gate (claimDueSchedules): no lease yet.
    // Call 2 is the per-job re-check: the lease has landed.
    quiesceAnswers = [false, true];
    const result = await runDueSchedulesOnce();

    expect(result.claimed).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.completed).toBe(0);
    // Nothing executed and nothing was lost: no notification fired, and the
    // one-shot is back in the queue with a near-future retry time.
    expect(mockEmitNotificationSignal).not.toHaveBeenCalled();
    const row = rawDb()
      .query("SELECT status, next_run_at FROM cron_jobs WHERE id = ?")
      .get(oneShot.id) as { status: string; next_run_at: number };
    expect(row.status).toBe("active");
    expect(row.next_run_at).toBeGreaterThan(Date.now());
  });

  test("deferClaimedSchedule restores an exhausted recurring claim", async () => {
    const recurring = await createSchedule({
      name: "Bounded recurring",
      cronExpression: "* * * * *",
      message: "final occurrence",
      mode: "notify",
    });
    // A bounded recurring schedule's FINAL occurrence is claimed by
    // exhausting the job: enabled = false, nextRunAt = 0.
    rawDb().run(
      "UPDATE cron_jobs SET enabled = 0, next_run_at = 0 WHERE id = ?",
      [recurring.id],
    );

    await deferClaimedSchedule(recurring.id, Date.now() + 30_000);

    const row = rawDb()
      .query("SELECT enabled, next_run_at, status FROM cron_jobs WHERE id = ?")
      .get(recurring.id) as {
      enabled: number;
      next_run_at: number;
      status: string;
    };
    expect(row.enabled).toBe(1);
    expect(row.next_run_at).toBeGreaterThan(Date.now());
    expect(row.status).toBe("active");
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
