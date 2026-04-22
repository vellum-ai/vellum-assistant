import type { DrizzleDb } from "../db-connection.js";

/**
 * Tracker for approval prompt message timestamps.
 *
 * Scopes guardian reaction approvals so only reactions on a known approval
 * prompt can resolve a pending request. Persisted so that a daemon restart
 * between prompt delivery and guardian reaction does not silently invalidate
 * valid reactions — the in-memory Map used previously lost all tracked
 * prompt ts's on restart, causing valid reactions within the 30-minute
 * guardian TTL to be treated as stale.
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
