import { type DrizzleDb } from "../db-connection.js";

/**
 * Rename notification_deliveries columns from thread-based names to
 * conversation-based names, aligning with the broader thread → conversation
 * terminology unification.
 *
 * Each rename is wrapped in try/catch so re-running the migration is
 * idempotent (SQLite throws if the source column does not exist).
 */
export function migrateRenameNotificationThreadColumns(
  database: DrizzleDb,
): void {
  try {
    database.run(
      `ALTER TABLE notification_deliveries RENAME COLUMN thread_action TO conversation_action`,
    );
  } catch {
    /* already renamed */
  }
  try {
    database.run(
      `ALTER TABLE notification_deliveries RENAME COLUMN thread_target_conversation_id TO conversation_target_id`,
    );
  } catch {
    /* already renamed */
  }
  try {
    database.run(
      `ALTER TABLE notification_deliveries RENAME COLUMN thread_decision_fallback_used TO conversation_fallback_used`,
    );
  } catch {
    /* already renamed */
  }
}
