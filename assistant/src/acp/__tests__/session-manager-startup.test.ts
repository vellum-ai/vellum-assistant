/**
 * Tests for AcpSessionManager's startup cleanup hook: any rows in
 * `acp_session_history` left in `running` or `initializing` status from a
 * previous daemon process must be flipped to `cancelled` with a
 * `daemon_restarted` stop reason on the next manager construction.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { AcpSessionManager } from "../../acp/session-manager.js";
import { getSqlite } from "../../memory/db-connection.js";
import { initializeDb } from "../../memory/db-init.js";
initializeDb();

function clearHistory() {
  getSqlite().run("DELETE FROM acp_session_history");
}

interface HistoryRow {
  id: string;
  status: string;
  stop_reason: string | null;
  completed_at: number | null;
  error: string | null;
}

function readHistoryRow(id: string): HistoryRow | null {
  return getSqlite()
    .query(
      `SELECT id, status, stop_reason, completed_at, error
       FROM acp_session_history WHERE id = ?`,
    )
    .get(id) as HistoryRow | null;
}

function insertRow(opts: {
  id: string;
  status: "running" | "initializing" | "completed" | "failed" | "cancelled";
  stopReason?: string | null;
  completedAt?: number | null;
}) {
  getSqlite().run(
    `INSERT INTO acp_session_history (
       id, agent_id, acp_session_id, parent_conversation_id,
       started_at, completed_at, status, stop_reason, error, event_log_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, '[]')`,
    [
      opts.id,
      "agent-X",
      "proto-X",
      "conv-1",
      1000,
      opts.completedAt ?? null,
      opts.status,
      opts.stopReason ?? null,
    ],
  );
}

describe("AcpSessionManager — startup cleanup", () => {
  beforeEach(() => {
    clearHistory();
  });

  test("flips a 'running' row to cancelled+daemon_restarted on construction", () => {
    insertRow({ id: "stale-running-1", status: "running" });

    new AcpSessionManager(1);

    const row = readHistoryRow("stale-running-1");
    expect(row).not.toBeNull();
    expect(row!.status).toBe("cancelled");
    expect(row!.stop_reason).toBe("daemon_restarted");
    expect(row!.completed_at).not.toBeNull();
  });

  test("flips an 'initializing' row to cancelled+daemon_restarted on construction", () => {
    insertRow({ id: "stale-init-1", status: "initializing" });

    new AcpSessionManager(1);

    const row = readHistoryRow("stale-init-1");
    expect(row).not.toBeNull();
    expect(row!.status).toBe("cancelled");
    expect(row!.stop_reason).toBe("daemon_restarted");
  });

  test("leaves terminal-status rows untouched", () => {
    insertRow({
      id: "completed-1",
      status: "completed",
      stopReason: "end_turn",
      completedAt: 2000,
    });
    insertRow({
      id: "failed-1",
      status: "failed",
      completedAt: 2000,
    });
    insertRow({
      id: "cancelled-1",
      status: "cancelled",
      stopReason: "user_cancelled",
      completedAt: 2000,
    });

    new AcpSessionManager(1);

    const completed = readHistoryRow("completed-1");
    expect(completed!.status).toBe("completed");
    expect(completed!.stop_reason).toBe("end_turn");
    expect(completed!.completed_at).toBe(2000);

    const failed = readHistoryRow("failed-1");
    expect(failed!.status).toBe("failed");
    expect(failed!.completed_at).toBe(2000);

    const cancelled = readHistoryRow("cancelled-1");
    expect(cancelled!.status).toBe("cancelled");
    // Pre-existing stop_reason is preserved — only stale running rows are
    // overwritten with `daemon_restarted`.
    expect(cancelled!.stop_reason).toBe("user_cancelled");
    expect(cancelled!.completed_at).toBe(2000);
  });

  test("is idempotent — second construction is a no-op", () => {
    insertRow({ id: "stale-running-2", status: "running" });

    new AcpSessionManager(1);

    const firstPass = readHistoryRow("stale-running-2");
    expect(firstPass!.status).toBe("cancelled");
    expect(firstPass!.stop_reason).toBe("daemon_restarted");
    const completedAtAfterFirst = firstPass!.completed_at!;

    // A second manager constructed on top of the same DB must not re-touch
    // rows that are already terminal.
    new AcpSessionManager(1);

    const secondPass = readHistoryRow("stale-running-2");
    expect(secondPass!.status).toBe("cancelled");
    expect(secondPass!.stop_reason).toBe("daemon_restarted");
    // The `completed_at` from the first pass must be preserved — if it
    // were rewritten on the second construction, we'd be lying about when
    // the session actually died.
    expect(secondPass!.completed_at).toBe(completedAtAfterFirst);
  });

  test("handles an empty table without error", () => {
    expect(() => new AcpSessionManager(1)).not.toThrow();
  });
});
