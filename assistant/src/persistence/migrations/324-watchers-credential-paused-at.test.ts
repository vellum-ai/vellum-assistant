import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "../schema.js";
import { migrateWatchersCredentialPausedAt } from "./324-watchers-credential-paused-at.js";

const COLUMN = "credential_paused_at";

function createTestDb() {
  const sqlite = new Database(":memory:");
  // Pre-324 shape: the watchers table without the credential_paused_at column.
  sqlite.exec(/*sql*/ `
    CREATE TABLE watchers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      poll_interval_ms INTEGER NOT NULL DEFAULT 60000,
      action_prompt TEXT NOT NULL,
      watermark TEXT,
      conversation_id TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      consecutive_errors INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      last_poll_at INTEGER,
      next_poll_at INTEGER NOT NULL,
      config_json TEXT,
      credential_service TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function columnNames(sqlite: Database): string[] {
  return (
    sqlite.query("PRAGMA table_info(watchers)").all() as Array<{ name: string }>
  ).map((c) => c.name);
}

describe("migration 324: watchers.credential_paused_at", () => {
  test("adds the nullable credential_paused_at column", () => {
    const { sqlite, db } = createTestDb();
    expect(columnNames(sqlite)).not.toContain(COLUMN);

    migrateWatchersCredentialPausedAt(db);

    const column = (
      sqlite.query("PRAGMA table_info(watchers)").all() as Array<{
        name: string;
        notnull: number;
      }>
    ).find((c) => c.name === COLUMN);
    expect(column).toBeDefined();
    expect(column?.notnull).toBe(0);
  });

  test("existing rows read back with a null marker", () => {
    const { sqlite, db } = createTestDb();
    sqlite.exec(/*sql*/ `
      INSERT INTO watchers
        (id, name, provider_id, action_prompt, next_poll_at,
         credential_service, created_at, updated_at)
      VALUES
        ('w-1', 'Work Outlook', 'outlook', 'Summarize', 1000,
         'outlook', 1000, 1000)
    `);

    migrateWatchersCredentialPausedAt(db);

    const row = sqlite
      .query(`SELECT ${COLUMN} FROM watchers WHERE id = 'w-1'`)
      .get() as Record<string, unknown>;
    expect(row[COLUMN]).toBeNull();
  });

  test("round-trips a paused timestamp", () => {
    const { sqlite, db } = createTestDb();
    migrateWatchersCredentialPausedAt(db);

    sqlite.exec(/*sql*/ `
      INSERT INTO watchers
        (id, name, provider_id, action_prompt, next_poll_at,
         credential_service, created_at, updated_at, credential_paused_at)
      VALUES
        ('w-2', 'Work Outlook', 'outlook', 'Summarize', 2000,
         'outlook', 2000, 2000, 1737000000000)
    `);

    const row = sqlite
      .query(`SELECT ${COLUMN} FROM watchers WHERE id = 'w-2'`)
      .get() as Record<string, unknown>;
    expect(row[COLUMN]).toBe(1737000000000);
  });

  test("is idempotent — re-run is a no-op", () => {
    const { sqlite, db } = createTestDb();

    migrateWatchersCredentialPausedAt(db);
    expect(() => migrateWatchersCredentialPausedAt(db)).not.toThrow();

    expect(columnNames(sqlite).filter((n) => n === COLUMN)).toHaveLength(1);
  });
});
