import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = mkdtempSync(join(tmpdir(), "task-scheduler-test-"));

mock.module("../util/platform.js", () => ({
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getSocketPath: () => join(testDir, "test.sock"),
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { getDb, initializeDb, resetDb } from "../memory/db.js";
import {
  createSchedule,
  getSchedule,
  getScheduleRuns,
} from "../schedule/schedule-store.js";
import { startScheduler } from "../schedule/scheduler.js";
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

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    /* best effort */
  }
});

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
    db.run("DELETE FROM messages");
    db.run("DELETE FROM conversations");
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
    const directCalls: { conversationId: string; message: string }[] = [];
    const processMessage = async (conversationId: string, message: string) => {
      directCalls.push({ conversationId, message });
    };

    const scheduler = startScheduler(
      processMessage,
      () => {},
      () => {},
    );

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
  });

  test("regular messages still go through processMessage normally", async () => {
    // Create a regular schedule (no run_task: prefix)
    const schedule = createSchedule({
      name: "Regular Schedule",
      cronExpression: "* * * * *",
      message: "Do something normal",
    });

    forceScheduleDue(schedule.id);

    const processedMessages: { conversationId: string; message: string }[] = [];
    const processMessage = async (conversationId: string, message: string) => {
      processedMessages.push({ conversationId, message });
    };

    const scheduler = startScheduler(
      processMessage,
      () => {},
      () => {},
    );

    await new Promise((resolve) => setTimeout(resolve, 500));
    scheduler.stop();

    // processMessage should have been called with the regular message
    expect(
      processedMessages.some((m) => m.message === "Do something normal"),
    ).toBe(true);
  });

  test("handles task not found gracefully", async () => {
    // Create a schedule pointing to a nonexistent task
    const schedule = createSchedule({
      name: "Bad Task Schedule",
      cronExpression: "* * * * *",
      message: "run_task:nonexistent-task-id",
    });

    forceScheduleDue(schedule.id);

    const processMessage = async (
      _conversationId: string,
      _message: string,
    ) => {};

    const scheduler = startScheduler(
      processMessage,
      () => {},
      () => {},
    );

    await new Promise((resolve) => setTimeout(resolve, 500));
    scheduler.stop();

    // The schedule run should be recorded as an error
    const runs = getScheduleRuns(schedule.id);
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs[0].status).toBe("error");
    expect(runs[0].error).toContain("Task not found");
  });
});
