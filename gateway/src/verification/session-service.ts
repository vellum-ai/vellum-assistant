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
 * replaced the old gateway polling loop for outbound voice sessions. The
 * voice guardian binding commits in the same gateway transaction as the
 * consume, so the poller's replay job is structurally unnecessary: a binding
 * failure rolls the consume back and the code stays redeemable.
 */

import { randomBytes, randomUUID } from "node:crypto";

import {
  CHALLENGE_TTL_MS,
  hashVerificationSecret,
} from "@vellumai/gateway-client";
import type {
  CreateInboundSessionIpcResponse,
  CreateOutboundSessionConditionalIpcResponse,
  CreateOutboundSessionConflict,
  CreateOutboundSessionIpcResponse,
  ValidateConsumeSessionIpcResponse,
} from "@vellumai/gateway-client";

import type { GuardianBindingGatewayWrites } from "../auth/guardian-bootstrap.js";
import {
  applyGuardianBindingGatewayWrites,
  mirrorGuardianBinding,
} from "../auth/guardian-bootstrap.js";
import { getGatewayDb } from "../db/connection.js";
import type {
  IdentityBindingStatus,
  VerificationPurpose,
} from "../db/session-store.js";
import {
  consumeSession,
  createInboundSession,
  createOutboundSession as storeCreateOutboundSession,
  findActiveSession,
  findPendingSessionByHash,
  getSessionById,
  updateSessionStatus,
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

// Result shapes are the shared contract's IPC response types — the service
// returns exactly what transits the wire.
export type CreateInboundVerificationSessionResult =
  CreateInboundSessionIpcResponse;

export type CreateOutboundSessionResult = CreateOutboundSessionIpcResponse;

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

export type CreateOutboundSessionConflictReason =
  CreateOutboundSessionConflict["reason"];

export type GuardedCreateOutboundSessionResult =
  CreateOutboundSessionConditionalIpcResponse;

/**
 * Guarded variant of `createOutboundSession` for callers whose check→mint
 * sequence spans separate IPC round trips (TOCTOU races).
 *
 * Guards and mint run in one synchronous section on the single bun:sqlite
 * connection — no awaits between the check and the revoke-prior+insert — so
 * concurrent handler invocations cannot interleave: exactly one claimant
 * mints; the rest get a machine-readable conflict instead of revoking the
 * winner's freshly minted code.
 *
 * - `requireSourceSessionPending`: the bootstrap handoff claim. The source
 *   session must still be `pending_bootstrap` (a prior mint revokes it, so a
 *   second claim of the same deep-link token conflicts).
 * - `ifNoneActive`: create-if-absent. Conflicts when the channel already has
 *   an active (pending_bootstrap / awaiting_response, non-expired) session.
 * - `ifNoneActiveForExternalUserId`: sender-scoped create-if-absent.
 *   Conflicts only when the channel's active session is bound to the same
 *   expectedExternalUserId — a different sender's session may be superseded
 *   (the unguarded revoke-prior semantics apply).
 */
export function createOutboundSessionGuarded(
  params: Parameters<typeof createOutboundSession>[0] & {
    requireSourceSessionPending?: string;
    ifNoneActive?: boolean;
    ifNoneActiveForExternalUserId?: string;
  },
): GuardedCreateOutboundSessionResult {
  if (params.requireSourceSessionPending !== undefined) {
    const source = getSessionById(params.requireSourceSessionPending);
    if (
      !source ||
      source.channel !== params.channel ||
      source.status !== "pending_bootstrap"
    ) {
      return { conflict: true, reason: "source_session_not_pending" };
    }
  }

  if (params.ifNoneActive && findActiveSession(params.channel) !== null) {
    return { conflict: true, reason: "active_session_exists" };
  }

  if (params.ifNoneActiveForExternalUserId !== undefined) {
    const active = findActiveSession(params.channel);
    if (
      active !== null &&
      active.expectedExternalUserId === params.ifNoneActiveForExternalUserId
    ) {
      return { conflict: true, reason: "active_session_exists" };
    }
  }

  return createOutboundSession(params);
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

export type ValidateConsumeSessionResult = ValidateConsumeSessionIpcResponse;

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
 *   shape): consume + binding commit in ONE gateway transaction. A binding
 *   failure (or a crash mid-flight) rolls back the consume, so the one-time
 *   code stays redeemable — no spent-code-without-binding state can exist.
 *   A blocked authoritative gateway row still rejects the verification with
 *   the code spent (mirrors the text guardian path).
 * - trusted_contact purpose: upsert the verified contact channel; a
 *   blocked/revoked authoritative gateway row rejects the verification even
 *   though the code matched (mirrors text-verification). The upsert spans
 *   assistant-IPC IO so it cannot share the consume's transaction; a thrown
 *   side effect instead restores the session for retry.
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

  // Guardian purpose on the outbound voice shape (an expected phone number is
  // only ever set by startOutboundVoice): the status-guarded consume and the
  // binding's gateway writes commit atomically. Everything inside the
  // transaction is synchronous over the gateway DB; the assistant identity
  // mirror runs after commit (best-effort).
  if (
    session.verificationPurpose !== "trusted_contact" &&
    channel === "phone" &&
    session.expectedPhoneE164 != null
  ) {
    const txn = getGatewayDb().transaction(() => {
      // Status-guarded atomic consume: a non-consumed return means a
      // concurrent consumer already won (one-time-code semantics).
      const consume = consumeSession(
        session.id,
        actorExternalUserId,
        actorChatId,
      );
      if (!consume.consumed) return { consumed: false as const };

      // Mirrors the text guardian path's gateway-status guard: a blocked
      // authoritative row must not report success — the binding writes leave
      // blocked rows untouched, so without this guard a blocked-number
      // rebind would revoke the current guardian and bind nobody. The
      // consume still commits: a blocked actor spends the one-time code.
      // Revoked rows stay rebindable here — outbound rebinds are
      // guardian-initiated and the ATL-514 recency guard covers staleness.
      if (gatewayChannelStatus(channel, actorExternalUserId) === "blocked") {
        return { consumed: true as const, blocked: true as const };
      }

      // Bind anchored on the persisted consume timestamp (never a fresh
      // clock sample).
      return {
        consumed: true as const,
        blocked: false as const,
        binding: applyPhoneGuardianBindingGatewayWrites(
          actorExternalUserId,
          actorChatId,
          consume.consumedAt,
        ),
      };
    });

    if (!txn.consumed) {
      log.warn(
        { sessionId: session.id },
        "Session already consumed by concurrent request",
      );
      return CONSUME_FAILURE;
    }

    if (txn.blocked) {
      // Fail closed WITHOUT resetting the rate limit: a blocked actor's
      // lockout state must survive a correct code.
      log.warn(
        { channel, actorExternalUserId },
        "Guardian phone binding rejected: gateway channel is blocked",
      );
      return CONSUME_FAILURE;
    }

    await resetRateLimit(channel, actorExternalUserId, actorChatId);

    if (txn.binding) await mirrorGuardianBinding(txn.binding);

    return { success: true, verificationType: session.verificationPurpose };
  }

  // Status-guarded atomic consume: a non-consumed return means a concurrent
  // consumer already won, so this attempt fails (one-time-code semantics).
  const consumeResult = consumeSession(
    session.id,
    actorExternalUserId,
    actorChatId,
  );
  if (!consumeResult.consumed) {
    log.warn(
      { sessionId: session.id },
      "Session already consumed by concurrent request",
    );
    return CONSUME_FAILURE;
  }

  await resetRateLimit(channel, actorExternalUserId, actorChatId);

  if (session.verificationPurpose === "trusted_contact") {
    // Mirrors text-verification: a blocked/revoked authoritative gateway row
    // rejects the verification — the actor must not regain trusted status
    // even though the code matched and the session is consumed.
    let verified: boolean;
    try {
      verified = await applyTrustedContactSideEffects({
        sourceChannel: channel,
        canonicalUserId: actorExternalUserId,
        actorChatId,
      });
    } catch (err) {
      // The upsert spans assistant-IPC IO, so it cannot share the consume's
      // transaction. Compensate: restore the session's pre-consume status so
      // a transient side-effect failure never strands a spent code without
      // its channel upsert (the retry re-runs the idempotent upsert).
      updateSessionStatus(session.id, session.status);
      log.warn(
        { err, sessionId: session.id },
        "Trusted-contact side effect failed; session restored for retry",
      );
      throw err;
    }
    if (!verified) {
      log.warn(
        { channel, actorExternalUserId },
        "Trusted-contact verification rejected: gateway channel is blocked/revoked",
      );
      return CONSUME_FAILURE;
    }
  }

  return { success: true, verificationType: session.verificationPurpose };
}

