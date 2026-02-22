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
  createChallenge,
  findPendingChallengeByHash,
  consumeChallenge,
} from '../memory/channel-guardian-store.js';
import type { GuardianBinding } from '../memory/channel-guardian-store.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Challenge TTL in milliseconds (10 minutes). */
const CHALLENGE_TTL_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateChallengeResult {
  challengeId: string;
  secret: string;
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
 * Create a new verification challenge for a guardian candidate.
 *
 * Generates a random secret, hashes it (SHA-256), and stores the
 * challenge record with a 10-minute TTL. The raw secret is returned
 * so it can be displayed to the user; only the hash is persisted.
 */
export function createVerificationChallenge(
  assistantId: string,
  channel: string,
  sessionId?: string,
): CreateChallengeResult {
  const secret = randomBytes(32).toString('hex');
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

  return {
    challengeId,
    secret,
    instruction: `Send \`/guardian_verify ${secret}\` to your bot from your Telegram account within 10 minutes.`,
  };
}

/**
 * Validate and consume a verification challenge.
 *
 * Hashes the provided secret, looks up a matching pending challenge,
 * validates it has not expired, consumes it, revokes any existing
 * active binding, and creates a new guardian binding.
 */
export function validateAndConsumeChallenge(
  assistantId: string,
  channel: string,
  secret: string,
  actorExternalUserId: string,
  actorChatId: string,
): ValidateChallengeResult {
  const challengeHash = hashSecret(secret);

  const challenge = findPendingChallengeByHash(assistantId, channel, challengeHash);
  if (!challenge) {
    return { success: false, reason: 'Invalid or expired verification code.' };
  }

  if (Date.now() > challenge.expiresAt) {
    return { success: false, reason: 'Invalid or expired verification code.' };
  }

  // Consume the challenge so it cannot be reused
  consumeChallenge(challenge.id, actorExternalUserId, actorChatId);

  // Revoke any existing active binding before creating a new one
  storeRevokeBinding(assistantId, channel);

  // Create the new guardian binding
  const binding = createBinding({
    assistantId,
    channel,
    guardianExternalUserId: actorExternalUserId,
    guardianDeliveryChatId: actorChatId,
    verifiedVia: 'challenge',
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
  return binding !== null && binding.guardianExternalUserId === externalUserId;
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
