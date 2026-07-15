import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "../schema.js";
import { migrateAcpSessionHistoryModelCacheColumns } from "./336-acp-usage-model-cache.js";

const NEW_COLUMNS = ["model", "cache_read_tokens", "cache_write_tokens"];

function createTestDb() {
  const sqlite = new Database(":memory:");
  // Post-308 shape: usage + token columns exist, model/cache columns do not.
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
      cost_currency TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER
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

describe("migration 336: acp_session_history model + cache columns", () => {
  test("adds the nullable model + cache columns", () => {
    const { sqlite, db } = createTestDb();
    const before = tableInfo(sqlite).map((c) => c.name);
    for (const name of NEW_COLUMNS) {
      expect(before).not.toContain(name);
    }

    migrateAcpSessionHistoryModelCacheColumns(db);

    const after = tableInfo(sqlite);
    for (const name of NEW_COLUMNS) {
      const column = after.find((c) => c.name === name);
      expect(column).toBeDefined();
      expect(column?.notnull).toBe(0);
    }
  });

  test("existing rows read back with null model + cache columns", () => {
    const { sqlite, db } = createTestDb();
    sqlite.exec(/*sql*/ `
      INSERT INTO acp_session_history
        (id, agent_id, acp_session_id, parent_conversation_id, started_at, status)
      VALUES
        ('acp-1', 'agent-1', 'sid-1', 'conv-1', 1000, 'completed')
    `);

    migrateAcpSessionHistoryModelCacheColumns(db);

    const row = sqlite
      .query(
        `SELECT ${NEW_COLUMNS.join(", ")} FROM acp_session_history WHERE id = 'acp-1'`,
      )
      .get() as Record<string, unknown>;
    for (const name of NEW_COLUMNS) {
      expect(row[name]).toBeNull();
    }
  });

  test("round-trips an insert that sets the new model + cache columns", () => {
    const { sqlite, db } = createTestDb();
    migrateAcpSessionHistoryModelCacheColumns(db);

    sqlite.exec(/*sql*/ `
      INSERT INTO acp_session_history
        (id, agent_id, acp_session_id, parent_conversation_id, started_at, status,
         model, cache_read_tokens, cache_write_tokens)
      VALUES
        ('acp-2', 'agent-1', 'sid-2', 'conv-1', 2000, 'completed',
         'claude-opus-4-8', 900, 300)
    `);

    const row = sqlite
      .query(
        `SELECT ${NEW_COLUMNS.join(", ")} FROM acp_session_history WHERE id = 'acp-2'`,
      )
      .get() as Record<string, unknown>;
    expect(row).toEqual({
      model: "claude-opus-4-8",
      cache_read_tokens: 900,
      cache_write_tokens: 300,
    });
  });

  test("is idempotent — re-run is a no-op", () => {
    const { sqlite, db } = createTestDb();

    migrateAcpSessionHistoryModelCacheColumns(db);
    expect(() => migrateAcpSessionHistoryModelCacheColumns(db)).not.toThrow();

    const names = tableInfo(sqlite).map((c) => c.name);
    for (const name of NEW_COLUMNS) {
      expect(names.filter((n) => n === name)).toHaveLength(1);
    }
  });
});
