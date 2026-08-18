import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "../schema.js";
import { migrateRetitleStuckChannelPlaceholders } from "./367-retitle-stuck-channel-placeholders.js";

const PLACEHOLDER = "Generating title...";
const HOUR_MS = 60 * 60 * 1000;
const STALE_CREATED_AT = Date.now() - 2 * HOUR_MS;
const FRESH_CREATED_AT = Date.now() - 5 * 60 * 1000;

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(/*sql*/ `
    CREATE TABLE conversations (
      id            TEXT PRIMARY KEY,
      title         TEXT,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      is_auto_title INTEGER NOT NULL DEFAULT 1,
      archived_at   INTEGER
    );
    CREATE TABLE messages (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role            TEXT NOT NULL,
      content         TEXT NOT NULL,
      created_at      INTEGER NOT NULL
    );
    CREATE TABLE channel_inbound_events (
      id                  TEXT PRIMARY KEY,
      source_channel      TEXT NOT NULL,
      external_chat_id    TEXT NOT NULL,
      external_message_id TEXT NOT NULL,
      conversation_id     TEXT NOT NULL,
      created_at          INTEGER NOT NULL
    );
    CREATE TABLE conversation_keys (
      id               TEXT PRIMARY KEY,
      conversation_key TEXT NOT NULL,
      conversation_id  TEXT NOT NULL,
      created_at       INTEGER NOT NULL
    );
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

interface ConversationRow {
  title: string | null;
  is_auto_title: number;
  archived_at: number | null;
  updated_at: number;
}

function insertConversation(
  sqlite: Database,
  id: string,
  opts: { title?: string; createdAt?: number; isAutoTitle?: number } = {},
): void {
  const createdAt = opts.createdAt ?? STALE_CREATED_AT;
  sqlite
    .query(
      /*sql*/ `INSERT INTO conversations (id, title, created_at, updated_at, is_auto_title)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      opts.title ?? PLACEHOLDER,
      createdAt,
      createdAt,
      opts.isAutoTitle ?? 1,
    );
}

