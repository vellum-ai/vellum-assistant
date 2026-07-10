import type { DrizzleDb } from "../db-connection.js";

/**
 * Add the `finalized` column to `messages`.
 *
 * `finalized = 1` (the default, and the backfill value for every existing
 * row) means the row's `content` is the complete, immutable value — either
 * an inline `ContentBlock[]` or a `{ ref }` pointing at an externalized
 * content file. `finalized = 0` means the message is still streaming: its
 * content lives in an in-flight delta file under the conversation
 * directory and the row's `content` holds the `{ ref }` to it. Batch
 * readers (search, memory indexing, fork) filter on `finalized = 1`; only
 * the live turn and crash recovery read unfinalized content.
 *
 * Uses ALTER TABLE ADD COLUMN with try/catch for idempotency — no registry
 * entry needed.
 */
export function migrateMessageFinalizedColumn(database: DrizzleDb): void {
  try {
    database.run(
      /*sql*/ `ALTER TABLE messages ADD COLUMN finalized INTEGER NOT NULL DEFAULT 1`,
    );
  } catch {
    /* already exists */
  }
}
