import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Mock the shared `runBackgroundJob` runner so the scheduler's fresh-bootstrap
// talk-mode path stays observable. Each invocation creates a new conversation
// row and pushes the prompt onto the per-test handler set via
// `onRunBackgroundJobCall`. `run_task:` schedules use a different code path
// and do not invoke this runner.
let onRunBackgroundJobCall:
  | ((info: {
      conversationId: string;
      prompt: string;
      trustContext: { sourceChannel: string; trustClass: string };
    }) => void)
  | null = null;
mock.module("../runtime/background-job-runner.js", () => ({
  runBackgroundJob: async (opts: {
    prompt: string;
    groupId?: string;
    trustContext: { sourceChannel: string; trustClass: string };
    onConversationCreated?: (conversationId: string) => void;
  }) => {
    const { createConversation } =
      await import("../memory/conversation-crud.js");
    const conv = createConversation({
      title: "(test stub)",
      conversationType: "background",
      source: "schedule",
      ...(opts.groupId ? { groupId: opts.groupId } : {}),
    });
    opts.onConversationCreated?.(conv.id);
    onRunBackgroundJobCall?.({
      conversationId: conv.id,
      prompt: opts.prompt,
      trustContext: opts.trustContext,
    });
    return { conversationId: conv.id, ok: true };
  },
}));

// Capture `emitNotificationSignal` calls so tests can assert that scheduled
// task failures surface via the notification pipeline (home feed + native).
const emitNotificationCalls: Array<Record<string, unknown>> = [];
mock.module("../notifications/emit-signal.js", () => ({
  emitNotificationSignal: async (params: Record<string, unknown>) => {
    emitNotificationCalls.push(params);
    return {
      signalId: "stub-signal",
      deduplicated: false,
      dispatched: true,
      reason: "ok",
      deliveryResults: [],
    };
  },
}));

import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { recordUsageEvent } from "../memory/llm-usage-store.js";
import {
  createSchedule,
  getSchedule,
  getScheduleRuns,
} from "../schedule/schedule-store.js";
import { getScheduleUsageSummaries } from "../schedule/schedule-usage-store.js";
import {
  runScheduleDueWorkOnce,
  startScheduler,
} from "../schedule/scheduler.js";
import { scheduleTask } from "../tasks/task-scheduler.js";
import { createTask } from "../tasks/task-store.js";

initializeDb();

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

// ── scheduleTask helper ─────────────────────────────────────────────

describe("scheduleTask", () => {
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM cron_runs");
    db.run("DELETE FROM cron_jobs");
    db.run("DELETE FROM task_runs");
    db.run("DELETE FROM tasks");
  });

  test("creates a schedule with run_task:<taskId> message format", () => {
    const task = createTask({
      title: "Daily Report",
      template: "Generate the daily report",
    });

    const schedule = scheduleTask({
      taskId: task.id,
      name: "Daily Report Schedule",
      cronExpression: "0 9 * * *",
      timezone: "America/New_York",
    });

    expect(schedule.name).toBe("Daily Report Schedule");
    expect(schedule.message).toBe(`run_task:${task.id}`);
    expect(schedule.cronExpression).toBe("0 9 * * *");
    expect(schedule.timezone).toBe("America/New_York");
    expect(schedule.enabled).toBe(true);
  });

  test("creates a schedule without timezone", () => {
    const task = createTask({
      title: "Hourly Check",
      template: "Check status",
    });

    const schedule = scheduleTask({
      taskId: task.id,
      name: "Hourly Check",
      cronExpression: "0 * * * *",
    });

    expect(schedule.message).toBe(`run_task:${task.id}`);
    expect(schedule.timezone).toBeNull();
  });

  test("schedule is persisted and retrievable", () => {
    const task = createTask({
      title: "Persisted Task",
      template: "Do something",
    });

    const schedule = scheduleTask({
      taskId: task.id,
      name: "Persisted Schedule",
      cronExpression: "*/5 * * * *",
    });

    const retrieved = getSchedule(schedule.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.message).toBe(`run_task:${task.id}`);
    expect(retrieved!.name).toBe("Persisted Schedule");
  });
});

// ── Scheduler run_task: detection ───────────────────────────────────

