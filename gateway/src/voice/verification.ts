/**
 * Gateway-owned voice verification.
 *
 * Handles the DTMF challenge-response flow for inbound phone calls
 * entirely within the gateway, BEFORE the ConversationRelay WebSocket
 * is established. The assistant never touches verification — it only
 * receives calls from verified callers.
 *
 * Flow:
 *   1. Twilio voice webhook → gateway detects pending verification session
 *   2. Gateway returns <Gather> TwiML prompting for the verification code
 *   3. Twilio collects DTMF → POSTs digits back to gateway action URL
 *   4. Gateway validates code, creates guardian binding, returns TwiML
 *      that forwards to the assistant for ConversationRelay setup
 *
 * Verification sessions are read from the assistant DB (via IPC proxy)
 * because the session creation still happens on the assistant side (the
 * guardian initiates verification through chat channels).
 */

import { createHash } from "node:crypto";

import { and, eq } from "drizzle-orm";

import {
  assistantDbQuery,
  assistantDbRun,
} from "../db/assistant-db-proxy.js";
import { getGatewayDb } from "../db/connection.js";
import { channelGuardianRateLimits as gwRateLimits } from "../db/schema.js";
import { getLogger } from "../logger.js";

const log = getLogger("voice-verification");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 3;
const RATE_LIMIT_MAX_ATTEMPTS = 5;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_LOCKOUT_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PendingSession {
  id: string;
  challengeHash: string;
  expiresAt: number;
  status: string;
  verificationPurpose: string;
  expectedExternalUserId: string | null;
  expectedChatId: string | null;
  expectedPhoneE164: string | null;
  identityBindingStatus: string | null;
  codeDigits: number;
  maxAttempts: number;
}

interface RateLimitRecord {
  attemptTimestampsJson: string;
  lockedUntil: number | null;
}

export interface VoiceVerificationResult {
  /** Whether a pending verification session exists for the phone channel. */
  hasPendingSession: boolean;
  /** The pending session details (only set when hasPendingSession is true). */
  session?: PendingSession;
}

