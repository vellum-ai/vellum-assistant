/**
 * Gateway-backed verification-session client.
 *
 * Typed async wrappers over the gateway's `verification_sessions_*` IPC
 * routes. The gateway owns the `channel_verification_sessions` table and
 * mints all secrets; the daemon relays lifecycle operations here and keeps
 * message composition and channel delivery. Responses are validated against
 * the shared contract schemas in `@vellumai/gateway-client` — the same
 * schemas the gateway routes are pinned to.
 *
 * Export names mirror the daemon session service
 * (`assistant/src/runtime/channel-verification-service.ts`) so call-site
 * flips are mechanical: same names, same result shapes, sync → async.
 *
 * Error posture (fail-closed — there is no local fallback):
 * - Lifecycle wrappers THROW on any transport failure or malformed
 *   response. Control-plane callers surface the error to the user;
 *   inbound-stage callers catch and degrade to a plain deny.
 * - `validateAndConsumeVerification` never throws: any failure — transport
 *   included — is the generic invalid-code result, preserving the consume
 *   path's anti-oracle posture (no signal about WHY a code was rejected).
 */

import {
  CountRecentSendsIpcResponseSchema,
  CreateInboundSessionIpcResponseSchema,
  CreateOutboundSessionConditionalIpcResponseSchema,
  type CreateOutboundSessionConflict,
  type CreateOutboundSessionIpcParams,
  CreateOutboundSessionIpcResponseSchema,
  SessionLookupIpcResponseSchema,
  SessionMutationIpcResponseSchema,
  type SessionStatus,
  ValidateConsumeSessionIpcResponseSchema,
  VERIFICATION_SESSIONS_IPC_METHODS,
  type VerificationSessionsIpcMethod,
  type VerificationSessionWire,
} from "@vellumai/gateway-client";
import type { ZodType } from "zod";

import { ipcCallPersistent } from "../ipc/gateway-client.js";
import { composeApprovalMessage } from "../runtime/approval-message-composer.js";
import type {
  CreateOutboundSessionResult,
  CreateVerificationSessionResult,
  ValidateVerificationResult,
} from "../runtime/channel-verification-service.js";

export type {
  CreateOutboundSessionResult,
  CreateVerificationSessionResult,
  ValidateVerificationResult,
} from "../runtime/channel-verification-service.js";
export type { VerificationSessionWire } from "@vellumai/gateway-client";

/**
 * Call a gateway session route and validate the response against its
 * contract schema. Throws on transport failure or a malformed response.
 */
async function callGateway<T>(
  method: VerificationSessionsIpcMethod,
  params: Record<string, unknown>,
  responseSchema: ZodType<T>,
): Promise<T> {
  const result = await ipcCallPersistent(method, params);
  const parsed = responseSchema.safeParse(result);
  if (!parsed.success) {
    throw new Error(`Gateway returned a malformed ${method} response`);
  }
  return parsed.data;
}

/** Call a mutation route; throws unless the gateway acks `{ ok: true }`. */
async function callMutation(
  method: VerificationSessionsIpcMethod,
  params: Record<string, unknown>,
): Promise<void> {
  const ack = await callGateway(method, params, SessionMutationIpcResponseSchema);
  if (!ack.ok) {
    throw new Error(`Gateway rejected ${method}`);
  }
}

/**
 * Create an inbound verification session for a guardian candidate. The
 * gateway mints the high-entropy secret and persists only its hash; the
 * `instruction` copy is composed daemon-side from the returned secret.
 * Throws when the gateway is unreachable (fail-closed, user-visible).
 */
export async function createInboundVerificationSession(
  channel: string,
  conversationId?: string,
): Promise<CreateVerificationSessionResult> {
  const response = await callGateway(
    VERIFICATION_SESSIONS_IPC_METHODS.createInbound,
    { channel, sourceConversationId: conversationId },
    CreateInboundSessionIpcResponseSchema,
  );
  return {
    challengeId: response.session.id,
    secret: response.secret,
    verifyCommand: response.verifyCommand,
    ttlSeconds: response.ttlSeconds,
    instruction: composeApprovalMessage({
      scenario: "guardian_verify_challenge_setup",
      channel,
      verifyCommand: response.verifyCommand,
    }),
  };
}

/**
 * Create an outbound verification session with expected identity pre-set.
 * The gateway mints the secret (numeric when identity is bound, hex for
 * `pending_bootstrap`); it transits back for daemon-owned delivery.
 * Throws when the gateway is unreachable (fail-closed, user-visible).
 */
export async function createOutboundSession(
  params: CreateOutboundSessionIpcParams,
): Promise<CreateOutboundSessionResult> {
  return callGateway(
    VERIFICATION_SESSIONS_IPC_METHODS.createOutbound,
    params as unknown as Record<string, unknown>,
    CreateOutboundSessionIpcResponseSchema,
  );
}

/**
 * Guarded variant of `createOutboundSession` for callers passing an atomic
 * claim guard (`requireSourceSessionPending` / `ifNoneActive`). The gateway
 * evaluates the guard in the same synchronous section as the mint; a failed
 * guard returns a conflict marker instead of revoking the concurrent
 * winner's session. Throws when the gateway is unreachable (fail-closed).
 */
