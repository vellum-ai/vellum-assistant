import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "../schema.js";
import { migrateScheduleCapabilities } from "./290-schedule-capabilities.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  // Pre-290 shape: no capabilities_json column (trimmed to the columns the
  // migration and assertions touch).
  sqlite.exec(/*sql*/ `
    CREATE TABLE cron_jobs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      message TEXT NOT NULL,
      next_run_at INTEGER NOT NULL,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function columnNames(sqlite: Database): string[] {
  return (
    sqlite.query("PRAGMA table_info(cron_jobs)").all() as Array<{
      name: string;
    }>
  ).map((c) => c.name);
}

describe("migration 290: cron_jobs capabilities_json", () => {
  test("adds a nullable capabilities_json column", () => {
    const { sqlite, db } = createTestDb();
    expect(columnNames(sqlite)).not.toContain("capabilities_json");

    migrateScheduleCapabilities(db);

    const column = (
      sqlite.query("PRAGMA table_info(cron_jobs)").all() as Array<{
        name: string;
        notnull: number;
      }>
    ).find((c) => c.name === "capabilities_json");
    expect(column).toBeDefined();
    expect(column?.notnull).toBe(0);
  });

  test("existing rows read back with capabilities_json null", () => {
    const { sqlite, db } = createTestDb();
    sqlite.exec(/*sql*/ `
      INSERT INTO cron_jobs (id, name, message, next_run_at, created_by, created_at, updated_at)
      VALUES ('job-1', 'Daily digest', 'write the digest', 1000, 'agent', 1000, 1000)
    `);

    migrateScheduleCapabilities(db);

    const row = sqlite
      .query("SELECT capabilities_json FROM cron_jobs WHERE id = 'job-1'")
      .get() as { capabilities_json: string | null };
    expect(row.capabilities_json).toBeNull();
  });

  test("is idempotent — re-run is a no-op", () => {
    const { sqlite, db } = createTestDb();

    migrateScheduleCapabilities(db);
    expect(() => migrateScheduleCapabilities(db)).not.toThrow();

    expect(
      columnNames(sqlite).filter((name) => name === "capabilities_json"),
    ).toHaveLength(1);
  });
});
