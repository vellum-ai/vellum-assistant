/**
 * Guardian verification rate limiting.
 *
 * Tracks invalid verification attempts per actor using a sliding window
 * and applies lockouts when the threshold is exceeded.
 */

import { and, eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { getDb } from "./db.js";
import { channelGuardianRateLimits } from "./schema.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VerificationRateLimit {
  id: string;
  channel: string;
  actorExternalUserId: string;
  actorChatId: string;
  /** Individual attempt timestamps (epoch-ms) within the sliding window. */
  attemptTimestamps: number[];
  /** Total stored attempt count (may include expired timestamps; use lockedUntil for enforcement decisions). */
  invalidAttempts: number;
  lockedUntil: number | null;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseTimestamps(json: string): number[] {
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function rowToRateLimit(
  row: typeof channelGuardianRateLimits.$inferSelect,
): VerificationRateLimit {
  const timestamps = parseTimestamps(row.attemptTimestampsJson);
  return {
    id: row.id,
    channel: row.channel,
    actorExternalUserId: row.actorExternalUserId,
    actorChatId: row.actorChatId,
    attemptTimestamps: timestamps,
    invalidAttempts: timestamps.length,
    lockedUntil: row.lockedUntil,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * Get the rate-limit record for a given actor on a specific channel.
 */
export function getRateLimit(
  channel: string,
  actorExternalUserId: string,
  actorChatId: string,
): VerificationRateLimit | null {
  const db = getDb();
  const row = db
    .select()
    .from(channelGuardianRateLimits)
    .where(
      and(
        eq(channelGuardianRateLimits.channel, channel),
        eq(channelGuardianRateLimits.actorExternalUserId, actorExternalUserId),
        eq(channelGuardianRateLimits.actorChatId, actorChatId),
      ),
    )
    .get();

  return row ? rowToRateLimit(row) : null;
}

/**
 * Record an invalid verification attempt using a true sliding window.
 *
 * Each individual attempt timestamp is stored; on every new attempt we
 * discard timestamps older than `windowMs`, append the current one, and
 * check whether the count exceeds `maxAttempts`. This avoids the
 * inactivity-timeout pitfall where attempts spaced just under the window
 * accumulate indefinitely.
 */
export function recordInvalidAttempt(
  channel: string,
  actorExternalUserId: string,
  actorChatId: string,
  windowMs: number,
  maxAttempts: number,
  lockoutMs: number,
): VerificationRateLimit {
  const db = getDb();
  const now = Date.now();
  const cutoff = now - windowMs;

  const existing = getRateLimit(channel, actorExternalUserId, actorChatId);

  if (existing) {
    // Keep only timestamps within the sliding window, then add the new one
    const recentTimestamps = existing.attemptTimestamps.filter(
      (ts) => ts > cutoff,
    );
    recentTimestamps.push(now);

    const newLockedUntil =
      recentTimestamps.length >= maxAttempts
        ? now + lockoutMs
        : existing.lockedUntil;

    const timestampsJson = JSON.stringify(recentTimestamps);

    db.update(channelGuardianRateLimits)
      .set({
        attemptTimestampsJson: timestampsJson,
        lockedUntil: newLockedUntil,
        updatedAt: now,
      })
      .where(eq(channelGuardianRateLimits.id, existing.id))
      .run();

    return {
      ...existing,
      attemptTimestamps: recentTimestamps,
      invalidAttempts: recentTimestamps.length,
      lockedUntil: newLockedUntil,
      updatedAt: now,
    };
  }

  // First attempt — create the row
  const id = uuid();
  const timestamps = [now];
  const lockedUntil = 1 >= maxAttempts ? now + lockoutMs : null;
  const row = {
    id,
    channel,
    actorExternalUserId,
    actorChatId,
    // Legacy columns kept for backward compatibility with upgraded databases
    invalidAttempts: 0,
    windowStartedAt: 0,
    attemptTimestampsJson: JSON.stringify(timestamps),
    lockedUntil,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(channelGuardianRateLimits).values(row).run();

  return rowToRateLimit(row);
}

/**
 * Reset the rate-limit counter for a given actor (e.g. after a
 * successful verification).
 */
export function resetRateLimit(
  channel: string,
  actorExternalUserId: string,
  actorChatId: string,
): void {
  const db = getDb();
  const now = Date.now();

  db.update(channelGuardianRateLimits)
    .set({
      attemptTimestampsJson: "[]",
      lockedUntil: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(channelGuardianRateLimits.channel, channel),
        eq(channelGuardianRateLimits.actorExternalUserId, actorExternalUserId),
        eq(channelGuardianRateLimits.actorChatId, actorChatId),
      ),
    )
    .run();
}
