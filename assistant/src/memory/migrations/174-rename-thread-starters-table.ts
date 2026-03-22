import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
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

      // If the new table already exists (crash recovery), skip the rename
      const newTableExists = raw
        .query(
          `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'conversation_starters'`,
        )
        .get();
      if (newTableExists) return;

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
    },
  );
}

/**
 * Reverse: rename conversation_starters back to thread_starters and recreate
 * old index names.
 *
 * Idempotent — skips if the old table already exists or the new table is
 * absent.
 */
export function migrateRenameThreadStartersTableDown(
  database: DrizzleDb,
): void {
  const raw = getSqliteFrom(database);

  // Guard: new table must exist
  const newTableExists = raw
    .query(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'conversation_starters'`,
    )
    .get();
  if (!newTableExists) return;

  // Guard: old table must not already exist
  const oldTableExists = raw
    .query(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'thread_starters'`,
    )
    .get();
  if (oldTableExists) return;

  // Rename the table back
  raw.exec(
    /*sql*/ `ALTER TABLE conversation_starters RENAME TO thread_starters`,
  );

  // Drop new indexes and recreate with old names
  raw.exec(/*sql*/ `DROP INDEX IF EXISTS idx_conversation_starters_batch`);
  raw.exec(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_thread_starters_batch ON thread_starters(generation_batch, created_at)`,
  );

  raw.exec(/*sql*/ `DROP INDEX IF EXISTS idx_conversation_starters_card_type`);
  raw.exec(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_thread_starters_card_type ON thread_starters(card_type, scope_id)`,
  );
}
