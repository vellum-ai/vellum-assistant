import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../db-connection.js";
import { migrateMessageBookmarks } from "../migrations/242-message-bookmarks.js";
import * as schema from "../schema.js";

interface ColumnRow {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

interface IndexInfoRow {
  name: string;
  unique: number;
}

interface CountRow {
  n: number;
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

/**
 * Recreate just enough of the conversations + messages tables to exercise
 * CASCADE behavior. We only need the columns the FKs reference (id) plus
 * NOT NULL columns required to insert a row.
 */
function bootstrapMessageTables(raw: Database): void {
  raw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  raw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
}

function seedConversationAndMessage(
  raw: Database,
  conversationId: string,
  messageId: string,
): void {
  const now = Date.now();
  raw
    .query(
      `INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    )
    .run(conversationId, "Example", now, now);
  raw
    .query(
      `INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(messageId, conversationId, "user", "hello", now);
}

function insertBookmark(
  raw: Database,
  id: string,
  messageId: string,
  conversationId: string,
): void {
  raw
    .query(
      `INSERT INTO message_bookmarks (id, message_id, conversation_id, created_at) VALUES (?, ?, ?, ?)`,
    )
    .run(id, messageId, conversationId, Date.now());
}

function countBookmarks(raw: Database): number {
  const row = raw
    .query(`SELECT COUNT(*) AS n FROM message_bookmarks`)
    .get() as CountRow | null;
  return row?.n ?? 0;
}

describe("message_bookmarks schema migration", () => {
  test("creates table with expected columns and indexes", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapCheckpointsTable(raw);
    bootstrapMessageTables(raw);

    migrateMessageBookmarks(db);

    const columns = raw
      .query(`PRAGMA table_info(message_bookmarks)`)
      .all() as ColumnRow[];
    const byName = new Map(columns.map((c) => [c.name, c]));
    expect(byName.get("id")?.pk).toBe(1);
    expect(byName.get("id")?.type).toBe("TEXT");
    expect(byName.get("message_id")?.notnull).toBe(1);
    expect(byName.get("conversation_id")?.notnull).toBe(1);
    expect(byName.get("created_at")?.notnull).toBe(1);
    expect(byName.get("created_at")?.type).toBe("INTEGER");

    const indexes = raw
      .query(`PRAGMA index_list(message_bookmarks)`)
      .all() as IndexInfoRow[];
    const indexByName = new Map(indexes.map((i) => [i.name, i]));
    const uniqIndex = indexByName.get("message_bookmarks_message_id_uniq");
    expect(uniqIndex).toBeDefined();
    expect(uniqIndex?.unique).toBe(1);
    expect(indexByName.get("message_bookmarks_created_at_idx")).toBeDefined();
  });

  test("CASCADE removes bookmark when parent message is deleted", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapCheckpointsTable(raw);
    bootstrapMessageTables(raw);
    migrateMessageBookmarks(db);

    seedConversationAndMessage(raw, "conv-1", "msg-1");
    insertBookmark(raw, "bm-1", "msg-1", "conv-1");
    expect(countBookmarks(raw)).toBe(1);

    raw.query(`DELETE FROM messages WHERE id = ?`).run("msg-1");
    expect(countBookmarks(raw)).toBe(0);
  });

  test("CASCADE removes bookmark when parent conversation is deleted", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapCheckpointsTable(raw);
    bootstrapMessageTables(raw);
    migrateMessageBookmarks(db);

    seedConversationAndMessage(raw, "conv-2", "msg-2");
    insertBookmark(raw, "bm-2", "msg-2", "conv-2");
    expect(countBookmarks(raw)).toBe(1);

    raw.query(`DELETE FROM conversations WHERE id = ?`).run("conv-2");
    // Deleting the conversation cascades to messages, which cascades to
    // bookmarks. Either FK alone would suffice; both fire here.
    expect(countBookmarks(raw)).toBe(0);
  });

  test("unique constraint on message_id rejects a second bookmark", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapCheckpointsTable(raw);
    bootstrapMessageTables(raw);
    migrateMessageBookmarks(db);

    seedConversationAndMessage(raw, "conv-3", "msg-3");
    insertBookmark(raw, "bm-3a", "msg-3", "conv-3");

    expect(() => insertBookmark(raw, "bm-3b", "msg-3", "conv-3")).toThrow();
    expect(countBookmarks(raw)).toBe(1);
  });
});
