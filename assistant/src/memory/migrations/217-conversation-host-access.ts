import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_conversation_host_access_v1";

/**
 * Add conversation-scoped host access state with a safe default of disabled.
 *
 * Idempotent: ALTER TABLE is guarded and the backfill only touches NULL rows.
 */
export function migrateConversationHostAccess(database: DrizzleDb): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    const raw = getSqliteFrom(database);

    try {
      raw.exec(
        `ALTER TABLE conversations ADD COLUMN host_access INTEGER NOT NULL DEFAULT 0`,
      );
    } catch {
      // Column already exists.
    }

    raw.exec(`
      UPDATE conversations
      SET host_access = 0
      WHERE host_access IS NULL
    `);
  });
}

/**
 * Reverse: no-op.
 *
 * The forward migration is additive and SQLite cannot drop one column without
 * rebuilding the table.
 */
export function downConversationHostAccess(_database: DrizzleDb): void {
  // Intentionally empty.
}
