import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

/**
 * Add the `initiated_from_conversation_id` column to `call_sessions` so
 * voice calls can track which conversation triggered them while pointing
 * the session's `conversation_id` to a dedicated per-call voice conversation.
 *
 * Uses ALTER TABLE ... ADD COLUMN which is a no-op if the column already
 * exists (caught via try/catch, matching the existing migration pattern in
 * db-init.ts for similar additive columns).
 */
export function migrateCallSessionsAddInitiatedFrom(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  try {
    raw.exec(
      /*sql*/ `ALTER TABLE call_sessions ADD COLUMN initiated_from_conversation_id TEXT`,
    );
  } catch {
    // Column already exists — nothing to do.
  }
}
