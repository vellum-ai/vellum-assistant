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

import {
  assistantDbQuery,
  assistantDbRun,
} from "../db/assistant-db-proxy.js";
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
  attemptCount: number;
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
// Rate limiting (reads/writes assistant DB)
// ---------------------------------------------------------------------------

async function getRateLimit(
  fromNumber: string,
): Promise<RateLimitRecord | null> {
  const rows = await assistantDbQuery<{
    attemptCount: number;
    lockedUntil: number | null;
  }>(
    `SELECT attempt_count AS attemptCount, locked_until AS lockedUntil
     FROM channel_verification_rate_limits
     WHERE channel = 'phone'
       AND external_user_id = ?
       AND chat_id = ?
     LIMIT 1`,
    [fromNumber, fromNumber],
  );
  return rows[0] ?? null;
}

async function recordInvalidAttempt(fromNumber: string): Promise<void> {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;

  // Upsert rate limit record
  await assistantDbRun(
    `INSERT INTO channel_verification_rate_limits
       (channel, external_user_id, chat_id, attempt_count, first_attempt_at, last_attempt_at, locked_until)
     VALUES ('phone', ?, ?, 1, ?, ?, NULL)
     ON CONFLICT (channel, external_user_id, chat_id) DO UPDATE SET
       attempt_count = CASE
         WHEN first_attempt_at < ? THEN 1
         ELSE attempt_count + 1
       END,
       first_attempt_at = CASE
         WHEN first_attempt_at < ? THEN ?
         ELSE first_attempt_at
       END,
       last_attempt_at = ?,
       locked_until = CASE
         WHEN first_attempt_at >= ? AND attempt_count + 1 >= ? THEN ?
         ELSE locked_until
       END`,
    [
      fromNumber,
      fromNumber,
      now,
      now,
      windowStart,
      windowStart,
      now,
      now,
      windowStart,
      RATE_LIMIT_MAX_ATTEMPTS,
      now + RATE_LIMIT_LOCKOUT_MS,
    ],
  );
}

async function resetRateLimit(fromNumber: string): Promise<void> {
  await assistantDbRun(
    `DELETE FROM channel_verification_rate_limits
     WHERE channel = 'phone' AND external_user_id = ? AND chat_id = ?`,
    [fromNumber, fromNumber],
  );
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

    if (
      !identityMatch &&
      session.expectedPhoneE164 == null &&
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
