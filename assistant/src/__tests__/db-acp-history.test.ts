import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../memory/db-connection.js";
import { migrate230AcpSessionHistory } from "../memory/migrations/230-acp-session-history.js";
import * as schema from "../memory/schema.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

function bootstrapCheckpointsTable(raw: Database): void {
  raw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS memory_checkpoints (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
}

interface IndexInfoRow {
  name: string;
  unique: number;
}

interface IndexColumnRow {
  name: string;
  desc: number;
}

interface ColumnRow {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface TableRow {
  name: string;
}

describe("acp_session_history migration", () => {
  test("creates table with expected columns", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapCheckpointsTable(raw);

    migrate230AcpSessionHistory(db);

    const tableRow = raw
      .query(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='acp_session_history'`,
      )
      .get() as TableRow | null;
    expect(tableRow?.name).toBe("acp_session_history");

    const columns = raw
      .query(`PRAGMA table_info(acp_session_history)`)
      .all() as ColumnRow[];

    const byName = new Map(columns.map((c) => [c.name, c]));
    expect(byName.get("id")?.pk).toBe(1);
    expect(byName.get("id")?.type).toBe("TEXT");
    expect(byName.get("agent_id")?.notnull).toBe(1);
    expect(byName.get("acp_session_id")?.notnull).toBe(1);
    expect(byName.get("parent_conversation_id")?.notnull).toBe(1);
    expect(byName.get("started_at")?.notnull).toBe(1);
    expect(byName.get("started_at")?.type).toBe("INTEGER");
    expect(byName.get("completed_at")?.notnull).toBe(0);
    expect(byName.get("status")?.notnull).toBe(1);
    expect(byName.get("stop_reason")?.notnull).toBe(0);
    expect(byName.get("error")?.notnull).toBe(0);
    expect(byName.get("event_log_json")?.notnull).toBe(1);
    expect(byName.get("event_log_json")?.dflt_value).toBe("'[]'");
  });

  test("creates indexes on started_at DESC and parent_conversation_id", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapCheckpointsTable(raw);

    migrate230AcpSessionHistory(db);

    const indexes = raw
      .query(`PRAGMA index_list(acp_session_history)`)
      .all() as IndexInfoRow[];
    const indexNames = indexes.map((i) => i.name);

    expect(indexNames).toContain("idx_acp_session_history_started_at");
    expect(indexNames).toContain(
      "idx_acp_session_history_parent_conversation_id",
    );

    const startedAtCols = raw
      .query(`PRAGMA index_xinfo("idx_acp_session_history_started_at")`)
      .all() as IndexColumnRow[];
    const startedAtKey = startedAtCols.find((c) => c.name === "started_at");
    expect(startedAtKey).toBeDefined();
    // desc=1 means DESC ordering on the indexed column.
    expect(startedAtKey?.desc).toBe(1);

    const parentCols = raw
      .query(
        `PRAGMA index_xinfo("idx_acp_session_history_parent_conversation_id")`,
      )
      .all() as IndexColumnRow[];
    const parentKey = parentCols.find(
      (c) => c.name === "parent_conversation_id",
    );
    expect(parentKey).toBeDefined();
  });

  test("supports insert and select round-trip", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapCheckpointsTable(raw);

    migrate230AcpSessionHistory(db);

    const eventLog = JSON.stringify([
      { type: "started", at: 1000 },
      { type: "tool_call", at: 1500, tool: "read" },
      { type: "completed", at: 2000 },
    ]);

    raw
      .query(
        /*sql*/ `
        INSERT INTO acp_session_history (
          id,
          agent_id,
          acp_session_id,
          parent_conversation_id,
          started_at,
          completed_at,
          status,
          stop_reason,
          error,
          event_log_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        "history-1",
        "agent-abc",
        "acp-session-1",
        "conv-xyz",
        1000,
        2000,
        "completed",
        "end_turn",
        null,
        eventLog,
      );

    const row = raw
      .query(
        /*sql*/ `
        SELECT
          id,
          agent_id,
          acp_session_id,
          parent_conversation_id,
          started_at,
          completed_at,
          status,
          stop_reason,
          error,
          event_log_json
        FROM acp_session_history
        WHERE id = ?
      `,
      )
      .get("history-1") as {
      id: string;
      agent_id: string;
      acp_session_id: string;
      parent_conversation_id: string;
      started_at: number;
      completed_at: number | null;
      status: string;
      stop_reason: string | null;
      error: string | null;
      event_log_json: string;
    } | null;

    expect(row).toEqual({
      id: "history-1",
      agent_id: "agent-abc",
      acp_session_id: "acp-session-1",
      parent_conversation_id: "conv-xyz",
      started_at: 1000,
      completed_at: 2000,
      status: "completed",
      stop_reason: "end_turn",
      error: null,
      event_log_json: eventLog,
    });
  });

  test("event_log_json defaults to '[]' when omitted", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapCheckpointsTable(raw);

    migrate230AcpSessionHistory(db);

    raw
      .query(
        /*sql*/ `
        INSERT INTO acp_session_history (
          id,
          agent_id,
          acp_session_id,
          parent_conversation_id,
          started_at,
          status
        ) VALUES (?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        "history-2",
        "agent-def",
        "acp-session-2",
        "conv-pqr",
        5000,
        "running",
      );

    const row = raw
      .query(
        `SELECT event_log_json, completed_at, stop_reason, error FROM acp_session_history WHERE id = 'history-2'`,
      )
      .get() as {
      event_log_json: string;
      completed_at: number | null;
      stop_reason: string | null;
      error: string | null;
    } | null;

    expect(row).toEqual({
      event_log_json: "[]",
      completed_at: null,
      stop_reason: null,
      error: null,
    });
  });

  test("re-running the migration is idempotent", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapCheckpointsTable(raw);

    migrate230AcpSessionHistory(db);
    raw
      .query(
        /*sql*/ `
        INSERT INTO acp_session_history (
          id,
          agent_id,
          acp_session_id,
          parent_conversation_id,
          started_at,
          status
        ) VALUES (?, ?, ?, ?, ?, ?)
      `,
      )
      .run("history-rerun", "agent-1", "acp-1", "conv-1", 1234, "completed");

    expect(() => migrate230AcpSessionHistory(db)).not.toThrow();

    const row = raw
      .query(`SELECT id FROM acp_session_history WHERE id = 'history-rerun'`)
      .get() as { id: string } | null;
    expect(row?.id).toBe("history-rerun");
  });
});
