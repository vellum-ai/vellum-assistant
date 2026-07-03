import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../../db-connection.js";
import * as schema from "../../schema.js";
import {
  downMemoryV2ActivationLogs,
  migrateMemoryV2ActivationLogs,
} from "../234-memory-v2-activation-logs.js";

interface TableRow {
  name: string;
}

interface IndexRow {
  name: string;
}

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

const EXPECTED_INDEXES = [
  "idx_memory_v2_activation_logs_message_id",
  "idx_memory_v2_activation_logs_conversation_id",
  "idx_memory_v2_activation_logs_created_at",
];

describe("memory_v2_activation_logs migration", () => {
  test("creates table with expected columns and indexes", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapCheckpointsTable(raw);

    migrateMemoryV2ActivationLogs(db);

    const tableRow = raw
      .query(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='memory_v2_activation_logs'`,
      )
      .get() as TableRow | null;
    expect(tableRow?.name).toBe("memory_v2_activation_logs");

    const columns = raw
      .query(`PRAGMA table_info(memory_v2_activation_logs)`)
      .all() as ColumnRow[];
    const byName = new Map(columns.map((c) => [c.name, c]));

    expect(byName.get("id")?.pk).toBe(1);
    expect(byName.get("id")?.type).toBe("TEXT");
    expect(byName.get("conversation_id")?.notnull).toBe(1);
    expect(byName.get("conversation_id")?.type).toBe("TEXT");
    expect(byName.get("message_id")?.notnull).toBe(0);
    expect(byName.get("message_id")?.type).toBe("TEXT");
    expect(byName.get("turn")?.notnull).toBe(1);
    expect(byName.get("turn")?.type).toBe("INTEGER");
    expect(byName.get("mode")?.notnull).toBe(1);
    expect(byName.get("mode")?.type).toBe("TEXT");
    expect(byName.get("concepts_json")?.notnull).toBe(1);
    expect(byName.get("concepts_json")?.type).toBe("TEXT");
    expect(byName.get("skills_json")?.notnull).toBe(1);
    expect(byName.get("skills_json")?.type).toBe("TEXT");
    expect(byName.get("config_json")?.notnull).toBe(1);
    expect(byName.get("config_json")?.type).toBe("TEXT");
    expect(byName.get("created_at")?.notnull).toBe(1);
    expect(byName.get("created_at")?.type).toBe("INTEGER");

    const indexes = raw
      .query(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='memory_v2_activation_logs'`,
      )
      .all() as IndexRow[];
    const indexNames = new Set(indexes.map((r) => r.name));
    for (const expected of EXPECTED_INDEXES) {
      expect(indexNames.has(expected)).toBe(true);
    }
  });

  test("re-running the migration is a no-op", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapCheckpointsTable(raw);

    migrateMemoryV2ActivationLogs(db);

    raw
      .query(
        /*sql*/ `
        INSERT INTO memory_v2_activation_logs (
          id,
          conversation_id,
          message_id,
          turn,
          mode,
          concepts_json,
          skills_json,
          config_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        "log-1",
        "conv-abc",
        "msg-xyz",
        3,
        "per-turn",
        "[]",
        "[]",
        "{}",
        1000,
      );

    expect(() => migrateMemoryV2ActivationLogs(db)).not.toThrow();

    const row = raw
      .query(`SELECT id FROM memory_v2_activation_logs WHERE id = 'log-1'`)
      .get() as { id: string } | null;
    expect(row?.id).toBe("log-1");

    const indexes = raw
      .query(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='memory_v2_activation_logs'`,
      )
      .all() as IndexRow[];
    const indexNames = new Set(indexes.map((r) => r.name));
    for (const expected of EXPECTED_INDEXES) {
      expect(indexNames.has(expected)).toBe(true);
    }
  });

  test("down() drops the table and is idempotent", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapCheckpointsTable(raw);

    migrateMemoryV2ActivationLogs(db);

    expect(
      raw
        .query(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='memory_v2_activation_logs'`,
        )
        .get(),
    ).toBeTruthy();

    downMemoryV2ActivationLogs(db);

    expect(
      raw
        .query(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='memory_v2_activation_logs'`,
        )
        .get(),
    ).toBeNull();

    expect(() => downMemoryV2ActivationLogs(db)).not.toThrow();
  });
});
