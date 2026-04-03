import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "../memory/schema.js";
import { scheduleJobs } from "../memory/schema.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

function getRawSqlite(db: ReturnType<typeof drizzle<typeof schema>>): Database {
  return (db as unknown as { $client: Database }).$client;
}

describe("schedule_syntax column migration", () => {
  test("fresh DB includes schedule_syntax with default cron", () => {
    const db = createTestDb();
    const raw = getRawSqlite(db);

    raw.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS cron_jobs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        cron_expression TEXT,
        schedule_syntax TEXT NOT NULL DEFAULT 'cron',
        timezone TEXT,
        message TEXT NOT NULL,
        next_run_at INTEGER NOT NULL,
        last_run_at INTEGER,
        last_status TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        created_by TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'execute',
        routing_intent TEXT NOT NULL DEFAULT 'all_channels',
        routing_hints_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'active',
        quiet INTEGER NOT NULL DEFAULT 0,
        reuse_conversation INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    const now = Date.now();
    db.insert(scheduleJobs)
      .values({
        id: "test-1",
        name: "Test Job",
        enabled: true,
        cronExpression: "0 9 * * *",
        timezone: null,
        message: "hello",
        nextRunAt: now + 60000,
        lastRunAt: null,
        lastStatus: null,
        retryCount: 0,
        createdBy: "agent",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const row = db
      .select()
      .from(scheduleJobs)
      .where(eq(scheduleJobs.id, "test-1"))
      .get();
    expect(row).toBeTruthy();
    expect(row!.scheduleSyntax).toBe("cron");
  });

  test("upgraded DB gains schedule_syntax column via ALTER TABLE", () => {
    const db = createTestDb();
    const raw = getRawSqlite(db);

    // Old schema without schedule_syntax
    raw.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS cron_jobs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        cron_expression TEXT,
        timezone TEXT,
        message TEXT NOT NULL,
        next_run_at INTEGER NOT NULL,
        last_run_at INTEGER,
        last_status TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        created_by TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'execute',
        routing_intent TEXT NOT NULL DEFAULT 'all_channels',
        routing_hints_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'active',
        quiet INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    const now = Date.now();
    raw.exec(
      `INSERT INTO cron_jobs (id, name, enabled, cron_expression, timezone, message, next_run_at, last_run_at, last_status, retry_count, created_by, created_at, updated_at) VALUES ('old-1', 'Old Job', 1, '0 9 * * *', NULL, 'hello', ${now + 60000}, NULL, NULL, 0, 'agent', ${now}, ${now})`,
    );

    // Run the migrations
    try {
      raw.exec(
        `ALTER TABLE cron_jobs ADD COLUMN schedule_syntax TEXT NOT NULL DEFAULT 'cron'`,
      );
    } catch {
      /* already exists */
    }
    try {
      raw.exec(
        `ALTER TABLE cron_jobs ADD COLUMN reuse_conversation INTEGER NOT NULL DEFAULT 0`,
      );
    } catch {
      /* already exists */
    }

    const row = db
      .select()
      .from(scheduleJobs)
      .where(eq(scheduleJobs.id, "old-1"))
      .get();
    expect(row).toBeTruthy();
    expect(row!.scheduleSyntax).toBe("cron");
  });

  test("migration is idempotent", () => {
    const db = createTestDb();
    const raw = getRawSqlite(db);

    raw.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS cron_jobs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        cron_expression TEXT,
        timezone TEXT,
        message TEXT NOT NULL,
        next_run_at INTEGER NOT NULL,
        last_run_at INTEGER,
        last_status TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        created_by TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'execute',
        routing_intent TEXT NOT NULL DEFAULT 'all_channels',
        routing_hints_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'active',
        quiet INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    try {
      raw.exec(
        `ALTER TABLE cron_jobs ADD COLUMN schedule_syntax TEXT NOT NULL DEFAULT 'cron'`,
      );
    } catch {
      /* ok */
    }
    try {
      raw.exec(
        `ALTER TABLE cron_jobs ADD COLUMN schedule_syntax TEXT NOT NULL DEFAULT 'cron'`,
      );
    } catch {
      /* ok */
    }
    try {
      raw.exec(
        `ALTER TABLE cron_jobs ADD COLUMN reuse_conversation INTEGER NOT NULL DEFAULT 0`,
      );
    } catch {
      /* ok */
    }

    const now = Date.now();
    raw.exec(
      `INSERT INTO cron_jobs (id, name, enabled, cron_expression, timezone, message, next_run_at, retry_count, created_by, created_at, updated_at) VALUES ('idem-1', 'Test', 1, '0 9 * * *', NULL, 'hi', ${now + 60000}, 0, 'agent', ${now}, ${now})`,
    );
    const row = db
      .select()
      .from(scheduleJobs)
      .where(eq(scheduleJobs.id, "idem-1"))
      .get();
    expect(row!.scheduleSyntax).toBe("cron");
  });
});
