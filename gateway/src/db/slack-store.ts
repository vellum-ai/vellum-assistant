import type { Database } from "bun:sqlite";
import { and, eq, gt, isNotNull, like } from "drizzle-orm";
import { type GatewayDb, getGatewayDb } from "./connection.js";
import {
  contactChannels,
  slackActiveThreads,
  slackLastSeenTs,
  slackSeenEvents,
} from "./schema.js";

const LAST_SEEN_KEY = "global";

/** Active thread row exposed for catch-up enumeration on reconnect. */
export type ActiveThreadRow = {
  threadTs: string;
  channelId: string;
};

/**
 * Persistent store for Slack thread tracking, event deduplication, and
 * Socket Mode reconnect-catch-up watermarks. Backed by SQLite so state
 * survives gateway restarts.
 */
export class SlackStore {
  private db: GatewayDb;

  constructor(db?: GatewayDb) {
    this.db = db ?? getGatewayDb();
  }

  // -- Active threads --

  /**
   * Track a thread the bot is participating in so unmentioned replies are
   * forwarded. `channelId` is required so reconnect catch-up can scope
   * `conversations.replies` calls to the thread's channel.
   */
  trackThread(threadTs: string, channelId: string, ttlMs: number): void {
    const now = Date.now();
    this.db
      .insert(slackActiveThreads)
      .values({
        threadTs,
        channelId,
        trackedAt: now,
        expiresAt: now + ttlMs,
      })
      .onConflictDoUpdate({
        target: slackActiveThreads.threadTs,
        set: { channelId, trackedAt: now, expiresAt: now + ttlMs },
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

  /**
   * Returns all unexpired active threads with a known channel for reconnect
   * catch-up. Rows with a NULL `channel_id` (legacy rows from before the
   * column was introduced) are filtered out.
   */
  listActiveThreadsWithChannel(): ActiveThreadRow[] {
    const now = Date.now();
    const rows = this.db
      .select({
        threadTs: slackActiveThreads.threadTs,
        channelId: slackActiveThreads.channelId,
      })
      .from(slackActiveThreads)
      .where(
        and(
          gt(slackActiveThreads.expiresAt, now),
          isNotNull(slackActiveThreads.channelId),
        ),
      )
      .all();
    return rows
      .filter(
        (row): row is { threadTs: string; channelId: string } =>
          typeof row.channelId === "string" && row.channelId.length > 0,
      )
      .map((row) => ({ threadTs: row.threadTs, channelId: row.channelId }));
  }

  /**
   * Returns distinct Slack DM channel IDs known to the gateway. Used by
   * reconnect catch-up to recover missed direct messages — DMs always route
   * to the default assistant, so any DM channel the gateway has previously
   * received from is a valid catch-up target.
   */
  listKnownSlackDmChannels(): string[] {
    const rows = this.db
      .select({ externalChatId: contactChannels.externalChatId })
      .from(contactChannels)
      .where(
        and(
          eq(contactChannels.type, "slack"),
          isNotNull(contactChannels.externalChatId),
          like(contactChannels.externalChatId, "D%"),
        ),
      )
      .all();
    const seen = new Set<string>();
    for (const row of rows) {
      if (row.externalChatId) seen.add(row.externalChatId);
    }
    return Array.from(seen);
  }

  cleanupExpiredThreads(): number {
    const now = Date.now();
    const raw = (this.db as unknown as { $client: Database }).$client;
    return raw
      .prepare("DELETE FROM slack_active_threads WHERE expires_at < ?")
      .run(now).changes;
  }

  // -- Event dedup --

  /**
   * Mark a generic dedup key as seen. Callers pass either a Slack `event_id`
   * (live path) or a synthetic `msg:${channel}:${ts}` key (replay path);
   * both flow into the same dedup table so the two paths dedup symmetrically.
   */
  markEventSeen(key: string, ttlMs: number): void {
    const now = Date.now();
    this.db
      .insert(slackSeenEvents)
      .values({ eventId: key, seenAt: now, expiresAt: now + ttlMs })
      .onConflictDoNothing()
      .run();
  }

  hasEvent(key: string): boolean {
    const now = Date.now();
    const row = this.db
      .select({ eventId: slackSeenEvents.eventId })
      .from(slackSeenEvents)
      .where(
        and(
          eq(slackSeenEvents.eventId, key),
          gt(slackSeenEvents.expiresAt, now),
        ),
      )
      .get();
    return row !== undefined;
  }

  cleanupExpiredEvents(): number {
    const now = Date.now();
    const raw = (this.db as unknown as { $client: Database }).$client;
    return raw
      .prepare("DELETE FROM slack_seen_events WHERE expires_at < ?")
      .run(now).changes;
  }

  // -- Catch-up watermark --

  /**
   * Latest accepted Slack event timestamp (`<seconds>.<microseconds>`),
   * persisted across reconnects so catch-up knows where to resume from.
   * Returns undefined on first ever start — callers should bootstrap to
   * "now" and skip catch-up.
   */
  getLastSeenTs(): string | undefined {
    const row = this.db
      .select({ ts: slackLastSeenTs.ts })
      .from(slackLastSeenTs)
      .where(eq(slackLastSeenTs.key, LAST_SEEN_KEY))
      .get();
    return row?.ts;
  }

  /**
   * Advances the watermark to `ts` only if it is greater than the persisted
   * value, so out-of-order live + replay events cannot push it backwards.
   * Comparison is numeric (Slack ts is a `<secs>.<micros>` string but lex
   * order matches numeric order until the seconds component grows in width
   * — well past 2286 — so string comparison is safe in practice).
   */
  setLastSeenTsIfGreater(ts: string): void {
    if (!ts) return;
    const now = Date.now();
    const current = this.getLastSeenTs();
    if (current && compareSlackTs(ts, current) <= 0) return;
    this.db
      .insert(slackLastSeenTs)
      .values({ key: LAST_SEEN_KEY, ts, updatedAt: now })
      .onConflictDoUpdate({
        target: slackLastSeenTs.key,
        set: { ts, updatedAt: now },
      })
      .run();
  }
}

/**
 * Numeric comparator for Slack timestamps. Returns negative/zero/positive
 * mirroring `Number(a) - Number(b)`. Falls back to string comparison if
 * either value fails to parse.
 */
export function compareSlackTs(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}
