/**
 * Channel verification service.
 *
 * Encapsulates the business logic for the verification session lifecycle:
 * creating sessions with cryptographic secrets, validating and consuming
 * them, and managing guardian bindings.
 */

import { createHash, randomBytes } from "crypto";
import { v4 as uuid } from "uuid";

import { findGuardianForChannel } from "../contacts/contact-store.js";
import { revokeGuardianBinding } from "../contacts/contacts-write.js";
import type {
  GuardianBinding,
  IdentityBindingStatus,
  SessionStatus,
  VerificationPurpose,
  VerificationSession,
} from "../memory/channel-verification-sessions.js";
import {
  bindSessionIdentity as storeBindSessionIdentity,
  consumeSession,
  countRecentSendsToDestination as storeCountRecentSendsToDestination,
  createInboundSession,
  createVerificationSession,
  findActiveSession as storeFindActiveSession,
  findPendingSessionByHash,
  findPendingSessionForChannel,
  findSessionByBootstrapTokenHash as storeFindSessionByBootstrapTokenHash,
  findSessionByIdentity as storeFindSessionByIdentity,
  revokePendingSessions as storeRevokePendingSessions,
  updateSessionDelivery as storeUpdateSessionDelivery,
  updateSessionStatus as storeUpdateSessionStatus,
} from "../memory/channel-verification-sessions.js";
import {
  getRateLimit,
  recordInvalidAttempt,
  resetRateLimit,
} from "../memory/guardian-rate-limits.js";
import { composeApprovalMessage } from "./approval-message-composer.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Challenge TTL in milliseconds (10 minutes). */
const CHALLENGE_TTL_MS = 10 * 60 * 1000;

/** Maximum invalid verification attempts within the throttling window before lockout. */
const RATE_LIMIT_MAX_ATTEMPTS = 5;

/** Throttling window in milliseconds (15 minutes). */
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

/** Lockout duration in milliseconds (30 minutes). */
const RATE_LIMIT_LOCKOUT_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateVerificationSessionResult {
  challengeId: string;
  secret: string;
  verifyCommand: string;
  ttlSeconds: number;
  instruction: string;
}