function insertKey(sqlite: Database, conversationId: string, key: string) {
  sqlite
    .query(
      /*sql*/ `INSERT INTO conversation_keys (id, conversation_key, conversation_id, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(`key-${conversationId}-${key}`, key, conversationId, STALE_CREATED_AT);
}

function insertInboundEvent(
  sqlite: Database,
  conversationId: string,
  sourceChannel: string,
) {
  sqlite
    .query(
      /*sql*/ `INSERT INTO channel_inbound_events
         (id, source_channel, external_chat_id, external_message_id, conversation_id, created_at)
       VALUES (?, ?, 'chat-1', ?, ?, ?)`,
    )
    .run(
      `evt-${conversationId}-${sourceChannel}`,
      sourceChannel,
      `msg-${conversationId}`,
      conversationId,
      STALE_CREATED_AT,
    );
}

function insertMessage(
  sqlite: Database,
  conversationId: string,
  content: string,
  id = `msg-${conversationId}-${content.length}-${Math.random()}`,
) {
  sqlite
    .query(
      /*sql*/ `INSERT INTO messages (id, conversation_id, role, content, created_at)
       VALUES (?, ?, 'user', ?, ?)`,
    )
    .run(id, conversationId, content, STALE_CREATED_AT);
}

function readConversation(sqlite: Database, id: string): ConversationRow {
  return sqlite
    .query(
      `SELECT title, is_auto_title, archived_at, updated_at FROM conversations WHERE id = ?`,
    )
    .get(id) as ConversationRow;
}

describe("migration 367: retitle stuck channel placeholders", () => {
  test("retitles a real-message channel conversation without archiving it", () => {
    const { sqlite, db } = createTestDb();
    insertConversation(sqlite, "conv-slack");
    insertKey(sqlite, "conv-slack", "asst:self:slack:C0123ABCDEF");
    insertInboundEvent(sqlite, "conv-slack", "slack");
    insertMessage(sqlite, "conv-slack", "hello there");

    migrateRetitleStuckChannelPlaceholders(db);

    const row = readConversation(sqlite, "conv-slack");
    expect(row.title).toBe("New Slack message");
    expect(row.is_auto_title).toBe(2);
    expect(row.archived_at).toBeNull();
    expect(row.updated_at).toBe(STALE_CREATED_AT);
  });

  test("retitles and archives a reaction-only conversation", () => {
    const { sqlite, db } = createTestDb();
    insertConversation(sqlite, "conv-react");
    insertKey(
      sqlite,
      "conv-react",
      "asst:self:slack:C0123ABCDEF:thread:1710000000.000100",
    );
    insertInboundEvent(sqlite, "conv-react", "slack");
    insertMessage(sqlite, "conv-react", "[reaction]", "m1");
    insertMessage(sqlite, "conv-react", "[reaction]", "m2");

    migrateRetitleStuckChannelPlaceholders(db);

    const row = readConversation(sqlite, "conv-react");
    expect(row.title).toBe("Slack reaction");
    expect(row.is_auto_title).toBe(2);
    expect(row.archived_at).not.toBeNull();
  });

  test("a reaction row beside a real message counts as real content", () => {
    const { sqlite, db } = createTestDb();
    insertConversation(sqlite, "conv-mixed");
    insertInboundEvent(sqlite, "conv-mixed", "slack");
    insertMessage(sqlite, "conv-mixed", "[reaction]", "m1");
    insertMessage(sqlite, "conv-mixed", "real text", "m2");

    migrateRetitleStuckChannelPlaceholders(db);

    const row = readConversation(sqlite, "conv-mixed");
    expect(row.title).toBe("New Slack message");
    expect(row.archived_at).toBeNull();
  });

  test("retitles and archives a message-less channel conversation", () => {
    const { sqlite, db } = createTestDb();
    insertConversation(sqlite, "conv-empty");
    insertInboundEvent(sqlite, "conv-empty", "telegram");

    migrateRetitleStuckChannelPlaceholders(db);

    const row = readConversation(sqlite, "conv-empty");
    expect(row.title).toBe("New Telegram message");
    expect(row.is_auto_title).toBe(2);
    expect(row.archived_at).not.toBeNull();
  });

  test("derives the channel from the key when no inbound event exists", () => {
    const { sqlite, db } = createTestDb();
    insertConversation(sqlite, "conv-wa");
    insertKey(sqlite, "conv-wa", "asst:self:whatsapp:15550100");

    migrateRetitleStuckChannelPlaceholders(db);

    expect(readConversation(sqlite, "conv-wa").title).toBe(
      "New WhatsApp message",
    );
  });

  test("respects the one-hour age fence", () => {
    const { sqlite, db } = createTestDb();
    insertConversation(sqlite, "conv-fresh", { createdAt: FRESH_CREATED_AT });
    insertInboundEvent(sqlite, "conv-fresh", "slack");

    migrateRetitleStuckChannelPlaceholders(db);

    const row = readConversation(sqlite, "conv-fresh");
    expect(row.title).toBe(PLACEHOLDER);
    expect(row.is_auto_title).toBe(1);
    expect(row.archived_at).toBeNull();
  });

  test("leaves non-channel and already-titled conversations untouched", () => {
    const { sqlite, db } = createTestDb();
    // Web conversation on the placeholder: no channel evidence.
    insertConversation(sqlite, "conv-web");
    insertKey(sqlite, "conv-web", "web-draft-key");
    // Voice key under the scope prefix but not a channel.
    insertConversation(sqlite, "conv-voice");
    insertKey(sqlite, "conv-voice", "asst:self:voice:call:session-1");
    // Channel conversation that already has a title.
    insertConversation(sqlite, "conv-titled", {
      title: "Lunch plans",
      isAutoTitle: 1,
    });
    insertInboundEvent(sqlite, "conv-titled", "slack");

    migrateRetitleStuckChannelPlaceholders(db);

    expect(readConversation(sqlite, "conv-web").title).toBe(PLACEHOLDER);
    expect(readConversation(sqlite, "conv-voice").title).toBe(PLACEHOLDER);
    expect(readConversation(sqlite, "conv-titled").title).toBe("Lunch plans");
    expect(readConversation(sqlite, "conv-titled").is_auto_title).toBe(1);
  });

  test("is idempotent", () => {
    const { sqlite, db } = createTestDb();
    insertConversation(sqlite, "conv-react");
    insertInboundEvent(sqlite, "conv-react", "slack");
    insertMessage(sqlite, "conv-react", "[reaction]", "m1");
    insertConversation(sqlite, "conv-real");
    insertInboundEvent(sqlite, "conv-real", "slack");
    insertMessage(sqlite, "conv-real", "hello", "m2");

    migrateRetitleStuckChannelPlaceholders(db);
    const firstReact = readConversation(sqlite, "conv-react");
    const firstReal = readConversation(sqlite, "conv-real");
    migrateRetitleStuckChannelPlaceholders(db);

    expect(readConversation(sqlite, "conv-react")).toEqual(firstReact);
    expect(readConversation(sqlite, "conv-real")).toEqual(firstReal);
  });

  test("processes more rows than one batch", () => {
    const { sqlite, db } = createTestDb();
    for (let i = 0; i < 1203; i++) {
      const id = `conv-${String(i).padStart(5, "0")}`;
      insertConversation(sqlite, id);
      insertInboundEvent(sqlite, id, "slack");
    }

    migrateRetitleStuckChannelPlaceholders(db);

    const remaining = sqlite
      .query(`SELECT COUNT(*) AS n FROM conversations WHERE title = ?`)
      .get(PLACEHOLDER) as { n: number };
    expect(remaining.n).toBe(0);
  });

  test("no-ops without the tables or the columns", () => {
    const bare = new Database(":memory:");
    expect(() =>
      migrateRetitleStuckChannelPlaceholders(drizzle(bare, { schema })),
    ).not.toThrow();

    const partial = new Database(":memory:");
    partial.exec(/*sql*/ `
      CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE channel_inbound_events (id TEXT PRIMARY KEY, source_channel TEXT NOT NULL, external_chat_id TEXT NOT NULL, external_message_id TEXT NOT NULL, conversation_id TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE conversation_keys (id TEXT PRIMARY KEY, conversation_key TEXT NOT NULL, conversation_id TEXT NOT NULL, created_at INTEGER NOT NULL);
    `);
    expect(() =>
      migrateRetitleStuckChannelPlaceholders(drizzle(partial, { schema })),
    ).not.toThrow();
  });
});
