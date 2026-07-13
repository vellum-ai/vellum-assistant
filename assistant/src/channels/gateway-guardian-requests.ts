/**
 * Gateway-backed guardian-request client.
 *
 * Typed async wrappers over the gateway's `guardian_requests_*` IPC routes.
 * The gateway owns the `guardian_requests` and `guardian_request_deliveries`
 * tables and applies decision ACL outcomes in the same transaction as the
 * status CAS; the daemon relays lifecycle operations here and keeps
 * notifications, card withdrawal, and other daemon-domain side effects.
 * Responses are validated against the shared contract schemas in
 * `@vellumai/gateway-client` — the same schemas the gateway routes are
 * pinned to.
 *
 * Error posture (fail-closed — there is no local fallback):
 * - Lifecycle writes (create, update, decide, expire, sweep, delivery
 *   writes) THROW on any transport failure or malformed response. A guardian
 *   decision that cannot persist must fail loudly, never fake success.
 * - Reads used for hints/dedup/scope THROW by default; ones whose only
 *   callers are deny paths that must degrade to "no data" instead of
 *   blocking are exported solely as a degrading variant (`...OrNull` /
 *   `...OrEmpty` / `...OrFalse`) that logs the failure and returns the
 *   empty value.
 */

import {
  type CreateGuardianRequestDeliveryIpcParams,
  CreateGuardianRequestDeliveryIpcResponseSchema,
  type CreateGuardianRequestIpcParams,
  CreateGuardianRequestIpcResponseSchema,
  type DecideGuardianRequestIpcParams,
  type DecideGuardianRequestIpcResponse,
  DecideGuardianRequestIpcResponseSchema,
  ExpireInteractionBoundIpcResponseSchema,
  GUARDIAN_REQUESTS_IPC_METHODS,
  GuardianRequestDeliveryListIpcResponseSchema,
  type GuardianRequestDeliveryWire,
  GuardianRequestInScopeIpcResponseSchema,
  GuardianRequestListIpcResponseSchema,
  GuardianRequestLookupIpcResponseSchema,
  GuardianRequestMutationIpcResponseSchema,
  type GuardianRequestPatch,
  type GuardianRequestsIpcMethod,
  type GuardianRequestWire,
  type ListGuardianRequestsIpcParams,
  type ListPendingGuardianRequestsByDestinationIpcParams,
  SweepExpiredGuardianRequestsIpcResponseSchema,
  type UpdateGuardianRequestDeliveryIpcParams,
} from "@vellumai/gateway-client";
import type { ZodType } from "zod";

import { ipcCallPersistentValidated } from "../ipc/gateway-validated-call.js";
import { getLogger } from "../util/logger.js";

export type {
  CreateGuardianRequestIpcParams,
  DecideGuardianRequestIpcParams,
  DecideGuardianRequestIpcResponse,
  GuardianRequestAclOutcome,
  GuardianRequestDeliveryWire,
  GuardianRequestPatch,
  GuardianRequestStatus,
  GuardianRequestWire,
} from "@vellumai/gateway-client";

const log = getLogger("gateway-guardian-requests");

/**
 * Call a gateway guardian-request route and validate the response against
 * its contract schema. Throws on transport failure or a malformed response
 * (shared helper; typed to the guardian-request method union).
 */
async function callGateway<T>(
  method: GuardianRequestsIpcMethod,
  params: Record<string, unknown>,
  responseSchema: ZodType<T>,
): Promise<T> {
  return ipcCallPersistentValidated(method, params, responseSchema);
}

/** Call a mutation route; throws unless the gateway acks `{ ok: true }`. */
async function callMutation(
  method: GuardianRequestsIpcMethod,
  params: Record<string, unknown>,
): Promise<void> {
  await callGateway(method, params, GuardianRequestMutationIpcResponseSchema);
}

/**
 * Wrap a read so any failure — transport included — degrades to `fallback`
 * (logged) instead of throwing, for deny-path callers.
 */
function degradeOnFailure<Args extends unknown[], T>(
  read: (...args: Args) => Promise<T>,
  fallback: T,
): (...args: Args) => Promise<T> {
  return async (...args: Args): Promise<T> => {
    try {
      return await read(...args);
    } catch (err) {
      log.warn(
        { err, read: read.name },
        "gateway guardian-request read degraded to fallback",
      );
      return fallback;
    }
  };
}

/**
 * Create a guardian request. `id` and `guardianPrincipalId` are required —
 * request ids are caller-supplied and load-bearing. Throws on any failure
 * (fail-closed).
 */
export async function createGuardianRequest(
  params: CreateGuardianRequestIpcParams,
): Promise<GuardianRequestWire> {
  return callGateway(
    GUARDIAN_REQUESTS_IPC_METHODS.create,
    params as unknown as Record<string, unknown>,
    CreateGuardianRequestIpcResponseSchema,
  );
}

