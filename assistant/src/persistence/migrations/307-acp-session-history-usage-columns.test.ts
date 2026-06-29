import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "../schema.js";
import { migrateAcpSessionHistoryUsageColumns } from "./307-acp-session-history-usage-columns.js";

const NEW_COLUMNS = [
  "task",
  "parent_tool_use_id",
  "used_tokens",
  "context_size",
  "cost_amount",
  "cost_currency",
];

function createTestDb() {
  const sqlite = new Database(":memory:");
  // Pre-302 shape: cwd exists (272), usage columns do not.
  sqlite.exec(/*sql*/ `
    CREATE TABLE acp_session_history (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      acp_session_id TEXT NOT NULL,
      parent_conversation_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      status TEXT NOT NULL,
      stop_reason TEXT,
      error TEXT,
      event_log_json TEXT NOT NULL DEFAULT '[]',
      cwd TEXT
    )
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function tableInfo(sqlite: Database) {
  return sqlite.query("PRAGMA table_info(acp_session_history)").all() as Array<{
    name: string;
    notnull: number;
  }>;
}

describe("migration 302: acp_session_history usage columns", () => {
  test("adds the nullable usage columns", () => {
    const { sqlite, db } = createTestDb();
    const before = tableInfo(sqlite).map((c) => c.name);
    for (const name of NEW_COLUMNS) {
      expect(before).not.toContain(name);
    }

    migrateAcpSessionHistoryUsageColumns(db);

    const after = tableInfo(sqlite);
    for (const name of NEW_COLUMNS) {
      const column = after.find((c) => c.name === name);
      expect(column).toBeDefined();
      expect(column?.notnull).toBe(0);
    }
  });

  test("existing rows read back with null usage columns", () => {
    const { sqlite, db } = createTestDb();
    sqlite.exec(/*sql*/ `
      INSERT INTO acp_session_history
        (id, agent_id, acp_session_id, parent_conversation_id, started_at, status)
      VALUES
        ('acp-1', 'agent-1', 'sid-1', 'conv-1', 1000, 'completed')
    `);

    migrateAcpSessionHistoryUsageColumns(db);

    const row = sqlite
      .query(
        `SELECT ${NEW_COLUMNS.join(", ")} FROM acp_session_history WHERE id = 'acp-1'`,
      )
      .get() as Record<string, unknown>;
    for (const name of NEW_COLUMNS) {
      expect(row[name]).toBeNull();
    }
  });

  test("round-trips an insert that sets the new usage columns", () => {
    const { sqlite, db } = createTestDb();
    migrateAcpSessionHistoryUsageColumns(db);

    sqlite.exec(/*sql*/ `
      INSERT INTO acp_session_history
        (id, agent_id, acp_session_id, parent_conversation_id, started_at, status,
         task, parent_tool_use_id, used_tokens, context_size, cost_amount, cost_currency)
      VALUES
        ('acp-2', 'agent-1', 'sid-2', 'conv-1', 2000, 'completed',
         'do the thing', 'tool-7', 1234, 8000, 0.42, 'USD')
    `);

    const row = sqlite
      .query(
        `SELECT ${NEW_COLUMNS.join(", ")} FROM acp_session_history WHERE id = 'acp-2'`,
      )
      .get() as Record<string, unknown>;
    expect(row).toEqual({
      task: "do the thing",
      parent_tool_use_id: "tool-7",
      used_tokens: 1234,
      context_size: 8000,
      cost_amount: 0.42,
      cost_currency: "USD",
    });
  });

  test("is idempotent — re-run is a no-op", () => {
    const { sqlite, db } = createTestDb();

    migrateAcpSessionHistoryUsageColumns(db);
    expect(() => migrateAcpSessionHistoryUsageColumns(db)).not.toThrow();

    const names = tableInfo(sqlite).map((c) => c.name);
    for (const name of NEW_COLUMNS) {
      expect(names.filter((n) => n === name)).toHaveLength(1);
    }
  });
});
