import type { DrizzleDb } from "../db-connection.js";

/**
 * Tracker for approval prompt message timestamps.
 *
 * Stores the (channel, chat_id, ts) tuples for delivered guardian approval
 * prompts so only reactions on a known prompt can resolve a pending
 * request. Persistence (rather than in-memory state) is required because
 * the guardian approval TTL is 30 minutes, which can span a daemon
 * restart between prompt delivery and the user's reaction.
 */
export function createApprovalPromptTsTrackerTable(database: DrizzleDb): void {
  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS approval_prompt_ts_tracker (
      channel TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      ts TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      PRIMARY KEY (channel, chat_id, ts)
    )
  `);

  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_approval_prompt_ts_tracker_expires ON approval_prompt_ts_tracker(expires_at)`,
  );
}
