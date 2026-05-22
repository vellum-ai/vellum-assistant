import type { DrizzleDb } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_conversation_cleaned_at_v1";

const COLUMN_NAME = "cleaned_at";
const COLUMN_DEFINITION = "cleaned_at INTEGER";

/**
 * Add a `cleaned_at` timestamp to conversations.
 *
 * Records the moment `/clean` ran. The load path uses it to skip metadata
 * reinjection (and strip injection prefixes from message content) for
 * messages whose `created_at < cleaned_at`, so the clean survives daemon
 * restart and conversation eviction. `forkConversation` copies the marker
 * to the child only when the fork point is at-or-after the clean.
 */
export function migrateConversationCleanedAt(database: DrizzleDb): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    if (tableHasColumn(database, "conversations", COLUMN_NAME)) {
      return;
    }
    database.run(`ALTER TABLE conversations ADD COLUMN ${COLUMN_DEFINITION}`);
  });
}

export function downConversationCleanedAt(database: DrizzleDb): void {
  if (!tableHasColumn(database, "conversations", COLUMN_NAME)) {
    return;
  }
  database.run(`ALTER TABLE conversations DROP COLUMN ${COLUMN_NAME}`);
}
