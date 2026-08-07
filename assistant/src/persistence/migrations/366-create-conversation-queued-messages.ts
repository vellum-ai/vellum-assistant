import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

/**
 * Creates `conversation_queued_messages`: the durable backing for each
 * conversation's in-memory message queue (see the schema module for the
 * design and for what is deliberately not stored).
 *
 * A message enqueued while the agent is mid-turn is otherwise held only in
 * process memory until the drain persists it, so a restart or crash inside
 * that window destroys input the daemon acknowledged with
 * `202 { queued: true }`, with no event and no error.
 *
 * Idempotent (`IF NOT EXISTS`). No backfill: whatever sits in a live queue
 * when this first runs predates the table and exists only in memory, and
 * inventing rows for messages the daemon may already have drained would
 * double-insert them.
 */
export function migrateCreateConversationQueuedMessages(
  database: DrizzleDb,
): void {
  const raw = getSqliteFrom(database);
  raw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS conversation_queued_messages (
      request_id                TEXT PRIMARY KEY,
      conversation_id           TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      client_message_id         TEXT,
      content                   TEXT NOT NULL,
      display_content           TEXT,
      attachments               TEXT,
      metadata                  TEXT,
      transport                 TEXT,
      source_actor_principal_id TEXT,
      is_interactive            INTEGER,
      sort_key                  INTEGER NOT NULL,
      state                     TEXT NOT NULL DEFAULT 'queued',
      sent_at                   INTEGER NOT NULL,
      enqueued_at               INTEGER NOT NULL
    )
  `);
  raw.exec(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_conversation_queued_messages_conv_sort
      ON conversation_queued_messages(conversation_id, sort_key)`);
}
