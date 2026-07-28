import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "../schema.js";
import { migrateScheduleDefaultNoReuseConversation } from "./292-schedule-default-no-reuse-conversation.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  // Post-210 shape: reuse_conversation column present (trimmed to the columns
  // the migration and assertions touch).
  sqlite.exec(/*sql*/ `
    CREATE TABLE cron_jobs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      message TEXT NOT NULL,
      next_run_at INTEGER NOT NULL,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      reuse_conversation INTEGER NOT NULL DEFAULT 0
    )
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function insertJob(sqlite: Database, id: string, reuse: number) {
  sqlite
    .query(
      /*sql*/ `INSERT INTO cron_jobs
        (id, name, message, next_run_at, created_by, created_at, updated_at, reuse_conversation)
        VALUES (?, ?, 'msg', 1000, 'agent', 1000, 1000, ?)`,
    )
    .run(id, id, reuse);
}

function reuseValue(sqlite: Database, id: string): number {
  return (
    sqlite
      .query("SELECT reuse_conversation FROM cron_jobs WHERE id = ?")
      .get(id) as { reuse_conversation: number }
  ).reuse_conversation;
}

describe("migration 292: schedules default to no conversation reuse", () => {
  test("flips existing reuse_conversation=1 rows to 0", () => {
    const { sqlite, db } = createTestDb();
    insertJob(sqlite, "reusing", 1);
    insertJob(sqlite, "already-fresh", 0);

    migrateScheduleDefaultNoReuseConversation(db);

    expect(reuseValue(sqlite, "reusing")).toBe(0);
    expect(reuseValue(sqlite, "already-fresh")).toBe(0);
  });

  test("is idempotent — re-run is a no-op", () => {
    const { sqlite, db } = createTestDb();
    insertJob(sqlite, "reusing", 1);

    migrateScheduleDefaultNoReuseConversation(db);
    expect(() => migrateScheduleDefaultNoReuseConversation(db)).not.toThrow();

    expect(reuseValue(sqlite, "reusing")).toBe(0);
  });
});
