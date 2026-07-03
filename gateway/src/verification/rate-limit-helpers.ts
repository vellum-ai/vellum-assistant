/**
 * Rate limiting helpers for gateway-owned verification.
 *
 * Gateway DB only. Uses atomic upserts (ON CONFLICT) to handle concurrent
 * webhook deliveries.
 */

import { and, eq, sql } from "drizzle-orm";

import { getGatewayDb } from "../db/connection.js";
import { channelGuardianRateLimits as gwRateLimits } from "../db/schema.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RATE_LIMIT_MAX_ATTEMPTS = 5;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_LOCKOUT_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RateLimitRecord {
  attemptTimestampsJson: string;
  lockedUntil: number | null;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export function getRateLimit(
  channel: string,
  actorExternalUserId: string,
  actorChatId: string,
): RateLimitRecord | null {
  const gwDb = getGatewayDb();
  const row = gwDb
    .select()
    .from(gwRateLimits)
    .where(
      and(
        eq(gwRateLimits.channel, channel),
        eq(gwRateLimits.actorExternalUserId, actorExternalUserId),
        eq(gwRateLimits.actorChatId, actorChatId),
      ),
    )
    .get();

  return row
    ? { attemptTimestampsJson: row.attemptTimestampsJson, lockedUntil: row.lockedUntil }
    : null;
}

/**
 * Returns true if the actor is currently locked out.
 */
export function isRateLimited(
  channel: string,
  actorExternalUserId: string,
  actorChatId: string,
): boolean {
  const record = getRateLimit(channel, actorExternalUserId, actorChatId);
  return record?.lockedUntil != null && Date.now() < record.lockedUntil;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Record an invalid verification attempt. Uses a single atomic SQL UPDATE
 * with json_array + json_each to prune old timestamps and append the new
 * one in one statement, avoiding the read-modify-write race where
 * concurrent calls could overwrite each other's timestamps.
 *
 * For new records (no existing row), falls back to INSERT with a single
 * timestamp.
 */
export async function recordInvalidAttempt(
  channel: string,
  actorExternalUserId: string,
  actorChatId: string,
): Promise<void> {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;

  // Gateway DB — atomic upsert with in-SQL JSON manipulation.
  // The ON CONFLICT UPDATE prunes expired timestamps and appends the new
  // one in a single statement, so concurrent upserts serialize at the
  // row level (SQLite's write lock) without stale reads.
  const gwDb = getGatewayDb();
  const newId = crypto.randomUUID();
  const singleTimestampJson = JSON.stringify([now]);

  gwDb.run(sql`
    INSERT INTO ${gwRateLimits} (
      id, channel, actor_external_user_id, actor_chat_id,
      attempt_timestamps_json, locked_until, created_at, updated_at
    ) VALUES (
      ${newId}, ${channel}, ${actorExternalUserId}, ${actorChatId},
      ${singleTimestampJson}, NULL, ${now}, ${now}
    )
    ON CONFLICT (channel, actor_external_user_id, actor_chat_id) DO UPDATE SET
      attempt_timestamps_json = (
        SELECT json_group_array(value) FROM (
          SELECT value FROM json_each(${gwRateLimits.attemptTimestampsJson})
          WHERE CAST(value AS INTEGER) > ${cutoff}
          UNION ALL
          SELECT ${now}
        )
      ),
      locked_until = CASE
        WHEN (
          SELECT COUNT(*) FROM (
            SELECT value FROM json_each(${gwRateLimits.attemptTimestampsJson})
            WHERE CAST(value AS INTEGER) > ${cutoff}
            UNION ALL
            SELECT ${now}
          )
        ) >= ${RATE_LIMIT_MAX_ATTEMPTS}
        THEN ${now + RATE_LIMIT_LOCKOUT_MS}
        ELSE ${gwRateLimits.lockedUntil}
      END,
      updated_at = ${now}
  `);
}

export async function resetRateLimit(
  channel: string,
  actorExternalUserId: string,
  actorChatId: string,
): Promise<void> {
  const now = Date.now();

  const gwDb = getGatewayDb();
  gwDb.update(gwRateLimits)
    .set({
      attemptTimestampsJson: "[]",
      lockedUntil: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(gwRateLimits.channel, channel),
        eq(gwRateLimits.actorExternalUserId, actorExternalUserId),
        eq(gwRateLimits.actorChatId, actorChatId),
      ),
    )
    .run();
}
