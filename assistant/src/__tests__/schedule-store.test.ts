import { beforeEach, describe, expect, test } from "bun:test";
import { mock } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
  truncateForLog: (value: string) => value,
}));

// Stub the background-wake publisher so these store-level unit tests stay
// hermetic. `notifySchedulesChanged()` fires a debounced background-wake
// refresh on every mutation; left real, that 250ms timer performs a
// synchronous DB read plus a platform-client lookup which compete with the
// serialized async event delivery and can push a `sync_changed` past the
// wait deadline on loaded runners. Background-wake behavior is covered by the
// background-wake tests.
mock.module("../background-wake/publisher.js", () => ({
  refreshBackgroundWakeIntent: () => {},
}));

import { SYNC_TAGS } from "../daemon/message-types/sync.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import type { AssistantEvent } from "../runtime/assistant-event.js";
import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import {
  cancelSchedule,
  claimDueSchedules,
  completeOneShot,
  completeScheduleRun,
  createSchedule,
  createScheduleRun,
  deleteSchedule,
  describeCronExpression,
  failOneShot,
  getSchedule,
  listSchedules,
  updateSchedule,
} from "../schedule/schedule-store.js";

await initializeDb();

/** Access the underlying bun:sqlite Database for raw parameterized queries. */
function getRawDb(): import("bun:sqlite").Database {
  return (getDb() as unknown as { $client: import("bun:sqlite").Database })
    .$client;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  // Event delivery is async (serialized through the hub's broadcast chain),
  // so poll until it lands. The deadline is generous to absorb scheduling
  // jitter on loaded CI runners — the happy path returns the moment the
  // predicate holds, so a larger budget costs nothing when events flow.
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for schedule-store event");
}

async function expectScheduleSyncEvent(
  received: AssistantEvent[],
): Promise<void> {
  await waitFor(() =>
    received.some(
      (event) =>
        event.message.type === "sync_changed" &&
        event.message.tags.includes(SYNC_TAGS.assistantSchedules),
    ),
  );
  const syncEvent = received.find(
    (event) =>
      event.message.type === "sync_changed" &&
      event.message.tags.includes(SYNC_TAGS.assistantSchedules),
  );
  expect(syncEvent?.message).toEqual({
    type: "sync_changed",
    tags: [SYNC_TAGS.assistantSchedules],
  });
  received.length = 0;
}

describe("schedule sync invalidation", () => {
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM cron_runs");
    db.run("DELETE FROM cron_jobs");
  });

  test("store-level schedule mutations emit schedule sync invalidation", async () => {
    const received: AssistantEvent[] = [];
    const subscription = assistantEventHub.subscribe({
      type: "process",
      callback: (event) => {
        received.push(event);
      },
    });

    try {
      const job = await createSchedule({
        name: "Sync test",
        cronExpression: "* * * * *",
        message: "sync me",
        syntax: "cron",
      });
      await expectScheduleSyncEvent(received);

      await updateSchedule(job.id, { name: "Updated sync test" });
      await expectScheduleSyncEvent(received);

      getRawDb().run("UPDATE cron_jobs SET next_run_at = ? WHERE id = ?", [
        Date.now() - 1000,
        job.id,
      ]);
      expect(await claimDueSchedules(Date.now())).toHaveLength(1);
      await expectScheduleSyncEvent(received);

      const runId = await createScheduleRun(job.id, "conv-123");
      await completeScheduleRun(runId, { status: "ok" });
      await expectScheduleSyncEvent(received);

      const oneShot = await createSchedule({
        name: "One-shot sync test",
        message: "cancel me",
        nextRunAt: Date.now() + 60_000,
      });
      await expectScheduleSyncEvent(received);

      expect(await cancelSchedule(oneShot.id)).toBe(true);
      await expectScheduleSyncEvent(received);

      expect(await deleteSchedule(job.id)).toBe(true);
      await expectScheduleSyncEvent(received);
    } finally {
      subscription.dispose();
    }
  });
});

// ── Cron schedules ──────────────────────────────────────────────────