export type ValidateVerificationResult =
  | { success: true; verificationType: "guardian" | "trusted_contact" }
  | { success: false; reason: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Generate a 6-digit numeric secret for verification challenges.
 * Uses cryptographic randomness to pick a number with the specified
 * number of digits (defaults to 6). The result is always zero-padded
 * to exactly `digits` characters.
 */
function generateNumericSecret(digits: number = 6): string {
  const buf = randomBytes(4);
  const num = buf.readUInt32BE(0);
  const max = 10 ** digits;
  return String(num % max).padStart(digits, "0");
}

/**
 * Create a new inbound verification session for a guardian candidate.
 *
 * Inbound sessions are not identity-bound (`identityBindingStatus: null`),
 * so `validateAndConsumeVerification` skips the identity check and code
 * secrecy is the only protection against brute-force guessing during the
 * TTL window. A 32-byte hex secret provides ~2^128 entropy, making
 * enumeration infeasible. Identity-bound outbound sessions (created via
 * `createOutboundSession`) use shorter 6-digit numeric codes because the
 * identity check adds a second layer of protection.
 *
 * Hashes the secret (SHA-256) and stores the session record with a
 * 10-minute TTL. The raw secret is returned so it can be displayed to
 * the user; only the hash is persisted.
 */
export function createInboundVerificationSession(
  channel: string,
  conversationId?: string,
): CreateVerificationSessionResult {
  // High-entropy hex for unbound inbound challenges — 6-digit numeric
  // codes are only safe when identity binding provides a second factor.
  const secret = randomBytes(32).toString("hex");
  const challengeHash = hashSecret(secret);
  const challengeId = uuid();
  const expiresAt = Date.now() + CHALLENGE_TTL_MS;

  createInboundSession({
    id: challengeId,
    channel,
    challengeHash,
    expiresAt,
    sourceConversationId: conversationId,
  });

  const ttlSeconds = CHALLENGE_TTL_MS / 1000;

  return {
    challengeId,
    secret,
    verifyCommand: secret,
    ttlSeconds,
    instruction: composeApprovalMessage({
      scenario: "guardian_verify_challenge_setup",
      channel,
      verifyCommand: secret,
    }),
  };
}

/**
 * Validate and consume a verification challenge.
 *
 * This function is a pure challenge validator: it checks rate limits,
 * validates the secret against pending challenges, verifies identity
 * binding, and consumes the challenge. It returns the verification type
 * (guardian or trusted_contact) but does NOT create bindings or apply
 * role-specific side effects — those are handled by callers:
 * verification-intercept.ts (channel verification) and
 * relay-server.ts (voice verification).
 *
 * On failure the invalid-attempt counter is incremented; after
 * exceeding the threshold the actor is locked out for a cooldown
 * period. On success the counter resets.
 */
export function validateAndConsumeVerification(
  channel: string,
  secret: string,
  actorExternalUserId: string,
  actorChatId: string,
  _actorUsername?: string,
  _actorDisplayName?: string,
): ValidateVerificationResult {
  // ── Rate-limit check ──
  const existing = getRateLimit(channel, actorExternalUserId, actorChatId);
  if (
    existing &&
    existing.lockedUntil != null &&
    Date.now() < existing.lockedUntil
  ) {
    // Use the same generic failure message to avoid leaking whether the
    // actor is rate-limited vs. the code is genuinely wrong.
    return {
      success: false,
      reason: composeApprovalMessage({
        scenario: "guardian_verify_failed",
        failureReason: "The verification code is invalid or has expired.",
      }),
    };
  }

  const challengeHash = hashSecret(secret);

  const challenge = findPendingSessionByHash(channel, challengeHash);
  if (!challenge) {
    recordInvalidAttempt(
      channel,
      actorExternalUserId,
      actorChatId,
      RATE_LIMIT_WINDOW_MS,
      RATE_LIMIT_MAX_ATTEMPTS,
      RATE_LIMIT_LOCKOUT_MS,
    );
    return {
      success: false,
      reason: composeApprovalMessage({
        scenario: "guardian_verify_failed",
        failureReason: "The verification code is invalid or has expired.",
      }),
    };
  }

  if (Date.now() > challenge.expiresAt) {
    recordInvalidAttempt(
      channel,
      actorExternalUserId,
      actorChatId,
      RATE_LIMIT_WINDOW_MS,
      RATE_LIMIT_MAX_ATTEMPTS,
      RATE_LIMIT_LOCKOUT_MS,
    );
    return {
      success: false,
      reason: composeApprovalMessage({
        scenario: "guardian_verify_failed",
        failureReason: "The verification code is invalid or has expired.",
      }),
    };
  }

  // ── Expected-identity check (outbound sessions) ──
  // If the session is in 'bound' state AND has at least one expected-identity
  // field, verify the actor matches. Inbound-only sessions have no expected
  // identity and rely on code secrecy alone. If identity_binding_status is
  // 'pending_bootstrap', allow consumption (bootstrap path handles binding
  // separately).
  const hasExpectedIdentity =
    challenge.expectedExternalUserId != null ||
    challenge.expectedChatId != null ||
    challenge.expectedPhoneE164 != null;

  if (hasExpectedIdentity && challenge.identityBindingStatus === "bound") {
    let identityMatch = false;

    // For voice: verify actorExternalUserId matches expectedPhoneE164
    // OR actorExternalUserId matches expectedExternalUserId
    if (challenge.expectedPhoneE164 != null) {
      if (
        actorExternalUserId === challenge.expectedPhoneE164 ||
        actorExternalUserId === challenge.expectedExternalUserId
      ) {
        identityMatch = true;
      }
    }

    // For chat-based channels (Telegram, Slack, etc.): when both
    // expectedExternalUserId and expectedChatId are set, require the
    // externalUserId match — chatId alone is insufficient because chat IDs
    // can be shared (e.g. Slack channel IDs, Telegram group chat IDs) and
    // would let any participant in the same chat satisfy identity binding.
    // Fall back to chatId-only match only when expectedExternalUserId is
    // not available (legacy sessions or channels without user-level identity).
    if (challenge.expectedChatId != null) {
      if (challenge.expectedExternalUserId != null) {
        if (actorExternalUserId === challenge.expectedExternalUserId) {
          identityMatch = true;
        }
      } else if (actorChatId === challenge.expectedChatId) {
        identityMatch = true;
      }
    }

    // Fallback: if only expectedExternalUserId is set (no phone/chat)
    if (
      challenge.expectedPhoneE164 == null &&
      challenge.expectedChatId == null &&
      challenge.expectedExternalUserId != null
    ) {
      if (actorExternalUserId === challenge.expectedExternalUserId) {
        identityMatch = true;
      }
    }

    if (!identityMatch) {
      // Anti-oracle: use the same generic error message to avoid leaking
      // whether the identity is wrong vs. the code is wrong.
      recordInvalidAttempt(
        channel,
        actorExternalUserId,
        actorChatId,
        RATE_LIMIT_WINDOW_MS,
        RATE_LIMIT_MAX_ATTEMPTS,
        RATE_LIMIT_LOCKOUT_MS,
      );
      return {
        success: false,
        reason: composeApprovalMessage({
          scenario: "guardian_verify_failed",
          failureReason: "The verification code is invalid or has expired.",
        }),
      };
    }
  }
  // pending_bootstrap: allow consumption without identity check

  // Consume the challenge so it cannot be reused
  consumeSession(challenge.id, actorExternalUserId, actorChatId);

  // Reset the rate-limit counter on success
  resetRateLimit(channel, actorExternalUserId, actorChatId);

  // Return the verification type — role-specific side effects are
  // handled by callers: verification-intercept (channel) and
  // relay-server (voice).
  return {
    success: true,
    verificationType:
      challenge.verificationPurpose === "trusted_contact"
        ? "trusted_contact"
        : "guardian",
  };
}

/**
 * Look up the active guardian binding for a given assistant and channel.
 * Reads from the contacts table via findGuardianForChannel and
 * synthesizes a GuardianBinding-shaped object.
 * Returns null when no contacts match.
 */
export function getGuardianBinding(
  assistantId: string,
  channel: string,
): GuardianBinding | null {
  const result = findGuardianForChannel(channel);
  if (result) {
    return {
      id: result.channel.id,
      assistantId,
      channel,
      guardianExternalUserId: result.channel.externalUserId ?? "",
      guardianDeliveryChatId: result.channel.externalChatId ?? "",
      guardianPrincipalId: result.contact.principalId ?? "",
      status: "active" as const,
      verifiedAt: result.channel.verifiedAt ?? 0,
      verifiedVia: result.channel.verifiedVia ?? "",
      metadataJson: null,
      createdAt: result.channel.createdAt,
      updatedAt: result.channel.updatedAt ?? result.channel.createdAt,
    };
  }

  return null;
}

/**
 * Check whether the given external user is the active guardian for
 * the specified assistant and channel.
 */
export function isGuardian(
  assistantId: string,
  channel: string,
  externalUserId: string,
): boolean {
  const result = findGuardianForChannel(channel);
  if (result) {
    return result.channel.externalUserId === externalUserId;
  }

  return false;
}

/**
 * Revoke the active guardian binding for a given assistant and channel.
 */
export function revokeBinding(assistantId: string, channel: string): boolean {
  return revokeGuardianBinding(channel);
}

/**
 * Revoke all pending sessions for a given channel.
 * Called when the user cancels verification so that stale sessions
 * don't gate inbound calls.
 */
export function revokePendingSessions(channel: string): void {
  storeRevokePendingSessions(channel);
}

/**
 * Look up a pending (non-expired) verification session for a given
 * channel. Used by relay setup to detect whether an active
 * voice verification session exists.
 */
export function getPendingSession(channel: string): VerificationSession | null {
  return findPendingSessionForChannel(channel);
}

// ---------------------------------------------------------------------------
// Outbound Verification Sessions
// ---------------------------------------------------------------------------

export interface CreateOutboundSessionResult {
  sessionId: string;
  secret: string;
  challengeHash: string;
  expiresAt: number;
  ttlSeconds: number;
}

/**
 * Create an outbound verification session with expected identity pre-set.
 * Returns session info including the secret for outbound delivery.
 *
 * Channels where identity is pre-bound (voice, Telegram with known
 * chat ID) use 6-digit numeric codes for ease of entry. Unbound bootstrap
 * sessions (e.g. Telegram handle where identity is not yet known) use
 * high-entropy 32-byte hex secrets to prevent brute-force guessing during
 * the TTL window.
 */
export function createOutboundSession(params: {
  channel: string;
  expectedExternalUserId?: string;
  expectedChatId?: string;
  expectedPhoneE164?: string;
  identityBindingStatus?: IdentityBindingStatus;
  destinationAddress?: string;
  codeDigits?: number;
  maxAttempts?: number;
  sessionId?: string;
  bootstrapTokenHash?: string;
  verificationPurpose?: VerificationPurpose;
}): CreateOutboundSessionResult {
  // Use high-entropy hex for unbound bootstrap sessions to prevent brute-force;
  // 6-digit numeric codes are only safe when identity is already bound.
  const isUnbound = params.identityBindingStatus === "pending_bootstrap";
  const secret = isUnbound
    ? randomBytes(32).toString("hex")
    : generateNumericSecret(params.codeDigits ?? 6);
  const challengeHash = hashSecret(secret);
  const sessionId = params.sessionId ?? uuid();
  const expiresAt = Date.now() + CHALLENGE_TTL_MS;

  createVerificationSession({
    id: sessionId,
    channel: params.channel,
    challengeHash,
    expiresAt,
    status:
      params.identityBindingStatus === "pending_bootstrap"
        ? "pending_bootstrap"
        : "awaiting_response",
    expectedExternalUserId: params.expectedExternalUserId,
    expectedChatId: params.expectedChatId,
    expectedPhoneE164: params.expectedPhoneE164,
    identityBindingStatus: params.identityBindingStatus ?? "bound",
    destinationAddress: params.destinationAddress,
    codeDigits: params.codeDigits,
    maxAttempts: params.maxAttempts,
    verificationPurpose: params.verificationPurpose,
    bootstrapTokenHash: params.bootstrapTokenHash,
  });

  return {
    sessionId,
    secret,
    challengeHash,
    expiresAt,
    ttlSeconds: CHALLENGE_TTL_MS / 1000,
  };
}

/**
 * Find the most recent active outbound session for a given channel.
 */
export function findActiveSession(channel: string): VerificationSession | null {
  return storeFindActiveSession(channel);
}

/**
 * Identity-bound session lookup for the consume path.
 */
export function findSessionByIdentity(
  channel: string,
  externalUserId?: string,
  chatId?: string,
  phoneE164?: string,
): VerificationSession | null {
  return storeFindSessionByIdentity(channel, externalUserId, chatId, phoneE164);
}

/**
 * Transition a session's status.
 */
export function updateSessionStatus(
  id: string,
  status: SessionStatus,
  extraFields?: Partial<{
    consumedByExternalUserId: string;
    consumedByChatId: string;
  }>,
): void {
  storeUpdateSessionStatus(id, status, extraFields);
}

/**
 * Update outbound delivery tracking fields on a session.
 */
export function updateSessionDelivery(
  id: string,
  lastSentAt: number,
  sendCount: number,
  nextResendAt: number | null,
): void {
  storeUpdateSessionDelivery(id, lastSentAt, sendCount, nextResendAt);
}

/**
 * Count total sends to a destination across all sessions within a
 * rolling time window. Prevents circumvention of per-session limits by
 * repeatedly creating new sessions to the same phone number.
 */
export function countRecentSendsToDestination(
  channel: string,
  destinationAddress: string,
  windowMs: number,
): number {
  return storeCountRecentSendsToDestination(
    channel,
    destinationAddress,
    windowMs,
  );
}

/**
 * Telegram bootstrap completion: bind the expected identity fields and
 * transition identity_binding_status from pending_bootstrap to bound.
 */
export function bindSessionIdentity(
  id: string,
  externalUserId: string,
  chatId: string,
): void {
  storeBindSessionIdentity(id, externalUserId, chatId);
}

/**
 * Resolve a bootstrap token to a pending_bootstrap session.
 * Hashes the raw token with SHA-256 and looks up the session.
 */
export function resolveBootstrapToken(
  channel: string,
  token: string,
): VerificationSession | null {
  const tokenHash = hashSecret(token);
  return storeFindSessionByBootstrapTokenHash(channel, tokenHash);
}
