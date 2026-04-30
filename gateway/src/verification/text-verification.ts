/**
 * Gateway-owned text-channel verification.
 *
 * Intercepts inbound messages that contain a bare verification code
 * (6-digit numeric or 64-char hex) when there is a pending or active
 * verification session for the source channel. Validates the code,
 * creates the guardian binding, and returns a result that the gateway
 * injects into the forwarded payload so the assistant can handle
 * contact upsert and reply delivery without re-validating.
 *
 * Security model: the gateway owns code validation, session
 * consumption, rate limiting, and binding creation. The assistant
 * receives only the outcome ("verified" / "failed") and never
 * touches the binding or verification logic.
 */

import { createHash } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { createGuardianBinding } from "../auth/guardian-bootstrap.js";
import {
  assistantDbQuery,
  assistantDbRun,
} from "../db/assistant-db-proxy.js";
import { getGatewayDb } from "../db/connection.js";
import {
  channelGuardianRateLimits as gwRateLimits,
  contactChannels as gwContactChannels,
} from "../db/schema.js";
import { getLogger } from "../logger.js";

const log = getLogger("text-verification");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RATE_LIMIT_MAX_ATTEMPTS = 5;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_LOCKOUT_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface VerificationSession {
  id: string;
  challengeHash: string;
  expiresAt: number;
  status: string;
  verificationPurpose: string;
  expectedExternalUserId: string | null;
  expectedChatId: string | null;
  expectedPhoneE164: string | null;
  identityBindingStatus: string | null;
}

interface RateLimitRecord {
  attemptTimestampsJson: string;
  lockedUntil: number | null;
}

export interface TextVerificationResult {
  /** Outcome of the verification attempt. */
  outcome: "verified" | "failed";
  /** The verification type — only set on success. */
  verificationType?: "guardian" | "trusted_contact";
  /** Whether there was a binding conflict (different user already bound). */
  bindingConflict?: boolean;
  /** Failure reason text (generic, anti-oracle). */
  failureReason?: string;
}

// ---------------------------------------------------------------------------
// Code parsing
// ---------------------------------------------------------------------------

function stripMrkdwnFormatting(text: string): string {
  return text.replace(/^[*_~`]+/, "").replace(/[*_~`]+$/, "");
}

function parseVerificationCode(content: string): string | undefined {
  const stripped = stripMrkdwnFormatting(content.trim());
  const match = stripped.match(/^([0-9a-fA-F]{64}|\d{6})$/);
  return match?.[1];
}

// ---------------------------------------------------------------------------
// Crypto
// ---------------------------------------------------------------------------

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

// ---------------------------------------------------------------------------
// Session lookup (reads assistant DB via IPC proxy)
// ---------------------------------------------------------------------------

const SESSION_COLUMNS = `
  id, challenge_hash AS challengeHash, expires_at AS expiresAt,
  status, verification_purpose AS verificationPurpose,
  expected_external_user_id AS expectedExternalUserId,
  expected_chat_id AS expectedChatId,
  expected_phone_e164 AS expectedPhoneE164,
  identity_binding_status AS identityBindingStatus
`;

async function hasPendingOrActiveSession(
  channel: string,
): Promise<boolean> {
  const now = Date.now();
  const rows = await assistantDbQuery<{ id: string }>(
    `SELECT id FROM channel_verification_sessions
     WHERE channel = ?
       AND status IN ('pending', 'pending_bootstrap', 'active')
       AND expires_at > ?
     LIMIT 1`,
    [channel, now],
  );
  return rows.length > 0;
}

