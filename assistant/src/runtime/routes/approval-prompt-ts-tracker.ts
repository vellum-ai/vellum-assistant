/**
 * Persistent tracker for approval prompt message timestamps.
 *
 * Scopes guardian reaction approvals so only reactions on a known approval
 * prompt can resolve a pending request. Without this, a stray 👍/✅ on any
 * message in the guardian chat could approve a pending request (since
 * reactions are now admitted from any subscribed channel, not just tracked
 * bot threads).
 *
 * Entries are stored in the `approval_prompt_ts_tracker` table (created by
 * `createApprovalPromptTsTrackerTable`) so that a daemon restart between
 * prompt delivery and guardian reaction does not silently invalidate
 * reactions that are still within the 30-minute guardian approval TTL.
 * Entries expire after `APPROVAL_PROMPT_TS_TTL_MS` (guardian approval TTL
 * plus grace).
 */
import { getSqlite } from "../../memory/db-connection.js";
import { getLogger } from "../../util/logger.js";

const log = getLogger("runtime-http");

const APPROVAL_PROMPT_TS_TTL_MS = 35 * 60 * 1000;

// Swallow errors: callers run this inside their delivery try/catch, so a
// tracker throw would be misread as a delivery failure and trigger
// fallback/retry, double-posting the guardian prompt.
export function trackApprovalPromptTs(
  channel: string,
  chatId: string,
  ts: string,
): void {
  try {
    const now = Date.now();
    const expiresAt = now + APPROVAL_PROMPT_TS_TTL_MS;
    const db = getSqlite();
    db.run(
      /*sql*/ `DELETE FROM approval_prompt_ts_tracker WHERE expires_at <= ?`,
      [now],
    );
    db.run(
      /*sql*/ `INSERT OR REPLACE INTO approval_prompt_ts_tracker (channel, chat_id, ts, expires_at) VALUES (?, ?, ?, ?)`,
      [channel, chatId, ts, expiresAt],
    );
  } catch (err) {
    log.error(
      { err, channel, chatId, ts },
      "Failed to persist approval prompt ts tracker entry; continuing without tracking",
    );
  }
}

export function isTrackedApprovalPromptTs(
  channel: string,
  chatId: string,
  ts: string,
): boolean {
  const now = Date.now();
  const db = getSqlite();
  const row = db
    .query(
      /*sql*/ `SELECT expires_at FROM approval_prompt_ts_tracker WHERE channel = ? AND chat_id = ? AND ts = ?`,
    )
    .get(channel, chatId, ts) as { expires_at: number } | null;
  if (!row) return false;
  if (row.expires_at <= now) {
    db.run(
      /*sql*/ `DELETE FROM approval_prompt_ts_tracker WHERE channel = ? AND chat_id = ? AND ts = ?`,
      [channel, chatId, ts],
    );
    return false;
  }
  return true;
}

/** @internal Test-only — clear all tracked entries. */
export function _clearApprovalPromptTsTrackerForTesting(): void {
  getSqlite().run(/*sql*/ `DELETE FROM approval_prompt_ts_tracker`);
}