export interface CodeValidationResult {
  success: boolean;
  verificationType?: "guardian" | "trusted_contact";
  /** Error message for TTS playback on failure. */
  failureMessage?: string;
  /** Whether the caller has exhausted all attempts. */
  exhausted?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

// ---------------------------------------------------------------------------
// Session lookup
// ---------------------------------------------------------------------------

/**
 * Check if there is a pending phone verification session.
 * Reads from the assistant's channel_verification_sessions table.
 */
export async function findPendingPhoneSession(): Promise<PendingSession | null> {
  const now = Date.now();
  const rows = await assistantDbQuery<PendingSession>(
    `SELECT id, challenge_hash AS challengeHash, expires_at AS expiresAt,
            status, verification_purpose AS verificationPurpose,
            expected_external_user_id AS expectedExternalUserId,
            expected_chat_id AS expectedChatId,
            expected_phone_e164 AS expectedPhoneE164,
            identity_binding_status AS identityBindingStatus,
            code_digits AS codeDigits, max_attempts AS maxAttempts
     FROM channel_verification_sessions
     WHERE channel = 'phone'
       AND status IN ('pending', 'pending_bootstrap')
       AND expires_at > ?
     ORDER BY created_at DESC
     LIMIT 1`,
    [now],
  );

  return rows[0] ?? null;
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
  fromNumber: string,
): RateLimitRecord | null {
  const gwDb = getGatewayDb();
  const row = gwDb
    .select()
    .from(gwRateLimits)
    .where(
      and(
        eq(gwRateLimits.channel, "phone"),
        eq(gwRateLimits.actorExternalUserId, fromNumber),
        eq(gwRateLimits.actorChatId, fromNumber),
      ),
    )
    .get();

  return row
    ? { attemptTimestampsJson: row.attemptTimestampsJson, lockedUntil: row.lockedUntil }
    : null;
}

async function recordInvalidAttempt(fromNumber: string): Promise<void> {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;

  const existing = getRateLimit(fromNumber);
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
      channel: "phone",
      actorExternalUserId: fromNumber,
      actorChatId: fromNumber,
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

  // Assistant DB dual-write — atomic upsert via ON CONFLICT
  try {
    await assistantDbRun(
      `INSERT INTO channel_guardian_rate_limits
         (id, channel, actor_external_user_id, actor_chat_id,
          attempt_timestamps_json, locked_until, created_at, updated_at)
       VALUES (?, 'phone', ?, ?, ?, ?, ?, ?)
       ON CONFLICT (channel, actor_external_user_id, actor_chat_id) DO UPDATE SET
         attempt_timestamps_json = excluded.attempt_timestamps_json,
         locked_until = excluded.locked_until,
         updated_at = excluded.updated_at`,
      [
        crypto.randomUUID(),
        fromNumber,
        fromNumber,
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

async function resetRateLimit(fromNumber: string): Promise<void> {
  const now = Date.now();

  // Gateway DB
  const gwDb = getGatewayDb();
  gwDb.update(gwRateLimits)
    .set({
      attemptTimestampsJson: "[]",
      lockedUntil: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(gwRateLimits.channel, "phone"),
        eq(gwRateLimits.actorExternalUserId, fromNumber),
        eq(gwRateLimits.actorChatId, fromNumber),
      ),
    )
    .run();

  // Assistant DB dual-write
  try {
    await assistantDbRun(
      `UPDATE channel_guardian_rate_limits
       SET attempt_timestamps_json = '[]', locked_until = NULL, updated_at = ?
       WHERE channel = 'phone'
         AND actor_external_user_id = ?
         AND actor_chat_id = ?`,
      [now, fromNumber, fromNumber],
    );
  } catch (err) {
    log.warn({ err }, "Assistant DB rate limit reset dual-write failed (best-effort)");
  }
}

// ---------------------------------------------------------------------------
// Session consumption
// ---------------------------------------------------------------------------

async function consumeSession(
  sessionId: string,
  fromNumber: string,
): Promise<void> {
  const now = Date.now();
  await assistantDbRun(
    `UPDATE channel_verification_sessions
     SET status = 'consumed',
         consumed_by_external_user_id = ?,
         consumed_by_chat_id = ?,
         updated_at = ?
     WHERE id = ?`,
    [fromNumber, fromNumber, now, sessionId],
  );
}

// ---------------------------------------------------------------------------
// Code validation
// ---------------------------------------------------------------------------

/**
 * Validate a DTMF-entered verification code against the pending session.
 *
 * On success: consumes the session so it cannot be reused, resets rate
 * limits, and returns the verification type (guardian vs trusted_contact).
 *
 * On failure: records an invalid attempt for rate limiting and returns
 * a failure message suitable for TTS playback.
 */
export async function validateVerificationCode(
  session: PendingSession,
  enteredCode: string,
  fromNumber: string,
  attempt: number,
): Promise<CodeValidationResult> {
  // Rate limit check
  const rateLimit = await getRateLimit(fromNumber);
  if (rateLimit?.lockedUntil && Date.now() < rateLimit.lockedUntil) {
    return {
      success: false,
      failureMessage:
        "Too many invalid attempts. Please try again later. Goodbye.",
      exhausted: true,
    };
  }

  // Expiry check
  if (Date.now() > session.expiresAt) {
    return {
      success: false,
      failureMessage:
        "The verification code has expired. Please request a new code. Goodbye.",
      exhausted: true,
    };
  }

  // Hash the entered code and compare
  const enteredHash = hashSecret(enteredCode);
  if (enteredHash !== session.challengeHash) {
    await recordInvalidAttempt(fromNumber);

    if (attempt + 1 >= MAX_ATTEMPTS) {
      return {
        success: false,
        failureMessage: "Verification failed. Goodbye.",
        exhausted: true,
      };
    }

    const remaining = MAX_ATTEMPTS - attempt - 1;
    return {
      success: false,
      failureMessage: `Incorrect code. You have ${remaining} ${remaining === 1 ? "attempt" : "attempts"} remaining. Please try again.`,
      exhausted: false,
    };
  }

  // Identity check for bound outbound sessions
  const hasExpectedIdentity =
    session.expectedExternalUserId != null ||
    session.expectedChatId != null ||
    session.expectedPhoneE164 != null;

  if (hasExpectedIdentity && session.identityBindingStatus === "bound") {
    let identityMatch = false;

    if (session.expectedPhoneE164 != null) {
      if (
        fromNumber === session.expectedPhoneE164 ||
        fromNumber === session.expectedExternalUserId
      ) {
        identityMatch = true;
      }
    }

    if (!identityMatch && session.expectedChatId != null) {
      if (session.expectedExternalUserId != null) {
        if (fromNumber === session.expectedExternalUserId) {
          identityMatch = true;
        }
      } else if (fromNumber === session.expectedChatId) {
        identityMatch = true;
      }
    }

    if (
      !identityMatch &&
      session.expectedPhoneE164 == null &&
      session.expectedChatId == null &&
      session.expectedExternalUserId != null
    ) {
      if (fromNumber === session.expectedExternalUserId) {
        identityMatch = true;
      }
    }

    if (!identityMatch) {
      await recordInvalidAttempt(fromNumber);
      if (attempt + 1 >= MAX_ATTEMPTS) {
        return {
          success: false,
          failureMessage: "Verification failed. Goodbye.",
          exhausted: true,
        };
      }
      const remaining = MAX_ATTEMPTS - attempt - 1;
      return {
        success: false,
        failureMessage: `Incorrect code. You have ${remaining} ${remaining === 1 ? "attempt" : "attempts"} remaining. Please try again.`,
        exhausted: false,
      };
    }
  }

  // Success — consume session and reset rate limits
  await consumeSession(session.id, fromNumber);
  await resetRateLimit(fromNumber);

  const verificationType: "guardian" | "trusted_contact" =
    session.verificationPurpose === "trusted_contact"
      ? "trusted_contact"
      : "guardian";

  log.info(
    { sessionId: session.id, fromNumber, verificationType },
    "Voice verification succeeded at gateway",
  );

  return { success: true, verificationType };
}

// ---------------------------------------------------------------------------
// TwiML generation
// ---------------------------------------------------------------------------

/**
 * Generate <Gather> TwiML that prompts the caller for their verification code.
 *
 * The `action` URL points back to the gateway's verification callback
 * endpoint, which will validate the code and either re-prompt or proceed.
 */
export function gatherVerificationTwiml(
  actionUrl: string,
  attempt: number,
  codeDigits: number,
): string {
  const prompt =
    attempt === 0
      ? "Welcome. Please enter your verification code using your keypad."
      : "Please try again. Enter your verification code using your keypad.";

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="${codeDigits}" action="${escapeXml(actionUrl)}" method="POST" timeout="30" finishOnKey="">
    <Say>${escapeXml(prompt)}</Say>
  </Gather>
  <Say>We did not receive any input. Goodbye.</Say>
</Response>`;
}

/**
 * Generate TwiML that speaks a failure message and hangs up.
 */
export function failureTwiml(message: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>${escapeXml(message)}</Say>
</Response>`;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
