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
 * Validate-and-consume lives here too (the
 * `verification_sessions_validate_consume` route): rate limiting, identity
 * binding, the status-guarded atomic consume, and the in-engine role side
 * effects (guardian phone binding / trusted-contact channel upsert) that
 * replace the outbound-voice-verification-sync poller.
 */

import { randomBytes, randomUUID } from "node:crypto";

import { hashVerificationSecret } from "@vellumai/gateway-client";

import { createGuardianBinding } from "../auth/guardian-bootstrap.js";
import type {
  IdentityBindingStatus,
  VerificationPurpose,
  VerificationSession,
} from "../db/session-store.js";
import {
  consumeSession,
  createInboundSession,
  createOutboundSession as storeCreateOutboundSession,
  findPendingSessionByHash,
} from "../db/session-store.js";
import { getLogger } from "../logger.js";
import {
  getExistingGuardianBinding,
  getMostRecentChannelGuardianTimestamp,
  resolveCanonicalPrincipal,
  revokeExistingChannelGuardian,
} from "./binding-helpers.js";
import { gatewayChannelStatus } from "./contact-helpers.js";
import { checkIdentityMatch } from "./identity-match.js";
import {
  isRateLimited,
  recordInvalidAttempt,
  resetRateLimit,
} from "./rate-limit-helpers.js";
import { applyTrustedContactSideEffects } from "./text-verification.js";

const log = getLogger("verification-session-service");

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

// ---------------------------------------------------------------------------
// Validate + consume
// ---------------------------------------------------------------------------

/**
 * The single machine-readable failure reason for validate+consume.
 *
 * Anti-oracle: every failure path — rate-limit lockout, unknown/expired
 * code, identity mismatch, concurrent consume, blocked actor — returns this
 * same code so the response cannot leak WHY the attempt failed. The daemon
 * composes the user-facing copy from it.
 */
export const VALIDATE_CONSUME_FAILURE_REASON = "invalid_or_expired";

export type ValidateConsumeSessionResult =
  | { success: true; verificationType: VerificationPurpose }
  | { success: false; reason: string };

const CONSUME_FAILURE: ValidateConsumeSessionResult = {
  success: false,
  reason: VALIDATE_CONSUME_FAILURE_REASON,
};

/**
 * Validate and consume a verification challenge — gateway-native port of the
 * daemon's `validateAndConsumeVerification`.
 *
 * Flow: rate-limit lockout check → hash lookup among interceptable,
 * non-expired sessions → expected-identity binding check → status-guarded
 * atomic consume (only the first concurrent consumer wins) → rate-limit
 * reset → in-engine role side effects.
 *
 * Side effects are applied here, in the engine, because trust-graph writes
 * must never happen in the (potentially prompt-injected) daemon:
 * - guardian purpose on phone with an expected number (the outbound voice
 *   shape): create the phone guardian binding synchronously — this replaces
 *   the outbound-voice-verification-sync poller. A blocked authoritative
 *   gateway row rejects the verification first (mirrors the text guardian
 *   path).
 * - trusted_contact purpose: upsert the verified contact channel; a
 *   blocked/revoked authoritative gateway row rejects the verification even
 *   though the code matched (mirrors text-verification).
 *
 * On failure the invalid-attempt counter is incremented; after exceeding the
 * threshold the actor is locked out for a cooldown. Success resets it.
 */
