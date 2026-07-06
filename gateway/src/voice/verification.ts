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
 * Verification sessions and rate limits live in the gateway DB.
 */

import { hashVerificationSecret } from "@vellumai/gateway-client";

import type { VerificationSession } from "../db/session-store.js";
import {
  consumeSession,
  findLatestSessionByStatuses,
} from "../db/session-store.js";
import { getLogger } from "../logger.js";
import {
  getRateLimit,
  recordInvalidAttempt,
  resetRateLimit,
} from "../verification/rate-limit-helpers.js";

const log = getLogger("voice-verification");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VoiceVerificationResult {
  /** Whether a pending verification session exists for the phone channel. */
  hasPendingSession: boolean;
  /** The pending session details (only set when hasPendingSession is true). */
  session?: VerificationSession;
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
// Session lookup
// ---------------------------------------------------------------------------

/**
 * Check if there is a pending phone verification session in the gateway DB.
 *
 * Narrower status set than the shared INTERCEPTABLE_STATUSES: phone
 * sessions never use 'awaiting_response' (that status is created only by
 * outbound text verification), so it is deliberately excluded here.
 */
export async function findPendingPhoneSession(): Promise<VerificationSession | null> {
  return findLatestSessionByStatuses("phone", ["pending", "pending_bootstrap"]);
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
  session: VerificationSession,
  enteredCode: string,
  fromNumber: string,
  attempt: number,
): Promise<CodeValidationResult> {
  // Rate limit check
  const rateLimit = getRateLimit("phone", fromNumber, fromNumber);
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
  const enteredHash = hashVerificationSecret(enteredCode);
  if (enteredHash !== session.challengeHash) {
    await recordInvalidAttempt("phone", fromNumber, fromNumber);

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
      await recordInvalidAttempt("phone", fromNumber, fromNumber);
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

  // Success — consume via the store's status-guarded UPDATE. A non-consumed
  // return means a concurrent request already consumed it; preserve
  // one-time-code semantics by treating that as verification failure.
  const { consumed } = consumeSession(session.id, fromNumber, fromNumber);
  if (!consumed) {
    log.warn(
      { sessionId: session.id },
      "Session already consumed by concurrent request",
    );
    return {
      success: false,
      failureMessage: "Verification failed. Goodbye.",
      exhausted: true,
    };
  }
  await resetRateLimit("phone", fromNumber, fromNumber);

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
