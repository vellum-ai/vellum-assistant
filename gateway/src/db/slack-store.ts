import type { Database } from "bun:sqlite";
import { and, eq, gt, isNotNull, isNull, like } from "drizzle-orm";
import { type GatewayDb, getGatewayDb } from "./connection.js";
import {
  channelBotIdentity,
  contactChannels,
  slackActiveThreads,
  slackLastSeenTs,
  slackSeenEvents,
} from "./schema.js";

const LAST_SEEN_KEY = "global";
const SLACK_CHANNEL_TYPE = "slack";

/** Drizzle-inferred row type for the channel_bot_identity table. */
type ChannelBotIdentityRow = typeof channelBotIdentity.$inferSelect;

/**
 * Parsed bot identity with deserialized metadata. The raw DB row stores
 * metadata as a JSON text column; this type represents the parsed shape
 * returned by `getBotIdentity` and accepted by `setBotIdentity`.
 */
export type ChannelBotIdentity = Omit<
  ChannelBotIdentityRow,
  "channelType" | "updatedAt" | "metadata"
> & {
  metadata: Record<string, unknown> | null;
};

/**
 * Lifetime of an explicit-detach (mute) marker row. While the marker is
 * unexpired, the bot's own thread replies do not re-arm the thread (see
 * `isThreadDetached`); a human re-engagement clears it earlier via
 * `trackThread`. Matches the active-thread tracking TTL: once tracking
 * would have lapsed anyway, the marker has nothing left to protect, and
 * `cleanupExpiredThreads` reaps it like any other expired row.
 */
const DETACHED_THREAD_TTL_MS = 24 * 60 * 60 * 1_000;

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
   *
   * Clears any explicit-detach (mute) marker: every caller represents a
   * human re-engagement signal (an @-mention, or a reply already admitted
   * by the active-thread filter), which re-arms a muted thread. The bot's
   * own thread-reply echoes must check `isThreadDetached` before calling
   * this — they are not a re-engagement signal.
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
        detachedAt: null,
      })
      .onConflictDoUpdate({
        target: slackActiveThreads.threadTs,
        set: {
          channelId,
          trackedAt: now,
          expiresAt: now + ttlMs,
          detachedAt: null,
        },
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
          isNull(slackActiveThreads.detachedAt),
        ),
      )
      .get();
    return row !== undefined;
  }

  /**
   * True when the thread carries an unexpired explicit-detach (mute)
   * marker. Consulted by the bot-own-thread-reply tracking path so the
   * Socket Mode echo of a mute confirmation (or any other bot-authored
   * post) does not re-arm a thread a human just muted.
   */
  isThreadDetached(threadTs: string): boolean {
    const now = Date.now();
    const row = this.db
      .select({ threadTs: slackActiveThreads.threadTs })
      .from(slackActiveThreads)
      .where(
        and(
          eq(slackActiveThreads.threadTs, threadTs),
          isNotNull(slackActiveThreads.detachedAt),
          gt(slackActiveThreads.expiresAt, now),
        ),
      )
      .get();
    return row !== undefined;
  }

  /**
   * Explicitly detach (mute) a thread. The row is converted into a
   * detached marker rather than deleted — see `isThreadDetached` — and a
   * marker is written even when the thread was never tracked, so the
   * "already muted" confirmation echo cannot arm an untracked thread.
   * Returns true when the thread was actively tracked before this call.
   */
  detachThread(threadTs: string, channelId: string): boolean {
    const now = Date.now();
    const row = this.db
      .select({
        channelId: slackActiveThreads.channelId,
        expiresAt: slackActiveThreads.expiresAt,
        detachedAt: slackActiveThreads.detachedAt,
      })
      .from(slackActiveThreads)
      .where(eq(slackActiveThreads.threadTs, threadTs))
      .get();
    // A row tracked for a different channel is another channel's thread
    // (thread_ts collision) — leave it alone, matching the channel guard
    // of the previous DELETE-based implementation.
    if (row && row.channelId != null && row.channelId !== channelId) {
      return false;
    }
    const wasTracked =
      row !== undefined && row.expiresAt > now && row.detachedAt === null;
    this.db
      .insert(slackActiveThreads)
      .values({
        threadTs,
        channelId,
        trackedAt: now,
        expiresAt: now + DETACHED_THREAD_TTL_MS,
        detachedAt: now,
      })
      .onConflictDoUpdate({
        target: slackActiveThreads.threadTs,
        set: {
          channelId,
          expiresAt: now + DETACHED_THREAD_TTL_MS,
          detachedAt: now,
        },
      })
      .run();
    return wasTracked;
  }

  /**
   * Returns all unexpired active threads with a known channel for reconnect
   * catch-up. Rows with a NULL `channel_id` (legacy rows from before the
   * column was introduced) and explicit-detach markers are filtered out —
   * a muted thread must not be fanned out during catch-up.
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
          isNull(slackActiveThreads.detachedAt),
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

  // -- Bot identity --

  /**
   * Load the persisted bot identity for a channel type. Returns undefined
   * on first-ever start (before any successful identity resolution).
   */
  getBotIdentity(
    channelType: string = SLACK_CHANNEL_TYPE,
  ): ChannelBotIdentity | undefined {
    const row = this.db
      .select({
        userId: channelBotIdentity.userId,
        username: channelBotIdentity.username,
        metadata: channelBotIdentity.metadata,
      })
      .from(channelBotIdentity)
      .where(eq(channelBotIdentity.channelType, channelType))
      .get();
    if (!row) return undefined;
    return {
      userId: row.userId,
      username: row.username,
      metadata: row.metadata
        ? (JSON.parse(row.metadata) as Record<string, unknown>)
        : null,
    };
  }

  /**
   * Persist the bot identity after a successful resolution.
   * Upserts so the first write creates the row and subsequent writes
   * update it (e.g. after a bot token rotation).
   */
  setBotIdentity(
    identity: ChannelBotIdentity,
    channelType: string = SLACK_CHANNEL_TYPE,
  ): void {
    const now = Date.now();
    const metadataJson = identity.metadata
      ? JSON.stringify(identity.metadata)
      : null;
    this.db
      .insert(channelBotIdentity)
      .values({
        channelType,
        userId: identity.userId,
        username: identity.username,
        metadata: metadataJson,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: channelBotIdentity.channelType,
        set: {
          userId: identity.userId,
          username: identity.username,
          metadata: metadataJson,
          updatedAt: now,
        },
      })
      .run();
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
