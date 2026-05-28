import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

/**
 * Create the `conversation_events` table — a durable, append-only log of
 * streaming events emitted during an assistant turn.
 *
 * Each row records one event the daemon published over the SSE channel for
 * a conversation, tagged with its per-conversation monotonic `seq`. The
 * table backs `Last-Event-Id` replay on SSE reconnect (see PR 2 of the
 * streaming-message-architecture plan) so a client that drops a stream
 * mid-turn can resume without losing or duplicating events.
 *
 * Columns:
 * - `conversation_id` — owner conversation; rows are scoped per-conversation
 *   for cheap range scans on reconnect replay.
 * - `seq` — the per-conversation monotonic sequence stamped on the event by
 *   {@link nextSeq}. The composite `(conversation_id, seq)` is the natural
 *   primary key and the only index used during replay.
 * - `event_type` — the `ServerMessage.type` discriminant (e.g.
 *   `assistant_text_delta`, `block_open`, `message_close`).
 * - `message_id` — the assistant `messageId` the event references, when one
 *   is in scope. Stored separately from the payload so future queries can
 *   filter by message without parsing the JSON blob.
 * - `block_index` — the 0-based block coordinate within the message, when
 *   applicable. Same rationale as `message_id`.
 * - `payload_json` — the full event payload, serialized so the SSE handshake
 *   can replay it verbatim.
 * - `created_at` — wall-clock insertion time (epoch ms). Drives the periodic
 *   trimmer that drops rows older than the retention window.
 *
 * Idempotent — re-running the migration is a no-op once the table and index
 * exist. Uses CREATE TABLE/INDEX IF NOT EXISTS so no checkpoint entry is
 * required.
 */
export function migrateConversationEvents(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  raw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS conversation_events (
      conversation_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      message_id TEXT,
      block_index INTEGER,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (conversation_id, seq)
    )
  `);
  // Time-range index for the cleanup task that trims rows older than the
  // retention window. The composite primary key already covers the replay
  // path, so no additional `(conversation_id, seq)` index is needed.
  raw.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_conversation_events_created_at
      ON conversation_events (created_at)
  `);
}
