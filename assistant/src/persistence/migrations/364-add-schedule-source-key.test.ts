import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "../schema.js";
import { migrateAddScheduleSourceKey } from "./364-add-schedule-source-key.js";

const NEW_COLUMNS = ["source_key", "definition_hash", "user_enabled"];

/** Pre-364 shape: the cron_jobs table exactly as core tables created it. */
function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(/*sql*/ `
    CREATE TABLE cron_jobs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      cron_expression TEXT NOT NULL,
      schedule_syntax TEXT NOT NULL DEFAULT 'cron',
      timezone TEXT,
      message TEXT NOT NULL,
      next_run_at INTEGER NOT NULL,
      last_run_at INTEGER,
      last_status TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function columnInfo(sqlite: Database) {
  return sqlite.query("PRAGMA table_info(cron_jobs)").all() as Array<{
    name: string;
    notnull: number;
  }>;
}

function insertJob(
  sqlite: Database,
  id: string,
  sourceKey: string | null,
): void {
  sqlite
    .query(
      /*sql*/ `INSERT INTO cron_jobs (id, name, cron_expression, message, next_run_at, created_by, created_at, updated_at, source_key)
       VALUES (?, 'Job', '0 9 * * *', 'hello', 1000, 'agent', 1000, 1000, ?)`,
    )
    .run(id, sourceKey);
}

describe("migration 364: cron_jobs declaration provenance", () => {
  test("adds the nullable columns to an existing database", () => {
    const { sqlite, db } = createTestDb();
    const before = columnInfo(sqlite).map((c) => c.name);
    for (const name of NEW_COLUMNS) {
      expect(before).not.toContain(name);
    }

    migrateAddScheduleSourceKey(db);

    const after = columnInfo(sqlite);
    for (const name of NEW_COLUMNS) {
      const column = after.find((c) => c.name === name);
      expect(column).toBeDefined();
      expect(column?.notnull).toBe(0);
    }
  });

  test("rows written before the columns existed read back null", () => {
    const { sqlite, db } = createTestDb();
    sqlite.exec(/*sql*/ `
      INSERT INTO cron_jobs (id, name, cron_expression, message, next_run_at, created_by, created_at, updated_at)
      VALUES ('job-old', 'Old', '0 9 * * *', 'hello', 1000, 'agent', 1000, 1000)
    `);

    migrateAddScheduleSourceKey(db);

    const row = sqlite
      .query(
        "SELECT source_key, definition_hash, user_enabled FROM cron_jobs WHERE id = 'job-old'",
      )
      .get() as Record<string, unknown>;
    expect(row.source_key).toBeNull();
    expect(row.definition_hash).toBeNull();
    expect(row.user_enabled).toBeNull();
  });

  test("rejects a second row with the same source_key", () => {
    const { sqlite, db } = createTestDb();
    migrateAddScheduleSourceKey(db);

    insertJob(sqlite, "job-a", "plugin:example/daily");

    expect(() => insertJob(sqlite, "job-b", "plugin:example/daily")).toThrow();
  });

  test("leaves imperative schedules unconstrained", () => {
    const { sqlite, db } = createTestDb();
    migrateAddScheduleSourceKey(db);

    insertJob(sqlite, "job-a", null);
    expect(() => insertJob(sqlite, "job-b", null)).not.toThrow();
  });

  test("is idempotent: re-run is a no-op", () => {
    const { sqlite, db } = createTestDb();

    migrateAddScheduleSourceKey(db);
    expect(() => migrateAddScheduleSourceKey(db)).not.toThrow();

    const names = columnInfo(sqlite).map((c) => c.name);
    for (const name of NEW_COLUMNS) {
      expect(names.filter((n) => n === name)).toHaveLength(1);
    }
  });
});
