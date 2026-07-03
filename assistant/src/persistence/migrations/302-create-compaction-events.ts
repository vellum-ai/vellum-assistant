import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

/**
 * Create the append-only `conversation_compaction_events` ledger and backfill
 * one event per already-compacted conversation from its current cache columns.
 *
 * The `conversations` row keeps the latest compaction
 * (`context_summary` / `context_compacted_message_count` /
 * `context_compacted_at`) as the hot-path cache the load path reads; this table
 * preserves the full history so a fork can inherit the most recent compaction
 * whose event time predates the message it forks from. Pre-feature history
 * beyond the latest compaction is unrecoverable, so existing rows seed exactly
 * one event.
 *
 * Idempotent: table creation is guarded on sqlite_master; the backfill is
 * guarded by a memory_checkpoints key and a per-conversation NOT EXISTS so a
 * lost checkpoint cannot duplicate rows.
 */
export function migrateCreateCompactionEvents(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  const tableExists = raw
    .query(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'conversation_compaction_events'`,
    )
    .get();

  if (!tableExists) {
    try {
      raw.exec("BEGIN");

      raw.exec(/*sql*/ `
        CREATE TABLE conversation_compaction_events (
          id                       TEXT PRIMARY KEY,
          conversation_id          TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          compacted_at             INTEGER NOT NULL,
          summary                  TEXT NOT NULL,
          compacted_message_count  INTEGER NOT NULL,
          created_at               INTEGER NOT NULL
        )
      `);

      raw.exec(/*sql*/ `
        CREATE INDEX idx_compaction_events_conv_at
          ON conversation_compaction_events(conversation_id, compacted_at)
      `);

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

  const checkpointKey = "backfill_conversation_compaction_events_v1";
  const checkpoint = raw
    .query(`SELECT 1 FROM memory_checkpoints WHERE key = ?`)
    .get(checkpointKey);
  if (checkpoint) return;

  try {
    raw.exec("BEGIN");

    raw
      .query(
        /*sql*/ `
        INSERT INTO conversation_compaction_events
          (id, conversation_id, compacted_at, summary, compacted_message_count, created_at)
        SELECT
          lower(hex(randomblob(16))),
          c.id,
          c.context_compacted_at,
          c.context_summary,
          c.context_compacted_message_count,
          ?
        FROM conversations c
        WHERE c.context_compacted_message_count > 0
          AND c.context_compacted_at IS NOT NULL
          AND c.context_summary IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM conversation_compaction_events e
            WHERE e.conversation_id = c.id
          )
      `,
      )
      .run(Date.now());

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
