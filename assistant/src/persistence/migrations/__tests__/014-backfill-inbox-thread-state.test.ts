import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../../db-connection.js";
import * as schema from "../../schema.js";
import { migrateBackfillInboxThreadStateFromBindings } from "../014-backfill-inbox-thread-state.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  return drizzle(sqlite, { schema });
}

function bootstrap(raw: Database, opts: { withAssistantId: boolean }): void {
  raw.exec(/*sql*/ `
    CREATE TABLE memory_checkpoints (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  raw.exec(/*sql*/ `
    CREATE TABLE external_conversation_bindings (
      conversation_id TEXT PRIMARY KEY,
      source_channel TEXT NOT NULL,
      external_chat_id TEXT NOT NULL,
      external_user_id TEXT,
      display_name TEXT,
      username TEXT,
      last_inbound_at INTEGER,
      last_outbound_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  raw.exec(/*sql*/ `
    CREATE TABLE assistant_inbox_thread_state (
      conversation_id TEXT PRIMARY KEY,
      ${opts.withAssistantId ? "assistant_id TEXT NOT NULL DEFAULT 'self'," : ""}
      source_channel TEXT NOT NULL,
      external_chat_id TEXT NOT NULL,
      external_user_id TEXT,
      display_name TEXT,
      username TEXT,
      last_inbound_at INTEGER,
      last_outbound_at INTEGER,
      last_message_at INTEGER,
      unread_count INTEGER NOT NULL DEFAULT 0,
      pending_escalation_count INTEGER NOT NULL DEFAULT 0,
      has_pending_escalation INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  raw.run(
    `INSERT INTO external_conversation_bindings
       (conversation_id, source_channel, external_chat_id, external_user_id,
        display_name, username, last_inbound_at, last_outbound_at,
        created_at, updated_at)
     VALUES ('c1','telegram','chat-1','U-1','Name One','one',1000,2000,500,2500)`,
  );
}

describe("migration 014 — backfill inbox thread state", () => {
  test("seeds rows when assistant_id column is present", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrap(raw, { withAssistantId: true });

    migrateBackfillInboxThreadStateFromBindings(db);

    const row = raw
      .query(
        `SELECT assistant_id, last_message_at FROM assistant_inbox_thread_state WHERE conversation_id = 'c1'`,
      )
      .get() as { assistant_id: string; last_message_at: number } | undefined;
    expect(row?.assistant_id).toBe("self");
    expect(row?.last_message_at).toBe(2000);
  });

  test("seeds rows without throwing when assistant_id column was dropped", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    // Simulate a DB where drop-assistant-id-columns already removed the column
    // but the backfill checkpoint was never written.
    bootstrap(raw, { withAssistantId: false });

    expect(() => migrateBackfillInboxThreadStateFromBindings(db)).not.toThrow();

    const count = raw
      .query(`SELECT COUNT(*) AS n FROM assistant_inbox_thread_state`)
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  test("is a no-op once the checkpoint is recorded", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrap(raw, { withAssistantId: false });

    migrateBackfillInboxThreadStateFromBindings(db);
    // Removing the source rows would surface any second-run insert attempt.
    raw.exec(`DELETE FROM external_conversation_bindings`);
    expect(() => migrateBackfillInboxThreadStateFromBindings(db)).not.toThrow();
  });
});
