import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

/**
 * Rename `thread_starters` table to `conversation_starters` and recreate
 * indexes with new names, aligning with the thread → conversation
 * terminology unification.
 */
export function migrateRenameThreadStartersTable(database: DrizzleDb): void {
  withCrashRecovery(
    database,
    "migration_rename_thread_starters_table_v1",
    () => {
      const raw = getSqliteFrom(database);

      // Check the old table exists before attempting anything
      const oldTableExists = raw
        .query(
          `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'thread_starters'`,
        )
        .get();
      if (!oldTableExists) return;

      // Rename the physical table
      raw.exec(
        /*sql*/ `ALTER TABLE thread_starters RENAME TO conversation_starters`,
      );

      // Drop old indexes and recreate with new names.
      // SQLite automatically updates index table references on RENAME, but the
      // index names still reference the old naming convention — drop and recreate
      // with consistent names pointing at the new table.

      raw.exec(/*sql*/ `DROP INDEX IF EXISTS idx_thread_starters_batch`);
      raw.exec(
        /*sql*/ `CREATE INDEX IF NOT EXISTS idx_conversation_starters_batch ON conversation_starters(generation_batch, created_at)`,
      );

      raw.exec(/*sql*/ `DROP INDEX IF EXISTS idx_thread_starters_card_type`);
      raw.exec(
        /*sql*/ `CREATE INDEX IF NOT EXISTS idx_conversation_starters_card_type ON conversation_starters(card_type, scope_id)`,
      );

      // Migrate checkpoint keys from old thread_starters: prefix to
      // conversation_starters: so existing checkpoint data is found by
      // the renamed code paths and unnecessary re-generation is avoided.
      raw.exec(
        /*sql*/ `UPDATE memory_checkpoints SET key = replace(key, 'thread_starters:', 'conversation_starters:') WHERE key LIKE 'thread_starters:%'`,
      );
    },
  );
}
