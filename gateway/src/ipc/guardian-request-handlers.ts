/**
 * IPC route definitions for the gateway-native guardian-request lifecycle
 * (ATL-463).
 *
 * The gateway owns the `guardian_requests` + `guardian_request_deliveries`
 * tables; the daemon relays its guardian-request lifecycle operations here.
 * Request/response shapes are pinned by the shared contract in
 * `@vellumai/gateway-client` (guardian-request-contract.ts). Read methods
 * return the wire DTO (or null / an array); mutations return a minimal
 * `{ ok: true }` ack.
 *
 * `guardian_requests_decide` (decision CAS + in-transaction ACL outcomes) is
 * not registered here.
 */

import {
  CreateGuardianRequestDeliveryIpcParamsSchema,
  CreateGuardianRequestIpcParamsSchema,
  ExpireGuardianRequestIpcParamsSchema,
  ExpireInteractionBoundIpcParamsSchema,
  GUARDIAN_REQUESTS_IPC_METHODS,
  GetGuardianRequestByCallSessionIpcParamsSchema,
  GetGuardianRequestByCodeIpcParamsSchema,
  GetGuardianRequestByDestinationMessageIpcParamsSchema,
  GetGuardianRequestByPendingQuestionIpcParamsSchema,
  GetGuardianRequestIpcParamsSchema,
  GuardianRequestInScopeIpcParamsSchema,
  ListGuardianRequestDeliveriesIpcParamsSchema,
  ListGuardianRequestsIpcParamsSchema,
  ListPendingGuardianRequestsByDestinationIpcParamsSchema,
  ListPendingGuardianRequestsByScopeIpcParamsSchema,
  ReopenGuardianRequestIpcParamsSchema,
  SweepExpiredGuardianRequestsIpcParamsSchema,
  UpdateGuardianRequestDeliveryIpcParamsSchema,
  UpdateGuardianRequestIpcParamsSchema,
} from "@vellumai/gateway-client";
import { z } from "zod";

import {
  createGuardianRequest,
  createGuardianRequestDelivery,
  expireGuardianRequest,
  expireInteractionBoundRequests,
  getGuardianRequest,
  getGuardianRequestByCode,
  getPendingRequestByCallSession,
  getPendingRequestByDestinationMessage,
  getRequestByPendingQuestion,
  isGuardianRequestInScope,
  listGuardianRequestDeliveries,
  listGuardianRequests,
  listPendingRequestsByDestination,
  listPendingRequestsByScope,
  reopenGuardianRequest,
  sweepExpiredRequests,
  updateGuardianRequest,
  updateGuardianRequestDelivery,
} from "../approvals/guardian-request-service.js";
import type { IpcRoute } from "./server.js";

// The server validates req.params BEFORE the handler runs, and no-arg daemon
// callers (`ipcCallPersistent(method)`) send req.params === undefined — these
// two routes must accept the omitted-params call shape and default it to {}.
const ExpireInteractionBoundParamsSchema = z.preprocess(
  (v) => v ?? {},
  ExpireInteractionBoundIpcParamsSchema,
);
const SweepExpiredParamsSchema = z.preprocess(
  (v) => v ?? {},
  SweepExpiredGuardianRequestsIpcParamsSchema,
);

