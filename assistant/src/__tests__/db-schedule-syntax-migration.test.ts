import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";

import { migrateScheduleDescription } from "../persistence/migrations/270-schedule-description.js";
import { migrateScheduleSourceConversation } from "../persistence/migrations/270-schedule-source-conversation.js";
import * as schema from "../persistence/schema/index.js";
import { scheduleJobs } from "../persistence/schema/index.js";

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
        max_retries INTEGER NOT NULL DEFAULT 3,
        retry_backoff_ms INTEGER NOT NULL DEFAULT 60000,
        created_from_conversation_id TEXT,
        created_by TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'execute',
        routing_intent TEXT NOT NULL DEFAULT 'all_channels',
        routing_hints_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'active',
        quiet INTEGER NOT NULL DEFAULT 0,
        reuse_conversation INTEGER NOT NULL DEFAULT 0,
        script TEXT,
        wake_conversation_id TEXT,
        workflow_name TEXT,
        workflow_args_json TEXT,
        timeout_ms INTEGER,
        inference_profile TEXT,
        capabilities_json TEXT,
        description TEXT NOT NULL DEFAULT '',
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
    try {
      raw.exec(`ALTER TABLE cron_jobs ADD COLUMN timeout_ms INTEGER`);
    } catch {
      /* already exists */
    }
    try {
      raw.exec(`ALTER TABLE cron_jobs ADD COLUMN workflow_name TEXT`);
    } catch {
      /* already exists */
    }
    try {
      raw.exec(`ALTER TABLE cron_jobs ADD COLUMN workflow_args_json TEXT`);
    } catch {
      /* already exists */
    }
    migrateScheduleSourceConversation(db);
    migrateScheduleDescription(db);

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
    try {
      raw.exec(`ALTER TABLE cron_jobs ADD COLUMN timeout_ms INTEGER`);
    } catch {
      /* ok */
    }
    try {
      raw.exec(`ALTER TABLE cron_jobs ADD COLUMN workflow_name TEXT`);
    } catch {
      /* ok */
    }
    try {
      raw.exec(`ALTER TABLE cron_jobs ADD COLUMN workflow_args_json TEXT`);
    } catch {
      /* ok */
    }
    migrateScheduleSourceConversation(db);
    migrateScheduleSourceConversation(db);
    migrateScheduleDescription(db);
    migrateScheduleDescription(db);

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

  test("schedule description migration backfills non-defer rows once", () => {
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
        retry_count INTEGER NOT NULL DEFAULT 0,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    const now = Date.now();
    raw
      .query(
        `INSERT INTO cron_jobs (id, name, cron_expression, message, next_run_at, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "legacy-schedule",
        "Legacy report",
        "0 9 * * *",
        "compile report",
        now + 60_000,
        "agent",
        now,
        now,
      );
    raw
      .query(
        `INSERT INTO cron_jobs (id, name, cron_expression, message, next_run_at, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "legacy-defer",
        "Deferred wake",
        null,
        "resume later",
        now + 60_000,
        "defer",
        now,
        now,
      );

    migrateScheduleDescription(db);

    const rows = raw
      .query("SELECT id, description FROM cron_jobs ORDER BY id")
      .all() as Array<{ id: string; description: string }>;
    expect(rows).toEqual([
      { id: "legacy-defer", description: "" },
      { id: "legacy-schedule", description: "Legacy report" },
    ]);
  });
});
