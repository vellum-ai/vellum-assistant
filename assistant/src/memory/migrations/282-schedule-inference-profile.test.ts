import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "../schema.js";
import { migrateScheduleInferenceProfile } from "./282-schedule-inference-profile.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  // Pre-282 shape: no inference_profile column (trimmed to the columns the
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

describe("migration 282: cron_jobs inference_profile", () => {
  test("adds a nullable inference_profile column", () => {
    const { sqlite, db } = createTestDb();
    expect(columnNames(sqlite)).not.toContain("inference_profile");

    migrateScheduleInferenceProfile(db);

    const column = (
      sqlite.query("PRAGMA table_info(cron_jobs)").all() as Array<{
        name: string;
        notnull: number;
      }>
    ).find((c) => c.name === "inference_profile");
    expect(column).toBeDefined();
    expect(column?.notnull).toBe(0);
  });

  test("existing rows read back with inference_profile null", () => {
    const { sqlite, db } = createTestDb();
    sqlite.exec(/*sql*/ `
      INSERT INTO cron_jobs (id, name, message, next_run_at, created_by, created_at, updated_at)
      VALUES ('job-1', 'Daily digest', 'write the digest', 1000, 'agent', 1000, 1000)
    `);

    migrateScheduleInferenceProfile(db);

    const row = sqlite
      .query("SELECT inference_profile FROM cron_jobs WHERE id = 'job-1'")
      .get() as { inference_profile: string | null };
    expect(row.inference_profile).toBeNull();
  });

  test("is idempotent — re-run is a no-op", () => {
    const { sqlite, db } = createTestDb();

    migrateScheduleInferenceProfile(db);
    expect(() => migrateScheduleInferenceProfile(db)).not.toThrow();

    expect(
      columnNames(sqlite).filter((name) => name === "inference_profile"),
    ).toHaveLength(1);
  });
});
