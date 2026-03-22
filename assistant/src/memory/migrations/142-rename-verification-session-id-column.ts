import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

/**
 * Reverse v22: rename verification_session_id back to
 * guardian_verification_session_id in call_sessions.
 */
export function downRenameVerificationSessionIdColumn(
  database: DrizzleDb,
): void {
  const raw = getSqliteFrom(database);

  const columns = raw.query(`PRAGMA table_info(call_sessions)`).all() as Array<{
    name: string;
  }>;
  const hasNewColumn = columns.some(
    (c) => c.name === "verification_session_id",
  );
  const hasOldColumn = columns.some(
    (c) => c.name === "guardian_verification_session_id",
  );
  if (!hasNewColumn || hasOldColumn) return;

  raw.exec(
    /*sql*/ `ALTER TABLE call_sessions RENAME COLUMN verification_session_id TO guardian_verification_session_id`,
  );
}

/**
 * One-shot migration: rename the guardian_verification_session_id column
 * in call_sessions to verification_session_id, dropping the "guardian_"
 * prefix to align with the broader verification vocabulary.
 */
export function migrateRenameVerificationSessionIdColumn(
  database: DrizzleDb,
): void {
  withCrashRecovery(
    database,
    "migration_rename_verification_session_id_column_v1",
    () => {
      const raw = getSqliteFrom(database);

      // Check the old column exists and the new column doesn't before attempting the rename.
      // Both checks are needed for crash recovery: if the rename succeeded but the checkpoint
      // didn't commit, the old column is gone and the new one already exists.
      const columns = raw
        .query(`PRAGMA table_info(call_sessions)`)
        .all() as Array<{ name: string }>;
      const hasOldColumn = columns.some(
        (c) => c.name === "guardian_verification_session_id",
      );
      const hasNewColumn = columns.some(
        (c) => c.name === "verification_session_id",
      );
      if (!hasOldColumn || hasNewColumn) return;

      raw.exec(
        /*sql*/ `ALTER TABLE call_sessions RENAME COLUMN guardian_verification_session_id TO verification_session_id`,
      );
    },
  );
}
