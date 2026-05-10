import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_message_bookmarks_v1";

/**
 * Create the message_bookmarks table for user-saved message bookmarks.
 *
 * Both foreign keys cascade so bookmarks are cleaned up automatically when
 * their parent message or conversation is deleted. A unique index on
 * message_id keeps the create-bookmark code path idempotent (a message can
 * be bookmarked at most once at a time).
 */
export function migrateMessageBookmarks(database: DrizzleDb): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    const raw = getSqliteFrom(database);

    raw.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS message_bookmarks (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL
      )
    `);

    raw.exec(/*sql*/ `
      CREATE UNIQUE INDEX IF NOT EXISTS message_bookmarks_message_id_uniq
      ON message_bookmarks (message_id)
    `);

    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS message_bookmarks_created_at_idx
      ON message_bookmarks (created_at)
    `);
  });
}
