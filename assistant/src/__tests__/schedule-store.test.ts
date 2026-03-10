import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mock } from "bun:test";

const testDir = mkdtempSync(join(tmpdir(), "schedule-store-test-"));

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
  isDebug: () => false,
  truncateForLog: (value: string) => value,
}));

import { getDb, initializeDb, resetDb } from "../memory/db.js";
import {
  cancelSchedule,
  claimDueSchedules,
  completeOneShot,
  createSchedule,
  describeCronExpression,
  failOneShot,
  getSchedule,
  listSchedules,
  updateSchedule,
} from "../schedule/schedule-store.js";

initializeDb();

/** Access the underlying bun:sqlite Database for raw parameterized queries. */
function getRawDb(): import("bun:sqlite").Database {
  return (getDb() as unknown as { $client: import("bun:sqlite").Database })
    .$client;
}

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    /* best effort */
  }
});

// ── Cron schedules ──────────────────────────────────────────────────

describe("createSchedule (cron)", () => {
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM cron_runs");
    db.run("DELETE FROM cron_jobs");
  });

  test("creates a cron schedule using only cronExpression", () => {
    const job = createSchedule({
      name: "Morning ping",
      cronExpression: "0 9 * * *",
      message: "good morning",
      syntax: "cron",
    });

    expect(job.syntax).toBe("cron");
    expect(job.expression).toBe("0 9 * * *");
    expect(job.cronExpression).toBe("0 9 * * *");
    expect(job.nextRunAt).toBeGreaterThan(Date.now() - 1000);
    expect(job.enabled).toBe(true);
  });

  test("persisted cron schedule is retrievable with new fields", () => {
    const job = createSchedule({
      name: "Hourly",
      cronExpression: "0 * * * *",
      message: "hourly check",
      syntax: "cron",
    });

    const retrieved = getSchedule(job.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.syntax).toBe("cron");
    expect(retrieved!.expression).toBe("0 * * * *");
    expect(retrieved!.cronExpression).toBe("0 * * * *");
  });

  test("stores schedule_syntax in the DB row", () => {
    const job = createSchedule({
      name: "Syntax check",
      cronExpression: "*/5 * * * *",
      message: "test",
      syntax: "cron",
    });

    const raw = getRawDb()
      .query("SELECT schedule_syntax FROM cron_jobs WHERE id = ?")
      .get(job.id) as { schedule_syntax: string } | null;
    expect(raw).not.toBeNull();
    expect(raw!.schedule_syntax).toBe("cron");
  });

  test("rejects invalid cron expression", () => {
    expect(() =>
      createSchedule({
        name: "Bad cron",
        cronExpression: "not-a-cron",
        message: "fail",
        syntax: "cron",
      }),
    ).toThrow();
  });
});

// ── RRULE schedule creation ──────────────────────────────────────────

describe("createSchedule (RRULE)", () => {
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM cron_runs");
    db.run("DELETE FROM cron_jobs");
  });

  test("creates an RRULE schedule with syntax + expression", () => {
    const rrule = "DTSTART:20260101T090000Z\nRRULE:FREQ=DAILY;INTERVAL=1";
    const job = createSchedule({
      name: "Daily RRULE",
      cronExpression: rrule,
      message: "rrule test",
      syntax: "rrule",
      expression: rrule,
    });

    expect(job.syntax).toBe("rrule");
    expect(job.expression).toBe(rrule);
    expect(job.cronExpression).toBe(rrule);
    expect(job.nextRunAt).toBeGreaterThan(0);
  });

  test("stores rrule syntax in DB", () => {
    const rrule = "DTSTART:20260101T090000Z\nRRULE:FREQ=WEEKLY;BYDAY=MO";
    const job = createSchedule({
      name: "Weekly RRULE",
      cronExpression: rrule,
      message: "weekly",
      syntax: "rrule",
      expression: rrule,
    });

    const raw = getRawDb()
      .query(
        "SELECT schedule_syntax, cron_expression FROM cron_jobs WHERE id = ?",
      )
      .get(job.id) as {
      schedule_syntax: string;
      cron_expression: string;
    } | null;
    expect(raw).not.toBeNull();
    expect(raw!.schedule_syntax).toBe("rrule");
    expect(raw!.cron_expression).toBe(rrule);
  });

  test("rejects RRULE without DTSTART", () => {
    expect(() =>
      createSchedule({
        name: "No dtstart",
        cronExpression: "RRULE:FREQ=DAILY",
        message: "fail",
        syntax: "rrule",
        expression: "RRULE:FREQ=DAILY",
      }),
    ).toThrow();
  });
});

