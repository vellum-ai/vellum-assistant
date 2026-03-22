import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

/**
 * One-shot migration: seed assistant_inbox_thread_state from existing
 * external_conversation_bindings so that pre-existing conversations
 * appear in the inbox without waiting for new inbound activity.
 *
 * Uses INSERT OR IGNORE for idempotency (conversation_id is PK).
 * Counters (unread_count, pending_escalation_count, has_pending_escalation)
 * are initialised to zero since historical state is unknown.
 */
export function migrateBackfillInboxThreadStateFromBindings(
  database: DrizzleDb,
): void {
  const raw = getSqliteFrom(database);
  const checkpointKey = "backfill_inbox_thread_state_from_bindings";
  const checkpoint = raw
    .query(`SELECT 1 FROM memory_checkpoints WHERE key = ?`)
    .get(checkpointKey);
  if (checkpoint) return;

  // Guard: skip if either table does not exist yet (first boot edge case).
  const srcExists = raw
    .query(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'external_conversation_bindings'`,
    )
    .get();
  const dstExists = raw
    .query(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'assistant_inbox_thread_state'`,
    )
    .get();
  if (!srcExists || !dstExists) {
    raw
      .query(
        `INSERT OR IGNORE INTO memory_checkpoints (key, value, updated_at) VALUES (?, '1', ?)`,
      )
      .run(checkpointKey, Date.now());
    return;
  }

  try {
    raw.exec("BEGIN");

    raw.exec(/*sql*/ `
      INSERT OR IGNORE INTO assistant_inbox_thread_state (
        conversation_id, assistant_id, source_channel, external_chat_id,
        external_user_id, display_name, username,
        last_inbound_at, last_outbound_at, last_message_at,
        unread_count, pending_escalation_count, has_pending_escalation,
        created_at, updated_at
      )
      SELECT
        conversation_id,
        'self',
        source_channel,
        external_chat_id,
        external_user_id,
        display_name,
        username,
        last_inbound_at,
        last_outbound_at,
        CASE
          WHEN last_inbound_at IS NULL AND last_outbound_at IS NULL THEN NULL
          ELSE MAX(COALESCE(last_inbound_at, 0), COALESCE(last_outbound_at, 0))
        END,
        0,
        0,
        0,
        created_at,
        updated_at
      FROM external_conversation_bindings
    `);

    raw
      .query(
        `INSERT OR IGNORE INTO memory_checkpoints (key, value, updated_at) VALUES (?, '1', ?)`,
      )
      .run(checkpointKey, Date.now());

    raw.exec("COMMIT");
  } catch (e) {
    try {
      raw.exec("ROLLBACK");
    } catch {
      /* no active transaction */
    }
    throw e;
  }
}

/**
 * No-op down: the seeded inbox thread state rows are expected to remain.
 * The forward migration used INSERT OR IGNORE, so existing rows were never
 * modified. Removing the seeded rows could leave the inbox empty for
 * pre-existing conversations, which is worse than keeping them.
 */
export function downBackfillInboxThreadState(_database: DrizzleDb): void {
  // Intentionally empty — seeded data is expected to remain.
}
