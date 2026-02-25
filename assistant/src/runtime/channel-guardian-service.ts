/**
 * Channel guardian verification service.
 *
 * Encapsulates the business logic for the guardian verification challenge
 * lifecycle: creating challenges with cryptographic secrets, validating
 * and consuming them, and managing guardian bindings.
 */

import { randomBytes, createHash } from 'crypto';
import { v4 as uuid } from 'uuid';
import {
  createBinding,
  getActiveBinding,
  revokeBinding as storeRevokeBinding,
  revokePendingChallenges as storeRevokePendingChallenges,
  createChallenge,
  findPendingChallengeByHash,
  findPendingChallengeForChannel,
  consumeChallenge,
  getRateLimit,
  recordInvalidAttempt,
  resetRateLimit,
  createVerificationSession,
  findActiveSession as storeFindActiveSession,
  findSessionByIdentity as storeFindSessionByIdentity,
  updateSessionStatus as storeUpdateSessionStatus,
  updateSessionDelivery as storeUpdateSessionDelivery,
  bindSessionIdentity as storeBindSessionIdentity,
} from '../memory/channel-guardian-store.js';
import type {
  GuardianBinding,
  VerificationChallenge,
  SessionStatus,
  IdentityBindingStatus,
} from '../memory/channel-guardian-store.js';
import { composeApprovalMessage } from './approval-message-composer.js';

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

export interface CreateChallengeResult {
  challengeId: string;
  secret: string;
  verifyCommand: string;
  ttlSeconds: number;
  instruction: string;
}

