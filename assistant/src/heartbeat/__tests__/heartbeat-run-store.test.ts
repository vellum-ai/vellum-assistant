import { beforeEach, describe, expect, test } from "bun:test";

import { sql } from "drizzle-orm";

import { getDb } from "../../persistence/db-connection.js";
import { initializeDb } from "../../persistence/db-init.js";
import { heartbeatRuns } from "../../persistence/schema/index.js";
import {
  completeHeartbeatRun,
  countCompletedHeartbeatRuns,
  getLastHeartbeatRunAt,
  insertPendingHeartbeatRun,
  listHeartbeatRuns,
  markStaleRunningAsError,
  markStaleRunsAsMissed,
  skipHeartbeatRun,
  startHeartbeatRun,
  supersedePendingRun,
} from "../heartbeat-run-store.js";

await initializeDb();

/**
 * Raw read-back of every row (any status). `listHeartbeatRuns` serves run
 * history and hides bookkeeping rows (pending/superseded), so tests that
 * assert on those statuses read the table directly.
 */
function allRuns() {
  return getDb()
    .select()
    .from(heartbeatRuns)
    .orderBy(sql`${heartbeatRuns.scheduledFor} DESC`)
    .all();
}

describe("heartbeat-run-store", () => {
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM heartbeat_runs");
  });

  test("insertPendingHeartbeatRun creates row with status pending and null timing", () => {
    const scheduledFor = Date.now();
    const id = insertPendingHeartbeatRun(scheduledFor);
    expect(id).toBeTruthy();

    const rows = allRuns();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(id);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].scheduledFor).toBe(scheduledFor);
    expect(rows[0].startedAt).toBeNull();
    expect(rows[0].finishedAt).toBeNull();
    expect(rows[0].durationMs).toBeNull();
    expect(rows[0].error).toBeNull();
    expect(rows[0].conversationId).toBeNull();
    expect(rows[0].skipReason).toBeNull();
  });

  test("startHeartbeatRun transitions pending -> running and sets startedAt", () => {
    const id = insertPendingHeartbeatRun(Date.now());
    const ok = startHeartbeatRun(id);
    expect(ok).toBe(true);

    const rows = listHeartbeatRuns();
    expect(rows[0].status).toBe("running");
    expect(rows[0].startedAt).toBeGreaterThan(0);
  });

  test("startHeartbeatRun returns false for non-pending row", () => {
    const id = insertPendingHeartbeatRun(Date.now());

    // Start once — succeeds
    expect(startHeartbeatRun(id)).toBe(true);
    // Start again — fails (already running)
    expect(startHeartbeatRun(id)).toBe(false);

    // Also: superseded row cannot be started
    const id2 = insertPendingHeartbeatRun(Date.now());
    supersedePendingRun(id2);
    expect(startHeartbeatRun(id2)).toBe(false);
  });

  test("completeHeartbeatRun transitions running -> ok with conversationId", () => {
    const id = insertPendingHeartbeatRun(Date.now());
    startHeartbeatRun(id);
    const ok = completeHeartbeatRun(id, {
      status: "ok",
      conversationId: "conv-123",
    });
    expect(ok).toBe(true);

    const rows = listHeartbeatRuns();
    expect(rows[0].status).toBe("ok");
    expect(rows[0].conversationId).toBe("conv-123");
    expect(rows[0].finishedAt).toBeGreaterThan(0);
    expect(rows[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  test("completeHeartbeatRun transitions running -> error with truncated error", () => {
    const id = insertPendingHeartbeatRun(Date.now());
    startHeartbeatRun(id);

    // 3KB string — should be truncated to 2000 chars
    const longError = "x".repeat(3000);
    const ok = completeHeartbeatRun(id, {
      status: "error",
      error: longError,
    });
    expect(ok).toBe(true);

    const rows = listHeartbeatRuns();
    expect(rows[0].status).toBe("error");
    expect(rows[0].error).toHaveLength(2000);
  });

  test("completeHeartbeatRun returns false when status is not running (CAS)", () => {
    const id = insertPendingHeartbeatRun(Date.now());
    startHeartbeatRun(id);
    // Complete with timeout
    completeHeartbeatRun(id, { status: "timeout" });
    // Try to complete again with ok — should fail (already timeout)
    const ok = completeHeartbeatRun(id, { status: "ok" });
    expect(ok).toBe(false);

    const rows = listHeartbeatRuns();
    expect(rows[0].status).toBe("timeout");
  });

  test("skipHeartbeatRun transitions pending -> skipped with reason", () => {
    const id = insertPendingHeartbeatRun(Date.now());
    const ok = skipHeartbeatRun(id, "outside_active_hours");
    expect(ok).toBe(true);

    const rows = listHeartbeatRuns();
    expect(rows[0].status).toBe("skipped");
    expect(rows[0].skipReason).toBe("outside_active_hours");
  });

  test("skipHeartbeatRun returns false for non-pending row", () => {
    const id = insertPendingHeartbeatRun(Date.now());
    startHeartbeatRun(id);
    const ok = skipHeartbeatRun(id, "disabled");
    expect(ok).toBe(false);
  });

  test("supersedePendingRun transitions pending -> superseded", () => {
    const id = insertPendingHeartbeatRun(Date.now());
    const ok = supersedePendingRun(id);
    expect(ok).toBe(true);

    const rows = allRuns();
    expect(rows[0].status).toBe("superseded");
  });

  test("supersedePendingRun returns false for non-pending row", () => {
    const id = insertPendingHeartbeatRun(Date.now());
    startHeartbeatRun(id);
    const ok = supersedePendingRun(id);
    expect(ok).toBe(false);
  });

  test("markStaleRunsAsMissed transitions old pending rows to missed", () => {
    const now = Date.now();
    // Two old pending rows
    const id1 = insertPendingHeartbeatRun(now - 10 * 60 * 1000);
    const id2 = insertPendingHeartbeatRun(now - 8 * 60 * 1000);
    // One recent pending row
    const id3 = insertPendingHeartbeatRun(now);

    const count = markStaleRunsAsMissed(5 * 60 * 1000);
    expect(count).toBe(2);

    const rows = allRuns();
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId[id1].status).toBe("missed");
    expect(byId[id2].status).toBe("missed");
    expect(byId[id3].status).toBe("pending");
  });

  test("markStaleRunningAsError transitions old running rows to error", () => {
    const now = Date.now();
    const id = insertPendingHeartbeatRun(now - 60 * 60 * 1000);
    startHeartbeatRun(id);

    // Backdate started_at to simulate a long-running process
    const db = getDb();
    const backdatedStartedAt = now - 60 * 60 * 1000;
    db.run(
      sql`UPDATE heartbeat_runs SET started_at = ${backdatedStartedAt} WHERE id = ${id}`,
    );

    const count = markStaleRunningAsError(45 * 60 * 1000);
    expect(count).toBe(1);

    const rows = listHeartbeatRuns();
    expect(rows[0].status).toBe("error");
    expect(rows[0].error).toBe("Process crashed or restarted during execution");
  });

  test("listHeartbeatRuns returns rows ordered by scheduledFor desc", () => {
    const now = Date.now();
    skipHeartbeatRun(insertPendingHeartbeatRun(now - 2000), "overlap");
    skipHeartbeatRun(insertPendingHeartbeatRun(now), "overlap");
    skipHeartbeatRun(insertPendingHeartbeatRun(now - 1000), "overlap");

    const rows = listHeartbeatRuns();
    expect(rows).toHaveLength(3);
    expect(rows[0].scheduledFor).toBe(now);
    expect(rows[1].scheduledFor).toBe(now - 1000);
    expect(rows[2].scheduledFor).toBe(now - 2000);
  });

  test("listHeartbeatRuns respects limit", () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      skipHeartbeatRun(insertPendingHeartbeatRun(now + i), "overlap");
    }

    const rows = listHeartbeatRuns(3);
    expect(rows).toHaveLength(3);
  });

  test("listHeartbeatRuns hides bookkeeping rows (pending, superseded)", () => {
    const now = Date.now();

    // Superseded rows: pending runs replaced by timer resets, scheduled in
    // the future at insert time — never ran.
    for (let i = 0; i < 3; i++) {
      supersedePendingRun(insertPendingHeartbeatRun(now + 60 * 60 * 1000 + i));
    }
    // The not-yet-fired next scheduled run.
    insertPendingHeartbeatRun(now + 60 * 60 * 1000 + 10);

    // Real history: a completed run, a skipped run, a missed run, and one
    // in flight.
    const okId = insertPendingHeartbeatRun(now - 3000);
    startHeartbeatRun(okId);
    completeHeartbeatRun(okId, { status: "ok", conversationId: "conv-1" });
    const skippedId = insertPendingHeartbeatRun(now - 2000);
    skipHeartbeatRun(skippedId, "outside_active_hours");
    const missedId = insertPendingHeartbeatRun(now - 10 * 60 * 1000);
    markStaleRunsAsMissed(5 * 60 * 1000);
    const runningId = insertPendingHeartbeatRun(now - 1000);
    startHeartbeatRun(runningId);

    const rows = listHeartbeatRuns();
    expect(rows.map((r) => r.id).sort()).toEqual(
      [okId, skippedId, missedId, runningId].sort(),
    );

    // The pagination cursor path applies the same filter.
    const paged = listHeartbeatRuns(10, now + 2 * 60 * 60 * 1000);
    expect(paged.map((r) => r.id).sort()).toEqual(
      [okId, skippedId, missedId, runningId].sort(),
    );
  });

  test("countCompletedHeartbeatRuns counts only ok rows", () => {
    const now = Date.now();

    // Insert runs with various statuses
    const id1 = insertPendingHeartbeatRun(now);
    startHeartbeatRun(id1);
    completeHeartbeatRun(id1, { status: "ok", conversationId: "conv-1" });

    const id2 = insertPendingHeartbeatRun(now + 1);
    startHeartbeatRun(id2);
    completeHeartbeatRun(id2, { status: "error", error: "something broke" });

    const id3 = insertPendingHeartbeatRun(now + 2);
    skipHeartbeatRun(id3, "disabled");

    const id4 = insertPendingHeartbeatRun(now + 3);
    startHeartbeatRun(id4);
    completeHeartbeatRun(id4, { status: "ok", conversationId: "conv-2" });

    expect(countCompletedHeartbeatRuns()).toBe(2);
  });

  test("countCompletedHeartbeatRuns returns 0 when no ok rows exist", () => {
    const now = Date.now();

    const id1 = insertPendingHeartbeatRun(now);
    startHeartbeatRun(id1);
    completeHeartbeatRun(id1, { status: "error", error: "fail" });

    const id2 = insertPendingHeartbeatRun(now + 1);
    skipHeartbeatRun(id2, "outside_active_hours");

    expect(countCompletedHeartbeatRuns()).toBe(0);
  });

  test("getLastHeartbeatRunAt returns the newest executed-run timestamp", () => {
    const now = Date.now();

    const oldId = insertPendingHeartbeatRun(now - 5000);
    startHeartbeatRun(oldId);
    completeHeartbeatRun(oldId, { status: "ok", conversationId: "conv-1" });

    const newId = insertPendingHeartbeatRun(now - 1000);
    startHeartbeatRun(newId);
    completeHeartbeatRun(newId, { status: "error", error: "fail" });

    // Non-executed rows never contribute, even when newer.
    skipHeartbeatRun(insertPendingHeartbeatRun(now), "outside_active_hours");
    insertPendingHeartbeatRun(now + 60 * 60 * 1000);

    const newRow = allRuns().find((r) => r.id === newId);
    expect(getLastHeartbeatRunAt()).toBe(newRow!.finishedAt!);
  });

  test("getLastHeartbeatRunAt falls back to startedAt when finishedAt is null", () => {
    const now = Date.now();
    const id = insertPendingHeartbeatRun(now - 60 * 60 * 1000);
    startHeartbeatRun(id);
    const db = getDb();
    const backdatedStartedAt = now - 60 * 60 * 1000;
    db.run(
      sql`UPDATE heartbeat_runs SET started_at = ${backdatedStartedAt} WHERE id = ${id}`,
    );
    // Crash sweep finalizes the row as error without a finishedAt.
    markStaleRunningAsError(45 * 60 * 1000);

    expect(getLastHeartbeatRunAt()).toBe(backdatedStartedAt);
  });

  test("getLastHeartbeatRunAt returns null when no run ever executed", () => {
    expect(getLastHeartbeatRunAt()).toBeNull();

    skipHeartbeatRun(insertPendingHeartbeatRun(Date.now()), "disabled");
    supersedePendingRun(insertPendingHeartbeatRun(Date.now() + 1));

    expect(getLastHeartbeatRunAt()).toBeNull();
  });
});
