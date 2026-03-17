import { type DrizzleDb } from "../db-connection.js";

/**
 * Rename `source_session_id` to `source_context_id` in the `notification_events`
 * table, aligning with the field's actual polymorphic usage (it holds conversation
 * IDs, call session IDs, schedule IDs, etc.).
 */
export function migrateRenameSourceSessionIdColumn(database: DrizzleDb): void {
  try {
    database.run(
      `ALTER TABLE notification_events RENAME COLUMN source_session_id TO source_context_id`,
    );
  } catch {
    /* already renamed */
  }
}
