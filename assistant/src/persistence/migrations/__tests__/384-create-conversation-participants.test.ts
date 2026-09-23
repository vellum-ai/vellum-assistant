/**
 * Migration 384 creates `conversation_participants`, which records the
 * principals taking part in a conversation.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../../db-connection.js";
import * as schema from "../../schema.js";
import { migrateCreateConversationParticipants } from "../384-create-conversation-participants.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  sqlite.exec("CREATE TABLE conversations (id TEXT PRIMARY KEY)");
  return drizzle(sqlite, { schema });
}

function tableNames(db: ReturnType<typeof createTestDb>): string[] {
  const rows = getSqliteFrom(db)
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as { name: string }[];
  return rows.map((row) => row.name);
}

function indexNames(db: ReturnType<typeof createTestDb>): string[] {
  const rows = getSqliteFrom(db)
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
    .all() as { name: string }[];
  return rows.map((row) => row.name);
}

describe("migrateCreateConversationParticipants", () => {
  test("creates the table and its principal lookup index", () => {
    const db = createTestDb();

    migrateCreateConversationParticipants(db);

    expect(tableNames(db)).toContain("conversation_participants");
    expect(indexNames(db)).toContain("idx_conversation_participants_principal");
  });

  test("keys a row by conversation and principal together", () => {
    const db = createTestDb();
    migrateCreateConversationParticipants(db);
    const sqlite = getSqliteFrom(db);
    sqlite.exec("INSERT INTO conversations (id) VALUES ('conv-1')");

    sqlite.exec(
      `INSERT INTO conversation_participants
         (conversation_id, principal_id, role, added_at)
       VALUES ('conv-1', 'principal-a', 'creator', 1)`,
    );

    expect(() =>
      sqlite.exec(
        `INSERT INTO conversation_participants
           (conversation_id, principal_id, role, added_at)
         VALUES ('conv-1', 'principal-a', 'participant', 2)`,
      ),
    ).toThrow();

    sqlite.exec(
      `INSERT INTO conversation_participants
         (conversation_id, principal_id, role, added_at)
       VALUES ('conv-1', 'principal-b', 'participant', 3)`,
    );
  });

  test("re-running is a no-op", () => {
    const db = createTestDb();

    migrateCreateConversationParticipants(db);
    migrateCreateConversationParticipants(db);

    expect(tableNames(db)).toContain("conversation_participants");
  });
});
