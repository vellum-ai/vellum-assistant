/**
 * Gateway-native guardian-request service (ATL-463).
 *
 * Thin lifecycle layer over the guardian-request store, serving the
 * `guardian_requests_*` IPC routes. Store-row ↔ wire-DTO mapping lives here:
 * the row type is the wire DTO minus `sourceType`, which the mapper computes
 * from `sourceChannel` (phone → voice, vellum → desktop, else channel).
 *
 * Create integrity: the store throws `GuardianRequestIntegrityError` (with a
 * machine-readable `code` the IPC error envelope mirrors into `errorCode`)
 * when a decisionable kind lacks `guardianPrincipalId`; the create IPC schema
 * enforces the same invariant at the boundary.
 *
 * The decision path (`guardian_requests_decide`) is not part of this
 * surface.
 */

import type {
  CreateGuardianRequestDeliveryIpcParams,
  CreateGuardianRequestIpcParams,
  ExpireInteractionBoundIpcResponse,
  GuardianRequestDeliveryWire,
  GuardianRequestPatch,
  GuardianRequestStatus,
  GuardianRequestWire,
  ListGuardianRequestsIpcParams,
  ListPendingGuardianRequestsByDestinationIpcParams,
  SweepExpiredGuardianRequestsIpcResponse,
  UpdateGuardianRequestDeliveryIpcParams,
} from "@vellumai/gateway-client";

import type { GuardianRequest } from "../db/guardian-request-store.js";
import {
  createDelivery,
  createGuardianRequest as storeCreateGuardianRequest,
  deriveSourceType,
  expireAllPendingInteractionBound,
  expireGuardianRequest as storeExpireGuardianRequest,
  getByPendingQuestionId,
  getGuardianRequest as storeGetGuardianRequest,
  getGuardianRequestByCode as storeGetGuardianRequestByCode,
  getPendingByCallSessionId,
  getPendingByDestinationMessage,
  isRequestInConversationScope,
  listDeliveries,
  listGuardianRequests as storeListGuardianRequests,
  listPendingByConversationScope,
  listPendingByDestinationChat,
  listPendingByDestinationConversation,
  resolveGuardianRequest,
  sweepExpiredGuardianRequests,
  updateDelivery,
  updateGuardianRequest as storeUpdateGuardianRequest,
} from "../db/guardian-request-store.js";

/** Map a store row onto the wire DTO by computing `sourceType`. */
export function toGuardianRequestWire(
  row: GuardianRequest,
): GuardianRequestWire {
  return { ...row, sourceType: deriveSourceType(row.sourceChannel) };
}

function toWireOrNull(row: GuardianRequest | null): GuardianRequestWire | null {
  return row ? toGuardianRequestWire(row) : null;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function createGuardianRequest(
  params: CreateGuardianRequestIpcParams,
): GuardianRequestWire {
  return toGuardianRequestWire(storeCreateGuardianRequest(params));
}

export function getGuardianRequest(id: string): GuardianRequestWire | null {
  return toWireOrNull(storeGetGuardianRequest(id));
}

/** Pending requests only — resolved requests never match by code. */
export function getGuardianRequestByCode(
  code: string,
): GuardianRequestWire | null {
  return toWireOrNull(storeGetGuardianRequestByCode(code));
}

export function listGuardianRequests(
  filters: ListGuardianRequestsIpcParams,
): GuardianRequestWire[] {
  return storeListGuardianRequests(filters).map(toGuardianRequestWire);
}

export function updateGuardianRequest(
  id: string,
  patch: GuardianRequestPatch,
): void {
  storeUpdateGuardianRequest(id, patch);
}

/** CAS reopen (`fromStatus` → pending); a missed swap is a no-op. */
export function reopenGuardianRequest(
  id: string,
  fromStatus: GuardianRequestStatus,
): void {
  resolveGuardianRequest(id, fromStatus, { status: "pending" });
}

export function expireGuardianRequest(id: string): void {
  storeExpireGuardianRequest(id);
}

/**
 * Daemon-boot expiry: interaction-bound kinds unconditionally, persistent
 * kinds only past their `expiresAt`. Returns the expired-row count.
 */
export function expireInteractionBoundRequests(): ExpireInteractionBoundIpcResponse {
  return { expired: expireAllPendingInteractionBound() };
}

/**
 * Deadline sweep: CAS-expires past-`expiresAt` pending requests and returns
 * their ids for daemon-side card-withdrawal / notification fan-out.
 */
export function sweepExpiredRequests(
  now?: number,
): SweepExpiredGuardianRequestsIpcResponse {
  return { expired: sweepExpiredGuardianRequests(now) };
}

// ---------------------------------------------------------------------------
// Deliveries
// ---------------------------------------------------------------------------

export function createGuardianRequestDelivery(
  params: CreateGuardianRequestDeliveryIpcParams,
): GuardianRequestDeliveryWire {
  return createDelivery(params);
}

export function updateGuardianRequestDelivery(
  id: string,
  patch: UpdateGuardianRequestDeliveryIpcParams["patch"],
): void {
  updateDelivery(id, patch);
}

export function listGuardianRequestDeliveries(
  requestId: string,
): GuardianRequestDeliveryWire[] {
  return listDeliveries(requestId);
}

// ---------------------------------------------------------------------------
// Destination + scope lookups
// ---------------------------------------------------------------------------

/** Reaction routing: the pending request delivered as a specific message. */
export function getPendingRequestByDestinationMessage(
  channel: string,
  chatId: string,
  messageId: string,
): GuardianRequestWire | null {
  return toWireOrNull(
    getPendingByDestinationMessage(channel, chatId, messageId),
  );
}

/**
 * Reply routing: pending requests delivered to a destination conversation
 * (optionally narrowed by channel) or to a channel + chat pair.
 */
export function listPendingRequestsByDestination(
  params: ListPendingGuardianRequestsByDestinationIpcParams,
): GuardianRequestWire[] {
  if (params.conversationId) {
    return listPendingByDestinationConversation(
      params.conversationId,
      params.channel,
    ).map(toGuardianRequestWire);
  }
  if (params.channel && params.chatId) {
    return listPendingByDestinationChat(params.channel, params.chatId).map(
      toGuardianRequestWire,
    );
  }
  throw new Error("conversationId or channel+chatId required");
}

export function listPendingRequestsByScope(
  conversationId: string,
  channel?: string,
): GuardianRequestWire[] {
  return listPendingByConversationScope(conversationId, channel).map(
    toGuardianRequestWire,
  );
}

export function isGuardianRequestInScope(
  requestId: string,
  conversationId: string,
  channel?: string,
): boolean {
  return isRequestInConversationScope(requestId, conversationId, channel);
}

export function getPendingRequestByCallSession(
  callSessionId: string,
): GuardianRequestWire | null {
  return toWireOrNull(getPendingByCallSessionId(callSessionId));
}

export function getRequestByPendingQuestion(
  pendingQuestionId: string,
): GuardianRequestWire | null {
  return toWireOrNull(getByPendingQuestionId(pendingQuestionId));
}
