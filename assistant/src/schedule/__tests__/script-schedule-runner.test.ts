/**
 * Tests for the script-schedule runner — the execution path shared by the
 * in-process scheduler and the schedule worker process. `runScriptSchedulesOnce`
 * is the worker's tick: it must claim only script-mode schedules and leave
 * every other mode for the daemon.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
  truncateForLog: (value: string) => value,
}));

mock.module("../../background-wake/publisher.js", () => ({
  refreshBackgroundWakeIntent: () => {},
}));

const mockEmitNotificationSignal = mock((..._args: unknown[]) =>
  Promise.resolve(),
);
mock.module("../../notifications/emit-signal.js", () => ({
  emitNotificationSignal: mockEmitNotificationSignal,
}));

import { getDb } from "../../persistence/db-connection.js";
import { initializeDb } from "../../persistence/db-init.js";
import { createSchedule } from "../schedule-store.js";
import {
  runScriptScheduleJob,
  runScriptSchedulesOnce,
} from "../script-schedule-runner.js";

await initializeDb();

function rawDb(): import("bun:sqlite").Database {
  return (getDb() as unknown as { $client: import("bun:sqlite").Database })
    .$client;
}

function markAllDue(): void {
  rawDb().run("UPDATE cron_jobs SET next_run_at = ?", [Date.now() - 1000]);
}

function runsFor(
  jobId: string,
): Array<{ status: string; error: string | null }> {
  return rawDb()
    .query("SELECT status, error FROM cron_runs WHERE job_id = ?")
    .all(jobId) as Array<{ status: string; error: string | null }>;
}

beforeEach(() => {
  mockEmitNotificationSignal.mockClear();
  const db = getDb();
  db.run("DELETE FROM cron_runs");
  db.run("DELETE FROM cron_jobs");
});

describe("runScriptSchedulesOnce", () => {
  test("claims and runs only script-mode schedules", async () => {
    const script = await createSchedule({
      name: "Script job",
      cronExpression: "* * * * *",
      message: "run script",
      mode: "script",
      script: "echo worker-ran",
    });
    const execute = await createSchedule({
      name: "Execute job",
      cronExpression: "* * * * *",
      message: "do the thing",
    });
    markAllDue();

    const processed = await runScriptSchedulesOnce();

    expect(processed).toBe(1);
    const scriptRuns = runsFor(script.id);
    expect(scriptRuns).toHaveLength(1);
    expect(scriptRuns[0].status).toBe("ok");
    // The execute-mode job is untouched — it belongs to the daemon scheduler.
    expect(runsFor(execute.id)).toHaveLength(0);
    const executeRow = rawDb()
      .query("SELECT status FROM cron_jobs WHERE id = ?")
      .get(execute.id) as { status: string };
    expect(executeRow.status).toBe("active");
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

    const processed = await runScriptSchedulesOnce();

    expect(processed).toBe(1);
    const row = rawDb()
      .query("SELECT status, enabled FROM cron_jobs WHERE id = ?")
      .get(oneShot.id) as { status: string; enabled: number };
    expect(row.status).toBe("fired");
    expect(row.enabled).toBe(0);
  });

  test("records an error run and schedules a retry when the script fails", async () => {
    const failing = await createSchedule({
      name: "Failing script",
      cronExpression: "* * * * *",
      message: "fail",
      mode: "script",
      script: "echo boom >&2; exit 1",
    });
    markAllDue();

    await runScriptSchedulesOnce();

    const runs = runsFor(failing.id);
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

describe("runScriptScheduleJob", () => {
  test("skips a script job with no script command", async () => {
    const job = await createSchedule({
      name: "Empty script",
      cronExpression: "* * * * *",
      message: "nothing to run",
      mode: "script",
    });

    const outcome = await runScriptScheduleJob({
      ...job,
      script: null,
    });

    expect(outcome).toBe("skipped");
    expect(runsFor(job.id)).toHaveLength(0);
  });
});
