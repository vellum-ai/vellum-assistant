/**
 * Migration 375 creates `channel_outbound_posts`, the provider-id resolution
 * index for messages the assistant itself posted: the outbound counterpart
 * of `channel_inbound_events`. Keyed by the (channel, chat, provider id)
 * triple, which is exactly how an inbound reaction or delete addresses a
 * post.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../../db-connection.js";
import * as schema from "../../schema.js";
import { migrateCreateChannelOutboundPosts } from "../375-create-channel-outbound-posts.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
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

describe("migrateCreateChannelOutboundPosts", () => {
  test("creates the table and its FK indexes", () => {
    const db = createTestDb();

    migrateCreateChannelOutboundPosts(db);

    expect(tableNames(db)).toContain("channel_outbound_posts");
    // SQLite does not index FK columns automatically, and both parents
    // cascade deletes through them.
    expect(indexNames(db)).toContain("idx_channel_outbound_posts_message_id");
    expect(indexNames(db)).toContain(
      "idx_channel_outbound_posts_conversation_id",
    );
  });

  test("re-running is a no-op", () => {
    const db = createTestDb();

    migrateCreateChannelOutboundPosts(db);
    migrateCreateChannelOutboundPosts(db);

    expect(tableNames(db)).toContain("channel_outbound_posts");
  });

  test("the triple is the primary key: one row per provider post", () => {
    const db = createTestDb();
    migrateCreateChannelOutboundPosts(db);
    const sqlite = getSqliteFrom(db);
    const insert = () =>
      sqlite
        .prepare(
          `INSERT OR IGNORE INTO channel_outbound_posts
             (source_channel, external_chat_id, provider_message_id,
              message_id, conversation_id, created_at)
           VALUES ('discord', 'chat-1', 'post-1', 'row-1', 'conv-1', 1)`,
        )
        .run();

    insert();
    insert();

    const count = sqlite
      .prepare("SELECT COUNT(*) AS n FROM channel_outbound_posts")
      .get() as { n: number };
    expect(count.n).toBe(1);
  });
});
