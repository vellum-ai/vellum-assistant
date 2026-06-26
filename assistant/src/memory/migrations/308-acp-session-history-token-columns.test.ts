import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "../schema.js";
import { migrateAcpSessionHistoryTokenColumns } from "./308-acp-session-history-token-columns.js";

const NEW_COLUMNS = ["input_tokens", "output_tokens"];

function createTestDb() {
  const sqlite = new Database(":memory:");
  // Post-304 shape: usage columns exist, token columns do not.
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
      cwd TEXT,
      task TEXT,
      parent_tool_use_id TEXT,
      used_tokens INTEGER,
      context_size INTEGER,
      cost_amount REAL,
      cost_currency TEXT
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

describe("migration 305: acp_session_history token columns", () => {
  test("adds the nullable token columns", () => {
    const { sqlite, db } = createTestDb();
    const before = tableInfo(sqlite).map((c) => c.name);
    for (const name of NEW_COLUMNS) {
      expect(before).not.toContain(name);
    }

    migrateAcpSessionHistoryTokenColumns(db);

    const after = tableInfo(sqlite);
    for (const name of NEW_COLUMNS) {
      const column = after.find((c) => c.name === name);
      expect(column).toBeDefined();
      expect(column?.notnull).toBe(0);
    }
  });

  test("existing rows read back with null token columns", () => {
    const { sqlite, db } = createTestDb();
    sqlite.exec(/*sql*/ `
      INSERT INTO acp_session_history
        (id, agent_id, acp_session_id, parent_conversation_id, started_at, status)
      VALUES
        ('acp-1', 'agent-1', 'sid-1', 'conv-1', 1000, 'completed')
    `);

    migrateAcpSessionHistoryTokenColumns(db);

    const row = sqlite
      .query(
        `SELECT ${NEW_COLUMNS.join(", ")} FROM acp_session_history WHERE id = 'acp-1'`,
      )
      .get() as Record<string, unknown>;
    for (const name of NEW_COLUMNS) {
      expect(row[name]).toBeNull();
    }
  });

  test("round-trips an insert that sets the new token columns", () => {
    const { sqlite, db } = createTestDb();
    migrateAcpSessionHistoryTokenColumns(db);

    sqlite.exec(/*sql*/ `
      INSERT INTO acp_session_history
        (id, agent_id, acp_session_id, parent_conversation_id, started_at, status,
         input_tokens, output_tokens)
      VALUES
        ('acp-2', 'agent-1', 'sid-2', 'conv-1', 2000, 'completed',
         1500, 750)
    `);

    const row = sqlite
      .query(
        `SELECT ${NEW_COLUMNS.join(", ")} FROM acp_session_history WHERE id = 'acp-2'`,
      )
      .get() as Record<string, unknown>;
    expect(row).toEqual({
      input_tokens: 1500,
      output_tokens: 750,
    });
  });

  test("is idempotent — re-run is a no-op", () => {
    const { sqlite, db } = createTestDb();

    migrateAcpSessionHistoryTokenColumns(db);
    expect(() => migrateAcpSessionHistoryTokenColumns(db)).not.toThrow();

    const names = tableInfo(sqlite).map((c) => c.name);
    for (const name of NEW_COLUMNS) {
      expect(names.filter((n) => n === name)).toHaveLength(1);
    }
  });
});
