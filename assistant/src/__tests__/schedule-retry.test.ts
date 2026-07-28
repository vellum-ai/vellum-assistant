import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// The scheduler's fresh-bootstrap path routes through `runBackgroundJob`,
// which invokes the real `processMessage` from `daemon/process-message.ts`
// instead of the test-injected callback. To keep these tests focused on
// the scheduler's retry policy (not on the runner's plumbing or on having
// a real provider configured), redirect every `runBackgroundJob` call back
// to the injected `processMessage` so a single test scenario controls
// success-vs-failure deterministically.
let injectedProcessMessageForRunner:
  | ((conversationId: string, message: string) => Promise<unknown>)
  | null = null;
mock.module("../runtime/background-job-runner.js", () => ({
  runBackgroundJob: async (opts: {
    jobName: string;
    prompt: string;
    onConversationCreated?: (conversationId: string) => void;
  }) => {
    const conversationId = `mock-conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    opts.onConversationCreated?.(conversationId);
    try {
      if (injectedProcessMessageForRunner) {
        await injectedProcessMessageForRunner(conversationId, opts.prompt);
      }
      return { conversationId, ok: true };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      return {
        conversationId,
        ok: false,
        error,
        errorKind: "exception" as const,
      };
    }
  },
}));

// The scheduler's conversation-reuse path dispatches through `processMessage`;
// route it to the same per-test delegate the runner mock uses.
let processMessageImpl: (
  conversationId: string,
  message: string,
) => Promise<unknown> = async () => {};
mock.module("../daemon/process-message.js", () => ({
  processMessage: (conversationId: string, message: string) =>
    processMessageImpl(conversationId, message),
}));

// Notify-mode firings dispatch through `emitNotificationSignal`; a per-test
// delegate lets a scenario make the notification throw to drive failure paths.
let emitNotificationSignalImpl: (
  payload: unknown,
) => Promise<unknown> = async () => {};
mock.module("../notifications/emit-signal.js", () => ({
  emitNotificationSignal: (payload: unknown) =>
    emitNotificationSignalImpl(payload),
}));

import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { applyRetryDecision, decideRetry } from "../schedule/retry-policy.js";
import { recoverStaleSchedules } from "../schedule/schedule-recovery.js";
import {
  completeScheduleRun,
  createSchedule,
  createScheduleRun,
  findStaleInFlightJobs,
  getSchedule,
  getScheduleRuns,
  resetRetryCount,
  scheduleRetry,
} from "../schedule/schedule-store.js";
import type { SchedulerHandle } from "../schedule/scheduler.js";
import {
  runDueSchedulesOnce,
  runScheduleDueWorkOnce,
} from "../schedule/scheduler.js";
import type { ScheduleMessageProcessor } from "../schedule/scheduler-types.js";

/**
 * Wire a single per-test `processMessage` callback into both schedule dispatch
 * paths — the conversation-reuse path (mocked `daemon/process-message`) and the
 * fresh-bootstrap path (mocked `runBackgroundJob`) — and return a handle that
 * drives schedule execution directly via `runDueSchedulesOnce` (the schedule
 * worker's path). Avoids spawning the real worker process in tests while
 * exercising the exact execution + retry logic.
 */
function startScheduler(
  processMessage: ScheduleMessageProcessor,
  _notifyScheduleOneShot?: unknown,
  _options?: unknown,
): SchedulerHandle {
  const dispatch = async (conversationId: string, message: string) => {
    await processMessage(conversationId, message, { trustClass: "guardian" });
  };
  processMessageImpl = dispatch;
  injectedProcessMessageForRunner = dispatch;
  // Mimic the real scheduler's immediate startup tick that fires due
  // schedules once; tests await a short delay for it to settle before
  // asserting or driving further runs via `runOnce`.
  void runDueSchedulesOnce();
  return {
    async runOnce(): Promise<number> {
      const r = await runDueSchedulesOnce();
      return r.completed + r.failed + r.skipped;
    },
    runDueWorkOnce: (options) => runScheduleDueWorkOnce(options),
    stop(): void {},
  };
}

await initializeDb();

/** Access the underlying bun:sqlite Database for raw parameterized queries. */
function getRawDb(): import("bun:sqlite").Database {
  return (getDb() as unknown as { $client: import("bun:sqlite").Database })
    .$client;
}

/** Force a schedule to be due by setting next_run_at in the past. */
function forceScheduleDue(scheduleId: string): void {
  getRawDb().run("UPDATE cron_jobs SET next_run_at = ? WHERE id = ?", [
    Date.now() - 1000,
    scheduleId,
  ]);
}

// ── Schedule retry store ──────────────────────────────────────────────

describe("schedule retry store", () => {
  beforeEach(() => {
    emitNotificationSignalImpl = async () => {};
    const db = getDb();
    db.run("DELETE FROM cron_runs");
    db.run("DELETE FROM cron_jobs");
  });

  test("scheduleRetry reverts one-shot from firing to active with future nextRunAt", async () => {
    const schedule = await createSchedule({
      name: "One-shot retry",
      expression: null,
      nextRunAt: Date.now() - 1000,
      message: "test",
      syntax: "cron",
    });

    // Simulate the claim step: transition to "firing"
    getRawDb().run("UPDATE cron_jobs SET status = 'firing' WHERE id = ?", [
      schedule.id,
    ]);

    const futureTime = Date.now() + 120_000;
    await scheduleRetry(schedule.id, futureTime);

    const updated = getSchedule(schedule.id)!;
    expect(updated.status).toBe("active");
    expect(updated.nextRunAt).toBe(futureTime);
  });

  test("scheduleRetry sets nextRunAt for recurring schedule without changing status", async () => {
    const schedule = await createSchedule({
      name: "Recurring retry",
      cronExpression: "0 * * * *",
      message: "test",
      syntax: "cron",
    });

    const originalStatus = getSchedule(schedule.id)!.status;
    const futureTime = Date.now() + 120_000;
    await scheduleRetry(schedule.id, futureTime);

    const updated = getSchedule(schedule.id)!;
    expect(updated.nextRunAt).toBe(futureTime);
    // Status unchanged for recurring (it's "active", not "firing")
    expect(updated.status).toBe(originalStatus);
  });

  test("resetRetryCount resets retryCount to 0 after error", async () => {
    const schedule = await createSchedule({
      name: "Reset test",
      cronExpression: "0 * * * *",
      message: "test",
      syntax: "cron",
    });

    // Simulate an error run which increments retryCount
    const runId = await createScheduleRun(schedule.id, "test-conv");
    await completeScheduleRun(runId, { status: "error", error: "boom" });

    const afterError = getSchedule(schedule.id)!;
    expect(afterError.retryCount).toBe(1);

    await resetRetryCount(schedule.id);

    const afterReset = getSchedule(schedule.id)!;
    expect(afterReset.retryCount).toBe(0);
  });

  test("createSchedule with custom maxRetries and retryBackoffMs", async () => {
    const schedule = await createSchedule({
      name: "Custom retry config",
      cronExpression: "0 * * * *",
      message: "test",
      syntax: "cron",
      maxRetries: 5,
      retryBackoffMs: 30000,
    });

    const retrieved = getSchedule(schedule.id)!;
    expect(retrieved.maxRetries).toBe(5);
    expect(retrieved.retryBackoffMs).toBe(30000);
  });

  test("createSchedule with defaults has maxRetries=3 and retryBackoffMs=60000", async () => {
    const schedule = await createSchedule({
      name: "Default retry config",
      cronExpression: "0 * * * *",
      message: "test",
      syntax: "cron",
    });

    const retrieved = getSchedule(schedule.id)!;
    expect(retrieved.maxRetries).toBe(3);
    expect(retrieved.retryBackoffMs).toBe(60000);
  });
});

// ── Scheduler retry integration ───────────────────────────────────────

describe("scheduler retry integration", () => {
  let scheduler: SchedulerHandle;

  beforeEach(() => {
    emitNotificationSignalImpl = async () => {};
    const db = getDb();
    db.run("DELETE FROM cron_runs");
    db.run("DELETE FROM cron_jobs");
  });

  afterEach(() => {
    scheduler?.stop();
  });

  test("execute mode failure retries with backoff", async () => {
    const schedule = await createSchedule({
      name: "Failing hourly",
      cronExpression: "0 * * * *",
      message: "do work",
      syntax: "cron",
      maxRetries: 2,
      retryBackoffMs: 60000,
    });

    forceScheduleDue(schedule.id);

    const processMessage = async () => {
      throw new Error("execute failed");
    };

    scheduler = startScheduler(processMessage, () => {});
    // Wait for the initial tick to complete
    await new Promise((resolve) => setTimeout(resolve, 500));
    scheduler.stop();

    const updated = getSchedule(schedule.id)!;
    // completeScheduleRun incremented retryCount from 0 to 1
    expect(updated.retryCount).toBe(1);
    // nextRunAt should be backoff time (much sooner than next hour)
    const now = Date.now();
    // Backoff should be roughly 60s from now, certainly not an hour
    expect(updated.nextRunAt).toBeGreaterThan(now - 5000);
    expect(updated.nextRunAt).toBeLessThan(now + 5 * 60 * 1000);

    // A schedule run should be recorded with error status
    const runs = getScheduleRuns(schedule.id);
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs[0].status).toBe("error");
  });

  test("execute mode retry success resets retryCount", async () => {
    const schedule = await createSchedule({
      name: "Flaky hourly",
      cronExpression: "0 * * * *",
      message: "do work",
      syntax: "cron",
      maxRetries: 2,
      retryBackoffMs: 1000,
    });

    // First run: failure
    forceScheduleDue(schedule.id);
    let callCount = 0;
    const processMessage = async () => {
      callCount++;
      if (callCount === 1) throw new Error("transient failure");
      // Second call succeeds
    };

    scheduler = startScheduler(processMessage, () => {});
    await new Promise((resolve) => setTimeout(resolve, 500));

    const afterFailure = getSchedule(schedule.id)!;
    expect(afterFailure.retryCount).toBe(1);

    // Second run: success
    forceScheduleDue(schedule.id);
    await scheduler.runOnce();

    const afterSuccess = getSchedule(schedule.id)!;
    expect(afterSuccess.retryCount).toBe(0);
    expect(afterSuccess.lastStatus).toBe("ok");
  });

  test("execute mode exhaustion resets retryCount and resumes cadence", async () => {
    const schedule = await createSchedule({
      name: "Exhaust hourly",
      cronExpression: "0 * * * *",
      message: "do work",
      syntax: "cron",
      maxRetries: 1,
      retryBackoffMs: 1000,
    });

    const processMessage = async () => {
      throw new Error("always fails");
    };

    // First failure: retryCount goes from 0 to 1, schedule retry with backoff
    forceScheduleDue(schedule.id);
    scheduler = startScheduler(processMessage, () => {});
    await new Promise((resolve) => setTimeout(resolve, 500));

    const afterFirst = getSchedule(schedule.id)!;
    expect(afterFirst.retryCount).toBe(1);
    // nextRunAt should be backoff time (much sooner than next hour)
    const now1 = Date.now();
    expect(afterFirst.nextRunAt).toBeLessThan(now1 + 5 * 60 * 1000);

    // Second failure: retryCount goes from 1 to 2, exceeds maxRetries (1)
    // so exhaust path resets retryCount to 0 and nextRunAt goes to normal cron cadence
    forceScheduleDue(schedule.id);
    await scheduler.runOnce();

    const afterSecond = getSchedule(schedule.id)!;
    // Exhaust path for recurring: resetRetryCount -> 0
    expect(afterSecond.retryCount).toBe(0);
    // Schedule should still be enabled (not cancelled for recurring)
    expect(afterSecond.enabled).toBe(true);
  });

  test("one-shot failure retries with backoff", async () => {
    const schedule = await createSchedule({
      name: "One-shot failing",
      expression: null,
      nextRunAt: Date.now() - 1000,
      message: "do work",
      syntax: "cron",
      maxRetries: 2,
      retryBackoffMs: 60000,
    });

    const processMessage = async () => {
      throw new Error("one-shot failed");
    };

    scheduler = startScheduler(processMessage, () => {});
    await new Promise((resolve) => setTimeout(resolve, 500));
    scheduler.stop();

    const updated = getSchedule(schedule.id)!;
    // One-shot should revert from "firing" back to "active" for retry
    expect(updated.status).toBe("active");
    // nextRunAt should be in the future (backoff delay)
    expect(updated.nextRunAt).toBeGreaterThan(Date.now() - 5000);
    expect(updated.retryCount).toBe(1);
  });

  test("one-shot exhaustion permanently cancels", async () => {
    const schedule = await createSchedule({
      name: "One-shot exhaust",
      expression: null,
      nextRunAt: Date.now() - 1000,
      message: "do work",
      syntax: "cron",
      maxRetries: 1,
      retryBackoffMs: 1000,
    });

    const processMessage = async () => {
      throw new Error("always fails");
    };

    // First failure: retries
    scheduler = startScheduler(processMessage, () => {});
    await new Promise((resolve) => setTimeout(resolve, 500));

    const afterFirst = getSchedule(schedule.id)!;
    expect(afterFirst.retryCount).toBe(1);
    expect(afterFirst.status).toBe("active"); // reverted for retry

    // Second failure: exhaust -> permanently cancel
    forceScheduleDue(schedule.id);
    await scheduler.runOnce();

    const afterSecond = getSchedule(schedule.id)!;
    expect(afterSecond.status).toBe("cancelled");
    expect(afterSecond.enabled).toBe(false);
  });

  test("notify one-shot failure creates schedule run", async () => {
    const schedule = await createSchedule({
      name: "Notify one-shot",
      expression: null,
      nextRunAt: Date.now() - 1000,
      message: "reminder",
      syntax: "cron",
      mode: "notify",
      maxRetries: 2,
    });

    emitNotificationSignalImpl = async () => {
      throw new Error("notify failed");
    };

    scheduler = startScheduler(async () => {});
    await new Promise((resolve) => setTimeout(resolve, 500));
    scheduler.stop();

    const runs = getScheduleRuns(schedule.id);
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs[0].status).toBe("error");

    const updated = getSchedule(schedule.id)!;
    expect(updated.retryCount).toBe(1);
  });

  test("recurring schedule retry blocks normal cadence", async () => {
    const schedule = await createSchedule({
      name: "Cadence blocking",
      cronExpression: "0 * * * *",
      message: "do work",
      syntax: "cron",
      maxRetries: 2,
      retryBackoffMs: 60000,
    });

    const processMessage = async () => {
      throw new Error("failed");
    };

    forceScheduleDue(schedule.id);
    scheduler = startScheduler(processMessage, () => {});
    await new Promise((resolve) => setTimeout(resolve, 500));
    scheduler.stop();

    const updated = getSchedule(schedule.id)!;
    const now = Date.now();
    // nextRunAt should be backoff delay (~60s), NOT the next hourly occurrence (~60 min)
    // Backoff at attempt 0 with base 60000 is ~60s (with jitter)
    expect(updated.nextRunAt).toBeLessThan(now + 5 * 60 * 1000);
    // Should be well before the next hour
    const oneHourFromNow = now + 60 * 60 * 1000;
    expect(updated.nextRunAt).toBeLessThan(oneHourFromNow - 30 * 60 * 1000);
  });
});

// ── Crash recovery ────────────────────────────────────────────────────

describe("crash recovery", () => {
  beforeEach(() => {
    emitNotificationSignalImpl = async () => {};
    const db = getDb();
    db.run("DELETE FROM cron_runs");
    db.run("DELETE FROM cron_jobs");
  });

  test("recovers stale firing one-shot", async () => {
    const schedule = await createSchedule({
      name: "Stale one-shot",
      expression: null,
      nextRunAt: Date.now() - 60_000,
      message: "test",
      syntax: "cron",
      maxRetries: 3,
    });

    // Simulate crash: force status to "firing" and set lastRunAt in the past
    getRawDb().run(
      "UPDATE cron_jobs SET status = 'firing', last_run_at = ? WHERE id = ?",
      [Date.now() - 60_000, schedule.id],
    );

    const recovered = await recoverStaleSchedules();
    expect(recovered).toBe(1);

    // A schedule run should be created with error
    const runs = getScheduleRuns(schedule.id);
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs[0].status).toBe("error");
    expect(runs[0].error).toContain("recovered on restart");

    const updated = getSchedule(schedule.id)!;
    // retryCount incremented by completeScheduleRun + retry applied
    expect(updated.retryCount).toBe(1);
    expect(updated.status).toBe("active"); // reverted for retry
    expect(updated.nextRunAt).toBeGreaterThan(Date.now() - 5000);
  });

  test("recovers stale running cron_run", async () => {
    const schedule = await createSchedule({
      name: "Stale run",
      cronExpression: "0 * * * *",
      message: "test",
      syntax: "cron",
    });

    // Create a "running" schedule run to simulate crash
    const runId = await createScheduleRun(schedule.id, "stale-conv");
    // The run is now in "running" status by default

    const recovered = await recoverStaleSchedules();
    expect(recovered).toBe(1);

    const runs = getScheduleRuns(schedule.id);
    const recoveredRun = runs.find((r) => r.id === runId);
    expect(recoveredRun).toBeDefined();
    expect(recoveredRun!.status).toBe("error");
    expect(recoveredRun!.error).toContain("recovered on restart");
  });

  test("respects maxRetries on recovery - cancels exhausted one-shot", async () => {
    const schedule = await createSchedule({
      name: "Exhausted one-shot",
      expression: null,
      nextRunAt: Date.now() - 60_000,
      message: "test",
      syntax: "cron",
      maxRetries: 3,
    });

    // Set retryCount = maxRetries (3) and status = "firing"
    getRawDb().run(
      "UPDATE cron_jobs SET status = 'firing', retry_count = ?, last_run_at = ? WHERE id = ?",
      [3, Date.now() - 60_000, schedule.id],
    );

    await recoverStaleSchedules();

    const updated = getSchedule(schedule.id)!;
    expect(updated.status).toBe("cancelled");
    expect(updated.enabled).toBe(false);
  });

  test("idempotent - second call returns 0", async () => {
    const schedule = await createSchedule({
      name: "Idempotent test",
      expression: null,
      nextRunAt: Date.now() - 60_000,
      message: "test",
      syntax: "cron",
    });

    getRawDb().run(
      "UPDATE cron_jobs SET status = 'firing', last_run_at = ? WHERE id = ?",
      [Date.now() - 60_000, schedule.id],
    );

    const first = await recoverStaleSchedules();
    expect(first).toBe(1);

    const second = await recoverStaleSchedules();
    expect(second).toBe(0);
  });

  test("age threshold filters recent in-flight jobs", async () => {
    const schedule = await createSchedule({
      name: "Recent firing",
      expression: null,
      nextRunAt: Date.now() - 1000,
      message: "test",
      syntax: "cron",
    });

    // Force status to "firing" with a recent lastRunAt
    getRawDb().run(
      "UPDATE cron_jobs SET status = 'firing', last_run_at = ? WHERE id = ?",
      [Date.now(), schedule.id],
    );

    // With a 10-minute threshold, the job is too recent to be considered stale
    const recentResults = findStaleInFlightJobs(10 * 60 * 1000);
    expect(recentResults.length).toBe(0);

    // With no threshold (0), the job is returned
    const allResults = findStaleInFlightJobs(0);
    expect(allResults.length).toBe(1);
    expect(allResults[0].jobId).toBe(schedule.id);
  });
});

// ── Scheduler-recovery equivalence ────────────────────────────────────

describe("scheduler-recovery equivalence", () => {
  let scheduler: SchedulerHandle;

  beforeEach(() => {
    emitNotificationSignalImpl = async () => {};
    const db = getDb();
    db.run("DELETE FROM cron_runs");
    db.run("DELETE FROM cron_jobs");
  });

  afterEach(() => {
    scheduler?.stop();
  });

  test("same retry state for identical recurring job inputs", async () => {
    // Create two identical recurring schedules
    const scheduleA = await createSchedule({
      name: "Equiv A",
      cronExpression: "0 * * * *",
      message: "test",
      syntax: "cron",
      maxRetries: 2,
      retryBackoffMs: 60000,
    });

    const scheduleB = await createSchedule({
      name: "Equiv B",
      cronExpression: "0 * * * *",
      message: "test",
      syntax: "cron",
      maxRetries: 2,
      retryBackoffMs: 60000,
    });

    // Schedule A: simulate scheduler failure path
    forceScheduleDue(scheduleA.id);
    const processMessage = async () => {
      throw new Error("fail");
    };
    scheduler = startScheduler(processMessage, () => {});
    await new Promise((resolve) => setTimeout(resolve, 500));
    scheduler.stop();

    // Schedule B: simulate crash recovery path
    // First simulate the schedule being claimed (sets lastRunAt, advances nextRunAt)
    forceScheduleDue(scheduleB.id);
    getRawDb().run("UPDATE cron_jobs SET last_run_at = ? WHERE id = ?", [
      Date.now(),
      scheduleB.id,
    ]);
    // Create a run and complete it with error (same as what scheduler does)
    const runId = await createScheduleRun(scheduleB.id, "recovery-conv");
    await completeScheduleRun(runId, {
      status: "error",
      error: "Process terminated during execution (recovered on restart)",
    });
    // Now run recovery's retry logic on the post-completeScheduleRun state
    const jobB = getSchedule(scheduleB.id)!;
    const decision = decideRetry(jobB);
    const noopLogger = new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    });
    await applyRetryDecision({
      job: jobB,
      isOneShot: false,
      errorMsg: "fail",
      decision,
      scheduleRetry,
      failOneShotPermanently: () => {},
      resetRetryCount,
      emitAlert: () => {},
      log: noopLogger as any,
    });

    const stateA = getSchedule(scheduleA.id)!;
    const stateB = getSchedule(scheduleB.id)!;

    // Both should have the same retryCount
    expect(stateA.retryCount).toBe(stateB.retryCount);
    expect(stateA.retryCount).toBe(1);
    // Both should have nextRunAt in the future (retry with backoff)
    expect(stateA.nextRunAt).toBeGreaterThan(Date.now() - 5000);
    expect(stateB.nextRunAt).toBeGreaterThan(Date.now() - 5000);
    // Both should still be active
    expect(stateA.enabled).toBe(true);
    expect(stateB.enabled).toBe(true);
  });

  test("same exhaust state for identical one-shot inputs", async () => {
    // Create two identical one-shot schedules at max retries
    const scheduleA = await createSchedule({
      name: "Exhaust A",
      expression: null,
      nextRunAt: Date.now() - 1000,
      message: "test",
      syntax: "cron",
      maxRetries: 1,
      retryBackoffMs: 1000,
    });

    const scheduleB = await createSchedule({
      name: "Exhaust B",
      expression: null,
      nextRunAt: Date.now() - 1000,
      message: "test",
      syntax: "cron",
      maxRetries: 1,
      retryBackoffMs: 1000,
    });

    // Schedule A: through scheduler — first failure retries, second exhausts
    const processMessage = async () => {
      throw new Error("always fails");
    };
    scheduler = startScheduler(processMessage, () => {});
    await new Promise((resolve) => setTimeout(resolve, 500));

    // After first failure, A should be retrying
    const afterFirstA = getSchedule(scheduleA.id)!;
    expect(afterFirstA.retryCount).toBe(1);
    expect(afterFirstA.status).toBe("active");

    // Second failure exhausts A
    forceScheduleDue(scheduleA.id);
    await scheduler.runOnce();
    scheduler.stop();

    // Schedule B: through crash recovery path
    // Simulate: claim -> fire -> error -> exhaust
    // First failure
    getRawDb().run(
      "UPDATE cron_jobs SET status = 'firing', last_run_at = ? WHERE id = ?",
      [Date.now() - 60_000, scheduleB.id],
    );
    const runB1 = await createScheduleRun(scheduleB.id, "recovery-conv-1");
    await completeScheduleRun(runB1, { status: "error", error: "fail" });
    // decideRetry + apply for first failure
    const jobB1 = getSchedule(scheduleB.id)!;
    const decision1 = decideRetry(jobB1);
    const noopLogger = new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    });
    await applyRetryDecision({
      job: jobB1,
      isOneShot: true,
      errorMsg: "fail",
      decision: decision1,
      scheduleRetry,
      failOneShotPermanently: (id: string) => {
        getRawDb().run(
          "UPDATE cron_jobs SET status = 'cancelled', enabled = 0, last_status = 'error', updated_at = ? WHERE id = ? AND status = 'firing'",
          [Date.now(), id],
        );
      },
      resetRetryCount,
      emitAlert: () => {},
      log: noopLogger as any,
    });

    // Second failure (simulate claim + fire again)
    forceScheduleDue(scheduleB.id);
    getRawDb().run(
      "UPDATE cron_jobs SET status = 'firing', last_run_at = ? WHERE id = ?",
      [Date.now() - 60_000, scheduleB.id],
    );
    const runB2 = await createScheduleRun(scheduleB.id, "recovery-conv-2");
    await completeScheduleRun(runB2, { status: "error", error: "fail" });
    const jobB2 = getSchedule(scheduleB.id)!;
    const decision2 = decideRetry(jobB2);
    await applyRetryDecision({
      job: jobB2,
      isOneShot: true,
      errorMsg: "fail",
      decision: decision2,
      scheduleRetry,
      failOneShotPermanently: (id: string) => {
        getRawDb().run(
          "UPDATE cron_jobs SET status = 'cancelled', enabled = 0, last_status = 'error', updated_at = ? WHERE id = ? AND status = 'firing'",
          [Date.now(), id],
        );
      },
      resetRetryCount,
      emitAlert: () => {},
      log: noopLogger as any,
    });

    const stateA = getSchedule(scheduleA.id)!;
    const stateB = getSchedule(scheduleB.id)!;

    // Both should be cancelled and disabled
    expect(stateA.status).toBe("cancelled");
    expect(stateA.enabled).toBe(false);
    expect(stateB.status).toBe("cancelled");
    expect(stateB.enabled).toBe(false);
  });
});
