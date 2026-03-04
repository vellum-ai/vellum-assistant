import type { Database, Statement } from "bun:sqlite";
import { getGatewayDb } from "./connection.js";

/**
 * Persistent store for Slack thread tracking and event deduplication.
 * Backed by SQLite so state survives gateway restarts.
 */
export class SlackStore {
  private db: Database;

  // Prepared statements (lazily cached)
  private _upsertThread: Statement | null = null;
  private _hasThread: Statement | null = null;
  private _deleteExpiredThreads: Statement | null = null;
  private _upsertEvent: Statement | null = null;
  private _hasEvent: Statement | null = null;
  private _deleteExpiredEvents: Statement | null = null;

  constructor(db?: Database) {
    this.db = db ?? getGatewayDb();
  }

  // -- Active threads --

  trackThread(threadTs: string, ttlMs: number): void {
    const now = Date.now();
    const stmt =
      this._upsertThread ??
      (this._upsertThread = this.db.prepare(
        `INSERT INTO slack_active_threads (thread_ts, tracked_at, expires_at)
         VALUES (?, ?, ?)
         ON CONFLICT(thread_ts) DO UPDATE SET tracked_at = excluded.tracked_at, expires_at = excluded.expires_at`,
      ));
    stmt.run(threadTs, now, now + ttlMs);
  }

  hasThread(threadTs: string): boolean {
    const now = Date.now();
    const stmt =
      this._hasThread ??
      (this._hasThread = this.db.prepare(
        `SELECT 1 FROM slack_active_threads WHERE thread_ts = ? AND expires_at > ?`,
      ));
    return stmt.get(threadTs, now) !== null;
  }

  cleanupExpiredThreads(): number {
    const now = Date.now();
    const stmt =
      this._deleteExpiredThreads ??
      (this._deleteExpiredThreads = this.db.prepare(
        `DELETE FROM slack_active_threads WHERE expires_at < ?`,
      ));
    return stmt.run(now).changes;
  }

  // -- Event dedup --

  markEventSeen(eventId: string, ttlMs: number): void {
    const now = Date.now();
    const stmt =
      this._upsertEvent ??
      (this._upsertEvent = this.db.prepare(
        `INSERT INTO slack_seen_events (event_id, seen_at, expires_at)
         VALUES (?, ?, ?)
         ON CONFLICT(event_id) DO NOTHING`,
      ));
    stmt.run(eventId, now, now + ttlMs);
  }

  hasEvent(eventId: string): boolean {
    const now = Date.now();
    const stmt =
      this._hasEvent ??
      (this._hasEvent = this.db.prepare(
        `SELECT 1 FROM slack_seen_events WHERE event_id = ? AND expires_at > ?`,
      ));
    return stmt.get(eventId, now) !== null;
  }

  cleanupExpiredEvents(): number {
    const now = Date.now();
    const stmt =
      this._deleteExpiredEvents ??
      (this._deleteExpiredEvents = this.db.prepare(
        `DELETE FROM slack_seen_events WHERE expires_at < ?`,
      ));
    return stmt.run(now).changes;
  }
}