export type ValidateChallengeResult =
  | { success: true; bindingId: string }
  | { success: false; reason: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Generate a six-digit numeric secret for voice channel challenges.
 * Uses cryptographic randomness to pick a number in [100000, 999999].
 */
function generateVoiceSecret(): string {
  const buf = randomBytes(4);
  const num = buf.readUInt32BE(0);
  // Map to the range [100000, 999999] (900000 possible values)
  return String(100000 + (num % 900000));
}

/**
 * Create a new verification challenge for a guardian candidate.
 *
 * For voice channels, generates a six-digit numeric secret that can be
 * spoken aloud. For all other channels, generates a 32-byte hex secret.
 *
 * Hashes the secret (SHA-256) and stores the challenge record with a
 * 10-minute TTL. The raw secret is returned so it can be displayed to
 * the user; only the hash is persisted.
 */
export function createVerificationChallenge(
  assistantId: string,
  channel: string,
  sessionId?: string,
): CreateChallengeResult {
  const secret = channel === 'voice' ? generateVoiceSecret() : randomBytes(32).toString('hex');
  const challengeHash = hashSecret(secret);
  const challengeId = uuid();
  const expiresAt = Date.now() + CHALLENGE_TTL_MS;

  createChallenge({
    id: challengeId,
    assistantId,
    channel,
    challengeHash,
    expiresAt,
    createdBySessionId: sessionId,
  });

  const verifyCommand = `/guardian_verify ${secret}`;
  const ttlSeconds = CHALLENGE_TTL_MS / 1000;

  return {
    challengeId,
    secret,
    verifyCommand,
    ttlSeconds,
    instruction: composeApprovalMessage({
      scenario: 'guardian_verify_challenge_setup',
      channel,
      verifyCommand,
      ttlSeconds,
    }),
  };
}

/**
 * Validate and consume a verification challenge.
 *
 * Checks per-actor/per-channel rate limits before attempting validation.
 * Hashes the provided secret, looks up a matching pending challenge,
 * validates it has not expired, consumes it, revokes any existing
 * active binding, and creates a new guardian binding.
 *
 * On failure the invalid-attempt counter is incremented; after
 * exceeding the threshold the actor is locked out for a cooldown
 * period. On success the counter resets.
 */
export function validateAndConsumeChallenge(
  assistantId: string,
  channel: string,
  secret: string,
  actorExternalUserId: string,
  actorChatId: string,
  actorUsername?: string,
  actorDisplayName?: string,
): ValidateChallengeResult {
  // ── Rate-limit check ──
  const existing = getRateLimit(assistantId, channel, actorExternalUserId, actorChatId);
  if (existing && existing.lockedUntil != null && Date.now() < existing.lockedUntil) {
    // Use the same generic failure message to avoid leaking whether the
    // actor is rate-limited vs. the code is genuinely wrong.
    return {
      success: false,
      reason: composeApprovalMessage({
        scenario: 'guardian_verify_failed',
        failureReason: 'The verification code is invalid or has expired.',
      }),
    };
  }

  const challengeHash = hashSecret(secret);

  const challenge = findPendingChallengeByHash(assistantId, channel, challengeHash);
  if (!challenge) {
    recordInvalidAttempt(
      assistantId, channel, actorExternalUserId, actorChatId,
      RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_ATTEMPTS, RATE_LIMIT_LOCKOUT_MS,
    );
    return {
      success: false,
      reason: composeApprovalMessage({
        scenario: 'guardian_verify_failed',
        failureReason: 'The verification code is invalid or has expired.',
      }),
    };
  }

  if (Date.now() > challenge.expiresAt) {
    recordInvalidAttempt(
      assistantId, channel, actorExternalUserId, actorChatId,
      RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_ATTEMPTS, RATE_LIMIT_LOCKOUT_MS,
    );
    return {
      success: false,
      reason: composeApprovalMessage({
        scenario: 'guardian_verify_failed',
        failureReason: 'The verification code is invalid or has expired.',
      }),
    };
  }

  // ── Expected-identity check (outbound sessions) ──
  // If the session has identity binding fields set and is in 'bound' state,
  // verify the actor matches the expected identity. If identity_binding_status
  // is 'pending_bootstrap', allow consumption (bootstrap path handles binding
  // separately). If no expected identity fields are set (legacy/inbound-only),
  // skip identity check for backward compatibility.
  const hasExpectedIdentity =
    challenge.expectedExternalUserId != null ||
    challenge.expectedChatId != null ||
    challenge.expectedPhoneE164 != null;

  if (hasExpectedIdentity && challenge.identityBindingStatus === 'bound') {
    let identityMatch = false;

    // For SMS/voice: verify actorExternalUserId matches expectedPhoneE164
    // OR actorExternalUserId matches expectedExternalUserId
    if (challenge.expectedPhoneE164 != null) {
      if (actorExternalUserId === challenge.expectedPhoneE164 ||
          actorExternalUserId === challenge.expectedExternalUserId) {
        identityMatch = true;
      }
    }

    // For Telegram: verify actorChatId matches expectedChatId
    // AND/OR actorExternalUserId matches expectedExternalUserId
    if (challenge.expectedChatId != null) {
      if (actorChatId === challenge.expectedChatId ||
          actorExternalUserId === challenge.expectedExternalUserId) {
        identityMatch = true;
      }
    }

    // Fallback: if only expectedExternalUserId is set (no phone/chat)
    if (challenge.expectedPhoneE164 == null && challenge.expectedChatId == null &&
        challenge.expectedExternalUserId != null) {
      if (actorExternalUserId === challenge.expectedExternalUserId) {
        identityMatch = true;
      }
    }

    if (!identityMatch) {
      // Anti-oracle: use the same generic error message to avoid leaking
      // whether the identity is wrong vs. the code is wrong.
      recordInvalidAttempt(
        assistantId, channel, actorExternalUserId, actorChatId,
        RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_ATTEMPTS, RATE_LIMIT_LOCKOUT_MS,
      );
      return {
        success: false,
        reason: composeApprovalMessage({
          scenario: 'guardian_verify_failed',
          failureReason: 'The verification code is invalid or has expired.',
        }),
      };
    }
  }
  // pending_bootstrap: allow consumption without identity check
  // no expected identity: legacy/inbound-only, skip identity check

  // Consume the challenge so it cannot be reused
  consumeChallenge(challenge.id, actorExternalUserId, actorChatId);

  // Reset the rate-limit counter on success
  resetRateLimit(assistantId, channel, actorExternalUserId, actorChatId);

  // Reject if a different user already holds the guardian binding
  const existingBinding = getActiveBinding(assistantId, channel);
  if (existingBinding && existingBinding.guardianExternalUserId !== actorExternalUserId) {
    return {
      success: false,
      reason: 'A guardian is already bound for this channel. The existing guardian must be revoked before a new one can be verified.',
    };
  }

  // Revoke any existing active binding before creating a new one (same-user re-verification)
  storeRevokeBinding(assistantId, channel);

  const metadata: Record<string, string> = {};
  if (actorUsername && actorUsername.trim().length > 0) {
    metadata.username = actorUsername.trim();
  }
  if (actorDisplayName && actorDisplayName.trim().length > 0) {
    metadata.displayName = actorDisplayName.trim();
  }

  // Create the new guardian binding
  const binding = createBinding({
    assistantId,
    channel,
    guardianExternalUserId: actorExternalUserId,
    guardianDeliveryChatId: actorChatId,
    verifiedVia: 'challenge',
    metadataJson: Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null,
  });

  return { success: true, bindingId: binding.id };
}

/**
 * Look up the active guardian binding for a given assistant and channel.
 */
export function getGuardianBinding(
  assistantId: string,
  channel: string,
): GuardianBinding | null {
  return getActiveBinding(assistantId, channel);
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
  const binding = getActiveBinding(assistantId, channel);
  return binding != null && binding.guardianExternalUserId === externalUserId;
}

/**
 * Revoke the active guardian binding for a given assistant and channel.
 */
export function revokeBinding(
  assistantId: string,
  channel: string,
): boolean {
  return storeRevokeBinding(assistantId, channel);
}

/**
 * Revoke all pending challenges for a given assistant and channel.
 * Called when the user cancels verification so that stale challenges
 * don't gate inbound calls.
 */
export function revokePendingChallenges(
  assistantId: string,
  channel: string,
): void {
  storeRevokePendingChallenges(assistantId, channel);
}

/**
 * Look up a pending (non-expired) verification challenge for a given
 * assistant and channel. Used by relay setup to detect whether an active
 * voice verification session exists.
 */
export function getPendingChallenge(
  assistantId: string,
  channel: string,
): VerificationChallenge | null {
  return findPendingChallengeForChannel(assistantId, channel);
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
 * For voice channels, generates a numeric code with the specified digit count.
 * For text channels (SMS, Telegram), generates a hex secret.
 */
export function createOutboundSession(params: {
  assistantId: string;
  channel: string;
  expectedExternalUserId?: string;
  expectedChatId?: string;
  expectedPhoneE164?: string;
  identityBindingStatus?: IdentityBindingStatus;
  destinationAddress?: string;
  codeDigits?: number;
  maxAttempts?: number;
  sessionId?: string;
}): CreateOutboundSessionResult {
  const isVoice = params.channel === 'voice';
  const secret = isVoice ? generateVoiceSecret() : randomBytes(32).toString('hex');
  const challengeHash = hashSecret(secret);
  const sessionId = params.sessionId ?? uuid();
  const expiresAt = Date.now() + CHALLENGE_TTL_MS;

  createVerificationSession({
    id: sessionId,
    assistantId: params.assistantId,
    channel: params.channel,
    challengeHash,
    expiresAt,
    status: params.identityBindingStatus === 'pending_bootstrap' ? 'pending_bootstrap' : 'awaiting_response',
    expectedExternalUserId: params.expectedExternalUserId,
    expectedChatId: params.expectedChatId,
    expectedPhoneE164: params.expectedPhoneE164,
    identityBindingStatus: params.identityBindingStatus ?? 'bound',
    destinationAddress: params.destinationAddress,
    codeDigits: params.codeDigits,
    maxAttempts: params.maxAttempts,
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
 * Find the most recent active outbound session for a given
 * (assistantId, channel).
 */
export function findActiveSession(
  assistantId: string,
  channel: string,
): VerificationChallenge | null {
  return storeFindActiveSession(assistantId, channel);
}

/**
 * Identity-bound session lookup for the consume path.
 */
export function findSessionByIdentity(
  assistantId: string,
  channel: string,
  externalUserId?: string,
  chatId?: string,
  phoneE164?: string,
): VerificationChallenge | null {
  return storeFindSessionByIdentity(assistantId, channel, externalUserId, chatId, phoneE164);
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
