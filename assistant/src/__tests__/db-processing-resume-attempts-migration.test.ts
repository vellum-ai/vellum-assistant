import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../persistence/db-connection.js";
import { migrateAddProcessingResumeAttempts } from "../persistence/migrations/322-add-processing-resume-attempts.js";
import * as schema from "../persistence/schema/index.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

function bootstrapPreResumeAttemptsConversations(raw: Database): void {
  raw.exec(/*sql*/ `
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      title TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      conversation_type TEXT NOT NULL DEFAULT 'standard',
      source TEXT NOT NULL DEFAULT 'user',
      memory_scope_id TEXT NOT NULL DEFAULT 'default',
      is_auto_title INTEGER NOT NULL DEFAULT 1,
      processing_started_at INTEGER
    )
  `);
}

function getResumeAttemptsColumn(raw: Database) {
  return (
    raw.query(`PRAGMA table_info(conversations)`).all() as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>
  ).find((column) => column.name === "processing_resume_attempts");
}

describe("processing resume attempts migration", () => {
  test("adds a NOT NULL column defaulting to 0", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);

    bootstrapPreResumeAttemptsConversations(raw);
    migrateAddProcessingResumeAttempts(db);

    const column = getResumeAttemptsColumn(raw);
    expect(column).toBeDefined();
    expect(column?.notnull).toBe(1);
    expect(column?.dflt_value).toBe("0");
  });

  test("existing rows are undisturbed and default to 0 attempts", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    const now = Date.now();

    bootstrapPreResumeAttemptsConversations(raw);
    raw.exec(/*sql*/ `
      INSERT INTO conversations (id, title, created_at, updated_at, processing_started_at)
      VALUES ('conv-existing', 'Existing conversation', ${now}, ${now}, ${now})
    `);

    migrateAddProcessingResumeAttempts(db);

    const row = raw
      .query(
        `SELECT id, title, processing_started_at, processing_resume_attempts
         FROM conversations WHERE id = 'conv-existing'`,
      )
      .get() as {
      id: string;
      title: string | null;
      processing_started_at: number | null;
      processing_resume_attempts: number;
    } | null;

    expect(row).toEqual({
      id: "conv-existing",
      title: "Existing conversation",
      processing_started_at: now,
      processing_resume_attempts: 0,
    });
  });

  test("re-running the migration is a no-op and preserves stored values", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    const now = Date.now();

    bootstrapPreResumeAttemptsConversations(raw);
    raw.exec(/*sql*/ `
      INSERT INTO conversations (id, created_at, updated_at)
      VALUES ('conv-rerun', ${now}, ${now})
    `);

    migrateAddProcessingResumeAttempts(db);
    raw.exec(/*sql*/ `
      UPDATE conversations SET processing_resume_attempts = 2 WHERE id = 'conv-rerun'
    `);

    expect(() => migrateAddProcessingResumeAttempts(db)).not.toThrow();

    const row = raw
      .query(
        `SELECT processing_resume_attempts FROM conversations WHERE id = 'conv-rerun'`,
      )
      .get() as { processing_resume_attempts: number } | null;

    expect(row).toEqual({ processing_resume_attempts: 2 });
  });
});
