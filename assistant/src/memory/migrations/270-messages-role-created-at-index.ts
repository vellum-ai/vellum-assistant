import type { DrizzleDb } from "../db-connection.js";

/**
 * Indexes `messages(role, created_at)` so the most recent message of a given
 * role can be found with an indexed seek instead of a table scan.
 *
 * The database-maintenance quiet-period gate looks up the newest user-message
 * timestamp on every idle worker tick; without this index that lookup scans
 * the (potentially multi-GB) messages table on the daemon's synchronous
 * connection.
 *
 * Idempotent — `CREATE INDEX IF NOT EXISTS` is a no-op once the index exists.
 */
export function migrateMessagesRoleCreatedAtIndex(database: DrizzleDb): void {
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_messages_role_created_at ON messages(role, created_at)`,
  );
}