/**
 * Sync gateway writes for the guardian phone binding of a consumed outbound
 * voice verification session. Composes inside the caller's transaction so
 * the consume and the binding commit — or roll back — together. Returns the
 * committed writes for the post-commit assistant mirror, or null when the
 * binding is skipped (replay-protection or idempotent re-run).
 *
 * `sessionUpdatedAt` is the session's persisted consume timestamp (the
 * `updated_at` written by the consume UPDATE); it anchors the recency check
 * below.
 */
function applyPhoneGuardianBindingGatewayWrites(
  phoneNumber: string,
  chatId: string,
  sessionUpdatedAt: number,
): GuardianBindingGatewayWrites | null {
  // Recency check (security backstop, ATL-514) — retained as the
  // idempotency/replay guard under IPC retries and gateway
  // restarts: a consumed session can have been superseded by manual
  // revocation or a sibling binding path (e.g. inbound verification).
  // `getExistingGuardianBinding` only checks active bindings, so without
  // this guard we would reactivate a revoked binding or revoke an active
  // one in favor of a stale session.
  const lastBindingTs = getMostRecentChannelGuardianTimestamp("phone");
  if (lastBindingTs != null && sessionUpdatedAt <= lastBindingTs) {
    log.warn(
      { phoneNumber, sessionUpdatedAt, lastBindingTs },
      "Phone guardian binding: session older than most recent binding event; skipping (replay-protection)",
    );
    return null;
  }

  const canonicalPrincipal = resolveCanonicalPrincipal(phoneNumber);
  const existingBinding = getExistingGuardianBinding("phone");

  if (existingBinding) {
    if (existingBinding.address === phoneNumber) {
      // Idempotent — binding already exists for this number (e.g. an IPC
      // retry of the consume).
      log.info(
        { phoneNumber },
        "Phone guardian binding already exists, skipping",
      );
      return null;
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
    revokeExistingChannelGuardian("phone");
  }

  return applyGuardianBindingGatewayWrites({
    channel: "phone",
    externalUserId: phoneNumber,
    deliveryChatId: chatId,
    guardianPrincipalId: canonicalPrincipal,
    verifiedVia: "challenge",
  });
}
