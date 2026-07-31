import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

/**
 * Adds `client_message_id` (nullable TEXT) to the `messages` table and
 * creates a partial unique index on `(conversation_id, client_message_id)`
 * for rows where `client_message_id IS NOT NULL`.
 *
 * The client-generated correlation nonce was previously wire-protocol-only
 * (echoed on SSE `user_message_echo` events for optimistic-row dedup) but
 * never persisted. Storing it enables server-side idempotency: a duplicate
 * INSERT with the same `(conversation_id, client_message_id)` pair is
 * silently skipped via `ON CONFLICT DO NOTHING`.
 *
 * Idempotent — re-running is a no-op once the column and index exist.
 */
export function migrateMessagesClientMessageId(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  const columns = raw.query(`PRAGMA table_info(messages)`).all() as Array<{
    name: string;
  }>;
  const columnNames = new Set(columns.map((c) => c.name));

  if (!columnNames.has("client_message_id")) {
    raw.exec(`ALTER TABLE messages ADD COLUMN client_message_id TEXT`);
  }

  // Partial unique index: only enforced when client_message_id is non-NULL.
  // Messages without a client_message_id (assistant messages, system-generated
  // messages, legacy rows) are unconstrained.
  const indexes = raw.query(`PRAGMA index_list(messages)`).all() as Array<{
    name: string;
  }>;
  const indexNames = new Set(indexes.map((i) => i.name));

  if (!indexNames.has("idx_messages_conv_client_msg_id")) {
    raw.exec(
      `CREATE UNIQUE INDEX idx_messages_conv_client_msg_id
       ON messages (conversation_id, client_message_id)
       WHERE client_message_id IS NOT NULL`,
    );
  }
}