// ── RRULE set expressions (RDATE, EXDATE, multi-RRULE) ──────────────

describe("createSchedule (RRULE set)", () => {
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM cron_runs");
    db.run("DELETE FROM cron_jobs");
  });

  test("creates schedule with RRULE + EXDATE set expression", () => {
    const expression = [
      "DTSTART:20250101T090000Z",
      "RRULE:FREQ=DAILY;INTERVAL=1",
      "EXDATE:20250102T090000Z",
    ].join("\n");

    const job = createSchedule({
      name: "Daily with exclusion",
      cronExpression: expression,
      message: "set test",
      syntax: "rrule",
      expression,
    });

    expect(job.syntax).toBe("rrule");
    expect(job.expression).toContain("EXDATE");
    expect(job.nextRunAt).toBeGreaterThan(0);
  });

  test("creates schedule with RRULE + RDATE set expression", () => {
    const expression = [
      "DTSTART:20250101T090000Z",
      "RRULE:FREQ=WEEKLY;BYDAY=MO",
      "RDATE:20250115T090000Z",
    ].join("\n");

    const job = createSchedule({
      name: "Weekly with extra dates",
      cronExpression: expression,
      message: "rdate test",
      syntax: "rrule",
      expression,
    });

    expect(job.syntax).toBe("rrule");
    expect(job.expression).toContain("RDATE");
  });

  test("preserves full set expression text in DB without collapsing", () => {
    const expression = [
      "DTSTART:20250101T090000Z",
      "RRULE:FREQ=DAILY;INTERVAL=1",
      "EXDATE:20250102T090000Z",
      "EXDATE:20250103T090000Z",
    ].join("\n");

    const job = createSchedule({
      name: "Multi-EXDATE",
      cronExpression: expression,
      message: "preserve test",
      syntax: "rrule",
      expression,
    });

    const raw = getRawDb()
      .query("SELECT cron_expression FROM cron_jobs WHERE id = ?")
      .get(job.id) as { cron_expression: string };
    // The full expression including all EXDATE lines should be stored
    expect(raw.cron_expression).toContain("EXDATE:20250102T090000Z");
    expect(raw.cron_expression).toContain("EXDATE:20250103T090000Z");
  });

  test("retrieved set schedule matches what was stored", () => {
    const expression = [
      "DTSTART:20250101T090000Z",
      "RRULE:FREQ=DAILY;INTERVAL=1",
      "EXDATE:20250105T090000Z",
    ].join("\n");

    const job = createSchedule({
      name: "Retrieve set",
      cronExpression: expression,
      message: "retrieve test",
      syntax: "rrule",
      expression,
    });

    const retrieved = getSchedule(job.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.syntax).toBe("rrule");
    expect(retrieved!.expression).toBe(expression);
    expect(retrieved!.expression).toContain("EXDATE");
  });
});

// ── claimDueSchedules with RRULE sets ────────────────────────────────

