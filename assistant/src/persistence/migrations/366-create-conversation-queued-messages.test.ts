import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "../schema.js";
import { migrateCreateConversationQueuedMessages } from "./366-create-conversation-queued-messages.js";

/** Pre-366 shape: conversations exists, the queue table does not. */
function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.exec(/*sql*/ `
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );
    INSERT INTO conversations (id, created_at) VALUES ('conv-1', 1000);
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function tableNames(sqlite: Database): string[] {
  return (
    sqlite
      .query("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

function insertQueuedRow(sqlite: Database, requestId: string): void {
  sqlite
    .query(
      /*sql*/ `INSERT INTO conversation_queued_messages
        (request_id, conversation_id, content, sort_key, sent_at, enqueued_at)
        VALUES (?, 'conv-1', 'queued text', 1, 1000, 1000)`,
    )
    .run(requestId);
}

describe("migration 366: conversation_queued_messages", () => {
  test("creates the table and index on a database without them", () => {
    const { sqlite, db } = createTestDb();
    expect(tableNames(sqlite)).not.toContain("conversation_queued_messages");

    migrateCreateConversationQueuedMessages(db);

    expect(tableNames(sqlite)).toContain("conversation_queued_messages");
    const indexes = (
      sqlite
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'conversation_queued_messages'",
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(indexes).toContain("idx_conversation_queued_messages_conv_sort");
  });

  test("re-running is a no-op that preserves existing rows", () => {
    const { sqlite, db } = createTestDb();
    migrateCreateConversationQueuedMessages(db);
    insertQueuedRow(sqlite, "req-1");

    migrateCreateConversationQueuedMessages(db);

    const count = sqlite
      .query("SELECT COUNT(*) AS n FROM conversation_queued_messages")
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  test("deleting a conversation cascades its queued rows", () => {
    const { sqlite, db } = createTestDb();
    migrateCreateConversationQueuedMessages(db);
    insertQueuedRow(sqlite, "req-1");

    sqlite.query("DELETE FROM conversations WHERE id = 'conv-1'").run();

    const count = sqlite
      .query("SELECT COUNT(*) AS n FROM conversation_queued_messages")
      .get() as { n: number };
    expect(count.n).toBe(0);
  });

  test("state defaults to queued", () => {
    const { sqlite, db } = createTestDb();
    migrateCreateConversationQueuedMessages(db);
    insertQueuedRow(sqlite, "req-1");

    const row = sqlite
      .query(
        "SELECT state FROM conversation_queued_messages WHERE request_id = 'req-1'",
      )
      .get() as { state: string };
    expect(row.state).toBe("queued");
  });
});
