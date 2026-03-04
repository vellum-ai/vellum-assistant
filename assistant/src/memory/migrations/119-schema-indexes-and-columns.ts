import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

/**
 * Add indexes, a column, and a unique constraint for schema improvements:
 * - Index on call_sessions(status) for status-based queries
 * - Index on llm_usage_events(conversation_id) for per-conversation usage queries
 * - startedAt column on memory_jobs for detecting stalled jobs
 * - Unique index on notification_deliveries(notification_decision_id, channel)
 */
export function migrateSchemaIndexesAndColumns(database: DrizzleDb): void {
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_call_sessions_status ON call_sessions(status)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_llm_usage_events_conversation_id ON llm_usage_events(conversation_id)`,
  );

  try {
    database.run(
      /*sql*/ `ALTER TABLE memory_jobs ADD COLUMN started_at INTEGER`,
    );
  } catch {
    /* already exists */
  }

  // Ensure notification_decision_id column exists on notification_deliveries.
  // Migration 114 (createNotificationTables) should have created this column,
  // but on databases where 114 crashed mid-run the column may be absent. Rather
  // than silently skipping the dedup+index step (leaving the schema incompatible
  // with runtime code that writes notificationDecisionId), we add the column
  // here if it is missing, then proceed unconditionally.
  const raw = getSqliteFrom(database);
  const notifDdl = raw
    .query(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notification_deliveries'`,
    )
    .get() as { sql: string } | null;

  if (notifDdl && !notifDdl.sql.includes("notification_decision_id")) {
    // ADD COLUMN cannot carry NOT NULL without a default in SQLite, so we add
    // it as nullable TEXT. Existing rows get NULL, which is valid until the
    // runtime backfills or replaces them. The unique index below is created
    // with WHERE NOT NULL to tolerate the transition period.
    try {
      database.run(
        /*sql*/ `ALTER TABLE notification_deliveries ADD COLUMN notification_decision_id TEXT`,
      );
    } catch {
      /* column was added concurrently — safe to continue */
    }
  }

  if (notifDdl) {
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
    } catch {
      /* deduplication failed — unique index creation below may fail too, which is non-fatal */
    }

    try {
      database.run(
        /*sql*/ `CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_deliveries_decision_channel ON notification_deliveries(notification_decision_id, channel) WHERE notification_decision_id IS NOT NULL`,
      );
    } catch {
      /* index already exists or constraint violation — safe to continue */
    }
  }
}
