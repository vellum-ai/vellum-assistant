import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

/**
 * Backfill existing sequence steps JSON blobs to rename the
 * `replyToThread` key to `replyInSameConversation`, aligning with
 * the broader thread → conversation terminology unification.
 *
 * The UPDATE is naturally idempotent — REPLACE is a no-op when
 * the old key does not appear in the text, so no checkpoint guard
 * is needed.
 */
export function migrateRenameSequenceStepsReplyKey(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  raw.exec(
    /*sql*/ `UPDATE sequences SET steps = REPLACE(steps, '"replyToThread"', '"replyInSameConversation"') WHERE steps LIKE '%"replyToThread"%'`,
  );
}
