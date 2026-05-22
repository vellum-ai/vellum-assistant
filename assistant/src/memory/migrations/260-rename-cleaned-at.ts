import type { DrizzleDb } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_rename_cleaned_at_v1";

const OLD_COLUMN = "cleaned_at";
const NEW_COLUMN = "history_stripped_at";

/**
 * Rename `conversations.cleaned_at` → `conversations.history_stripped_at`.
 *
 * The marker now records any injection-strip event (`/clean` or compaction),
 * not just `/clean`. Renaming reflects the broader semantics; compaction
 * sets it alongside its summary state instead of destructively wiping
 * message metadata.
 */
export function migrateRenameCleanedAt(database: DrizzleDb): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    if (tableHasColumn(database, "conversations", NEW_COLUMN)) {
      return;
    }
    if (!tableHasColumn(database, "conversations", OLD_COLUMN)) {
      // 259 didn't run (fresh install on a newer schema where 259's column
      // was added under the new name) — nothing to rename.
      return;
    }
    database.run(
      `ALTER TABLE conversations RENAME COLUMN ${OLD_COLUMN} TO ${NEW_COLUMN}`,
    );
  });
}

export function downRenameCleanedAt(database: DrizzleDb): void {
  if (!tableHasColumn(database, "conversations", NEW_COLUMN)) {
    return;
  }
  if (tableHasColumn(database, "conversations", OLD_COLUMN)) {
    return;
  }
  database.run(
    `ALTER TABLE conversations RENAME COLUMN ${NEW_COLUMN} TO ${OLD_COLUMN}`,
  );
}