describe("createSchedule (cron)", () => {
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM cron_runs");
    db.run("DELETE FROM cron_jobs");
  });

  test("creates a cron schedule using only cronExpression", async () => {
    const job = await createSchedule({
      name: "Morning ping",
      cronExpression: "0 9 * * *",
      message: "good morning",
      syntax: "cron",
    });

    expect(job.syntax).toBe("cron");
    expect(job.expression).toBe("0 9 * * *");
    expect(job.cronExpression).toBe("0 9 * * *");
    expect(job.description).toBe("Morning ping");
    expect(job.nextRunAt).toBeGreaterThan(Date.now() - 1000);
    expect(job.enabled).toBe(true);
  });

  test("persisted cron schedule is retrievable with new fields", async () => {
    const job = await createSchedule({
      name: "Hourly",
      description: "Check the hourly status report",
      cronExpression: "0 * * * *",
      message: "hourly check",
      syntax: "cron",
    });

    const retrieved = getSchedule(job.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.syntax).toBe("cron");
    expect(retrieved!.expression).toBe("0 * * * *");
    expect(retrieved!.cronExpression).toBe("0 * * * *");
    expect(retrieved!.description).toBe("Check the hourly status report");
  });

  test("normalizes schedule descriptions on create and update", async () => {
    const job = await createSchedule({
      name: "Description normalization",
      description: "  Daily executive summary  ",
      cronExpression: "0 8 * * *",
      message: "summarize the day",
      syntax: "cron",
    });

    expect(job.description).toBe("Daily executive summary");

    const raw = getRawDb()
      .query("SELECT description FROM cron_jobs WHERE id = ?")
      .get(job.id) as { description: string };
    expect(raw.description).toBe("Daily executive summary");

    const updated = await updateSchedule(job.id, {
      description: "  Updated summary prompt  ",
    });
    expect(updated).not.toBeNull();
    expect(updated!.description).toBe("Updated summary prompt");
    expect(getSchedule(job.id)!.description).toBe("Updated summary prompt");
    expect(listSchedules()[0].description).toBe("Updated summary prompt");
  });

  test("defaults source conversation metadata to null", async () => {
    const job = await createSchedule({
      name: "No source conversation",
      cronExpression: "0 9 * * *",
      message: "daily check",
      syntax: "cron",
    });

    expect(job.createdFromConversationId).toBeNull();
    expect(getSchedule(job.id)!.createdFromConversationId).toBeNull();

    const raw = getRawDb()
      .query("SELECT created_from_conversation_id FROM cron_jobs WHERE id = ?")
      .get(job.id) as { created_from_conversation_id: string | null };
    expect(raw.created_from_conversation_id).toBeNull();
  });

  test("persists source conversation metadata through create, list, and update", async () => {
    const job = await createSchedule({
      name: "With source conversation",
      cronExpression: "0 9 * * *",
      message: "daily check",
      syntax: "cron",
      createdFromConversationId: "conv-source",
    });

    expect(job.createdFromConversationId).toBe("conv-source");
    expect(getSchedule(job.id)!.createdFromConversationId).toBe("conv-source");
    expect(listSchedules()[0].createdFromConversationId).toBe("conv-source");

    const updated = await updateSchedule(job.id, {
      createdFromConversationId: "conv-updated",
    });
    expect(updated!.createdFromConversationId).toBe("conv-updated");

    const cleared = await updateSchedule(job.id, {
      createdFromConversationId: null,
    });
    expect(cleared!.createdFromConversationId).toBeNull();
  });

  test("stores schedule_syntax in the DB row", async () => {
    const job = await createSchedule({
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

  test("rejects invalid cron expression", async () => {
    await expect(
      createSchedule({
        name: "Bad cron",
        cronExpression: "not-a-cron",
        message: "fail",
        syntax: "cron",
      }),
    ).rejects.toThrow();
  });
});

// ── RRULE schedule creation ──────────────────────────────────────────

describe("createSchedule (RRULE)", () => {
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM cron_runs");
    db.run("DELETE FROM cron_jobs");
  });

  test("creates an RRULE schedule with syntax + expression", async () => {
    const rrule = "DTSTART:20260101T090000Z\nRRULE:FREQ=DAILY;INTERVAL=1";
    const job = await createSchedule({
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

  test("stores rrule syntax in DB", async () => {
    const rrule = "DTSTART:20260101T090000Z\nRRULE:FREQ=WEEKLY;BYDAY=MO";
    const job = await createSchedule({
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

  test("rejects RRULE without DTSTART", async () => {
    await expect(
      createSchedule({
        name: "No dtstart",
        cronExpression: "RRULE:FREQ=DAILY",
        message: "fail",
        syntax: "rrule",
        expression: "RRULE:FREQ=DAILY",
      }),
    ).rejects.toThrow();
  });
});

// ── RRULE set expressions (RDATE, EXDATE, multi-RRULE) ──────────────

describe("createSchedule (RRULE set)", () => {
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM cron_runs");
    db.run("DELETE FROM cron_jobs");
  });

  test("creates schedule with RRULE + EXDATE set expression", async () => {
    const expression = [
      "DTSTART:20250101T090000Z",
      "RRULE:FREQ=DAILY;INTERVAL=1",
      "EXDATE:20250102T090000Z",
    ].join("\n");

    const job = await createSchedule({
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

  test("creates schedule with RRULE + RDATE set expression", async () => {
    const expression = [
      "DTSTART:20250101T090000Z",
      "RRULE:FREQ=WEEKLY;BYDAY=MO",
      "RDATE:20250115T090000Z",
    ].join("\n");

    const job = await createSchedule({
      name: "Weekly with extra dates",
      cronExpression: expression,
      message: "rdate test",
      syntax: "rrule",
      expression,
    });

    expect(job.syntax).toBe("rrule");
    expect(job.expression).toContain("RDATE");
  });

  test("preserves full set expression text in DB without collapsing", async () => {
    const expression = [
      "DTSTART:20250101T090000Z",
      "RRULE:FREQ=DAILY;INTERVAL=1",
      "EXDATE:20250102T090000Z",
      "EXDATE:20250103T090000Z",
    ].join("\n");

    const job = await createSchedule({
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

  test("retrieved set schedule matches what was stored", async () => {
    const expression = [
      "DTSTART:20250101T090000Z",
      "RRULE:FREQ=DAILY;INTERVAL=1",
      "EXDATE:20250105T090000Z",
    ].join("\n");

    const job = await createSchedule({
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

  test("claims RRULE set schedule and correctly advances nextRunAt past exclusions", async () => {
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

    const job = await createSchedule({
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
    const claimed = await claimDueSchedules(now);
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

  test("updating cronExpression (legacy path) still works", async () => {
    const job = await createSchedule({
      name: "Update test",
      cronExpression: "0 9 * * *",
      message: "update me",
      syntax: "cron",
    });

    const updated = await updateSchedule(job.id, {
      cronExpression: "0 10 * * *",
    });
    expect(updated).not.toBeNull();
    expect(updated!.cronExpression).toBe("0 10 * * *");
    expect(updated!.expression).toBe("0 10 * * *");
    expect(updated!.syntax).toBe("cron");
    // nextRunAt should have been recomputed
    expect(updated!.nextRunAt).not.toBe(job.nextRunAt);
  });

  test("updating syntax + expression switches to RRULE", async () => {
    const job = await createSchedule({
      name: "Switch to RRULE",
      cronExpression: "0 9 * * *",
      message: "switching",
      syntax: "cron",
    });

    const rrule = "DTSTART:20260101T090000Z\nRRULE:FREQ=DAILY;INTERVAL=2";
    const updated = await updateSchedule(job.id, {
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

  test("updating to RRULE set expression preserves full text", async () => {
    const job = await createSchedule({
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

    const updated = await updateSchedule(job.id, {
      syntax: "rrule",
      expression: setExpr,
    });

    expect(updated).not.toBeNull();
    expect(updated!.syntax).toBe("rrule");
    expect(updated!.expression).toBe(setExpr);
    expect(updated!.expression).toContain("EXDATE");
    expect(updated!.nextRunAt).toBeGreaterThan(0);
  });

  test("rejects invalid expression on update", async () => {
    const job = await createSchedule({
      name: "Reject bad update",
      cronExpression: "0 9 * * *",
      message: "nope",
      syntax: "cron",
    });

    await expect(
      updateSchedule(job.id, {
        syntax: "rrule",
        expression: "RRULE:FREQ=DAILY",
      }),
    ).rejects.toThrow();
  });
});

// ── claimDueSchedules ────────────────────────────────────────────────

describe("claimDueSchedules", () => {
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM cron_runs");
    db.run("DELETE FROM cron_jobs");
  });

  test("claims due cron schedules and advances nextRunAt", async () => {
    const job = await createSchedule({
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

    const claimed = await claimDueSchedules(Date.now());
    expect(claimed.length).toBe(1);
    expect(claimed[0].id).toBe(job.id);
    expect(claimed[0].syntax).toBe("cron");
    expect(claimed[0].nextRunAt).toBeGreaterThan(Date.now() - 1000);
  });

  test("claims due RRULE schedules and advances nextRunAt", async () => {
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
    const job = await createSchedule({
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
    const claimed = await claimDueSchedules(now);
    expect(claimed.length).toBe(1);
    expect(claimed[0].id).toBe(job.id);
    expect(claimed[0].syntax).toBe("rrule");
    // nextRunAt should be in the future (at or after now)
    expect(claimed[0].nextRunAt).toBeGreaterThanOrEqual(now);
  });

  test("does not claim schedules that are not yet due", async () => {
    await createSchedule({
      name: "Not due yet",
      cronExpression: "0 9 * * *",
      message: "future schedule",
      syntax: "cron",
    });

    const claimed = await claimDueSchedules(0); // timestamp 0 means nothing is due
    expect(claimed.length).toBe(0);
  });

  test("claims exhausted RRULE schedule and disables it", async () => {
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

    const claimed = await claimDueSchedules(Date.now());
    expect(claimed.length).toBe(1);
    expect(claimed[0].id).toBe(id);
    expect(claimed[0].enabled).toBe(false);
    expect(claimed[0].nextRunAt).toBe(0);

    // Verify the schedule is disabled in the DB
    const persisted = getSchedule(id);
    expect(persisted!.enabled).toBe(false);

    // A subsequent claim should not pick it up
    const again = await claimDueSchedules(Date.now());
    expect(again.length).toBe(0);
  });

  test("optimistic lock prevents double-claiming", async () => {
    const job = await createSchedule({
      name: "Double claim",
      cronExpression: "* * * * *",
      message: "no double",
      syntax: "cron",
    });

    getRawDb().run("UPDATE cron_jobs SET next_run_at = ? WHERE id = ?", [
      Date.now() - 1000,
      job.id,
    ]);

    const first = await claimDueSchedules(Date.now());
    expect(first.length).toBe(1);

    // Second claim should find nothing since nextRunAt was advanced
    const second = await claimDueSchedules(Date.now() - 500);
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

  test("creates a one-shot schedule with no expression", async () => {
    const fireAt = Date.now() + 60_000;
    const job = await createSchedule({
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

  test("creates a one-shot schedule with notify mode and routing", async () => {
    const fireAt = Date.now() + 60_000;
    const hints = { preferredChannel: "slack", threadId: "abc123" };
    const job = await createSchedule({
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

  test("rejects one-shot schedule without nextRunAt", async () => {
    await expect(
      createSchedule({
        name: "Bad one-shot",
        message: "no time",
      }),
    ).rejects.toThrow("One-shot schedules (no expression) require nextRunAt");
  });

  test("one-shot schedule persists and round-trips correctly", async () => {
    const fireAt = Date.now() + 120_000;
    const hints = { channel: "telegram" };
    const job = await createSchedule({
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

  test("claims one-shot schedules whose nextRunAt <= now", async () => {
    const job = await createSchedule({
      name: "Due one-shot",
      message: "fire now",
      nextRunAt: Date.now() - 1000,
    });

    const claimed = await claimDueSchedules(Date.now());
    expect(claimed.length).toBe(1);
    expect(claimed[0].id).toBe(job.id);
    expect(claimed[0].expression).toBeNull();
    expect(claimed[0].status).toBe("firing");
  });

  test("does not claim one-shot schedules that are not yet due", async () => {
    await createSchedule({
      name: "Future one-shot",
      message: "not yet",
      nextRunAt: Date.now() + 60_000,
    });

    const claimed = await claimDueSchedules(Date.now());
    expect(claimed.length).toBe(0);
  });

  test("does not double-claim one-shot schedules", async () => {
    await createSchedule({
      name: "Once only",
      message: "no double",
      nextRunAt: Date.now() - 1000,
    });

    const first = await claimDueSchedules(Date.now());
    expect(first.length).toBe(1);

    // Second claim should find nothing since status is now 'firing'
    const second = await claimDueSchedules(Date.now());
    expect(second.length).toBe(0);
  });

  test("claims both recurring and one-shot schedules in the same tick", async () => {
    const recurring = await createSchedule({
      name: "Recurring",
      cronExpression: "* * * * *",
      message: "recurring",
      syntax: "cron",
    });
    getRawDb().run("UPDATE cron_jobs SET next_run_at = ? WHERE id = ?", [
      Date.now() - 1000,
      recurring.id,
    ]);

    await createSchedule({
      name: "One-shot",
      message: "one-shot",
      nextRunAt: Date.now() - 1000,
    });

    const claimed = await claimDueSchedules(Date.now());
    expect(claimed.length).toBe(2);
    const expressions = claimed.map((c) => c.expression);
    expect(expressions).toContain(null); // one-shot
    expect(expressions.some(Boolean)).toBe(true); // recurring
  });
});

// ── One-shot lifecycle (complete, fail, cancel) ─────────────────────

describe("completeOneShot", () => {
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM cron_runs");
    db.run("DELETE FROM cron_jobs");
  });

  test("transitions firing -> fired", async () => {
    const job = await createSchedule({
      name: "Complete me",
      message: "done",
      nextRunAt: Date.now() - 1000,
    });

    // Claim first to get to 'firing' state
    await claimDueSchedules(Date.now());

    await completeOneShot(job.id);

    const retrieved = getSchedule(job.id);
    expect(retrieved!.status).toBe("fired");
    expect(retrieved!.enabled).toBe(false);
  });

  test("does not transition if not in firing state", async () => {
    const job = await createSchedule({
      name: "Not firing",
      message: "still active",
      nextRunAt: Date.now() + 60_000,
    });

    await completeOneShot(job.id);

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

  test("transitions firing -> active for retry", async () => {
    const job = await createSchedule({
      name: "Fail me",
      message: "retry",
      nextRunAt: Date.now() - 1000,
    });

    // Claim to get to 'firing'
    await claimDueSchedules(Date.now());

    await failOneShot(job.id);

    const retrieved = getSchedule(job.id);
    expect(retrieved!.status).toBe("active");
    expect(retrieved!.enabled).toBe(true); // still enabled for retry
  });

  test("can be re-claimed after failing", async () => {
    const job = await createSchedule({
      name: "Retry",
      message: "try again",
      nextRunAt: Date.now() - 1000,
    });

    await claimDueSchedules(Date.now());
    await failOneShot(job.id);

    // Should be claimable again
    const claimed = await claimDueSchedules(Date.now());
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

  test("cancels an active one-shot schedule", async () => {
    const job = await createSchedule({
      name: "Cancel me",
      message: "never fire",
      nextRunAt: Date.now() + 60_000,
    });

    const result = await cancelSchedule(job.id);
    expect(result).toBe(true);

    const retrieved = getSchedule(job.id);
    expect(retrieved!.status).toBe("cancelled");
    expect(retrieved!.enabled).toBe(false);
  });

  test("returns false for non-active schedule", async () => {
    const job = await createSchedule({
      name: "Already done",
      message: "completed",
      nextRunAt: Date.now() - 1000,
    });

    // Claim and complete it
    await claimDueSchedules(Date.now());
    await completeOneShot(job.id);

    const result = await cancelSchedule(job.id);
    expect(result).toBe(false);
  });

  test("cancelled schedule is not claimable", async () => {
    const job = await createSchedule({
      name: "Cancelled",
      message: "should not fire",
      nextRunAt: Date.now() - 1000,
    });

    await cancelSchedule(job.id);

    const claimed = await claimDueSchedules(Date.now());
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

  test("recurring schedule defaults to execute mode and all_channels", async () => {
    const job = await createSchedule({
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

  test("routing hints round-trip through create/read", async () => {
    const hints = { channels: ["slack", "discord"], priority: 1 };
    const job = await createSchedule({
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

  test("routing hints round-trip through DB raw query", async () => {
    const hints = { target: "telegram" };
    const job = await createSchedule({
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

  test("updateSchedule updates mode and routing fields", async () => {
    const job = await createSchedule({
      name: "Update routing",
      cronExpression: "0 9 * * *",
      message: "update routing",
      syntax: "cron",
    });

    const updated = await updateSchedule(job.id, {
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

// ── Script timeout override ─────────────────────────────────────────

describe("script timeout override", () => {
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM cron_runs");
    db.run("DELETE FROM cron_jobs");
  });

  test("defaults timeoutMs to null when not provided", async () => {
    // GIVEN a schedule created without a timeout override
    const job = await createSchedule({
      name: "No timeout",
      cronExpression: "0 9 * * *",
      message: "no timeout",
      syntax: "cron",
    });

    // THEN the stored timeout is null (the runner falls back to the default)
    expect(job.timeoutMs).toBeNull();
    expect(getSchedule(job.id)!.timeoutMs).toBeNull();
  });

  test("persists a timeoutMs override through create/read", async () => {
    // GIVEN a script schedule created with a custom timeout
    const job = await createSchedule({
      name: "Slow script",
      cronExpression: "0 9 * * *",
      message: "",
      script: "sleep 5",
      mode: "script",
      syntax: "cron",
      timeoutMs: 120_000,
    });

    // THEN the override round-trips through the store
    expect(job.timeoutMs).toBe(120_000);
    expect(getSchedule(job.id)!.timeoutMs).toBe(120_000);
  });

  test("updateSchedule sets and clears the timeout override", async () => {
    // GIVEN a schedule with a custom timeout
    const job = await createSchedule({
      name: "Adjust timeout",
      cronExpression: "0 9 * * *",
      message: "",
      script: "echo hi",
      mode: "script",
      syntax: "cron",
      timeoutMs: 90_000,
    });

    // WHEN the timeout is changed
    const updated = await updateSchedule(job.id, { timeoutMs: 5_000 });

    // THEN the new value is stored
    expect(updated!.timeoutMs).toBe(5_000);

    // AND WHEN the timeout is cleared back to the default
    const cleared = await updateSchedule(job.id, { timeoutMs: null });

    // THEN it reverts to null
    expect(cleared!.timeoutMs).toBeNull();
    expect(getSchedule(job.id)!.timeoutMs).toBeNull();
  });
});

// ── Capability manifest ─────────────────────────────────────────────

describe("capability manifest", () => {
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM cron_runs");
    db.run("DELETE FROM cron_jobs");
  });

  const manifest = {
    tools: ["file_write"],
    hostFunctions: [],
    persona: false,
  };

  test("persists a capability manifest through create/read", async () => {
    const job = await createSchedule({
      name: "Capable schedule",
      cronExpression: "0 9 * * *",
      message: "do scoped work",
      syntax: "cron",
      capabilities: manifest,
    });

    expect(job.capabilities).toEqual(manifest);
    expect(getSchedule(job.id)!.capabilities).toEqual(manifest);
  });

  test("defaults capabilities to null when not provided", async () => {
    const job = await createSchedule({
      name: "No manifest",
      cronExpression: "0 9 * * *",
      message: "unconstrained",
      syntax: "cron",
    });

    expect(job.capabilities).toBeNull();
    expect(getSchedule(job.id)!.capabilities).toBeNull();
  });

  test("updateSchedule sets and clears the capability manifest", async () => {
    const job = await createSchedule({
      name: "Update manifest",
      cronExpression: "0 9 * * *",
      message: "update manifest",
      syntax: "cron",
    });

    expect(job.capabilities).toBeNull();

    const updated = await updateSchedule(job.id, { capabilities: manifest });
    expect(updated!.capabilities).toEqual(manifest);
    expect(getSchedule(job.id)!.capabilities).toEqual(manifest);

    const cleared = await updateSchedule(job.id, { capabilities: null });
    expect(cleared!.capabilities).toBeNull();
    expect(getSchedule(job.id)!.capabilities).toBeNull();
  });
});

// ── listSchedules filters ───────────────────────────────────────────

describe("listSchedules filters", () => {
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM cron_runs");
    db.run("DELETE FROM cron_jobs");
  });

  test("oneShotOnly filter returns only one-shot schedules", async () => {
    await createSchedule({
      name: "Recurring",
      cronExpression: "0 9 * * *",
      message: "recurring",
      syntax: "cron",
    });
    await createSchedule({
      name: "One-shot",
      message: "one-shot",
      nextRunAt: Date.now() + 60_000,
    });

    const oneShots = listSchedules({ oneShotOnly: true });
    expect(oneShots.length).toBe(1);
    expect(oneShots[0].name).toBe("One-shot");
    expect(oneShots[0].expression).toBeNull();
  });

  test("recurringOnly filter returns only recurring schedules", async () => {
    await createSchedule({
      name: "Recurring",
      cronExpression: "0 9 * * *",
      message: "recurring",
      syntax: "cron",
    });
    await createSchedule({
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

// ── Wake mode ───────────────────────────────────────────────────────

describe("createSchedule (wake mode)", () => {
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM cron_runs");
    db.run("DELETE FROM cron_jobs");
  });

  test("creates a wake schedule with wakeConversationId", async () => {
    const job = await createSchedule({
      name: "Wake conv",
      message: "resume conversation",
      nextRunAt: Date.now() + 60_000,
      mode: "wake",
      wakeConversationId: "conv-123",
    });

    expect(job.mode).toBe("wake");
    expect(job.wakeConversationId).toBe("conv-123");
    expect(job.status).toBe("active");

    const retrieved = getSchedule(job.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.wakeConversationId).toBe("conv-123");
  });

  test("throws when creating wake schedule without wakeConversationId", async () => {
    await expect(
      createSchedule({
        name: "Bad wake",
        message: "no conv id",
        nextRunAt: Date.now() + 60_000,
        mode: "wake",
      }),
    ).rejects.toThrow("Wake schedules require wakeConversationId");
  });
});

// ── listSchedules new filters ───────────────────────────────────────

describe("listSchedules new filters", () => {
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM cron_runs");
    db.run("DELETE FROM cron_jobs");
  });

  test("mode filter returns only schedules with matching mode", async () => {
    await createSchedule({
      name: "Execute schedule",
      message: "execute",
      nextRunAt: Date.now() + 60_000,
      mode: "execute",
    });
    await createSchedule({
      name: "Wake schedule",
      message: "wake",
      nextRunAt: Date.now() + 60_000,
      mode: "wake",
      wakeConversationId: "conv-abc",
    });

    const wakeOnly = listSchedules({ mode: "wake" });
    expect(wakeOnly.length).toBe(1);
    expect(wakeOnly[0].name).toBe("Wake schedule");
    expect(wakeOnly[0].mode).toBe("wake");
  });

  test("createdBy filter returns only schedules with matching creator", async () => {
    await createSchedule({
      name: "Agent schedule",
      message: "by agent",
      nextRunAt: Date.now() + 60_000,
      createdBy: "agent",
    });
    await createSchedule({
      name: "Defer schedule",
      message: "by defer",
      nextRunAt: Date.now() + 60_000,
      createdBy: "defer",
    });

    const deferOnly = listSchedules({ createdBy: "defer" });
    expect(deferOnly.length).toBe(1);
    expect(deferOnly[0].name).toBe("Defer schedule");
    expect(deferOnly[0].createdBy).toBe("defer");
  });

  test("conversationId filter returns only wakes targeting that conversation", async () => {
    await createSchedule({
      name: "Wake for conv-123",
      message: "wake conv-123",
      nextRunAt: Date.now() + 60_000,
      mode: "wake",
      wakeConversationId: "conv-123",
    });
    await createSchedule({
      name: "Wake for conv-456",
      message: "wake conv-456",
      nextRunAt: Date.now() + 60_000,
      mode: "wake",
      wakeConversationId: "conv-456",
    });
    await createSchedule({
      name: "Regular schedule",
      message: "no wake",
      nextRunAt: Date.now() + 60_000,
    });

    const conv123Only = listSchedules({ conversationId: "conv-123" });
    expect(conv123Only.length).toBe(1);
    expect(conv123Only[0].name).toBe("Wake for conv-123");
    expect(conv123Only[0].wakeConversationId).toBe("conv-123");
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