/** Look up a guardian request by id. Throws on transport failure. */
export async function getGuardianRequest(
  id: string,
): Promise<GuardianRequestWire | null> {
  return callGateway(
    GUARDIAN_REQUESTS_IPC_METHODS.get,
    { id },
    GuardianRequestLookupIpcResponseSchema,
  );
}

/** `getGuardianRequest` for deny-path callers: failures degrade to null. */
export const getGuardianRequestOrNull = degradeOnFailure(
  getGuardianRequest,
  null,
);

/**
 * Look up a PENDING guardian request by its short request code. Throws on
 * transport failure.
 */
async function getGuardianRequestByCode(
  code: string,
): Promise<GuardianRequestWire | null> {
  return callGateway(
    GUARDIAN_REQUESTS_IPC_METHODS.getByCode,
    { code },
    GuardianRequestLookupIpcResponseSchema,
  );
}

/** `getGuardianRequestByCode` for deny-path callers: degrades to null. */
export const getGuardianRequestByCodeOrNull = degradeOnFailure(
  getGuardianRequestByCode,
  null,
);

/** List guardian requests matching the filters. Throws on transport failure. */
async function listGuardianRequests(
  filters: ListGuardianRequestsIpcParams = {},
): Promise<GuardianRequestWire[]> {
  return callGateway(
    GUARDIAN_REQUESTS_IPC_METHODS.list,
    filters as unknown as Record<string, unknown>,
    GuardianRequestListIpcResponseSchema,
  );
}

/** `listGuardianRequests` for deny-path callers: degrades to []. */
export const listGuardianRequestsOrEmpty = degradeOnFailure(
  listGuardianRequests,
  [],
);

/** Apply a partial patch to a guardian request. Throws on any failure. */
export async function updateGuardianRequest(
  id: string,
  patch: GuardianRequestPatch,
): Promise<void> {
  await callMutation(GUARDIAN_REQUESTS_IPC_METHODS.update, { id, patch });
}

/**
 * Decide a pending guardian request: status CAS plus the optional ACL
 * outcome, committed in one gateway transaction. A CAS miss returns
 * `{ applied: false, reason: "status_conflict" }` with zero side effects;
 * on success `mintedSession` carries the raw outbound-session secret when
 * the outcome minted one. Throws on any transport failure or malformed
 * response (fail-closed — a decision that cannot persist fails loudly).
 */
export async function decideGuardianRequest(
  params: DecideGuardianRequestIpcParams,
): Promise<DecideGuardianRequestIpcResponse> {
  return callGateway(
    GUARDIAN_REQUESTS_IPC_METHODS.decide,
    params as unknown as Record<string, unknown>,
    DecideGuardianRequestIpcResponseSchema,
  );
}

/**
 * Expire a pending request (CAS pending → expired; the gateway also expires
 * its deliveries). Throws on any failure (fail-closed).
 */
export async function expireGuardianRequest(id: string): Promise<void> {
  await callMutation(GUARDIAN_REQUESTS_IPC_METHODS.expire, { id });
}

/**
 * Daemon-boot expiry: interaction-bound kinds die with the daemon's
 * in-memory pendingInteractions map, plus persistent kinds already past
 * `expiresAt`. Returns the expired count. Throws on any failure
 * (fail-closed).
 */
export async function expireInteractionBoundGuardianRequests(): Promise<number> {
  const response = await callGateway(
    GUARDIAN_REQUESTS_IPC_METHODS.expireInteractionBound,
    {},
    ExpireInteractionBoundIpcResponseSchema,
  );
  return response.expired;
}

/**
 * Sweep persistent requests past their `expiresAt` (gateway CAS-expires;
 * `now` defaults gateway-side). Returns the expired rows so the daemon fan-out
 * needs no follow-up read. Throws on any failure (fail-closed).
 */
export async function sweepExpiredGuardianRequests(
  now?: number,
): Promise<GuardianRequestWire[]> {
  const response = await callGateway(
    GUARDIAN_REQUESTS_IPC_METHODS.sweepExpired,
    { now },
    SweepExpiredGuardianRequestsIpcResponseSchema,
  );
  return response.expired;
}

/**
 * Record a delivery of a guardian-request card to a destination. Throws on
 * any failure (fail-closed).
 */
export async function createGuardianRequestDelivery(
  params: CreateGuardianRequestDeliveryIpcParams,
): Promise<GuardianRequestDeliveryWire> {
  return callGateway(
    GUARDIAN_REQUESTS_IPC_METHODS.createDelivery,
    params as unknown as Record<string, unknown>,
    CreateGuardianRequestDeliveryIpcResponseSchema,
  );
}

/** Patch a delivery record. Throws on any failure (fail-closed). */
export async function updateGuardianRequestDelivery(
  id: string,
  patch: UpdateGuardianRequestDeliveryIpcParams["patch"],
): Promise<void> {
  await callMutation(GUARDIAN_REQUESTS_IPC_METHODS.updateDelivery, {
    id,
    patch,
  });
}