export const guardianRequestRoutes: IpcRoute[] = [
  {
    // Caller-supplied ids are load-bearing (deterministic access-request
    // ids; tool_approval rows reuse the pending-interaction requestId).
    method: GUARDIAN_REQUESTS_IPC_METHODS.create,
    schema: CreateGuardianRequestIpcParamsSchema,
    handler: (params?: Record<string, unknown>) => {
      const input = CreateGuardianRequestIpcParamsSchema.parse(params);
      return createGuardianRequest(input);
    },
  },
  {
    method: GUARDIAN_REQUESTS_IPC_METHODS.get,
    schema: GetGuardianRequestIpcParamsSchema,
    handler: (params?: Record<string, unknown>) => {
      const { id } = GetGuardianRequestIpcParamsSchema.parse(params);
      return getGuardianRequest(id);
    },
  },
  {
    // Pending requests only — a resolved request's code never matches.
    method: GUARDIAN_REQUESTS_IPC_METHODS.getByCode,
    schema: GetGuardianRequestByCodeIpcParamsSchema,
    handler: (params?: Record<string, unknown>) => {
      const { code } = GetGuardianRequestByCodeIpcParamsSchema.parse(params);
      return getGuardianRequestByCode(code);
    },
  },
  {
    // `sourceType` filters translate into source_channel predicates
    // gateway-side (the column is not stored).
    method: GUARDIAN_REQUESTS_IPC_METHODS.list,
    schema: ListGuardianRequestsIpcParamsSchema,
    handler: (params?: Record<string, unknown>) => {
      const filters = ListGuardianRequestsIpcParamsSchema.parse(params);
      return listGuardianRequests(filters);
    },
  },
  {
    method: GUARDIAN_REQUESTS_IPC_METHODS.update,
    schema: UpdateGuardianRequestIpcParamsSchema,
    handler: (params?: Record<string, unknown>) => {
      const { id, patch } = UpdateGuardianRequestIpcParamsSchema.parse(params);
      updateGuardianRequest(id, patch);
      return { ok: true };
    },
  },
  {
    // CAS `fromStatus` → pending; a missed swap acks without reopening.
    method: GUARDIAN_REQUESTS_IPC_METHODS.reopen,
    schema: ReopenGuardianRequestIpcParamsSchema,
    handler: (params?: Record<string, unknown>) => {
      const { id, fromStatus } =
        ReopenGuardianRequestIpcParamsSchema.parse(params);
      reopenGuardianRequest(id, fromStatus);
      return { ok: true };
    },
  },
  {
    // CAS pending → expired; the request's deliveries expire with it.
    method: GUARDIAN_REQUESTS_IPC_METHODS.expire,
    schema: ExpireGuardianRequestIpcParamsSchema,
    handler: (params?: Record<string, unknown>) => {
      const { id } = ExpireGuardianRequestIpcParamsSchema.parse(params);
      expireGuardianRequest(id);
      return { ok: true };
    },
  },
  {
    // Daemon-boot expiry (daemon-keyed — never run on gateway restart).
    method: GUARDIAN_REQUESTS_IPC_METHODS.expireInteractionBound,
    schema: ExpireInteractionBoundParamsSchema,
    handler: () => expireInteractionBoundRequests(),
  },
  {
    // Returns the expired ids for daemon-side notification fan-out.
    method: GUARDIAN_REQUESTS_IPC_METHODS.sweepExpired,
    schema: SweepExpiredParamsSchema,
    handler: (params?: Record<string, unknown>) => {
      const { now } = SweepExpiredParamsSchema.parse(params);
      return sweepExpiredRequests(now);
    },
  },
  {
    method: GUARDIAN_REQUESTS_IPC_METHODS.createDelivery,
    schema: CreateGuardianRequestDeliveryIpcParamsSchema,
    handler: (params?: Record<string, unknown>) => {
      const input = CreateGuardianRequestDeliveryIpcParamsSchema.parse(params);
      return createGuardianRequestDelivery(input);
    },
  },
  {
    method: GUARDIAN_REQUESTS_IPC_METHODS.updateDelivery,
    schema: UpdateGuardianRequestDeliveryIpcParamsSchema,
    handler: (params?: Record<string, unknown>) => {
      const { id, patch } =
        UpdateGuardianRequestDeliveryIpcParamsSchema.parse(params);
      updateGuardianRequestDelivery(id, patch);
      return { ok: true };
    },
  },
  {
    method: GUARDIAN_REQUESTS_IPC_METHODS.listDeliveries,
    schema: ListGuardianRequestDeliveriesIpcParamsSchema,
    handler: (params?: Record<string, unknown>) => {
      const { requestId } =
        ListGuardianRequestDeliveriesIpcParamsSchema.parse(params);
      return listGuardianRequestDeliveries(requestId);
    },
  },
  {
    // Reaction routing: the pending request whose delivered card is the
    // reacted-to message.
    method: GUARDIAN_REQUESTS_IPC_METHODS.getByDestinationMessage,
    schema: GetGuardianRequestByDestinationMessageIpcParamsSchema,
    handler: (params?: Record<string, unknown>) => {
      const { channel, chatId, messageId } =
        GetGuardianRequestByDestinationMessageIpcParamsSchema.parse(params);
      return getPendingRequestByDestinationMessage(channel, chatId, messageId);
    },
  },
  {
    // Reply routing: by destination conversation (optionally narrowed by
    // channel) or by channel + chat pair.
    method: GUARDIAN_REQUESTS_IPC_METHODS.listPendingByDestination,
    schema: ListPendingGuardianRequestsByDestinationIpcParamsSchema,
    handler: (params?: Record<string, unknown>) => {
      const input =
        ListPendingGuardianRequestsByDestinationIpcParamsSchema.parse(params);
      return listPendingRequestsByDestination(input);
    },
  },
  {
    method: GUARDIAN_REQUESTS_IPC_METHODS.listPendingByScope,
    schema: ListPendingGuardianRequestsByScopeIpcParamsSchema,
    handler: (params?: Record<string, unknown>) => {
      const { conversationId, channel } =
        ListPendingGuardianRequestsByScopeIpcParamsSchema.parse(params);
      return listPendingRequestsByScope(conversationId, channel);
    },
  },
  {
    method: GUARDIAN_REQUESTS_IPC_METHODS.inScope,
    schema: GuardianRequestInScopeIpcParamsSchema,
    handler: (params?: Record<string, unknown>) => {
      const { requestId, conversationId, channel } =
        GuardianRequestInScopeIpcParamsSchema.parse(params);
      return {
        inScope: isGuardianRequestInScope(requestId, conversationId, channel),
      };
    },
  },
  {
    method: GUARDIAN_REQUESTS_IPC_METHODS.getByCallSession,
    schema: GetGuardianRequestByCallSessionIpcParamsSchema,
    handler: (params?: Record<string, unknown>) => {
      const { callSessionId } =
        GetGuardianRequestByCallSessionIpcParamsSchema.parse(params);
      return getPendingRequestByCallSession(callSessionId);
    },
  },
  {
    method: GUARDIAN_REQUESTS_IPC_METHODS.getByPendingQuestion,
    schema: GetGuardianRequestByPendingQuestionIpcParamsSchema,
    handler: (params?: Record<string, unknown>) => {
      const { pendingQuestionId } =
        GetGuardianRequestByPendingQuestionIpcParamsSchema.parse(params);
      return getRequestByPendingQuestion(pendingQuestionId);
    },
  },
];
