import { type DrizzleDb } from "../db-connection.js";

/**
 * Rename `created_by_session_id` to `source_conversation_id` in two tables,
 * aligning with the broader session → conversation terminology unification.
 *
 * Each rename is wrapped in try/catch so re-running the migration is
 * idempotent (SQLite throws if the source column does not exist).
 */
export function migrateRenameCreatedBySessionIdColumns(
  database: DrizzleDb,
): void {
  try {
    database.run(
      `ALTER TABLE channel_verification_sessions RENAME COLUMN created_by_session_id TO source_conversation_id`,
    );
  } catch {
    /* already renamed */
  }
  try {
    database.run(
      `ALTER TABLE assistant_ingress_invites RENAME COLUMN created_by_session_id TO source_conversation_id`,
    );
  } catch {
    /* already renamed */
  }
}