export async function createOutboundSessionConditional(
  params: CreateOutboundSessionIpcParams,
): Promise<CreateOutboundSessionResult | CreateOutboundSessionConflict> {
  return callGateway(
    VERIFICATION_SESSIONS_IPC_METHODS.createOutbound,
    params as unknown as Record<string, unknown>,
    CreateOutboundSessionConditionalIpcResponseSchema,
  );
}

/**
 * Look up the pending (status `pending`, non-expired) inbound session for a
 * channel. Throws when the gateway is unreachable — callers on soft paths
 * catch and treat the read as inconclusive.
 */
export async function getPendingSession(
  channel: string,
): Promise<VerificationSessionWire | null> {
  return callGateway(
    VERIFICATION_SESSIONS_IPC_METHODS.getPending,
    { channel },
    SessionLookupIpcResponseSchema,
  );
}

/**
 * Find the most recent active outbound session (`pending_bootstrap` /
 * `awaiting_response`) for a channel. Throws when the gateway is
 * unreachable — callers on soft paths catch and treat the read as
 * inconclusive.
 */
export async function findActiveSession(
  channel: string,
): Promise<VerificationSessionWire | null> {
  return callGateway(
    VERIFICATION_SESSIONS_IPC_METHODS.findActive,
    { channel },
    SessionLookupIpcResponseSchema,
  );
}

/**
 * Resolve a bootstrap deep-link token to its `pending_bootstrap` session.
 * Takes the RAW token — hashing happens gateway-side so the scheme stays
 * pinned to the stored `bootstrap_token_hash` values. Throws when the
 * gateway is unreachable.
 */
export async function resolveBootstrapToken(
  channel: string,
  token: string,
): Promise<VerificationSessionWire | null> {
  return callGateway(
    VERIFICATION_SESSIONS_IPC_METHODS.resolveBootstrap,
    { channel, token },
    SessionLookupIpcResponseSchema,
  );
}

/**
 * Telegram bootstrap completion: bind the expected identity fields and flip
 * `identity_binding_status` to bound. Throws on any failure (fail-closed).
 */
export async function bindSessionIdentity(
  id: string,
  externalUserId: string,
  chatId: string,
): Promise<void> {
  await callMutation(VERIFICATION_SESSIONS_IPC_METHODS.bindIdentity, {
    sessionId: id,
    externalUserId,
    chatId,
  });
}

/**
 * Transition a session's status. Throws on any failure (fail-closed).
 */
export async function updateSessionStatus(
  id: string,
  status: SessionStatus,
  extraFields?: Partial<{
    consumedByExternalUserId: string;
    consumedByChatId: string;
  }>,
): Promise<void> {
  await callMutation(VERIFICATION_SESSIONS_IPC_METHODS.updateStatus, {
    sessionId: id,
    status,
    consumedByExternalUserId: extraFields?.consumedByExternalUserId,
    consumedByChatId: extraFields?.consumedByChatId,
  });
}

/**
 * Update outbound delivery tracking fields on a session. Throws on any
 * failure (fail-closed).
 */
export async function updateSessionDelivery(
  id: string,
  lastSentAt: number,
  sendCount: number,
  nextResendAt: number | null,
): Promise<void> {
  await callMutation(VERIFICATION_SESSIONS_IPC_METHODS.updateDelivery, {
    sessionId: id,
    lastSentAt,
    sendCount,
    nextResendAt,
  });
}

/**
 * Count sends to a destination across all sessions within a rolling window
 * (destination-level send throttle input). Throws when the gateway is
 * unreachable — the throttle must not fail open.
 */
export async function countRecentSendsToDestination(
  channel: string,
  destinationAddress: string,
  windowMs: number,
): Promise<number> {
  const response = await callGateway(
    VERIFICATION_SESSIONS_IPC_METHODS.countRecentSends,
    { channel, destinationAddress, windowMs },
    CountRecentSendsIpcResponseSchema,
  );
  return response.count;
}

/**
 * Revoke all pending sessions for a channel (user cancelled verification).
 * Throws on any failure (fail-closed).
 */
export async function revokePendingSessions(channel: string): Promise<void> {
  await callMutation(VERIFICATION_SESSIONS_IPC_METHODS.revokePending, {
    channel,
  });
}

function genericVerifyFailedReason(): string {
  return composeApprovalMessage({
    scenario: "guardian_verify_failed",
    failureReason: "The verification code is invalid or has expired.",
  });
}

/**
 * Validate and consume a verification challenge at the gateway (rate
 * limiting, identity binding, status-guarded single consume, in-engine role
 * side effects).
 *
 * Never throws. Every failure — including gateway-unreachable and malformed
 * responses — returns the same generic invalid-code result: the consume
 * path is fail-closed and anti-oracle, so the machine-readable gateway
 * reason is deliberately not surfaced to the actor.
 */
export async function validateAndConsumeVerification(
  channel: string,
  secret: string,
  actorExternalUserId: string,
  actorChatId: string,
): Promise<ValidateVerificationResult> {
  try {
    const response = await callGateway(
      VERIFICATION_SESSIONS_IPC_METHODS.validateConsume,
      { channel, secret, actorExternalUserId, actorChatId },
      ValidateConsumeSessionIpcResponseSchema,
    );
    if (response.success) {
      return { success: true, verificationType: response.verificationType };
    }
    return { success: false, reason: genericVerifyFailedReason() };
  } catch {
    return { success: false, reason: genericVerifyFailedReason() };
  }
}
