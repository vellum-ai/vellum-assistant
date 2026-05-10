import { beforeEach, describe, expect, test } from "bun:test";
import { mock } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
  truncateForLog: (value: string) => value,
}));

import { sql } from "drizzle-orm";

import { getDb } from "../../memory/db-connection.js";
import { initializeDb } from "../../memory/db-init.js";
import {
  completeHeartbeatRun,
  countCompletedHeartbeatRuns,
  insertPendingHeartbeatRun,
  listHeartbeatRuns,
  markStaleRunningAsError,
  markStaleRunsAsMissed,
  skipHeartbeatRun,
  startHeartbeatRun,
  supersedePendingRun,
} from "../heartbeat-run-store.js";

initializeDb();

describe("heartbeat-run-store", () => {
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM heartbeat_runs");
  });

  test("insertPendingHeartbeatRun creates row with status pending and null timing", () => {
    const scheduledFor = Date.now();
    const id = insertPendingHeartbeatRun(scheduledFor);
    expect(id).toBeTruthy();

    const rows = listHeartbeatRuns();
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

    const rows = listHeartbeatRuns();
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

    const rows = listHeartbeatRuns();
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
    insertPendingHeartbeatRun(now - 2000);
    insertPendingHeartbeatRun(now);
    insertPendingHeartbeatRun(now - 1000);

    const rows = listHeartbeatRuns();
    expect(rows).toHaveLength(3);
    expect(rows[0].scheduledFor).toBe(now);
    expect(rows[1].scheduledFor).toBe(now - 1000);
    expect(rows[2].scheduledFor).toBe(now - 2000);
  });

  test("listHeartbeatRuns respects limit", () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      insertPendingHeartbeatRun(now + i);
    }

    const rows = listHeartbeatRuns(3);
    expect(rows).toHaveLength(3);
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
});
