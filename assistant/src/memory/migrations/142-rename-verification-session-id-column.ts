import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

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

      // Check the old column exists before attempting the rename
      const columns = raw
        .query(`PRAGMA table_info(call_sessions)`)
        .all() as Array<{ name: string }>;
      const hasOldColumn = columns.some(
        (c) => c.name === "guardian_verification_session_id",
      );
      if (!hasOldColumn) return;

      raw.exec(
        /*sql*/ `ALTER TABLE call_sessions RENAME COLUMN guardian_verification_session_id TO verification_session_id`,
      );
    },
  );
}
