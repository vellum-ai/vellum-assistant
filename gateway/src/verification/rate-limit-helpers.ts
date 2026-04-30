/**
 * Rate limiting helpers for gateway-owned verification.
 *
 * Gateway DB is the primary store; assistant DB gets best-effort dual-writes.
 * Uses atomic upserts (ON CONFLICT) to handle concurrent webhook deliveries.
 */

import { and, eq } from "drizzle-orm";

import { assistantDbRun } from "../db/assistant-db-proxy.js";
import { getGatewayDb } from "../db/connection.js";
import { channelGuardianRateLimits as gwRateLimits } from "../db/schema.js";
import { getLogger } from "../logger.js";

const log = getLogger("verification-rate-limits");

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

export async function recordInvalidAttempt(
  channel: string,
  actorExternalUserId: string,
  actorChatId: string,
): Promise<void> {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;

  const existing = getRateLimit(channel, actorExternalUserId, actorChatId);
  const recentTimestamps = existing
    ? parseTimestamps(existing.attemptTimestampsJson).filter((ts) => ts > cutoff)
    : [];
  recentTimestamps.push(now);

  const timestampsJson = JSON.stringify(recentTimestamps);
  const newLockedUntil =
    recentTimestamps.length >= RATE_LIMIT_MAX_ATTEMPTS
      ? now + RATE_LIMIT_LOCKOUT_MS
      : existing?.lockedUntil ?? null;

  // Gateway DB — atomic upsert
  const gwDb = getGatewayDb();
  gwDb.insert(gwRateLimits)
    .values({
      id: crypto.randomUUID(),
      channel,
      actorExternalUserId,
      actorChatId,
      attemptTimestampsJson: timestampsJson,
      lockedUntil: newLockedUntil,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [gwRateLimits.channel, gwRateLimits.actorExternalUserId, gwRateLimits.actorChatId],
      set: {
        attemptTimestampsJson: timestampsJson,
        lockedUntil: newLockedUntil,
        updatedAt: now,
      },
    })
    .run();

  // Assistant DB dual-write
  try {
    await assistantDbRun(
      `INSERT INTO channel_guardian_rate_limits
         (id, channel, actor_external_user_id, actor_chat_id,
          attempt_timestamps_json, locked_until, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (channel, actor_external_user_id, actor_chat_id) DO UPDATE SET
         attempt_timestamps_json = excluded.attempt_timestamps_json,
         locked_until = excluded.locked_until,
         updated_at = excluded.updated_at`,
      [
        crypto.randomUUID(),
        channel,
        actorExternalUserId,
        actorChatId,
        timestampsJson,
        newLockedUntil,
        now,
        now,
      ],
    );
  } catch (err) {
    log.warn({ err }, "Assistant DB rate limit dual-write failed (best-effort)");
  }
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

  try {
    await assistantDbRun(
      `UPDATE channel_guardian_rate_limits
       SET attempt_timestamps_json = '[]', locked_until = NULL, updated_at = ?
       WHERE channel = ?
         AND actor_external_user_id = ?
         AND actor_chat_id = ?`,
      [now, channel, actorExternalUserId, actorChatId],
    );
  } catch (err) {
    log.warn({ err }, "Assistant DB rate limit reset dual-write failed (best-effort)");
  }
}
