import { getSqliteFrom } from '../db-connection.js';
import type { DrizzleDb } from '../db-connection.js';

/**
 * Add indexes, a column, and a unique constraint for schema improvements:
 * - Index on call_sessions(status) for status-based queries
 * - Index on llm_usage_events(conversation_id) for per-conversation usage queries
 * - startedAt column on memory_jobs for detecting stalled jobs
 * - Unique index on notification_deliveries(notification_decision_id, channel)
 */
export function migrateSchemaIndexesAndColumns(database: DrizzleDb): void {
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_call_sessions_status ON call_sessions(status)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_llm_usage_events_conversation_id ON llm_usage_events(conversation_id)`);

  try {
    database.run(/*sql*/ `ALTER TABLE memory_jobs ADD COLUMN started_at INTEGER`);
  } catch { /* already exists */ }

  // Skip the notification_deliveries dedup + unique index if the table doesn't
  // have the notification_decision_id column yet. This column is added by
  // migration 114-notifications.ts (createNotificationTables), which runs
  // before this migration in the db-init sequence. However, on databases where
  // migration 119 is applied before 114 has fully completed (e.g., after a
  // crash mid-migration), the column may be absent and the DELETE would throw.
  const raw = getSqliteFrom(database);
  const notifDdl = raw.query(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notification_deliveries'`,
  ).get() as { sql: string } | null;

  if (notifDdl?.sql.includes('notification_decision_id')) {
    // Deduplicate before creating the unique index — the prior schema allowed
    // multiple rows per (notification_decision_id, channel) via the wider
    // (decision_id, channel, destination, attempt) unique index.  Keep the
    // row with the latest updated_at for each group.
    try {
      database.run(/*sql*/ `
        DELETE FROM notification_deliveries
        WHERE id NOT IN (
          SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (
              PARTITION BY notification_decision_id, channel
              ORDER BY updated_at DESC
            ) AS rn
            FROM notification_deliveries
          )
          WHERE rn = 1
        )
      `);
    } catch { /* deduplication failed — unique index creation below may fail too, which is non-fatal */ }

    try {
      database.run(/*sql*/ `CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_deliveries_decision_channel ON notification_deliveries(notification_decision_id, channel)`);
    } catch { /* index already exists or constraint violation — safe to continue */ }
  }
}
