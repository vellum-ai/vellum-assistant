import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../../db-connection.js";
import * as schema from "../../schema.js";
import { migrateMemoryRetrospectiveState } from "../245-memory-retrospective-state.js";

interface ColumnRow {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface ForeignKeyRow {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string;
  on_update: string;
  on_delete: string;
}

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  // `withCrashRecovery` (used by the migration) reads/writes a
  // `memory_checkpoints` table. Seed a minimal version so the migration's
  // structural setup can be exercised without booting the entire
  // db-init pipeline.
  sqlite.exec(`
    CREATE TABLE memory_checkpoints (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  // The state table FK references `conversations(id)`, so the test DB needs
  // that table to exist before we can apply the FK. Use a minimal table —
  // we're only checking the migration's structural output, not exercising
  // cascade behavior end-to-end.
  sqlite.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    )
  `);
  return drizzle(sqlite, { schema });
}

describe("migration 245 — memory_retrospective_state", () => {
  test("creates the table with the expected columns and primary key", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);

    migrateMemoryRetrospectiveState(db);

    const cols = raw
      .query(`PRAGMA table_info(memory_retrospective_state)`)
      .all() as ColumnRow[];
    const colMap = Object.fromEntries(cols.map((c) => [c.name, c]));

    expect(colMap["conversation_id"]).toBeDefined();
    expect(colMap["conversation_id"].pk).toBe(1);

    expect(colMap["last_processed_message_id"]).toBeDefined();
    expect(colMap["last_processed_message_id"].notnull).toBe(1);

    expect(colMap["last_run_at"]).toBeDefined();
    expect(colMap["last_run_at"].notnull).toBe(1);
  });

  test("FK on conversation_id is ON DELETE CASCADE", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);

    migrateMemoryRetrospectiveState(db);

    const fks = raw
      .query(`PRAGMA foreign_key_list(memory_retrospective_state)`)
      .all() as ForeignKeyRow[];

    expect(fks).toHaveLength(1);
    expect(fks[0]!.from).toBe("conversation_id");
    expect(fks[0]!.table).toBe("conversations");
    expect(fks[0]!.to).toBe("id");
    expect(fks[0]!.on_delete).toBe("CASCADE");
  });

  test("is idempotent — running twice does not throw", () => {
    const db = createTestDb();

    migrateMemoryRetrospectiveState(db);
    expect(() => migrateMemoryRetrospectiveState(db)).not.toThrow();
  });

  test("deleting a conversation cascades to its state row", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);

    migrateMemoryRetrospectiveState(db);

    raw.exec(`INSERT INTO conversations (id, created_at) VALUES ('c1', 0)`);
    raw.exec(
      `INSERT INTO memory_retrospective_state (conversation_id, last_processed_message_id, last_run_at) VALUES ('c1', 'm1', 1000)`,
    );

    const before = raw
      .query(`SELECT COUNT(*) AS c FROM memory_retrospective_state`)
      .get() as { c: number };
    expect(before.c).toBe(1);

    raw.exec(`DELETE FROM conversations WHERE id = 'c1'`);

    const after = raw
      .query(`SELECT COUNT(*) AS c FROM memory_retrospective_state`)
      .get() as { c: number };
    expect(after.c).toBe(0);
  });
});