async function findSessionByHash(
  channel: string,
  challengeHash: string,
): Promise<VerificationSession | null> {
  const now = Date.now();
  const rows = await assistantDbQuery<VerificationSession>(
    `SELECT ${SESSION_COLUMNS}
     FROM channel_verification_sessions
     WHERE channel = ?
       AND challenge_hash = ?
       AND status IN ('pending', 'pending_bootstrap')
       AND expires_at > ?
     LIMIT 1`,
    [channel, challengeHash, now],
  );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Session consumption
// ---------------------------------------------------------------------------

async function consumeSession(
  sessionId: string,
  actorExternalUserId: string,
  actorChatId: string,
): Promise<void> {
  const now = Date.now();
  await assistantDbRun(
    `UPDATE channel_verification_sessions
     SET status = 'consumed',
         consumed_by_external_user_id = ?,
         consumed_by_chat_id = ?,
         updated_at = ?
     WHERE id = ?`,
    [actorExternalUserId, actorChatId, now, sessionId],
  );
}

// ---------------------------------------------------------------------------
// Rate limiting (gateway DB primary, assistant DB dual-write)
// ---------------------------------------------------------------------------

function parseTimestamps(json: string): number[] {
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function getRateLimit(
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

async function recordInvalidAttempt(
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

async function resetRateLimit(
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

// ---------------------------------------------------------------------------
// Identity matching (mirrors assistant's channel-verification-service.ts)
// ---------------------------------------------------------------------------

function checkIdentityMatch(
  session: VerificationSession,
  actorExternalUserId: string,
  actorChatId: string,
): boolean {
  const hasExpectedIdentity =
    session.expectedExternalUserId != null ||
    session.expectedChatId != null ||
    session.expectedPhoneE164 != null;

  if (!hasExpectedIdentity || session.identityBindingStatus !== "bound") {
    return true;
  }

  if (session.expectedPhoneE164 != null) {
    if (
      actorExternalUserId === session.expectedPhoneE164 ||
      actorExternalUserId === session.expectedExternalUserId
    ) {
      return true;
    }
  }

  if (session.expectedChatId != null) {
    if (session.expectedExternalUserId != null) {
      if (actorExternalUserId === session.expectedExternalUserId) {
        return true;
      }
    } else if (actorChatId === session.expectedChatId) {
      return true;
    }
  }

  if (
    session.expectedPhoneE164 == null &&
    session.expectedChatId == null &&
    session.expectedExternalUserId != null
  ) {
    if (actorExternalUserId === session.expectedExternalUserId) {
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Guardian binding helpers
// ---------------------------------------------------------------------------

async function resolveCanonicalPrincipal(
  fallback: string,
): Promise<string> {
  const rows = await assistantDbQuery<{ principalId: string | null }>(
    `SELECT c.principal_id AS principalId
     FROM contacts c
     JOIN contact_channels cc ON cc.contact_id = c.id
     WHERE c.role = 'guardian' AND cc.type = 'vellum' AND cc.status = 'active'
     LIMIT 1`,
    [],
  );
  return rows[0]?.principalId ?? fallback;
}

async function getExistingGuardianBinding(
  channel: string,
): Promise<{ externalUserId: string | null } | null> {
  const rows = await assistantDbQuery<{ externalUserId: string | null }>(
    `SELECT cc.external_user_id AS externalUserId
     FROM contacts c
     JOIN contact_channels cc ON cc.contact_id = c.id
     WHERE c.role = 'guardian' AND cc.type = ? AND cc.status = 'active'
     LIMIT 1`,
    [channel],
  );
  return rows[0] ?? null;
}

async function revokeExistingChannelGuardian(channel: string): Promise<void> {
  const now = Date.now();

  const revokedRows = await assistantDbQuery<{ id: string }>(
    `SELECT cc.id
     FROM contacts c
     JOIN contact_channels cc ON cc.contact_id = c.id
     WHERE c.role = 'guardian' AND cc.type = ? AND cc.status = 'active'`,
    [channel],
  );

  if (revokedRows.length === 0) return;

  const ids = revokedRows.map((r) => r.id);
  const placeholders = ids.map(() => "?").join(", ");

  await assistantDbRun(
    `UPDATE contact_channels
     SET status = 'revoked', policy = 'deny', updated_at = ?
     WHERE id IN (${placeholders})`,
    [now, ...ids],
  );

  try {
    const gwDb = getGatewayDb();
    for (const id of ids) {
      gwDb.update(gwContactChannels)
        .set({ status: "revoked", policy: "deny", updatedAt: now })
        .where(eq(gwContactChannels.id, id))
        .run();
    }
  } catch (gwErr) {
    log.warn({ err: gwErr }, "Gateway DB revoke dual-write failed (best-effort)");
  }
}

// ---------------------------------------------------------------------------
// Main intercept
// ---------------------------------------------------------------------------

const GENERIC_FAILURE = "The verification code is invalid or has expired.";

/**
 * Attempt to intercept an inbound message as a verification code.
 *
 * If the message is a bare code and a pending session exists, the gateway
 * validates the code, creates the binding, and returns the outcome.
 * The caller (handleInbound) injects the outcome into the forwarded payload
 * so the assistant can handle contact upsert and reply delivery without
 * re-validating.
 *
 * Returns null if the message is not a verification code or no session exists.
 */
export async function tryTextVerificationIntercept(params: {
  sourceChannel: string;
  messageContent: string;
  actorExternalId: string;
  conversationExternalId: string;
  actorDisplayName?: string;
  actorUsername?: string;
}): Promise<TextVerificationResult | null> {
  const {
    sourceChannel,
    messageContent,
    actorExternalId,
    conversationExternalId,
    actorDisplayName,
    actorUsername,
  } = params;

  const code = parseVerificationCode(messageContent);
  if (!code) return null;

  // Only intercept when there's actually a pending or active session
  const hasSession = await hasPendingOrActiveSession(sourceChannel);
  if (!hasSession) return null;

  log.info(
    { sourceChannel, actorExternalId },
    "Verification code detected — intercepting in gateway",
  );

  // ── Rate limit check ──
  const rateLimit = getRateLimit(sourceChannel, actorExternalId, conversationExternalId);
  if (rateLimit?.lockedUntil != null && Date.now() < rateLimit.lockedUntil) {
    return {
      outcome: "failed",
      failureReason: GENERIC_FAILURE,
    };
  }

  // ── Validate code ──
  const challengeHash = hashSecret(code);
  const session = await findSessionByHash(sourceChannel, challengeHash);

  if (!session) {
    await recordInvalidAttempt(sourceChannel, actorExternalId, conversationExternalId);
    return {
      outcome: "failed",
      failureReason: GENERIC_FAILURE,
    };
  }

  if (Date.now() > session.expiresAt) {
    await recordInvalidAttempt(sourceChannel, actorExternalId, conversationExternalId);
    return {
      outcome: "failed",
      failureReason: GENERIC_FAILURE,
    };
  }

  // ── Identity check ──
  if (!checkIdentityMatch(session, actorExternalId, conversationExternalId)) {
    await recordInvalidAttempt(sourceChannel, actorExternalId, conversationExternalId);
    return {
      outcome: "failed",
      failureReason: GENERIC_FAILURE,
    };
  }

  // ── Success — consume session and reset rate limits ──
  await consumeSession(session.id, actorExternalId, conversationExternalId);
  await resetRateLimit(sourceChannel, actorExternalId, conversationExternalId);

  const verificationType: "guardian" | "trusted_contact" =
    session.verificationPurpose === "trusted_contact"
      ? "trusted_contact"
      : "guardian";

  // ── Guardian binding ──
  let bindingConflict = false;
  if (verificationType === "guardian") {
    const existingBinding = await getExistingGuardianBinding(sourceChannel);
    if (existingBinding && existingBinding.externalUserId !== actorExternalId) {
      log.warn(
        { sourceChannel, existingGuardian: existingBinding.externalUserId },
        "Guardian binding conflict: another user already holds this channel binding",
      );
      bindingConflict = true;
    } else {
      await revokeExistingChannelGuardian(sourceChannel);

      const canonicalPrincipal = await resolveCanonicalPrincipal(actorExternalId);

      await createGuardianBinding({
        channel: sourceChannel,
        externalUserId: actorExternalId,
        deliveryChatId: conversationExternalId,
        guardianPrincipalId: canonicalPrincipal,
        displayName: actorDisplayName?.trim() || actorUsername?.trim(),
        verifiedVia: "challenge",
      });
    }
  }

  log.info(
    { sourceChannel, actorExternalId, verificationType },
    "Text channel verification succeeded",
  );

  return {
    outcome: "verified",
    verificationType,
    bindingConflict,
  };
}
