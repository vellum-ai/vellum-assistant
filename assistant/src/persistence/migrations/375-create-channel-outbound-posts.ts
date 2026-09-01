import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

const TABLE = "channel_outbound_posts";

/**
 * Create `channel_outbound_posts`: the provider-id index for messages the
 * assistant itself posted, the outbound counterpart of
 * `channel_inbound_events`' provider-id resolution.
 *
 * Its own table rather than more envelope fields on `messages`, because one
 * stored reply fans out to many provider posts (a reply split at tool
 * boundaries or length limits) and resolution by id must be exact: reactions
 * and deletions name a provider post, and a JSON-array scan over recent rows
 * is a recency heuristic, not a resolution contract. The row's
 * `providerMeta` envelope stays the self-description every reader consumes;
 * this table is the derived index over its id facts, written by the same
 * post-send reconciliation that writes them.
 *
 * Composite primary key: a provider post id is unique within its channel's
 * chat, and the triple is exactly how an inbound reaction or delete
 * addresses it. Secondary indexes on the two FK columns because SQLite does
 * not index FK columns automatically and both parents cascade deletes.
 *
 * No backfill: rows delivered before this table resolve through the
 * transitional envelope-scan fallback in `findMessageByProviderMessageId`
 * until they age out of relevance.
 *
 * Idempotent via IF NOT EXISTS.
 */
export function migrateCreateChannelOutboundPosts(database: DrizzleDb): void {
  const sqlite = getSqliteFrom(database);
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (
       source_channel TEXT NOT NULL,
       external_chat_id TEXT NOT NULL,
       provider_message_id TEXT NOT NULL,
       message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
       conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
       created_at INTEGER NOT NULL,
       PRIMARY KEY (source_channel, external_chat_id, provider_message_id)
     )`,
  );
  sqlite.exec(
    `CREATE INDEX IF NOT EXISTS idx_channel_outbound_posts_message_id
       ON ${TABLE} (message_id)`,
  );
  sqlite.exec(
    `CREATE INDEX IF NOT EXISTS idx_channel_outbound_posts_conversation_id
       ON ${TABLE} (conversation_id)`,
  );
}
