import type { DrizzleDb } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";

const COLUMN_NAME = "enabled_plugins";
const COLUMN_DEFINITION = "enabled_plugins TEXT";

/**
 * Add the nullable `enabled_plugins` column to the `conversations` table.
 *
 * Stores a JSON-encoded `string[]` of plugin ids scoping the chat, or NULL
 * (the default) meaning no per-chat restriction — all globally-enabled
 * plugins apply. No backfill is needed: existing rows default to NULL.
 *
 * Idempotent: guarded with `tableHasColumn` so a crash between the `ALTER
 * TABLE` and the checkpoint write doesn't cause a duplicate-column error on
 * the next boot.
 */
export function migrateAddConversationEnabledPlugins(
  database: DrizzleDb,
): void {
  if (tableHasColumn(database, "conversations", COLUMN_NAME)) {
    return;
  }
  database.run(`ALTER TABLE conversations ADD COLUMN ${COLUMN_DEFINITION}`);
}