/** List a request's delivery records. Throws on transport failure. */
export async function listGuardianRequestDeliveries(
  requestId: string,
): Promise<GuardianRequestDeliveryWire[]> {
  return callGateway(
    GUARDIAN_REQUESTS_IPC_METHODS.listDeliveries,
    { requestId },
    GuardianRequestDeliveryListIpcResponseSchema,
  );
}

/** `listGuardianRequestDeliveries` for deny-path callers: degrades to []. */
export const listGuardianRequestDeliveriesOrEmpty = degradeOnFailure(
  listGuardianRequestDeliveries,
  [],
);

/**
 * Reaction routing: the pending request whose delivered card is the
 * reacted-to message. Throws on transport failure.
 */
async function getPendingRequestByDestinationMessage(
  channel: string,
  chatId: string,
  messageId: string,
): Promise<GuardianRequestWire | null> {
  return callGateway(
    GUARDIAN_REQUESTS_IPC_METHODS.getByDestinationMessage,
    { channel, chatId, messageId },
    GuardianRequestLookupIpcResponseSchema,
  );
}

/** `getPendingRequestByDestinationMessage` deny-path variant: degrades to null. */
export const getPendingRequestByDestinationMessageOrNull = degradeOnFailure(
  getPendingRequestByDestinationMessage,
  null,
);

/**
 * Reply routing: pending requests delivered to a destination conversation
 * (`conversationId`, optionally narrowed by `channel`) or chat
 * (`channel` + `chatId`). Throws on transport failure.
 */
async function listPendingRequestsByDestination(
  params: ListPendingGuardianRequestsByDestinationIpcParams,
): Promise<GuardianRequestWire[]> {
  return callGateway(
    GUARDIAN_REQUESTS_IPC_METHODS.listPendingByDestination,
    params as unknown as Record<string, unknown>,
    GuardianRequestListIpcResponseSchema,
  );
}

/** `listPendingRequestsByDestination` deny-path variant: degrades to []. */
export const listPendingRequestsByDestinationOrEmpty = degradeOnFailure(
  listPendingRequestsByDestination,
  [],
);

/**
 * Pending requests sourced from OR delivered to the conversation,
 * deduplicated, non-expired. Throws on transport failure.
 */
export async function listPendingRequestsByScope(
  conversationId: string,
  channel?: string,
): Promise<GuardianRequestWire[]> {
  return callGateway(
    GUARDIAN_REQUESTS_IPC_METHODS.listPendingByScope,
    { conversationId, channel },
    GuardianRequestListIpcResponseSchema,
  );
}

/** `listPendingRequestsByScope` deny-path variant: degrades to []. */
export const listPendingRequestsByScopeOrEmpty = degradeOnFailure(
  listPendingRequestsByScope,
  [],
);

/**
 * Is a decision from this conversation allowed for the request (source
 * match, or delivery match optionally narrowed by `channel`)? Throws on
 * transport failure.
 */
async function isGuardianRequestInScope(
  requestId: string,
  conversationId: string,
  channel?: string,
): Promise<boolean> {
  const response = await callGateway(
    GUARDIAN_REQUESTS_IPC_METHODS.inScope,
    { requestId, conversationId, channel },
    GuardianRequestInScopeIpcResponseSchema,
  );
  return response.inScope;
}

/** `isGuardianRequestInScope` deny-path variant: degrades to false (not in scope). */
export const isGuardianRequestInScopeOrFalse = degradeOnFailure(
  isGuardianRequestInScope,
  false,
);

/**
 * Latest pending request for a live voice call session (mid-call guardian
 * wait polling). Throws on transport failure.
 */
export async function getPendingRequestByCallSession(
  callSessionId: string,
): Promise<GuardianRequestWire | null> {
  return callGateway(
    GUARDIAN_REQUESTS_IPC_METHODS.getByCallSession,
    { callSessionId },
    GuardianRequestLookupIpcResponseSchema,
  );
}

/** `getPendingRequestByCallSession` deny-path variant: degrades to null. */
export const getPendingRequestByCallSessionOrNull = degradeOnFailure(
  getPendingRequestByCallSession,
  null,
);

/**
 * The request carrying a specific voice pending-question id. Throws on
 * transport failure.
 */
async function getRequestByPendingQuestion(
  pendingQuestionId: string,
): Promise<GuardianRequestWire | null> {
  return callGateway(
    GUARDIAN_REQUESTS_IPC_METHODS.getByPendingQuestion,
    { pendingQuestionId },
    GuardianRequestLookupIpcResponseSchema,
  );
}

/** `getRequestByPendingQuestion` deny-path variant: degrades to null. */
export const getRequestByPendingQuestionOrNull = degradeOnFailure(
  getRequestByPendingQuestion,
  null,
);
