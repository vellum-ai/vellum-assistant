import type { DrizzleDb } from "../db-connection.js";

/**
 * Rename sequence_enrollments.thread_id → conversation_id, aligning with the
 * broader thread → conversation terminology unification.
 *
 * Wrapped in try/catch for idempotency (SQLite throws if the source column
 * does not exist, meaning it was already renamed).
 */
export function migrateRenameSequenceEnrollmentsThreadIdColumn(
  database: DrizzleDb,
): void {
  try {
    database.run(
      `ALTER TABLE sequence_enrollments RENAME COLUMN thread_id TO conversation_id`,
    );
  } catch {
    /* already renamed */
  }
}
