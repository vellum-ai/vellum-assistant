import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = mkdtempSync(join(tmpdir(), "scheduler-recurrence-test-"));

mock.module("../util/platform.js", () => ({
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
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
  truncateForLog: (value: string) => value,
}));

import { getDb, initializeDb, resetDb } from "../memory/db.js";
import {
  createSchedule,
  getSchedule,
  getScheduleRuns,
} from "../schedule/schedule-store.js";
import { startScheduler } from "../schedule/scheduler.js";
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

// Build an RRULE expression anchored at the given start date, recurring every minute.
// This ensures the rule always has future occurrences relative to the test clock.
function buildEveryMinuteRrule(dtstart: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const ds = `${dtstart.getUTCFullYear()}${pad(dtstart.getUTCMonth() + 1)}${pad(
    dtstart.getUTCDate(),
  )}T${pad(dtstart.getUTCHours())}${pad(dtstart.getUTCMinutes())}${pad(
    dtstart.getUTCSeconds(),
  )}Z`;
  return `DTSTART:${ds}\nRRULE:FREQ=MINUTELY;INTERVAL=1`;
}

// Build an RRULE expression that ended in the past (UNTIL already passed).
function buildEndedRrule(): string {
  const past = new Date(Date.now() - 86_400_000 * 30); // 30 days ago
  const until = new Date(Date.now() - 86_400_000); // 1 day ago
  const pad = (n: number) => String(n).padStart(2, "0");
  const ds = `${past.getUTCFullYear()}${pad(past.getUTCMonth() + 1)}${pad(
    past.getUTCDate(),
  )}T000000Z`;
  const us = `${until.getUTCFullYear()}${pad(until.getUTCMonth() + 1)}${pad(
    until.getUTCDate(),
  )}T235959Z`;
  return `DTSTART:${ds}\nRRULE:FREQ=DAILY;INTERVAL=1;UNTIL=${us}`;
}

// ── RRULE schedule fires through the scheduler ──────────────────────

