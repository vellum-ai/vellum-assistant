/**
 * Gateway-native verification session service (Combo 13).
 *
 * Ports secret minting from the daemon's channel-verification-service:
 * sessions are created here, secrets are minted here, and only SHA-256
 * hashes are persisted (via the gateway session store). The raw secret
 * transits back to the daemon in the create-IPC response because message
 * composition and channel delivery stay daemon-owned — mirror of how
 * invite mint returns data and the daemon composes presentation.
 *
 * Validate-and-consume is deliberately NOT here yet; it lands with the
 * `verification_sessions_validate_consume` route (in-engine role side
 * effects replace the outbound-voice-verification-sync poller).
 */

import { randomBytes, randomUUID } from "node:crypto";

import { hashVerificationSecret } from "@vellumai/gateway-client";

import type {
  IdentityBindingStatus,
  VerificationPurpose,
  VerificationSession,
} from "../db/session-store.js";
import {
  createInboundSession,
  createOutboundSession as storeCreateOutboundSession,
} from "../db/session-store.js";

/** Challenge TTL in milliseconds (10 minutes). */
export const CHALLENGE_TTL_MS = 10 * 60 * 1000;

export interface CreateInboundVerificationSessionResult {
  session: VerificationSession;
  secret: string;
  verifyCommand: string;
  ttlSeconds: number;
}

export interface CreateOutboundSessionResult {
  sessionId: string;
  secret: string;
  challengeHash: string;
  expiresAt: number;
  ttlSeconds: number;
}

/**
 * Generate a numeric secret with the specified number of digits
 * (default 6), zero-padded, using cryptographic randomness.
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
 * Inbound sessions are not identity-bound, so code secrecy is the only
 * protection against brute-force guessing during the TTL window — a
 * 32-byte hex secret provides ~2^128 entropy. Identity-bound outbound
 * sessions use shorter numeric codes because the identity check adds a
 * second layer of protection.
 *
 * Only the SHA-256 hash is persisted; the raw secret is returned so the
 * daemon can compose and deliver the instruction copy.
 */
export function createInboundVerificationSession(
  channel: string,
  sourceConversationId?: string,
): CreateInboundVerificationSessionResult {
  const secret = randomBytes(32).toString("hex");

  const session = createInboundSession({
    id: randomUUID(),
    channel,
    challengeHash: hashVerificationSecret(secret),
    expiresAt: Date.now() + CHALLENGE_TTL_MS,
    sourceConversationId,
  });

  return {
    session,
    secret,
    verifyCommand: secret,
    ttlSeconds: CHALLENGE_TTL_MS / 1000,
  };
}

/**
 * Create an outbound verification session with expected identity pre-set.
 *
 * Channels where identity is pre-bound use numeric codes for ease of
 * entry; unbound bootstrap sessions (`pending_bootstrap`) use high-entropy
 * 32-byte hex secrets to prevent brute-force guessing during the TTL
 * window. Only the hash is persisted; the secret transits back for
 * daemon-owned delivery.
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
  verificationPurpose?: VerificationPurpose;
  bootstrapTokenHash?: string;
  sessionId?: string;
}): CreateOutboundSessionResult {
  const isUnbound = params.identityBindingStatus === "pending_bootstrap";
  const secret = isUnbound
    ? randomBytes(32).toString("hex")
    : generateNumericSecret(params.codeDigits ?? 6);
  const challengeHash = hashVerificationSecret(secret);
  const sessionId = params.sessionId ?? randomUUID();
  const expiresAt = Date.now() + CHALLENGE_TTL_MS;

  storeCreateOutboundSession({
    id: sessionId,
    channel: params.channel,
    challengeHash,
    expiresAt,
    status: isUnbound ? "pending_bootstrap" : "awaiting_response",
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
