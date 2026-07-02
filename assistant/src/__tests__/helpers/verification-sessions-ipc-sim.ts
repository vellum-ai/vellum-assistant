/**
 * Test-only handler for `verification_sessions_*` gateway IPC methods.
 *
 * Delegates to the daemon's local session service — the gateway store ported
 * those semantics 1:1 — so integration tests keep seeding and asserting
 * against the local test DB while production code paths go through the
 * gateway session client. Wire in an `ipcCallPersistent` mock:
 *
 *   if (isVerificationSessionsIpcMethod(method)) {
 *     return handleVerificationSessionsIpc(method, params);
 *   }
 */

import { VERIFICATION_SESSIONS_IPC_METHODS } from "@vellumai/gateway-client";

import {
  bindSessionIdentity,
  countRecentSendsToDestination,
  createInboundVerificationSession,
  createOutboundSession,
  findActiveSession,
  getPendingSession,
  resolveBootstrapToken,
  revokePendingSessions,
  updateSessionDelivery,
  updateSessionStatus,
  validateAndConsumeVerification,
} from "../../runtime/channel-verification-service.js";

const METHOD_SET = new Set<string>(
  Object.values(VERIFICATION_SESSIONS_IPC_METHODS),
);

export function isVerificationSessionsIpcMethod(method: string): boolean {
  return METHOD_SET.has(method);
}

export function handleVerificationSessionsIpc(
  method: string,
  params: Record<string, unknown> = {},
): unknown {
  const M = VERIFICATION_SESSIONS_IPC_METHODS;
  const p = params as Record<string, never>;
  switch (method) {
    case M.createInbound: {
      const result = createInboundVerificationSession(
        p.channel,
        p.sourceConversationId,
      );
      const session = getPendingSession(p.channel);
      if (!session) {
        throw new Error("sim: no pending session after inbound create");
      }
      return {
        session,
        secret: result.secret,
        verifyCommand: result.verifyCommand,
        ttlSeconds: result.ttlSeconds,
      };
    }
    case M.createOutbound:
      return createOutboundSession(
        params as Parameters<typeof createOutboundSession>[0],
      );
    case M.getPending:
      return getPendingSession(p.channel);
    case M.findActive:
      return findActiveSession(p.channel);
    case M.resolveBootstrap:
      return resolveBootstrapToken(p.channel, p.token);
    case M.bindIdentity:
      bindSessionIdentity(p.sessionId, p.externalUserId, p.chatId);
      return { ok: true };
    case M.updateStatus: {
      const extra: Partial<{
        consumedByExternalUserId: string;
        consumedByChatId: string;
      }> = {};
      if (p.consumedByExternalUserId != null) {
        extra.consumedByExternalUserId = p.consumedByExternalUserId;
      }
      if (p.consumedByChatId != null) {
        extra.consumedByChatId = p.consumedByChatId;
      }
      updateSessionStatus(p.sessionId, p.status, extra);
      return { ok: true };
    }
    case M.updateDelivery:
      updateSessionDelivery(
        p.sessionId,
        p.lastSentAt,
        p.sendCount,
        p.nextResendAt ?? null,
      );
      return { ok: true };
    case M.countRecentSends:
      return {
        count: countRecentSendsToDestination(
          p.channel,
          p.destinationAddress,
          p.windowMs,
        ),
      };
    case M.revokePending:
      revokePendingSessions(p.channel);
      return { ok: true };
    case M.validateConsume:
      return validateAndConsumeVerification(
        p.channel,
        p.secret,
        p.actorExternalUserId,
        p.actorChatId,
      );
    default:
      throw new Error(`sim: unhandled verification_sessions method ${method}`);
  }
}