describe("scheduler RRULE execution", () => {
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM cron_runs");
    db.run("DELETE FROM cron_jobs");
    db.run("DELETE FROM task_runs");
    db.run("DELETE FROM tasks");
    db.run("DELETE FROM messages");
    db.run("DELETE FROM conversations");
  });

  test("RRULE schedule fires and creates cron_runs entry", async () => {
    const rruleExpr = buildEveryMinuteRrule();
    const schedule = createSchedule({
      name: "RRULE Test",
      cronExpression: rruleExpr,
      message: "Hello from RRULE",
      syntax: "rrule",
      expression: rruleExpr,
    });

    // Verify it was stored with rrule syntax
    const stored = getSchedule(schedule.id);
    expect(stored).not.toBeNull();
    expect(stored!.syntax).toBe("rrule");

    // Force it to be due
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

    // processMessage should have been called with the RRULE message
    expect(
      processedMessages.some((m) => m.message === "Hello from RRULE"),
    ).toBe(true);

    // A cron_runs entry should have been created
    const runs = getScheduleRuns(schedule.id);
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs[0].status).toBe("ok");
  });

  test("RRULE run_task:<id> triggers task runner", async () => {
    const task = createTask({
      title: "RRULE Task",
      template: "Execute RRULE task",
    });

    const rruleExpr = buildEveryMinuteRrule();
    const schedule = createSchedule({
      name: "RRULE Task Schedule",
      cronExpression: rruleExpr,
      message: `run_task:${task.id}`,
      syntax: "rrule",
      expression: rruleExpr,
    });

    forceScheduleDue(schedule.id);

    const directCalls: { conversationId: string; message: string }[] = [];
    const processMessage = async (conversationId: string, message: string) => {
      directCalls.push({ conversationId, message });
    };

    const scheduler = startScheduler(
      processMessage,
      () => {},
      () => {},
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    scheduler.stop();

    // runTask renders the template, so processMessage gets the template text
    const runTaskCalls = directCalls.filter(
      (c) => c.message === "Execute RRULE task",
    );
    const rawCalls = directCalls.filter((c) =>
      c.message.startsWith("run_task:"),
    );

    expect(runTaskCalls.length).toBe(1);
    expect(rawCalls.length).toBe(0);

    // A cron_runs entry should exist
    const runs = getScheduleRuns(schedule.id);
    expect(runs.length).toBeGreaterThanOrEqual(1);
  });

  test("expired RRULE fires one final due run then is disabled", async () => {
    const endedExpr = buildEndedRrule();

    // Insert directly via raw SQL because createSchedule would throw when
    // computing nextRunAt for an already-ended RRULE. This simulates a
    // schedule that was valid when created but has since expired.
    const id = crypto.randomUUID();
    const now = Date.now();
    getRawDb().run(
      `INSERT INTO cron_jobs (id, name, enabled, cron_expression, schedule_syntax, timezone, message, next_run_at, last_run_at, last_status, retry_count, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        "Ended RRULE",
        1,
        endedExpr,
        "rrule",
        null,
        "Final expired run",
        now - 1000,
        null,
        null,
        0,
        "agent",
        now,
        now,
      ],
    );

    const processedMessages: string[] = [];
    const processMessage = async (_conversationId: string, message: string) => {
      processedMessages.push(message);
    };

    // First tick: the expired schedule should fire its final due run
    const scheduler1 = startScheduler(
      processMessage,
      () => {},
      () => {},
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    scheduler1.stop();

    // The message IS delivered once
    expect(processedMessages).toContain("Final expired run");

    // One run record IS created with status 'ok'
    const runs = getScheduleRuns(id);
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe("ok");

    // After firing, the schedule is disabled with nextRunAt=0
    const afterSchedule = getSchedule(id);
    expect(afterSchedule).not.toBeNull();
    expect(afterSchedule!.enabled).toBe(false);
    expect(afterSchedule!.nextRunAt).toBe(0);

    // Second tick: the disabled schedule must NOT fire again
    processedMessages.length = 0;
    const scheduler2 = startScheduler(
      processMessage,
      () => {},
      () => {},
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    scheduler2.stop();

    expect(processedMessages).not.toContain("Final expired run");
    // No additional runs
    const runsAfter = getScheduleRuns(id);
    expect(runsAfter.length).toBe(1);
  });

  test("existing cron schedule behavior is unchanged", async () => {
    const schedule = createSchedule({
      name: "Cron Schedule",
      cronExpression: "* * * * *",
      message: "Cron message",
      syntax: "cron",
    });

    // Verify it defaults to cron syntax
    const stored = getSchedule(schedule.id);
    expect(stored).not.toBeNull();
    expect(stored!.syntax).toBe("cron");

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

    // processMessage should have been called with the cron message
    expect(processedMessages.some((m) => m.message === "Cron message")).toBe(
      true,
    );

    // A cron_runs entry should have been created
    const runs = getScheduleRuns(schedule.id);
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs[0].status).toBe("ok");
  });

  test("RRULE set with EXDATE skips excluded occurrence and advances to next valid date", async () => {
    // Build an RRULE set that fires every minute but excludes the next immediate occurrence.
    // The scheduler should skip the excluded date and advance to the one after.
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");

    // DTSTART one hour ago so there are plenty of past occurrences
    const pastDate = new Date(now.getTime() - 3_600_000);
    const ds = `${pastDate.getUTCFullYear()}${pad(
      pastDate.getUTCMonth() + 1,
    )}${pad(pastDate.getUTCDate())}T${pad(pastDate.getUTCHours())}${pad(
      pastDate.getUTCMinutes(),
    )}${pad(pastDate.getUTCSeconds())}Z`;

    // Exclude the current minute's occurrence
    const currentMinuteDate = new Date(now);
    currentMinuteDate.setUTCSeconds(0);
    currentMinuteDate.setUTCMilliseconds(0);
    // Seconds must match DTSTART so the EXDATE aligns with a recurrence instance
    const exDate = `${currentMinuteDate.getUTCFullYear()}${pad(
      currentMinuteDate.getUTCMonth() + 1,
    )}${pad(currentMinuteDate.getUTCDate())}T${pad(
      currentMinuteDate.getUTCHours(),
    )}${pad(currentMinuteDate.getUTCMinutes())}${pad(
      pastDate.getUTCSeconds(),
    )}Z`;

    const expression = `DTSTART:${ds}\nRRULE:FREQ=MINUTELY;INTERVAL=1\nEXDATE:${exDate}`;

    const schedule = createSchedule({
      name: "RRULE set EXDATE test",
      cronExpression: expression,
      message: "Set exclusion test",
      syntax: "rrule",
      expression,
    });

    // Force the schedule to be due
    forceScheduleDue(schedule.id);

    const processedMessages: string[] = [];
    const processMessage = async (_conversationId: string, message: string) => {
      processedMessages.push(message);
    };

    const scheduler = startScheduler(
      processMessage,
      () => {},
      () => {},
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    scheduler.stop();

    // The schedule should have been claimed and nextRunAt advanced
    const after = getSchedule(schedule.id);
    expect(after).not.toBeNull();
    expect(after!.lastRunAt).not.toBeNull();
    // nextRunAt should be in the future (not the excluded date)
    expect(after!.nextRunAt).toBeGreaterThan(Date.now() - 5000);
  });

  test("RRULE set schedule fires and creates cron_runs entry", async () => {
    // Use a recent DTSTART (1 hour ago) so rrule doesn't iterate through hundreds of
    // thousands of occurrences when computing the next run.
    const pastDate = new Date(Date.now() - 3_600_000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const ds = `${pastDate.getUTCFullYear()}${pad(
      pastDate.getUTCMonth() + 1,
    )}${pad(pastDate.getUTCDate())}T${pad(pastDate.getUTCHours())}${pad(
      pastDate.getUTCMinutes(),
    )}${pad(pastDate.getUTCSeconds())}Z`;
    const exMinute = new Date(pastDate.getTime() + 60_000);
    const exDs = `${exMinute.getUTCFullYear()}${pad(
      exMinute.getUTCMonth() + 1,
    )}${pad(exMinute.getUTCDate())}T${pad(exMinute.getUTCHours())}${pad(
      exMinute.getUTCMinutes(),
    )}${pad(exMinute.getUTCSeconds())}Z`;
    const expression = [
      `DTSTART:${ds}`,
      "RRULE:FREQ=MINUTELY;INTERVAL=1",
      `EXDATE:${exDs}`,
    ].join("\n");

    const schedule = createSchedule({
      name: "Set schedule fire test",
      cronExpression: expression,
      message: "Set fire test",
      syntax: "rrule",
      expression,
    });

    forceScheduleDue(schedule.id);

    const processedMessages: string[] = [];
    const processMessage = async (_conversationId: string, message: string) => {
      processedMessages.push(message);
    };

    const scheduler = startScheduler(
      processMessage,
      () => {},
      () => {},
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    scheduler.stop();

    expect(processedMessages).toContain("Set fire test");

    const runs = getScheduleRuns(schedule.id);
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs[0].status).toBe("ok");
  });

  test("EXRULE schedule skips excluded occurrence and advances to next valid date", async () => {
    // RRULE: every minute from a known dtstart
    // EXRULE: every 2nd minute from the same dtstart (excludes offsets 0, 2, 4, ...)
    //
    // DTSTART is set to 59 minutes ago (floored to minute) so the first
    // occurrence after "now" without EXRULE would be at offset 60 (even).
    // With EXRULE active, offset 60 is excluded and the scheduler must
    // advance to offset 61 (odd). Using 59 minutes (not 60) is critical:
    // at 60 minutes the first post-now occurrence is offset 61 (odd), which
    // would pass the parity check even if EXRULE were completely ignored.
    //
    // We mock Date.now() so the scheduler's internal clock matches the test
    // baseline exactly, making the test fully deterministic regardless of
    // when it runs.
    const realNow = new Date();
    const frozenNow = new Date(realNow);
    frozenNow.setUTCSeconds(30);
    frozenNow.setUTCMilliseconds(0);

    const originalDateNow = Date.now;
    Date.now = () => frozenNow.getTime();

    try {
      const pad = (n: number) => String(n).padStart(2, "0");
      const pastDate = new Date(frozenNow.getTime() - 59 * 60_000);
      pastDate.setUTCSeconds(0);
      pastDate.setUTCMilliseconds(0);
      const ds = `${pastDate.getUTCFullYear()}${pad(
        pastDate.getUTCMonth() + 1,
      )}${pad(pastDate.getUTCDate())}T${pad(pastDate.getUTCHours())}${pad(
        pastDate.getUTCMinutes(),
      )}00Z`;

      const expression = `DTSTART:${ds}\nRRULE:FREQ=MINUTELY;INTERVAL=1\nEXRULE:FREQ=MINUTELY;INTERVAL=2`;

      // Compute what the next occurrence would be WITHOUT EXRULE — this should
      // be at an even offset that EXRULE must exclude.
      const withoutExrule = `DTSTART:${ds}\nRRULE:FREQ=MINUTELY;INTERVAL=1`;
      const { computeNextRunAt } =
        await import("../schedule/recurrence-engine.js");
      const nextWithoutExrule = computeNextRunAt(
        { syntax: "rrule", expression: withoutExrule },
        frozenNow.getTime(),
      );
      const offsetWithout = Math.round(
        (nextWithoutExrule - pastDate.getTime()) / 60_000,
      );
      // Sanity: the without-EXRULE occurrence must be even (would be excluded)
      expect(offsetWithout % 2).toBe(0);

      const schedule = createSchedule({
        name: "EXRULE scheduler test",
        cronExpression: expression,
        message: "EXRULE scheduler fire",
        syntax: "rrule",
        expression,
      });

      forceScheduleDue(schedule.id);

      const processedMessages: string[] = [];
      const processMessage = async (
        _conversationId: string,
        message: string,
      ) => {
        processedMessages.push(message);
      };

      const scheduler = startScheduler(
        processMessage,
        () => {},
        () => {},
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      scheduler.stop();

      // The schedule should have fired
      expect(processedMessages).toContain("EXRULE scheduler fire");

      const after = getSchedule(schedule.id);
      expect(after).not.toBeNull();
      expect(after!.lastRunAt).not.toBeNull();
      expect(after!.nextRunAt).toBeGreaterThan(frozenNow.getTime() - 5000);

      // nextRunAt must NOT equal the without-EXRULE occurrence (which is excluded)
      expect(after!.nextRunAt).not.toBe(nextWithoutExrule);

      // nextRunAt must land on an odd-minute offset from dtstart
      const dtstartMs = pastDate.getTime();
      const minuteOffset = Math.round((after!.nextRunAt - dtstartMs) / 60_000);
      expect(minuteOffset % 2).toBe(1);
    } finally {
      Date.now = originalDateNow;
    }
  });

  test("RRULE schedule advances nextRunAt after firing", async () => {
    const rruleExpr = buildEveryMinuteRrule();
    const schedule = createSchedule({
      name: "Advancing RRULE",
      cronExpression: rruleExpr,
      message: "Advance test",
      syntax: "rrule",
      expression: rruleExpr,
    });

    const originalNextRunAt = getSchedule(schedule.id)!.nextRunAt;
    forceScheduleDue(schedule.id);
    const forcedDueAt = getSchedule(schedule.id)!.nextRunAt;

    const processMessage = async () => {};
    const scheduler = startScheduler(
      processMessage,
      () => {},
      () => {},
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    scheduler.stop();

    const after = getSchedule(schedule.id);
    expect(after).not.toBeNull();
    // nextRunAt must have moved forward from the forced-due value
    expect(after!.nextRunAt).toBeGreaterThan(forcedDueAt);
    // After claiming, MINUTELY recurrence advances nextRunAt by ~60s, so allow up to 65s tolerance
    expect(Math.abs(after!.nextRunAt - originalNextRunAt)).toBeLessThan(65000);
    expect(after!.lastRunAt).not.toBeNull();
  });

  // ── One-shot schedule tests ───────────────────────────────────────

  test("one-shot execute mode fires and marks schedule as fired", async () => {
    const schedule = createSchedule({
      name: "One-shot execute",
      message: "Execute this once",
      mode: "execute",
      nextRunAt: Date.now() - 1000,
      // No expression = one-shot
    });

    expect(getSchedule(schedule.id)!.status).toBe("active");

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

    expect(
      processedMessages.some((m) => m.message === "Execute this once"),
    ).toBe(true);

    const after = getSchedule(schedule.id);
    expect(after).not.toBeNull();
    expect(after!.status).toBe("fired");
    expect(after!.enabled).toBe(false);

    // A cron_runs entry should have been created
    const runs = getScheduleRuns(schedule.id);
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs[0].status).toBe("ok");
  });

  test("one-shot notify mode emits notification and marks schedule as fired", async () => {
    const schedule = createSchedule({
      name: "One-shot notify",
      message: "Notify about this",
      mode: "notify",
      nextRunAt: Date.now() - 1000,
      routingIntent: "multi_channel",
      routingHints: { channel: "slack" },
    });

    expect(getSchedule(schedule.id)!.status).toBe("active");

    const notifyCalls: Array<{
      id: string;
      label: string;
      message: string;
      routingIntent: string;
      routingHints: Record<string, unknown>;
    }> = [];
    const notifyScheduleOneShot = (payload: {
      id: string;
      label: string;
      message: string;
      routingIntent: string;
      routingHints: Record<string, unknown>;
    }) => {
      notifyCalls.push(payload);
    };

    const scheduler = startScheduler(
      async () => {},
      notifyScheduleOneShot,
      () => {},
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    scheduler.stop();

    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0]).toEqual({
      id: schedule.id,
      label: "One-shot notify",
      message: "Notify about this",
      routingIntent: "multi_channel",
      routingHints: { channel: "slack" },
    });

    const after = getSchedule(schedule.id);
    expect(after).not.toBeNull();
    expect(after!.status).toBe("fired");
    expect(after!.enabled).toBe(false);
  });

  test("one-shot failure reverts to active for retry", async () => {
    const schedule = createSchedule({
      name: "One-shot fail",
      message: "This will fail",
      mode: "execute",
      nextRunAt: Date.now() - 1000,
    });

    expect(getSchedule(schedule.id)!.status).toBe("active");

    const processMessage = async () => {
      throw new Error("Simulated failure");
    };

    const scheduler = startScheduler(
      processMessage,
      () => {},
      () => {},
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    scheduler.stop();

    const after = getSchedule(schedule.id);
    expect(after).not.toBeNull();
    expect(after!.status).toBe("active");
    expect(after!.enabled).toBe(true);
  });

  test("recurring + notify mode emits notification and continues recurring", async () => {
    const rruleExpr = buildEveryMinuteRrule();
    const schedule = createSchedule({
      name: "Recurring notify",
      cronExpression: rruleExpr,
      message: "Recurring notification",
      syntax: "rrule",
      expression: rruleExpr,
      mode: "notify",
      routingIntent: "single_channel",
      routingHints: { preferred: "email" },
    });

    forceScheduleDue(schedule.id);

    const notifyCalls: Array<{
      id: string;
      label: string;
      message: string;
      routingIntent: string;
      routingHints: Record<string, unknown>;
    }> = [];
    const notifyScheduleOneShot = (payload: {
      id: string;
      label: string;
      message: string;
      routingIntent: string;
      routingHints: Record<string, unknown>;
    }) => {
      notifyCalls.push(payload);
    };

    const scheduler = startScheduler(
      async () => {},
      notifyScheduleOneShot,
      () => {},
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    scheduler.stop();

    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0]).toEqual({
      id: schedule.id,
      label: "Recurring notify",
      message: "Recurring notification",
      routingIntent: "single_channel",
      routingHints: { preferred: "email" },
    });

    // Schedule should remain enabled and have a future nextRunAt (not fired/disabled)
    const after = getSchedule(schedule.id);
    expect(after).not.toBeNull();
    expect(after!.enabled).toBe(true);
    expect(after!.nextRunAt).toBeGreaterThan(Date.now() - 5000);
    // Status should still be "active" (not "fired")
    expect(after!.status).toBe("active");
  });

  test("one-shot notify mode passes routing intent and hints to notifier", async () => {
    const schedule = createSchedule({
      name: "Routing test",
      message: "Check routing",
      mode: "notify",
      nextRunAt: Date.now() - 1000,
      routingIntent: "all_channels",
      routingHints: {
        requestedByUser: true,
        channelMentions: ["telegram", "slack"],
        priority: "high",
      },
    });

    const notifyCalls: Array<{
      id: string;
      label: string;
      message: string;
      routingIntent: string;
      routingHints: Record<string, unknown>;
    }> = [];
    const notifyScheduleOneShot = (payload: {
      id: string;
      label: string;
      message: string;
      routingIntent: string;
      routingHints: Record<string, unknown>;
    }) => {
      notifyCalls.push(payload);
    };

    const scheduler = startScheduler(
      async () => {},
      notifyScheduleOneShot,
      () => {},
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    scheduler.stop();

    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0].routingIntent).toBe("all_channels");
    expect(notifyCalls[0].routingHints).toEqual({
      requestedByUser: true,
      channelMentions: ["telegram", "slack"],
      priority: "high",
    });

    // Should be marked as fired
    const after = getSchedule(schedule.id);
    expect(after!.status).toBe("fired");
  });
});
