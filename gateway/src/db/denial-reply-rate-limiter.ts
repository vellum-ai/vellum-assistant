/**
 * SQLite-backed rate limiter for denial reply messages.
 *
 * Enforces two limits before allowing a denial reply to be sent:
 *   1. Per-source: max N replies to the same sender on a given channel
 *      within a rolling window (prevents a single spammer burning quota).
 *   2. Global: max N total denial replies across all channels/senders
 *      within a rolling window (caps total exposure).
 *
 * On allow, records the denial reply so subsequent checks account for it.
 * Periodically prunes expired rows to keep the table small.
 */

import { and, count, eq, gte, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getLogger } from "../logger.js";
import { getGatewayDb } from "./connection.js";
import { channelDenialReplyLog } from "./schema.js";

const log = getLogger("denial-reply-rate-limiter");

// ── Tunable constants ─────────────────────────────────────────────────

/** Rolling window for both per-source and global limits. */
const DENIAL_REPLY_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Max denial replies to a single (channel, sourceAddress) within the window. */
const DENIAL_REPLY_PER_SOURCE_LIMIT = 3;

/** Max denial replies globally (all channels/senders) within the window. */
const DENIAL_REPLY_GLOBAL_LIMIT = 50;

/** How often to prune expired rows (at most once per this interval). */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

let lastPruneAt = 0;

// ── Public API ────────────────────────────────────────────────────────

/**
 * Check whether a denial reply is allowed for the given channel and
 * source address. If allowed, records it in the log and returns true.
 * If either limit is exceeded, returns false without recording.
 */
export function recordDenialReplyIfAllowed(
  channel: string,
  sourceAddress: string,
): boolean {
  const db = getGatewayDb();
  const now = Date.now();
  const windowStart = now - DENIAL_REPLY_WINDOW_MS;

  maybePrune(now);

  // Per-source check
  const perSourceResult = db
    .select({ total: count() })
    .from(channelDenialReplyLog)
    .where(
      and(
        eq(channelDenialReplyLog.channel, channel),
        eq(channelDenialReplyLog.sourceAddress, sourceAddress),
        gte(channelDenialReplyLog.sentAt, windowStart),
      ),
    )
    .get();

  const perSourceCount = perSourceResult?.total ?? 0;
  if (perSourceCount >= DENIAL_REPLY_PER_SOURCE_LIMIT) {
    log.info(
      { channel, sourceAddress, count: perSourceCount },
      "Denial reply rate-limited (per-source)",
    );
    return false;
  }

  // Global check
  const globalResult = db
    .select({ total: count() })
    .from(channelDenialReplyLog)
    .where(gte(channelDenialReplyLog.sentAt, windowStart))
    .get();

  const globalCount = globalResult?.total ?? 0;
  if (globalCount >= DENIAL_REPLY_GLOBAL_LIMIT) {
    log.info(
      { channel, sourceAddress, globalCount },
      "Denial reply rate-limited (global)",
    );
    return false;
  }

  // Record
  db.insert(channelDenialReplyLog)
    .values({
      id: randomUUID(),
      channel,
      sourceAddress,
      sentAt: now,
    })
    .run();

  return true;
}

// ── Internal ──────────────────────────────────────────────────────────

function maybePrune(now: number): void {
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return;
  lastPruneAt = now;

  const windowStart = now - DENIAL_REPLY_WINDOW_MS;
  try {
    const result = getGatewayDb()
      .delete(channelDenialReplyLog)
      .where(sql`${channelDenialReplyLog.sentAt} < ${windowStart}`)
      .run();
    if (result.changes > 0) {
      log.info(
        { pruned: result.changes },
        "Pruned expired denial reply log entries",
      );
    }
  } catch (err) {
    log.warn({ err }, "Failed to prune denial reply log");
  }
}
