import { and, eq, gt } from "drizzle-orm";
import { type GatewayDb, getGatewayDb } from "./connection.js";
import { slackActiveThreads, slackSeenEvents } from "./schema.js";

/**
 * Persistent store for Slack thread tracking and event deduplication.
 * Backed by SQLite so state survives gateway restarts.
 */
export class SlackStore {
  private db: GatewayDb;

  constructor(db?: GatewayDb) {
    this.db = db ?? getGatewayDb();
  }

  // -- Active threads --

  trackThread(threadTs: string, ttlMs: number): void {
    const now = Date.now();
    this.db
      .insert(slackActiveThreads)
      .values({ threadTs, trackedAt: now, expiresAt: now + ttlMs })
      .onConflictDoUpdate({
        target: slackActiveThreads.threadTs,
        set: { trackedAt: now, expiresAt: now + ttlMs },
      })
      .run();
  }

  hasThread(threadTs: string): boolean {
    const now = Date.now();
    const row = this.db
      .select({ threadTs: slackActiveThreads.threadTs })
      .from(slackActiveThreads)
      .where(
        and(
          eq(slackActiveThreads.threadTs, threadTs),
          gt(slackActiveThreads.expiresAt, now),
        ),
      )
      .get();
    return row !== undefined;
  }

  cleanupExpiredThreads(): number {
    const now = Date.now();
    const raw = (
      this.db as unknown as { $client: import("bun:sqlite").Database }
    ).$client;
    return raw
      .prepare("DELETE FROM slack_active_threads WHERE expires_at < ?")
      .run(now).changes;
  }

  // -- Event dedup --

  markEventSeen(eventId: string, ttlMs: number): void {
    const now = Date.now();
    this.db
      .insert(slackSeenEvents)
      .values({ eventId, seenAt: now, expiresAt: now + ttlMs })
      .onConflictDoNothing()
      .run();
  }

  hasEvent(eventId: string): boolean {
    const now = Date.now();
    const row = this.db
      .select({ eventId: slackSeenEvents.eventId })
      .from(slackSeenEvents)
      .where(
        and(
          eq(slackSeenEvents.eventId, eventId),
          gt(slackSeenEvents.expiresAt, now),
        ),
      )
      .get();
    return row !== undefined;
  }

  cleanupExpiredEvents(): number {
    const now = Date.now();
    const raw = (
      this.db as unknown as { $client: import("bun:sqlite").Database }
    ).$client;
    return raw
      .prepare("DELETE FROM slack_seen_events WHERE expires_at < ?")
      .run(now).changes;
  }
}
