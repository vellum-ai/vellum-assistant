import type { DrizzleDb } from "../db-connection.js";

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
 */
export function migrateAddProcessingStartedAt(database: DrizzleDb): void {
  database.run(
    /*sql*/ `ALTER TABLE conversations ADD COLUMN processing_started_at INTEGER`,
  );
}