describe("claimDueSchedules (RRULE set)", () => {
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM cron_runs");
    db.run("DELETE FROM cron_jobs");
  });

  test("claims RRULE set schedule and correctly advances nextRunAt past exclusions", () => {
    // Use a recent DTSTART (1 hour ago) so rrule doesn't iterate through hundreds of
    // thousands of occurrences when computing the next run.
    const pastDate = new Date(Date.now() - 3_600_000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const ds = `${pastDate.getUTCFullYear()}${pad(
      pastDate.getUTCMonth() + 1,
    )}${pad(pastDate.getUTCDate())}T${pad(pastDate.getUTCHours())}${pad(
      pastDate.getUTCMinutes(),
    )}${pad(pastDate.getUTCSeconds())}Z`;
    // Exclude the 2nd minute after DTSTART (safely in the past, won't block the next run)
    const exMinute = new Date(pastDate.getTime() + 60_000);
    const exDs = `${exMinute.getUTCFullYear()}${pad(
      exMinute.getUTCMonth() + 1,
    )}${pad(exMinute.getUTCDate())}T${pad(exMinute.getUTCHours())}${pad(
      exMinute.getUTCMinutes(),
    )}${pad(pastDate.getUTCSeconds())}Z`;
    const expression = [
      `DTSTART:${ds}`,
      "RRULE:FREQ=MINUTELY;INTERVAL=1",
      `EXDATE:${exDs}`,
    ].join("\n");

    const job = createSchedule({
      name: "Claim set test",
      cronExpression: expression,
      message: "claim set",
      syntax: "rrule",
      expression,
    });

    // Force due
    getRawDb().run("UPDATE cron_jobs SET next_run_at = ? WHERE id = ?", [
      Date.now() - 1000,
      job.id,
    ]);

    const now = Date.now();
    const claimed = claimDueSchedules(now);
    expect(claimed.length).toBe(1);
    expect(claimed[0].syntax).toBe("rrule");
    // nextRunAt should advance to a future time
    expect(claimed[0].nextRunAt).toBeGreaterThanOrEqual(now);
  });
});

// ── updateSchedule with syntax/expression ────────────────────────────

describe("updateSchedule", () => {
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM cron_runs");
    db.run("DELETE FROM cron_jobs");
  });

  test("updating cronExpression (legacy path) still works", () => {
    const job = createSchedule({
      name: "Update test",
      cronExpression: "0 9 * * *",
      message: "update me",
      syntax: "cron",
    });

    const updated = updateSchedule(job.id, { cronExpression: "0 10 * * *" });
    expect(updated).not.toBeNull();
    expect(updated!.cronExpression).toBe("0 10 * * *");
    expect(updated!.expression).toBe("0 10 * * *");
    expect(updated!.syntax).toBe("cron");
    // nextRunAt should have been recomputed
    expect(updated!.nextRunAt).not.toBe(job.nextRunAt);
  });

  test("updating syntax + expression switches to RRULE", () => {
    const job = createSchedule({
      name: "Switch to RRULE",
      cronExpression: "0 9 * * *",
      message: "switching",
      syntax: "cron",
    });

    const rrule = "DTSTART:20260101T090000Z\nRRULE:FREQ=DAILY;INTERVAL=2";
    const updated = updateSchedule(job.id, {
      syntax: "rrule",
      expression: rrule,
    });

    expect(updated).not.toBeNull();
    expect(updated!.syntax).toBe("rrule");
    expect(updated!.expression).toBe(rrule);
    expect(updated!.cronExpression).toBe(rrule);
    expect(updated!.nextRunAt).toBeGreaterThan(0);

    // Confirm DB has the right syntax
    const raw = getRawDb()
      .query("SELECT schedule_syntax FROM cron_jobs WHERE id = ?")
      .get(job.id) as { schedule_syntax: string } | null;
    expect(raw!.schedule_syntax).toBe("rrule");
  });

  test("updating to RRULE set expression preserves full text", () => {
    const job = createSchedule({
      name: "Update to set",
      cronExpression: "0 9 * * *",
      message: "update to set",
      syntax: "cron",
    });

    const setExpr = [
      "DTSTART:20250101T090000Z",
      "RRULE:FREQ=DAILY;INTERVAL=1",
      "EXDATE:20250102T090000Z",
    ].join("\n");

    const updated = updateSchedule(job.id, {
      syntax: "rrule",
      expression: setExpr,
    });

    expect(updated).not.toBeNull();
    expect(updated!.syntax).toBe("rrule");
    expect(updated!.expression).toBe(setExpr);
    expect(updated!.expression).toContain("EXDATE");
    expect(updated!.nextRunAt).toBeGreaterThan(0);
  });

  test("rejects invalid expression on update", () => {
    const job = createSchedule({
      name: "Reject bad update",
      cronExpression: "0 9 * * *",
      message: "nope",
      syntax: "cron",
    });

    expect(() =>
      updateSchedule(job.id, {
        syntax: "rrule",
        expression: "RRULE:FREQ=DAILY",
      }),
    ).toThrow();
  });
});

// ── claimDueSchedules ────────────────────────────────────────────────

