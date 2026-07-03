import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../../db-connection.js";
import * as schema from "../../schema.js";
import { migrateDropAssistantIdColumns } from "../136-drop-assistant-id-columns.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  return drizzle(sqlite, { schema });
}

function indexExists(raw: Database, name: string): boolean {
  return !!raw
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?`)
    .get(name);
}

/**
 * Create a minimal assistant_inbox_thread_state carrying assistant_id plus its
 * composite index, so the column-drop + index-recreate path has something to
 * act on.
 */
function createInboxThreadState(raw: Database): void {
  raw.exec(/*sql*/ `
    CREATE TABLE assistant_inbox_thread_state (
      conversation_id TEXT PRIMARY KEY,
      assistant_id TEXT NOT NULL DEFAULT 'self',
      source_channel TEXT NOT NULL,
      external_chat_id TEXT NOT NULL,
      last_message_at INTEGER,
      has_pending_escalation INTEGER NOT NULL DEFAULT 0
    )
  `);
  raw.exec(/*sql*/ `
    CREATE UNIQUE INDEX idx_inbox_thread_state_channel
      ON assistant_inbox_thread_state(assistant_id, source_channel, external_chat_id)
  `);
}

describe("migration 136 — drop assistant_id columns", () => {
  test("drops the column and recreates the index without assistant_id", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    createInboxThreadState(raw);

    migrateDropAssistantIdColumns(db);

    const cols = (
      raw.query(`PRAGMA table_info(assistant_inbox_thread_state)`).all() as {
        name: string;
      }[]
    ).map((c) => c.name);
    expect(cols).not.toContain("assistant_id");
    expect(indexExists(raw, "idx_inbox_thread_state_channel")).toBe(true);
  });

  test("does not throw when some scoped tables were already dropped", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    // Only the inbox table exists — actor_token_records and friends were
    // removed by an earlier migration. Index recreation must skip the missing
    // tables instead of failing with "no such table".
    createInboxThreadState(raw);

    expect(() => migrateDropAssistantIdColumns(db)).not.toThrow();
    // Sanity: the index targeting the missing table was not created.
    expect(indexExists(raw, "idx_actor_tokens_active_device")).toBe(false);
  });

  test("is idempotent across repeated runs", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    createInboxThreadState(raw);

    migrateDropAssistantIdColumns(db);
    expect(() => migrateDropAssistantIdColumns(db)).not.toThrow();
  });
});
