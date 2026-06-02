import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

/**
 * Adds the incognito conversation flags to `conversations`:
 *
 * - `incognito` (default 0) — when set, the conversation never produces
 *   memories.
 * - `factor_in_memories` (default 1) — controls whether existing memories are
 *   recalled into the conversation.
 *
 * An index on `incognito` supports filtering incognito conversations out of
 * memory-producing queries.
 *
 * Idempotent — the `ADD COLUMN` statements are wrapped in try/catch (mirroring
 * the surrounding additive-column migrations, e.g.
 * 253-conversation-last-notified-profile and 221-conversations-archived-at),
 * and `CREATE INDEX IF NOT EXISTS` is a no-op once the index exists.
 */
export function migrateConversationsIncognitoFlags(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  try {
    raw.exec(
      `ALTER TABLE conversations ADD COLUMN incognito INTEGER NOT NULL DEFAULT 0`,
    );
  } catch {
    // Column already exists — nothing to do.
  }
  try {
    raw.exec(
      `ALTER TABLE conversations ADD COLUMN factor_in_memories INTEGER NOT NULL DEFAULT 1`,
    );
  } catch {
    // Column already exists — nothing to do.
  }
  raw.exec(
    `CREATE INDEX IF NOT EXISTS idx_conversations_incognito ON conversations(incognito)`,
  );
}