describe("scheduler run_task detection", () => {
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM cron_runs");
    db.run("DELETE FROM cron_jobs");
    db.run("DELETE FROM task_runs");
    db.run("DELETE FROM tasks");
    db.run("DELETE FROM llm_usage_events");
    db.run("DELETE FROM messages");
    db.run("DELETE FROM conversations");
    onRunBackgroundJobCall = null;
    emitNotificationCalls.length = 0;
  });

  test("run_task:<id> messages trigger runTask instead of processMessage", async () => {
    const task = createTask({
      title: "Scheduled Task",
      template: "Execute this scheduled task",
    });

    // Create a schedule with run_task: message
    const schedule = scheduleTask({
      taskId: task.id,
      name: "Task Schedule",
      cronExpression: "* * * * *",
    });

    forceScheduleDue(schedule.id);

    // Track all processMessage calls
    const directCalls: Array<{
      conversationId: string;
      message: string;
      options?: { trustClass?: string; taskRunId?: string };
    }> = [];
    const processMessage = async (
      conversationId: string,
      message: string,
      options?: { trustClass?: string; taskRunId?: string },
    ) => {
      directCalls.push({ conversationId, message, options });
    };

    const scheduler = startScheduler(processMessage, () => {});

    // Wait for the initial tick to complete
    await new Promise((resolve) => setTimeout(resolve, 500));
    scheduler.stop();

    // runTask delegates to processMessage with the rendered template, not the raw run_task: message
    const runTaskCalls = directCalls.filter(
      (c) => c.message === "Execute this scheduled task",
    );
    const rawCalls = directCalls.filter((c) =>
      c.message.startsWith("run_task:"),
    );

    expect(runTaskCalls.length).toBe(1);
    // The scheduler should NOT pass the raw run_task: message to processMessage
    expect(rawCalls.length).toBe(0);
    expect(runTaskCalls[0].options?.trustClass).toBe("guardian");
    expect(typeof runTaskCalls[0].options?.taskRunId).toBe("string");
  });

  test("regular messages route through the runBackgroundJob runner", async () => {
    // Create a regular schedule (no run_task: prefix)
    const schedule = createSchedule({
      name: "Regular Schedule",
      cronExpression: "* * * * *",
      message: "Do something normal",
      syntax: "cron",
    });

    forceScheduleDue(schedule.id);

    const runnerCalls: Array<{
      conversationId: string;
      prompt: string;
      trustContext: { sourceChannel: string; trustClass: string };
    }> = [];
    onRunBackgroundJobCall = (info) => {
      runnerCalls.push(info);
    };

    const scheduler = startScheduler(
      async () => {},
      () => {},
    );

    await new Promise((resolve) => setTimeout(resolve, 500));
    scheduler.stop();

    // The runner should have been invoked with the schedule message and a
    // guardian trust context, mirroring the historical inline `processMessage`
    // call that the migration replaced.
    expect(runnerCalls.length).toBe(1);
    expect(runnerCalls[0].prompt).toBe("Do something normal");
    expect(runnerCalls[0].trustContext).toEqual({
      sourceChannel: "vellum",
      trustClass: "guardian",
    });
  });

  test("handles task not found gracefully", async () => {
    // Create a schedule pointing to a nonexistent task
    const schedule = createSchedule({
      name: "Bad Task Schedule",
      cronExpression: "* * * * *",
      message: "run_task:nonexistent-task-id",
      syntax: "cron",
    });

    forceScheduleDue(schedule.id);

    const processMessage = async (
      _conversationId: string,
      _message: string,
    ) => {};

    const scheduler = startScheduler(processMessage, () => {});

    await new Promise((resolve) => setTimeout(resolve, 500));
    scheduler.stop();

    // The schedule run should be recorded as an error
    const runs = getScheduleRuns(schedule.id);
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs[0].status).toBe("error");
    expect(runs[0].error).toContain("Task not found");

    // Failed scheduled tasks must surface via the notification pipeline so
    // they reach the home feed and native macOS notifications. The shape
    // mirrors what `runBackgroundJob` emits for its own failures.
    const failureSignal = emitNotificationCalls.find(
      (p) => p.sourceEventName === "activity.failed",
    );
    expect(failureSignal).toBeDefined();
    expect(failureSignal?.sourceChannel).toBe("scheduler");
    const payload = failureSignal?.contextPayload as Record<string, unknown>;
    expect(payload.jobName).toBe("task:nonexistent-task-id");
    expect(payload.errorKind).toBe("exception");
    expect(typeof payload.errorMessage).toBe("string");
    expect(failureSignal?.dedupeKey).toMatch(
      /^activity-failed:task:nonexistent-task-id:\d{4}-\d{2}-\d{2}$/,
    );
  });

  test("opens a task-backed schedule run before task processing and backfills the real conversation id", async () => {
    const task = createTask({
      title: "Usage Attribution Task",
      template: "Spend scheduled tokens",
    });
    const schedule = scheduleTask({
      taskId: task.id,
      name: "Usage Attribution Schedule",
      cronExpression: "* * * * *",
    });
    forceScheduleDue(schedule.id);

    const from = Date.now() - 1000;
    let processingConversationId: string | null = null;
    let usageEventCreatedAt: number | null = null;
    let runsDuringProcessing: ReturnType<typeof getScheduleRuns> = [];

    const result = await runScheduleDueWorkOnce(
      async (conversationId) => {
        processingConversationId = conversationId;
        runsDuringProcessing = getScheduleRuns(schedule.id);
        const event = recordUsageEvent(
          {
            conversationId,
            runId: null,
            requestId: "req-scheduled-task-usage",
            actor: "main_agent",
            callSite: "mainAgent",
            inferenceProfile: "balanced",
            provider: "anthropic",
            model: "claude-sonnet-4-20250514",
            inputTokens: 100,
            outputTokens: 50,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            rawUsage: null,
          },
          { estimatedCostUsd: 0.25, pricingStatus: "priced" },
        );
        usageEventCreatedAt = event.createdAt;
      },
      () => {},
    );
    const to = Date.now() + 1000;

    expect(result.completed).toBe(1);
    expect(result.failed).toBe(0);
    expect(processingConversationId).not.toBeNull();
    expect(usageEventCreatedAt).not.toBeNull();
    expect(runsDuringProcessing).toHaveLength(1);
    expect(runsDuringProcessing[0].status).toBe("running");
    expect(runsDuringProcessing[0].conversationId).toBeNull();
    expect(runsDuringProcessing[0].startedAt).toBeLessThanOrEqual(
      usageEventCreatedAt!,
    );

    const runs = getScheduleRuns(schedule.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe(runsDuringProcessing[0].id);
    expect(runs[0].status).toBe("ok");
    expect(runs[0].conversationId).toBe(processingConversationId);
    expect(runs[0].startedAt).toBeLessThanOrEqual(usageEventCreatedAt!);
    expect(runs[0].finishedAt).not.toBeNull();
    expect(runs[0].finishedAt!).toBeGreaterThanOrEqual(usageEventCreatedAt!);

    const summary = getScheduleUsageSummaries({ from, to }).find(
      (row) => row.scheduleId === schedule.id,
    );
    expect(summary).toEqual({
      scheduleId: schedule.id,
      runCount: 1,
      totalEstimatedCostUsd: 0.25,
      eventCount: 1,
    });
  });

  test("opens a normal execute schedule run before fresh background processing and records the conversation id", async () => {
    const schedule = createSchedule({
      name: "Usage Attribution Message Schedule",
      cronExpression: "* * * * *",
      message: "Spend scheduled message tokens",
      syntax: "cron",
    });
    forceScheduleDue(schedule.id);

    const from = Date.now() - 1000;
    let processingConversationId: string | null = null;
    let usageEventCreatedAt: number | null = null;
    let runsDuringProcessing: ReturnType<typeof getScheduleRuns> = [];

    onRunBackgroundJobCall = (info) => {
      processingConversationId = info.conversationId;
      runsDuringProcessing = getScheduleRuns(schedule.id);
      const event = recordUsageEvent(
        {
          conversationId: info.conversationId,
          runId: null,
          requestId: "req-scheduled-message-usage",
          actor: "main_agent",
          callSite: "mainAgent",
          inferenceProfile: "balanced",
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
          inputTokens: 80,
          outputTokens: 20,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          rawUsage: null,
        },
        { estimatedCostUsd: 0.1, pricingStatus: "priced" },
      );
      usageEventCreatedAt = event.createdAt;
    };

    const result = await runScheduleDueWorkOnce(
      async () => {},
      () => {},
    );
    const to = Date.now() + 1000;

    expect(result.completed).toBe(1);
    expect(result.failed).toBe(0);
    expect(processingConversationId).not.toBeNull();
    expect(usageEventCreatedAt).not.toBeNull();
    expect(runsDuringProcessing).toHaveLength(1);
    expect(runsDuringProcessing[0].status).toBe("running");
    expect(runsDuringProcessing[0].conversationId).toBe(
      processingConversationId,
    );
    expect(runsDuringProcessing[0].startedAt).toBeLessThanOrEqual(
      usageEventCreatedAt!,
    );

    const runs = getScheduleRuns(schedule.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe(runsDuringProcessing[0].id);
    expect(runs[0].status).toBe("ok");
    expect(runs[0].conversationId).toBe(processingConversationId);
    expect(runs[0].startedAt).toBeLessThanOrEqual(usageEventCreatedAt!);
    expect(runs[0].finishedAt).not.toBeNull();
    expect(runs[0].finishedAt!).toBeGreaterThanOrEqual(usageEventCreatedAt!);

    const summary = getScheduleUsageSummaries({ from, to }).find(
      (row) => row.scheduleId === schedule.id,
    );
    expect(summary).toEqual({
      scheduleId: schedule.id,
      runCount: 1,
      totalEstimatedCostUsd: 0.1,
      eventCount: 1,
    });
  });
});
