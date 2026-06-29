import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../persistence/db-connection.js";
import { migrateCreateCompactionEvents } from "../persistence/migrations/302-create-compaction-events.js";
import * as schema from "../persistence/schema/index.js";

interface EventRow {
  conversation_id: string;
  compacted_at: number;
  summary: string;
  compacted_message_count: number;
}

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

function bootstrapCheckpointsTable(raw: Database): void {
  raw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS memory_checkpoints (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
}

function bootstrapConversations(raw: Database): void {
  raw.exec(/*sql*/ `
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      title TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      context_summary TEXT,
      context_compacted_message_count INTEGER NOT NULL DEFAULT 0,
      context_compacted_at INTEGER
    )
  `);
}

function insertConversation(
  raw: Database,
  id: string,
  summary: string | null,
  count: number,
  compactedAt: number | null,
): void {
  raw
    .query(
      /*sql*/ `
        INSERT INTO conversations (
          id, title, created_at, updated_at,
          context_summary, context_compacted_message_count, context_compacted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(id, id, 1000, 2000, summary, count, compactedAt);
}

function getEvents(raw: Database): EventRow[] {
  return raw
    .query(
      /*sql*/ `
        SELECT conversation_id, compacted_at, summary, compacted_message_count
        FROM conversation_compaction_events
        ORDER BY conversation_id
      `,
    )
    .all() as EventRow[];
}

describe("migrateCreateCompactionEvents", () => {
  test("creates the ledger and backfills one event per compacted conversation", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapCheckpointsTable(raw);
    bootstrapConversations(raw);

    insertConversation(raw, "compacted", "Summary text", 5, 3000);
    insertConversation(raw, "uncompacted", null, 0, null);
    // count>0 but never actually compacted (no timestamp) — must be skipped.
    insertConversation(raw, "count-without-at", "Orphan summary", 4, null);

    migrateCreateCompactionEvents(db);

    expect(getEvents(raw)).toEqual([
      {
        conversation_id: "compacted",
        compacted_at: 3000,
        summary: "Summary text",
        compacted_message_count: 5,
      },
    ]);
  });

  test("is idempotent — re-running does not duplicate backfilled events", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapCheckpointsTable(raw);
    bootstrapConversations(raw);
    insertConversation(raw, "compacted", "Summary text", 5, 3000);

    migrateCreateCompactionEvents(db);
    migrateCreateCompactionEvents(db);

    expect(getEvents(raw)).toHaveLength(1);
  });

  test("the NOT EXISTS guard prevents duplicates even if the checkpoint is lost", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapCheckpointsTable(raw);
    bootstrapConversations(raw);
    insertConversation(raw, "compacted", "Summary text", 5, 3000);

    migrateCreateCompactionEvents(db);
    raw.exec(`DELETE FROM memory_checkpoints`);
    migrateCreateCompactionEvents(db);

    expect(getEvents(raw)).toHaveLength(1);
  });
});
