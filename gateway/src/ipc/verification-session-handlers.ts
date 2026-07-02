/**
 * IPC route definitions for the gateway-native verification session
 * lifecycle (Combo 13).
 *
 * The gateway owns the `channel_verification_sessions` table: secrets are
 * minted in the session service, only hashes are persisted, and the daemon
 * relays its session lifecycle operations here via `ipcCallPersistent`.
 * Raw secrets transit back in the create responses because message
 * composition and channel delivery stay daemon-owned.
 *
 * These are the 10 lifecycle methods. `verification_sessions_validate_consume`
 * (gateway-native validation, rate limiting, and in-engine role side effects)
 * ships separately.
 *
 * Request/response shapes are pinned by the shared contract in
 * `@vellumai/gateway-client` (verification-session-contract.ts); the daemon
 * client validates responses against the same schemas. Read methods return
 * the wire DTO or null; mutations return a minimal `{ ok: true }` ack.
 */

import {
  BindSessionIdentityIpcParamsSchema,
  CountRecentSendsIpcParamsSchema,
  CreateInboundSessionIpcParamsSchema,
  CreateOutboundSessionIpcParamsSchema,
  FindActiveSessionIpcParamsSchema,
  GetPendingSessionIpcParamsSchema,
  ResolveBootstrapSessionIpcParamsSchema,
  RevokePendingSessionsIpcParamsSchema,
  UpdateSessionDeliveryIpcParamsSchema,
  UpdateSessionStatusIpcParamsSchema,
  VERIFICATION_SESSIONS_IPC_METHODS,
  hashVerificationSecret,
} from "@vellumai/gateway-client";

import {
  bindSessionIdentity,
  countRecentSendsToDestination,
  findActiveSession,
  findPendingSessionForChannel,
  findSessionByBootstrapTokenHash,
  revokePendingSessions,
  updateSessionDelivery,
  updateSessionStatus,
} from "../db/session-store.js";
import {
  createInboundVerificationSession,
  createOutboundSession,
} from "../verification/session-service.js";
import type { IpcRoute } from "./server.js";

export const verificationSessionRoutes: IpcRoute[] = [
  {
    // Mint a high-entropy inbound challenge; the raw secret returns to the
    // daemon, which composes the instruction copy and delivers it.
    method: VERIFICATION_SESSIONS_IPC_METHODS.createInbound,
    schema: CreateInboundSessionIpcParamsSchema,
    handler: (params?: Record<string, unknown>) => {
      const { channel, sourceConversationId } =
        CreateInboundSessionIpcParamsSchema.parse(params);
      return createInboundVerificationSession(channel, sourceConversationId);
    },
  },
  {
    // Mint an outbound session (numeric code when identity is bound,
    // 32-byte hex for pending_bootstrap); secret transits for delivery.
    method: VERIFICATION_SESSIONS_IPC_METHODS.createOutbound,
    schema: CreateOutboundSessionIpcParamsSchema,
    handler: (params?: Record<string, unknown>) => {
      const input = CreateOutboundSessionIpcParamsSchema.parse(params);
      return createOutboundSession(input);
    },
  },
  {
    // Pending inbound session for a channel ('pending' status only).
    method: VERIFICATION_SESSIONS_IPC_METHODS.getPending,
    schema: GetPendingSessionIpcParamsSchema,
    handler: (params?: Record<string, unknown>) => {
      const { channel } = GetPendingSessionIpcParamsSchema.parse(params);
      return findPendingSessionForChannel(channel);
    },
  },
  {
    // Most recent active outbound session (pending_bootstrap /
    // awaiting_response).
    method: VERIFICATION_SESSIONS_IPC_METHODS.findActive,
    schema: FindActiveSessionIpcParamsSchema,
    handler: (params?: Record<string, unknown>) => {
      const { channel } = FindActiveSessionIpcParamsSchema.parse(params);
      return findActiveSession(channel);
    },
  },
  {
    // The daemon relays the RAW deep-link token; hashing happens here so
    // the scheme stays pinned to the stored bootstrap_token_hash values.
    method: VERIFICATION_SESSIONS_IPC_METHODS.resolveBootstrap,
    schema: ResolveBootstrapSessionIpcParamsSchema,
    handler: (params?: Record<string, unknown>) => {
      const { channel, token } =
        ResolveBootstrapSessionIpcParamsSchema.parse(params);
      return findSessionByBootstrapTokenHash(
        channel,
        hashVerificationSecret(token),
      );
    },
  },
  {
    // Telegram bootstrap completion: bind identity fields and flip
    // identity_binding_status to bound.
    method: VERIFICATION_SESSIONS_IPC_METHODS.bindIdentity,
    schema: BindSessionIdentityIpcParamsSchema,
    handler: (params?: Record<string, unknown>) => {
      const { sessionId, externalUserId, chatId } =
        BindSessionIdentityIpcParamsSchema.parse(params);
      bindSessionIdentity(sessionId, externalUserId, chatId);
      return { ok: true };
    },
  },
  {
    method: VERIFICATION_SESSIONS_IPC_METHODS.updateStatus,
    schema: UpdateSessionStatusIpcParamsSchema,
    handler: (params?: Record<string, unknown>) => {
      const { sessionId, status, consumedByExternalUserId, consumedByChatId } =
        UpdateSessionStatusIpcParamsSchema.parse(params);
      updateSessionStatus(sessionId, status, {
        consumedByExternalUserId,
        consumedByChatId,
      });
      return { ok: true };
    },
  },
  {
    method: VERIFICATION_SESSIONS_IPC_METHODS.updateDelivery,
    schema: UpdateSessionDeliveryIpcParamsSchema,
    handler: (params?: Record<string, unknown>) => {
      const { sessionId, lastSentAt, sendCount, nextResendAt } =
        UpdateSessionDeliveryIpcParamsSchema.parse(params);
      updateSessionDelivery(sessionId, lastSentAt, sendCount, nextResendAt);
      return { ok: true };
    },
  },
  {
    // Destination-level send throttle input: sends to one address across
    // all sessions within a rolling window.
    method: VERIFICATION_SESSIONS_IPC_METHODS.countRecentSends,
    schema: CountRecentSendsIpcParamsSchema,
    handler: (params?: Record<string, unknown>) => {
      const { channel, destinationAddress, windowMs } =
        CountRecentSendsIpcParamsSchema.parse(params);
      return {
        count: countRecentSendsToDestination(
          channel,
          destinationAddress,
          windowMs,
        ),
      };
    },
  },
  {
    method: VERIFICATION_SESSIONS_IPC_METHODS.revokePending,
    schema: RevokePendingSessionsIpcParamsSchema,
    handler: (params?: Record<string, unknown>) => {
      const { channel } = RevokePendingSessionsIpcParamsSchema.parse(params);
      revokePendingSessions(channel);
      return { ok: true };
    },
  },
];
