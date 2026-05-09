import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import {
  createBookmark,
  deleteBookmarkByMessageId,
  listBookmarks,
} from "../bookmark-crud.js";
import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { migrateMessageBookmarks } from "../migrations/242-message-bookmarks.js";
import * as schema from "../schema.js";

/**
 * Recreate just enough of the conversations + messages tables to satisfy
 * the bookmark JOIN and FK CASCADE behavior. The PR-2 schema test uses
 * the same lightweight bootstrap.
 */
function bootstrapMessageTables(raw: Database): void {
  raw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS memory_checkpoints (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
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

interface SeedOptions {
  conversationId: string;
  messageId: string;
  conversationTitle?: string | null;
  messageContent?: string;
  messageRole?: string;
  messageCreatedAt?: number;
}

function seedConversationAndMessage(raw: Database, opts: SeedOptions): void {
  const now = Date.now();
  raw
    .query(
      `INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    )
    .run(opts.conversationId, opts.conversationTitle ?? "Example", now, now);
  raw
    .query(
      `INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      opts.messageId,
      opts.conversationId,
      opts.messageRole ?? "user",
      opts.messageContent ?? "hello",
      opts.messageCreatedAt ?? now,
    );
}

function setupDb(): { db: DrizzleDb; raw: Database } {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  const raw = getSqliteFrom(db);
  bootstrapMessageTables(raw);
  migrateMessageBookmarks(db);
  return { db, raw };
}

describe("bookmark-crud", () => {
  test("createBookmark is idempotent — second call returns the existing row", () => {
    const { db, raw } = setupDb();
    seedConversationAndMessage(raw, {
      conversationId: "conv-1",
      messageId: "msg-1",
    });

    const first = createBookmark(db, {
      messageId: "msg-1",
      conversationId: "conv-1",
    });
    const second = createBookmark(db, {
      messageId: "msg-1",
      conversationId: "conv-1",
    });

    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);

    const all = listBookmarks(db);
    expect(all.length).toBe(1);
  });

  test("createBookmark returns the JOIN-shaped summary directly", () => {
    const { db, raw } = setupDb();
    seedConversationAndMessage(raw, {
      conversationId: "conv-summary",
      messageId: "msg-summary",
      conversationTitle: "Title goes here",
      messageContent: "summary body",
      messageRole: "assistant",
    });

    const summary = createBookmark(db, {
      messageId: "msg-summary",
      conversationId: "conv-summary",
    });

    expect(summary.conversationTitle).toBe("Title goes here");
    expect(summary.messagePreview).toBe("summary body");
    expect(summary.messageRole).toBe("assistant");
    expect(typeof summary.messageCreatedAt).toBe("number");
  });

  test("listBookmarks returns rows newest-first and includes joined fields", () => {
    const { db, raw } = setupDb();
    seedConversationAndMessage(raw, {
      conversationId: "conv-A",
      messageId: "msg-A",
      conversationTitle: "Older",
      messageContent: "first message",
      messageRole: "user",
    });
    seedConversationAndMessage(raw, {
      conversationId: "conv-B",
      messageId: "msg-B",
      conversationTitle: "Newer",
      messageContent: "second message",
      messageRole: "assistant",
    });

    // Force deterministic ordering by inserting bookmarks with explicit
    // created_at values 1 ms apart.
    raw
      .query(
        `INSERT INTO message_bookmarks (id, message_id, conversation_id, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run("bm-A", "msg-A", "conv-A", 1000);
    raw
      .query(
        `INSERT INTO message_bookmarks (id, message_id, conversation_id, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run("bm-B", "msg-B", "conv-B", 2000);

    const result = listBookmarks(db);
    expect(result.map((r) => r.id)).toEqual(["bm-B", "bm-A"]);
    expect(result[0]?.conversationTitle).toBe("Newer");
    expect(result[0]?.messagePreview).toBe("second message");
    expect(result[0]?.messageRole).toBe("assistant");
    expect(result[1]?.conversationTitle).toBe("Older");
    expect(result[1]?.messageRole).toBe("user");
  });

  test("listBookmarks excludes bookmarks whose conversation no longer exists (CASCADE)", () => {
    const { db, raw } = setupDb();
    seedConversationAndMessage(raw, {
      conversationId: "conv-keep",
      messageId: "msg-keep",
    });
    seedConversationAndMessage(raw, {
      conversationId: "conv-drop",
      messageId: "msg-drop",
    });
    createBookmark(db, {
      messageId: "msg-keep",
      conversationId: "conv-keep",
    });
    createBookmark(db, {
      messageId: "msg-drop",
      conversationId: "conv-drop",
    });
    expect(listBookmarks(db).length).toBe(2);

    // Deleting the parent conversation cascades through messages → bookmarks.
    raw.query(`DELETE FROM conversations WHERE id = ?`).run("conv-drop");

    const remaining = listBookmarks(db);
    expect(remaining.length).toBe(1);
    expect(remaining[0]?.conversationId).toBe("conv-keep");
  });

  test("deleteBookmarkByMessageId removes the matching row", () => {
    const { db, raw } = setupDb();
    seedConversationAndMessage(raw, {
      conversationId: "conv-d",
      messageId: "msg-d",
    });
    createBookmark(db, { messageId: "msg-d", conversationId: "conv-d" });
    expect(listBookmarks(db).length).toBe(1);

    expect(deleteBookmarkByMessageId(db, "msg-d")).toBe(true);
    expect(listBookmarks(db).length).toBe(0);
    // Calling again with no row present returns false.
    expect(deleteBookmarkByMessageId(db, "msg-d")).toBe(false);
  });

  test("messagePreview decodes JSON-serialized ContentBlock[] rows", () => {
    const { db, raw } = setupDb();
    seedConversationAndMessage(raw, {
      conversationId: "conv-blocks",
      messageId: "msg-blocks",
      messageContent: JSON.stringify([
        { type: "text", text: "Hello, can you help with…" },
      ]),
      messageRole: "user",
    });

    const summary = createBookmark(db, {
      messageId: "msg-blocks",
      conversationId: "conv-blocks",
    });

    // Without the decode step, this would render as the raw JSON literal
    // (`[{"type":"text","text":"…"}]`) rather than the spoken text.
    expect(summary.messagePreview).toBe("Hello, can you help with…");
    const listed = listBookmarks(db);
    expect(listed[0]?.messagePreview).toBe("Hello, can you help with…");
  });

  test("messagePreview concatenates multi-text blocks and drops non-text blocks", () => {
    const { db, raw } = setupDb();
    seedConversationAndMessage(raw, {
      conversationId: "conv-multi",
      messageId: "msg-multi",
      messageContent: JSON.stringify([
        { type: "text", text: "first paragraph" },
        { type: "tool_use", id: "x", name: "noop", input: {} },
        { type: "text", text: "second paragraph" },
      ]),
      messageRole: "assistant",
    });

    const summary = createBookmark(db, {
      messageId: "msg-multi",
      conversationId: "conv-multi",
    });

    expect(summary.messagePreview).toBe("first paragraph\nsecond paragraph");
  });
});
