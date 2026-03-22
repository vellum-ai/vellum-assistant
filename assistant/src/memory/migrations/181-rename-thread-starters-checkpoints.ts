import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

/**
 * Rename checkpoint keys from the old `thread_starters:` prefix to
 * `conversation_starters:` so that the renamed code paths in
 * `conversation-starters-cadence.ts` and `conversation-starters.ts`
 * find existing generation state and avoid unnecessary re-generation.
 *
 * This was originally appended to migration 174, but that migration
 * had already shipped with its own checkpoint key
 * (`migration_rename_thread_starters_table_v1`), so `withCrashRecovery`
 * would skip the entire body for users who had already run it. Moving
 * the checkpoint-key rewrite into its own migration with an independent
 * checkpoint key ensures it runs for all users.
 *
 * The rename is collision-safe: if a database already has both old
 * `thread_starters:*` keys and new `conversation_starters:*` keys
 * (written by updated code after the table rename), we drop the stale
 * old rows first to avoid UNIQUE constraint violations on the primary key.
 */
export function migrateRenameThreadStartersCheckpoints(
  database: DrizzleDb,
): void {
  withCrashRecovery(
    database,
    "migration_rename_thread_starters_checkpoints_v1",
    () => {
      const raw = getSqliteFrom(database);

      // 1. Delete old thread_starters: keys where a corresponding
      //    conversation_starters: key already exists (the newer key
      //    written by updated code takes precedence).
      raw.exec(/*sql*/ `DELETE FROM memory_checkpoints
         WHERE key LIKE 'thread_starters:%'
           AND replace(key, 'thread_starters:', 'conversation_starters:') IN (
             SELECT key FROM memory_checkpoints WHERE key LIKE 'conversation_starters:%'
           )`);

      // 2. Rename remaining old keys that have no collision.
      raw.exec(
        /*sql*/ `UPDATE memory_checkpoints SET key = replace(key, 'thread_starters:', 'conversation_starters:') WHERE key LIKE 'thread_starters:%'`,
      );
    },
  );
}

/**
 * Reverse: rename checkpoint keys from "conversation_starters:" back to
 * "thread_starters:" prefix.
 *
 * Mirrors the forward migration but in reverse. Handles collisions the same
 * way — if an old-prefix key already exists, the new-prefix key is dropped.
 */
export function migrateRenameThreadStartersCheckpointsDown(
  database: DrizzleDb,
): void {
  const raw = getSqliteFrom(database);

  // 1. Delete conversation_starters: keys where a corresponding
  //    thread_starters: key already exists.
  raw.exec(/*sql*/ `DELETE FROM memory_checkpoints
     WHERE key LIKE 'conversation_starters:%'
       AND replace(key, 'conversation_starters:', 'thread_starters:') IN (
         SELECT key FROM memory_checkpoints WHERE key LIKE 'thread_starters:%'
       )`);

  // 2. Rename remaining keys back to the old prefix.
  raw.exec(
    /*sql*/ `UPDATE memory_checkpoints SET key = replace(key, 'conversation_starters:', 'thread_starters:') WHERE key LIKE 'conversation_starters:%'`,
  );
}
