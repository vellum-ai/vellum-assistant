/**
 * Wiring tests for the schedule-result notification: which schedule runs reach
 * the producer, and with what.
 *
 * The producer's own gates (already notified / nothing to say / flag off) are
 * covered in `notifications/__tests__/schedule-result-producer.test.ts`. What
 * is checked here is the scheduler's half of the contract, which the producer
 * cannot verify about itself: that a successful execute-mode run calls it at
 * all, that a failed run does not, that the other modes are left alone, and
 * that `runStartedAt` is captured before the run rather than after — the bound
 * that keeps a reused conversation's earlier notifications from silencing
 * later runs.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// Stub the shared runner so the execute path is observable without an LLM.
let runBackgroundJobShouldFail = false;
mock.module("../runtime/background-job-runner.js", () => ({
  runBackgroundJob: async (opts: {
    prompt: string;
    groupId?: string;
    conversationType?: "background" | "scheduled";
    scheduleJobId?: string;
    onConversationCreated?: (id: string) => void;
  }) => {
    const { createConversation } =
      await import("../persistence/conversation-crud.js");
    const conv = createConversation({
      title: "(test stub)",
      conversationType: opts.conversationType ?? "background",
      source: "schedule",
      ...(opts.groupId ? { groupId: opts.groupId } : {}),
      ...(opts.scheduleJobId ? { scheduleJobId: opts.scheduleJobId } : {}),
    });
    opts.onConversationCreated?.(conv.id);
    if (runBackgroundJobShouldFail) {
      return {
        conversationId: conv.id,
        ok: false,
        error: new Error("Simulated failure"),
        errorKind: "exception" as const,
      };
    }
    return { conversationId: conv.id, ok: true };
  },
}));

interface CapturedCall {
  scheduleId: string;
  scheduleName: string;
  conversationId: string;
  runId: string;
  runStartedAt: number;
}
const producerCalls: CapturedCall[] = [];
mock.module("../notifications/schedule-result-producer.js", () => ({
  emitScheduleResultNotification: async (params: CapturedCall) => {
    producerCalls.push(params);
  },
}));

// Notify-mode schedules emit through the pipeline; stub it so the mode-scoping
// test does not need a live notification stack.
mock.module("../notifications/emit-signal.js", () => ({
  emitNotificationSignal: async () => ({
    signalId: "sig-1",
    deduplicated: false,
    dispatched: true,
    reason: "ok",
    deliveryResults: [],
  }),
}));

import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { createSchedule, getScheduleRuns } from "../schedule/schedule-store.js";
import { runDueSchedulesOnce } from "../schedule/scheduler.js";

await initializeDb();

function getRawDb(): import("bun:sqlite").Database {
  return (getDb() as unknown as { $client: import("bun:sqlite").Database })
    .$client;
}

function forceScheduleDue(scheduleId: string): void {
  getRawDb().run("UPDATE cron_jobs SET next_run_at = ? WHERE id = ?", [
    Date.now() - 1000,
    scheduleId,
  ]);
}

describe("schedule result notification wiring", () => {
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM cron_runs");
    db.run("DELETE FROM cron_jobs");
    db.run("DELETE FROM messages");
    db.run("DELETE FROM conversations");
    producerCalls.length = 0;
    runBackgroundJobShouldFail = false;
  });

  test("a successful execute-mode run reaches the producer", async () => {
    const schedule = await createSchedule({
      name: "Morning briefing",
      cronExpression: "0 9 * * *",
      message: "Summarize my inbox",
      syntax: "cron",
      expression: "0 9 * * *",
    });
    forceScheduleDue(schedule.id);

    await runDueSchedulesOnce();

    expect(producerCalls).toHaveLength(1);
    expect(producerCalls[0].scheduleId).toBe(schedule.id);
    expect(producerCalls[0].scheduleName).toBe("Morning briefing");
    expect(producerCalls[0].conversationId).toBeTruthy();

    // The producer must be handed the run the scheduler actually recorded, so
    // its dedupe key names this firing and not some other.
    const runs = getScheduleRuns(schedule.id);
    expect(producerCalls[0].runId).toBe(runs[0].id);
    expect(runs[0].conversationId).toBe(producerCalls[0].conversationId);
  });

  test("captures runStartedAt before the run, not after", async () => {
    const before = Date.now();
    const schedule = await createSchedule({
      name: "Morning briefing",
      cronExpression: "0 9 * * *",
      message: "Summarize my inbox",
      syntax: "cron",
      expression: "0 9 * * *",
    });
    forceScheduleDue(schedule.id);

    await runDueSchedulesOnce();

    // Stamped at or after the moment this test began and at or before the
    // run's own reply. A timestamp taken after the run would sit past any
    // notification the run emitted, so the probe would miss it and every
    // well-authored schedule would notify twice.
    const runs = getScheduleRuns(schedule.id);
    expect(producerCalls[0].runStartedAt).toBeGreaterThanOrEqual(before);
    expect(producerCalls[0].runStartedAt).toBeLessThanOrEqual(
      runs[0].startedAt,
    );
  });

  test("a failed run does not reach the producer", async () => {
    // A failure has its own alerting path (the retry policy's exhaustion
    // alert). Notifying here would pair every failure with a second message
    // carrying whatever half-finished text the run left behind.
    runBackgroundJobShouldFail = true;
    const schedule = await createSchedule({
      name: "Morning briefing",
      cronExpression: "0 9 * * *",
      message: "Summarize my inbox",
      syntax: "cron",
      expression: "0 9 * * *",
    });
    forceScheduleDue(schedule.id);

    await runDueSchedulesOnce();

    expect(getScheduleRuns(schedule.id)[0].status).toBe("error");
    expect(producerCalls).toHaveLength(0);
  });

  test("notify-mode schedules are left alone", async () => {
    // Notify mode already is a notification; the fallback would duplicate it.
    const schedule = await createSchedule({
      name: "Drink water",
      cronExpression: "0 9 * * *",
      message: "Time to drink water",
      syntax: "cron",
      expression: "0 9 * * *",
      mode: "notify",
    });
    forceScheduleDue(schedule.id);

    await runDueSchedulesOnce();

    expect(getScheduleRuns(schedule.id)[0].status).toBe("ok");
    expect(producerCalls).toHaveLength(0);
  });

  test("script-mode schedules are left alone", async () => {
    // No agent turn runs, so there is no reply to carry and nothing the
    // producer could say.
    const schedule = await createSchedule({
      name: "Rotate logs",
      cronExpression: "0 9 * * *",
      message: "unused",
      syntax: "cron",
      expression: "0 9 * * *",
      mode: "script",
      script: "true",
    });
    forceScheduleDue(schedule.id);

    await runDueSchedulesOnce();

    expect(producerCalls).toHaveLength(0);
  });
});
