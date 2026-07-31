import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../../db-connection.js";
import * as schema from "../../schema.js";
import { migrateMemoryRetrospectiveState } from "../245-memory-retrospective-state.js";
import { migrateMemoryRetrospectiveRememberedLog } from "../281-memory-retrospective-remembered-log.js";

interface ColumnRow {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  // `withCrashRecovery` (used by the migrations) reads/writes a
  // `memory_checkpoints` table. Seed a minimal version so the migrations'
  // structural setup can be exercised without booting the entire
  // db-init pipeline.
  sqlite.exec(`
    CREATE TABLE memory_checkpoints (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  // The state table FK references `conversations(id)`. Minimal stand-in.
  sqlite.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    )
  `);
  return drizzle(sqlite, { schema });
}

describe("migration 281 — memory_retrospective_state.remembered_log", () => {
  test("adds a nullable remembered_log TEXT column", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);

    migrateMemoryRetrospectiveState(db);
    migrateMemoryRetrospectiveRememberedLog(db);

    const cols = raw
      .query(`PRAGMA table_info(memory_retrospective_state)`)
      .all() as ColumnRow[];
    const col = cols.find((c) => c.name === "remembered_log");

    expect(col).toBeDefined();
    expect(col!.type).toBe("TEXT");
    expect(col!.notnull).toBe(0);
    expect(col!.pk).toBe(0);
  });

  test("is idempotent — running twice does not throw or duplicate the column", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);

    migrateMemoryRetrospectiveState(db);
    migrateMemoryRetrospectiveRememberedLog(db);
    expect(() => migrateMemoryRetrospectiveRememberedLog(db)).not.toThrow();

    const cols = raw
      .query(`PRAGMA table_info(memory_retrospective_state)`)
      .all() as ColumnRow[];
    expect(cols.filter((c) => c.name === "remembered_log")).toHaveLength(1);
  });

  test("pre-existing rows get NULL for the new column", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);

    migrateMemoryRetrospectiveState(db);
    raw.exec(`INSERT INTO conversations (id, created_at) VALUES ('c1', 0)`);
    raw.exec(
      `INSERT INTO memory_retrospective_state (conversation_id, last_processed_message_id, last_run_at) VALUES ('c1', 'm1', 1000)`,
    );

    migrateMemoryRetrospectiveRememberedLog(db);

    const row = raw
      .query(
        `SELECT remembered_log FROM memory_retrospective_state WHERE conversation_id = 'c1'`,
      )
      .get() as { remembered_log: string | null };
    expect(row.remembered_log).toBeNull();
  });
});
