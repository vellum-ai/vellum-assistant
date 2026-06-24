import type { DrizzleDb } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";

const COLUMN_NAME = "processing_started_at";
const COLUMN_DEFINITION = "processing_started_at INTEGER";

/**
 * Add `processing_started_at` column to the `conversations` table.
 *
 * The column is a nullable epoch-ms timestamp: non-NULL means the agent loop
 * is mid-turn for this conversation, NULL means idle. This is the
 * cross-process source of truth for processing state — the in-memory
 * `Conversation._processing` flag is the hot-path read for resident
 * conversations, but out-of-process callers (e.g. the retrospective CLI)
 * read this column directly via `isConversationProcessing()`.
 *
 * No backfill is needed — all existing rows default to NULL (not processing),
 * which is correct for any conversation that isn't actively mid-turn at
 * migration time.
 *
 * Idempotent: guarded with `tableHasColumn` so a crash between the `ALTER
 * TABLE` and the checkpoint write doesn't cause a duplicate-column error on
 * the next boot.
 */
export function migrateAddProcessingStartedAt(database: DrizzleDb): void {
  if (tableHasColumn(database, "conversations", COLUMN_NAME)) {
    return;
  }
  database.run(`ALTER TABLE conversations ADD COLUMN ${COLUMN_DEFINITION}`);
}