export async function validateAndConsumeSession(
  channel: string,
  secret: string,
  actorExternalUserId: string,
  actorChatId: string,
): Promise<ValidateConsumeSessionResult> {
  // Lockout does not record another attempt (matches the daemon port).
  if (isRateLimited(channel, actorExternalUserId, actorChatId)) {
    return CONSUME_FAILURE;
  }

  // The store lookup enforces both interceptable status and expiry
  // (expires_at > now), so an expired code lands here as "no match" —
  // indistinguishable from a wrong code, as intended.
  const session = findPendingSessionByHash(
    channel,
    hashVerificationSecret(secret),
  );
  if (!session) {
    await recordInvalidAttempt(channel, actorExternalUserId, actorChatId);
    return CONSUME_FAILURE;
  }

  // Expected-identity binding check (outbound sessions). checkIdentityMatch
  // carries the daemon's rules verbatim: phone match, the shared-chatId
  // caveat (externalUserId required when both are set), the
  // externalUserId-only fallback, and the pending_bootstrap bypass.
  if (!checkIdentityMatch(session, actorExternalUserId, actorChatId)) {
    await recordInvalidAttempt(channel, actorExternalUserId, actorChatId);
    return CONSUME_FAILURE;
  }

  // Status-guarded atomic consume: a false return means a concurrent
  // consumer already won, so this attempt fails (one-time-code semantics).
  if (!consumeSession(session.id, actorExternalUserId, actorChatId)) {
    log.warn(
      { sessionId: session.id },
      "Session already consumed by concurrent request",
    );
    return CONSUME_FAILURE;
  }
  const consumedAt = Date.now();

  await resetRateLimit(channel, actorExternalUserId, actorChatId);

  if (session.verificationPurpose === "trusted_contact") {
    // Mirrors text-verification: a blocked/revoked authoritative gateway row
    // rejects the verification — the actor must not regain trusted status
    // even though the code matched and the session is consumed.
    const verified = await applyTrustedContactSideEffects({
      sourceChannel: channel,
      canonicalUserId: actorExternalUserId,
      actorChatId,
    });
    if (!verified) {
      log.warn(
        { channel, actorExternalUserId },
        "Trusted-contact verification rejected: gateway channel is blocked/revoked",
      );
      return CONSUME_FAILURE;
    }
  } else if (channel === "phone" && session.expectedPhoneE164 != null) {
    // Mirrors the text guardian path's gateway-status guard: a blocked
    // authoritative row must not report success — createGuardianBinding
    // leaves blocked rows untouched, so without this guard a blocked-number
    // rebind would revoke the current guardian and bind nobody. Checked
    // after consume (same ordering as the text path); revoked rows stay
    // rebindable here — outbound rebinds are guardian-initiated and the
    // ATL-514 recency guard covers staleness.
    if (gatewayChannelStatus(channel, actorExternalUserId) === "blocked") {
      log.warn(
        { channel, actorExternalUserId },
        "Guardian phone binding rejected: gateway channel is blocked",
      );
      return CONSUME_FAILURE;
    }

    // Guardian purpose on the outbound voice shape (an expected phone number
    // is only ever set by startOutboundVoice) — exactly the filter the
    // retired poller used. Bind synchronously at consume time.
    await createPhoneGuardianBinding(
      actorExternalUserId,
      actorChatId,
      consumedAt,
    );
  }

  return { success: true, verificationType: session.verificationPurpose };
}

/**
 * Create the guardian phone binding for a consumed outbound voice
 * verification session. Called synchronously at consume time (and, until the
 * poller is deleted, by outbound-voice-verification-sync replays — both are
 * idempotent here).
 *
 * `sessionUpdatedAt` is the session's consume timestamp; it anchors the
 * recency check below.
 */
export async function createPhoneGuardianBinding(
  phoneNumber: string,
  chatId: string,
  sessionUpdatedAt: number,
): Promise<void> {
  // Recency check (security backstop, ATL-514) — retained as the
  // idempotency/replay guard under IPC retries, poller replays, and gateway
  // restarts: a consumed session can have been superseded by manual
  // revocation or a sibling binding path (e.g. inbound verification).
  // `getExistingGuardianBinding` only checks active bindings, so without
  // this guard we would reactivate a revoked binding or revoke an active
  // one in favor of a stale session.
  const lastBindingTs = await getMostRecentChannelGuardianTimestamp("phone");
  if (lastBindingTs != null && sessionUpdatedAt <= lastBindingTs) {
    log.warn(
      { phoneNumber, sessionUpdatedAt, lastBindingTs },
      "Phone guardian binding: session older than most recent binding event; skipping (replay-protection)",
    );
    return;
  }

  const canonicalPrincipal = await resolveCanonicalPrincipal(phoneNumber);
  const existingBinding = await getExistingGuardianBinding("phone");

  if (existingBinding) {
    if (existingBinding.address === phoneNumber) {
      // Idempotent — binding already exists for this number. Can happen on
      // an IPC retry of the consume, or when the poller re-encounters an
      // already-processed session after a gateway restart.
      log.info(
        { phoneNumber },
        "Phone guardian binding already exists, skipping",
      );
      return;
    }

    // A different number holds the phone guardian binding — revoke it first.
    //
    // This is an intentional behavioral difference from the inbound path
    // (twilio-voice-verify-callback.ts), which logs and skips on conflict.
    // Outbound calls are guardian-initiated by definition: only the trusted
    // guardian can command the assistant to dial a specific number with
    // expected_phone_e164 set. So an outbound code-redemption is always a
    // deliberate rebind. Inbound's conservative skip exists because anyone
    // could call in with a stolen code; outbound has no such attack surface.
    //
    // The recency check above ensures we only rebind when the consumed
    // session is newer than the current binding's last-touched timestamp.
    log.warn(
      { phoneNumber, existingGuardian: existingBinding.address },
      "Phone guardian binding: revoking conflicting phone guardian binding",
    );
    await revokeExistingChannelGuardian("phone");
  }

  await createGuardianBinding({
    channel: "phone",
    externalUserId: phoneNumber,
    deliveryChatId: chatId,
    guardianPrincipalId: canonicalPrincipal,
    verifiedVia: "challenge",
  });

  log.info(
    { phoneNumber, canonicalPrincipal },
    "Guardian phone binding created",
  );
}