describe("claimDueSchedules", () => {
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM cron_runs");
    db.run("DELETE FROM cron_jobs");
  });

  test("claims due cron schedules and advances nextRunAt", () => {
    const job = createSchedule({
      name: "Claim cron",
      cronExpression: "* * * * *",
      message: "cron claim test",
      syntax: "cron",
    });

    // Force the schedule to be due
    getRawDb().run("UPDATE cron_jobs SET next_run_at = ? WHERE id = ?", [
      Date.now() - 1000,
      job.id,
    ]);

    const claimed = claimDueSchedules(Date.now());
    expect(claimed.length).toBe(1);
    expect(claimed[0].id).toBe(job.id);
    expect(claimed[0].syntax).toBe("cron");
    expect(claimed[0].nextRunAt).toBeGreaterThan(Date.now() - 1000);
  });

  test("claims due RRULE schedules and advances nextRunAt", () => {
    // Use a recent DTSTART (1 hour ago) so rrule doesn't iterate through
    // hundreds of thousands of occurrences when computing the next run.
    const pastDate = new Date(Date.now() - 3_600_000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const ds = `${pastDate.getUTCFullYear()}${pad(
      pastDate.getUTCMonth() + 1,
    )}${pad(pastDate.getUTCDate())}T${pad(pastDate.getUTCHours())}${pad(
      pastDate.getUTCMinutes(),
    )}${pad(pastDate.getUTCSeconds())}Z`;
    const rrule = `DTSTART:${ds}\nRRULE:FREQ=MINUTELY;INTERVAL=1`;
    const job = createSchedule({
      name: "Claim RRULE",
      cronExpression: rrule,
      message: "rrule claim test",
      syntax: "rrule",
      expression: rrule,
    });

    // Force the schedule to be due
    const pastTs = Date.now() - 60_000;
    getRawDb().run("UPDATE cron_jobs SET next_run_at = ? WHERE id = ?", [
      pastTs,
      job.id,
    ]);

    const now = Date.now();
    const claimed = claimDueSchedules(now);
    expect(claimed.length).toBe(1);
    expect(claimed[0].id).toBe(job.id);
    expect(claimed[0].syntax).toBe("rrule");
    // nextRunAt should be in the future (at or after now)
    expect(claimed[0].nextRunAt).toBeGreaterThanOrEqual(now);
  });

  test("does not claim schedules that are not yet due", () => {
    createSchedule({
      name: "Not due yet",
      cronExpression: "0 9 * * *",
      message: "future schedule",
      syntax: "cron",
    });

    const claimed = claimDueSchedules(0); // timestamp 0 means nothing is due
    expect(claimed.length).toBe(0);
  });

  test("claims exhausted RRULE schedule and disables it", () => {
    // COUNT=1 with a past DTSTART means the single occurrence has already
    // passed, so computeNextRunAt returns null — triggering the exhaustion path.
    // We insert directly via SQL because createSchedule validates that at least
    // one future run exists, which would reject an already-exhausted schedule.
    const yesterday = new Date(Date.now() - 86_400_000);
    const dtstart = yesterday
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}/, "");
    const rrule = `DTSTART:${dtstart}\nRRULE:FREQ=DAILY;COUNT=1`;
    const id = "exhausted-rrule-test";
    const now = Date.now();
    getRawDb().run(
      `INSERT INTO cron_jobs (id, name, enabled, cron_expression, schedule_syntax, message, next_run_at, retry_count, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        "Finite RRULE",
        1,
        rrule,
        "rrule",
        "one-shot",
        now - 1000,
        0,
        "agent",
        now,
        now,
      ],
    );

    const claimed = claimDueSchedules(Date.now());
    expect(claimed.length).toBe(1);
    expect(claimed[0].id).toBe(id);
    expect(claimed[0].enabled).toBe(false);
    expect(claimed[0].nextRunAt).toBe(0);

    // Verify the schedule is disabled in the DB
    const persisted = getSchedule(id);
    expect(persisted!.enabled).toBe(false);

    // A subsequent claim should not pick it up
    const again = claimDueSchedules(Date.now());
    expect(again.length).toBe(0);
  });

  test("optimistic lock prevents double-claiming", () => {
    const job = createSchedule({
      name: "Double claim",
      cronExpression: "* * * * *",
      message: "no double",
      syntax: "cron",
    });

    getRawDb().run("UPDATE cron_jobs SET next_run_at = ? WHERE id = ?", [
      Date.now() - 1000,
      job.id,
    ]);

    const first = claimDueSchedules(Date.now());
    expect(first.length).toBe(1);

    // Second claim should find nothing since nextRunAt was advanced
    const second = claimDueSchedules(Date.now() - 500);
    expect(second.length).toBe(0);
  });
});

// ── One-shot schedules ──────────────────────────────────────────────

describe("createSchedule (one-shot)", () => {
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM cron_runs");
    db.run("DELETE FROM cron_jobs");
  });

  test("creates a one-shot schedule with no expression", () => {
    const fireAt = Date.now() + 60_000;
    const job = createSchedule({
      name: "Remind me",
      message: "take out the trash",
      nextRunAt: fireAt,
    });

    expect(job.expression).toBeNull();
    expect(job.cronExpression).toBeNull();
    expect(job.nextRunAt).toBe(fireAt);
    expect(job.enabled).toBe(true);
    expect(job.status).toBe("active");
    expect(job.mode).toBe("execute");
    expect(job.routingIntent).toBe("all_channels");
    expect(job.routingHints).toEqual({});
  });

  test("creates a one-shot schedule with notify mode and routing", () => {
    const fireAt = Date.now() + 60_000;
    const hints = { preferredChannel: "slack", threadId: "abc123" };
    const job = createSchedule({
      name: "Notify me",
      message: "meeting in 5",
      nextRunAt: fireAt,
      mode: "notify",
      routingIntent: "single_channel",
      routingHints: hints,
    });

    expect(job.mode).toBe("notify");
    expect(job.routingIntent).toBe("single_channel");
    expect(job.routingHints).toEqual(hints);
    expect(job.expression).toBeNull();
    expect(job.status).toBe("active");
  });

  test("rejects one-shot schedule without nextRunAt", () => {
    expect(() =>
      createSchedule({
        name: "Bad one-shot",
        message: "no time",
      }),
    ).toThrow("One-shot schedules (no expression) require nextRunAt");
  });

  test("one-shot schedule persists and round-trips correctly", () => {
    const fireAt = Date.now() + 120_000;
    const hints = { channel: "telegram" };
    const job = createSchedule({
      name: "Persist test",
      message: "round trip",
      nextRunAt: fireAt,
      mode: "notify",
      routingIntent: "multi_channel",
      routingHints: hints,
    });

    const retrieved = getSchedule(job.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.expression).toBeNull();
    expect(retrieved!.cronExpression).toBeNull();
    expect(retrieved!.nextRunAt).toBe(fireAt);
    expect(retrieved!.mode).toBe("notify");
    expect(retrieved!.routingIntent).toBe("multi_channel");
    expect(retrieved!.routingHints).toEqual(hints);
    expect(retrieved!.status).toBe("active");
  });
});

// ── One-shot claiming ───────────────────────────────────────────────

describe("claimDueSchedules (one-shot)", () => {
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM cron_runs");
    db.run("DELETE FROM cron_jobs");
  });

  test("claims one-shot schedules whose nextRunAt <= now", () => {
    const job = createSchedule({
      name: "Due one-shot",
      message: "fire now",
      nextRunAt: Date.now() - 1000,
    });

    const claimed = claimDueSchedules(Date.now());
    expect(claimed.length).toBe(1);
    expect(claimed[0].id).toBe(job.id);
    expect(claimed[0].expression).toBeNull();
    expect(claimed[0].status).toBe("firing");
  });

  test("does not claim one-shot schedules that are not yet due", () => {
    createSchedule({
      name: "Future one-shot",
      message: "not yet",
      nextRunAt: Date.now() + 60_000,
    });

    const claimed = claimDueSchedules(Date.now());
    expect(claimed.length).toBe(0);
  });

  test("does not double-claim one-shot schedules", () => {
    createSchedule({
      name: "Once only",
      message: "no double",
      nextRunAt: Date.now() - 1000,
    });

    const first = claimDueSchedules(Date.now());
    expect(first.length).toBe(1);

    // Second claim should find nothing since status is now 'firing'
    const second = claimDueSchedules(Date.now());
    expect(second.length).toBe(0);
  });

  test("claims both recurring and one-shot schedules in the same tick", () => {
    const recurring = createSchedule({
      name: "Recurring",
      cronExpression: "* * * * *",
      message: "recurring",
      syntax: "cron",
    });
    getRawDb().run("UPDATE cron_jobs SET next_run_at = ? WHERE id = ?", [
      Date.now() - 1000,
      recurring.id,
    ]);

    createSchedule({
      name: "One-shot",
      message: "one-shot",
      nextRunAt: Date.now() - 1000,
    });

    const claimed = claimDueSchedules(Date.now());
    expect(claimed.length).toBe(2);
    const expressions = claimed.map((c) => c.expression);
    expect(expressions).toContain(null); // one-shot
    expect(expressions.some((e) => e !== null)).toBe(true); // recurring
  });
});

// ── One-shot lifecycle (complete, fail, cancel) ─────────────────────

describe("completeOneShot", () => {
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM cron_runs");
    db.run("DELETE FROM cron_jobs");
  });

  test("transitions firing -> fired", () => {
    const job = createSchedule({
      name: "Complete me",
      message: "done",
      nextRunAt: Date.now() - 1000,
    });

    // Claim first to get to 'firing' state
    claimDueSchedules(Date.now());

    completeOneShot(job.id);

    const retrieved = getSchedule(job.id);
    expect(retrieved!.status).toBe("fired");
    expect(retrieved!.enabled).toBe(false);
  });

  test("does not transition if not in firing state", () => {
    const job = createSchedule({
      name: "Not firing",
      message: "still active",
      nextRunAt: Date.now() + 60_000,
    });

    completeOneShot(job.id);

    const retrieved = getSchedule(job.id);
    expect(retrieved!.status).toBe("active"); // unchanged
    expect(retrieved!.enabled).toBe(true);
  });
});

describe("failOneShot", () => {
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM cron_runs");
    db.run("DELETE FROM cron_jobs");
  });

  test("transitions firing -> active for retry", () => {
    const job = createSchedule({
      name: "Fail me",
      message: "retry",
      nextRunAt: Date.now() - 1000,
    });

    // Claim to get to 'firing'
    claimDueSchedules(Date.now());

    failOneShot(job.id);

    const retrieved = getSchedule(job.id);
    expect(retrieved!.status).toBe("active");
    expect(retrieved!.enabled).toBe(true); // still enabled for retry
  });

  test("can be re-claimed after failing", () => {
    const job = createSchedule({
      name: "Retry",
      message: "try again",
      nextRunAt: Date.now() - 1000,
    });

    claimDueSchedules(Date.now());
    failOneShot(job.id);

    // Should be claimable again
    const claimed = claimDueSchedules(Date.now());
    expect(claimed.length).toBe(1);
    expect(claimed[0].id).toBe(job.id);
  });
});

describe("cancelSchedule", () => {
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM cron_runs");
    db.run("DELETE FROM cron_jobs");
  });

  test("cancels an active one-shot schedule", () => {
    const job = createSchedule({
      name: "Cancel me",
      message: "never fire",
      nextRunAt: Date.now() + 60_000,
    });

    const result = cancelSchedule(job.id);
    expect(result).toBe(true);

    const retrieved = getSchedule(job.id);
    expect(retrieved!.status).toBe("cancelled");
    expect(retrieved!.enabled).toBe(false);
  });

  test("returns false for non-active schedule", () => {
    const job = createSchedule({
      name: "Already done",
      message: "completed",
      nextRunAt: Date.now() - 1000,
    });

    // Claim and complete it
    claimDueSchedules(Date.now());
    completeOneShot(job.id);

    const result = cancelSchedule(job.id);
    expect(result).toBe(false);
  });

  test("cancelled schedule is not claimable", () => {
    const job = createSchedule({
      name: "Cancelled",
      message: "should not fire",
      nextRunAt: Date.now() - 1000,
    });

    cancelSchedule(job.id);

    const claimed = claimDueSchedules(Date.now());
    expect(claimed.length).toBe(0);
  });
});

// ── Routing and mode round-trip ─────────────────────────────────────

describe("routing and mode fields", () => {
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM cron_runs");
    db.run("DELETE FROM cron_jobs");
  });

  test("recurring schedule defaults to execute mode and all_channels", () => {
    const job = createSchedule({
      name: "Defaults",
      cronExpression: "0 9 * * *",
      message: "check defaults",
      syntax: "cron",
    });

    expect(job.mode).toBe("execute");
    expect(job.routingIntent).toBe("all_channels");
    expect(job.routingHints).toEqual({});
    expect(job.status).toBe("active");
  });

  test("routing hints round-trip through create/read", () => {
    const hints = { channels: ["slack", "discord"], priority: 1 };
    const job = createSchedule({
      name: "Routed",
      cronExpression: "0 9 * * *",
      message: "routed msg",
      syntax: "cron",
      routingIntent: "multi_channel",
      routingHints: hints,
      mode: "notify",
    });

    const retrieved = getSchedule(job.id);
    expect(retrieved!.routingIntent).toBe("multi_channel");
    expect(retrieved!.routingHints).toEqual(hints);
    expect(retrieved!.mode).toBe("notify");
  });

  test("routing hints round-trip through DB raw query", () => {
    const hints = { target: "sms" };
    const job = createSchedule({
      name: "Raw round-trip",
      message: "check raw",
      nextRunAt: Date.now() + 60_000,
      routingIntent: "single_channel",
      routingHints: hints,
    });

    const raw = getRawDb()
      .query(
        "SELECT mode, routing_intent, routing_hints_json, status FROM cron_jobs WHERE id = ?",
      )
      .get(job.id) as {
      mode: string;
      routing_intent: string;
      routing_hints_json: string;
      status: string;
    } | null;
    expect(raw).not.toBeNull();
    expect(raw!.mode).toBe("execute");
    expect(raw!.routing_intent).toBe("single_channel");
    expect(JSON.parse(raw!.routing_hints_json)).toEqual(hints);
    expect(raw!.status).toBe("active");
  });

  test("updateSchedule updates mode and routing fields", () => {
    const job = createSchedule({
      name: "Update routing",
      cronExpression: "0 9 * * *",
      message: "update routing",
      syntax: "cron",
    });

    const updated = updateSchedule(job.id, {
      mode: "notify",
      routingIntent: "single_channel",
      routingHints: { channel: "telegram" },
    });

    expect(updated).not.toBeNull();
    expect(updated!.mode).toBe("notify");
    expect(updated!.routingIntent).toBe("single_channel");
    expect(updated!.routingHints).toEqual({ channel: "telegram" });
  });
});

// ── listSchedules filters ───────────────────────────────────────────

describe("listSchedules filters", () => {
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM cron_runs");
    db.run("DELETE FROM cron_jobs");
  });

  test("oneShotOnly filter returns only one-shot schedules", () => {
    createSchedule({
      name: "Recurring",
      cronExpression: "0 9 * * *",
      message: "recurring",
      syntax: "cron",
    });
    createSchedule({
      name: "One-shot",
      message: "one-shot",
      nextRunAt: Date.now() + 60_000,
    });

    const oneShots = listSchedules({ oneShotOnly: true });
    expect(oneShots.length).toBe(1);
    expect(oneShots[0].name).toBe("One-shot");
    expect(oneShots[0].expression).toBeNull();
  });

  test("recurringOnly filter returns only recurring schedules", () => {
    createSchedule({
      name: "Recurring",
      cronExpression: "0 9 * * *",
      message: "recurring",
      syntax: "cron",
    });
    createSchedule({
      name: "One-shot",
      message: "one-shot",
      nextRunAt: Date.now() + 60_000,
    });

    const recurring = listSchedules({ recurringOnly: true });
    expect(recurring.length).toBe(1);
    expect(recurring[0].name).toBe("Recurring");
    expect(recurring[0].expression).not.toBeNull();
  });
});

// ── describeCronExpression ──────────────────────────────────────────

describe("describeCronExpression", () => {
  test("returns 'One-time' for null expression", () => {
    expect(describeCronExpression(null)).toBe("One-time");
  });

  test("returns description for valid cron expression", () => {
    expect(describeCronExpression("0 9 * * *")).toBe("Every day at 9:00 AM");
  });
});
