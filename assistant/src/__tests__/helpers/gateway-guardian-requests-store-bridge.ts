/**
 * Test-only bridge that serves the daemon's gateway guardian-request client
 * surface from the assistant's local `canonical-guardian-store` (the exact
 * semantics the gateway store ports).
 *
 * Wire it in with a module mock so flows run without a live gateway while the
 * rest of the guardian machinery (decision primitive, reply routing, card
 * withdrawal) still reads the assistant tables:
 *
 *   mock.module("../channels/gateway-guardian-requests.js", () =>
 *     gatewayGuardianRequestsStoreBridge,
 *   );
 *
 * Create params are validated against the shared contract schema — the same
 * validation the gateway route applies — so malformed daemon params fail here
 * exactly as they would on the wire. `sourceType` is computed from
 * `sourceChannel` the way the gateway mapper does (phone → voice, vellum →
 * desktop, else channel); the list filter translates a `sourceType` filter
 * onto channels the same way.
 */

import {
  type CreateGuardianRequestDeliveryIpcParams,
  CreateGuardianRequestDeliveryIpcParamsSchema,
  type CreateGuardianRequestIpcParams,
  CreateGuardianRequestIpcParamsSchema,
  type DecideGuardianRequestIpcParams,
  DecideGuardianRequestIpcParamsSchema,
  type DecideGuardianRequestIpcResponse,
  type GuardianRequestAclOutcome,
  type GuardianRequestDeliveryWire,
  type GuardianRequestPatch,
  type GuardianRequestSourceType,
  type GuardianRequestStatus,
  type GuardianRequestWire,
  type ListGuardianRequestsIpcParams,
  type ListPendingGuardianRequestsByDestinationIpcParams,
  type UpdateGuardianRequestDeliveryIpcParams,
} from "@vellumai/gateway-client";

import type { CanonicalGuardianRequest } from "../../contacts/canonical-guardian-store.js";

// Store access is deferred to call time so importing this helper installs no
// production coupling before a test's own setup/mocks run (per the shared
// test-helper rule in assistant/AGENTS.md).
function store() {
  return import("../../contacts/canonical-guardian-store.js");
}

function deriveSourceType(
  sourceChannel: string | null,
): GuardianRequestSourceType {
  if (sourceChannel === "phone") {
    return "voice";
  }
  if (sourceChannel === "vellum") {
    return "desktop";
  }
  return "channel";
}

/** Map an assistant-store row onto the gateway wire DTO. */
export function toGuardianRequestWire(
  row: CanonicalGuardianRequest,
): GuardianRequestWire {
  const { sourceType: _stored, conversationId, trigger, ...rest } = row;
  return {
    ...rest,
    sourceType: deriveSourceType(row.sourceChannel),
    sourceConversationId: conversationId,
    requestTrigger: trigger,
  };
}

async function createGuardianRequest(
  params: CreateGuardianRequestIpcParams,
): Promise<GuardianRequestWire> {
  const parsed = CreateGuardianRequestIpcParamsSchema.parse(params);
  const { sourceConversationId, requestTrigger, ...rest } = parsed;
  return toGuardianRequestWire(
    (await store()).createCanonicalGuardianRequest({
      ...rest,
      sourceType: deriveSourceType(parsed.sourceChannel ?? null),
      conversationId: sourceConversationId,
      trigger: requestTrigger,
    }),
  );
}

async function listGuardianRequests(
  filters: ListGuardianRequestsIpcParams = {},
): Promise<GuardianRequestWire[]> {
  const { sourceType, sourceConversationId, ...rest } = filters;
  let rows = (await store()).listCanonicalGuardianRequests({
    ...rest,
    conversationId: sourceConversationId,
    // voice/desktop translate to one channel; "channel" filters below.
    ...(sourceType === "voice" ? { sourceChannel: "phone" } : {}),
    ...(sourceType === "desktop" ? { sourceChannel: "vellum" } : {}),
  });
  if (sourceType === "channel") {
    rows = rows.filter(
      (row) => row.sourceChannel !== "phone" && row.sourceChannel !== "vellum",
    );
  }
  return rows.map(toGuardianRequestWire);
}

async function createGuardianRequestDelivery(
  params: CreateGuardianRequestDeliveryIpcParams,
): Promise<GuardianRequestDeliveryWire> {
  return (await store()).createCanonicalGuardianDelivery(
    CreateGuardianRequestDeliveryIpcParamsSchema.parse(params),
  );
}

async function updateGuardianRequestDelivery(
  id: string,
  patch: UpdateGuardianRequestDeliveryIpcParams["patch"],
): Promise<void> {
  (await store()).updateCanonicalGuardianDelivery(id, patch);
}

async function listGuardianRequestDeliveries(
  requestId: string,
): Promise<GuardianRequestDeliveryWire[]> {
  return (await store()).listCanonicalGuardianDeliveries(requestId);
}

// ── Decide surface ───────────────────────────────────────────────────

function toWireOrNull(
  row: CanonicalGuardianRequest | null,
): GuardianRequestWire | null {
  return row ? toGuardianRequestWire(row) : null;
}

async function getGuardianRequest(
  id: string,
): Promise<GuardianRequestWire | null> {
  return toWireOrNull((await store()).getCanonicalGuardianRequest(id));
}

async function getGuardianRequestByCode(
  code: string,
): Promise<GuardianRequestWire | null> {
  return toWireOrNull((await store()).getCanonicalGuardianRequestByCode(code));
}

async function updateGuardianRequest(
  id: string,
  patch: GuardianRequestPatch,
): Promise<void> {
  (await store()).updateCanonicalGuardianRequest(id, patch);
}

/**
 * Apply the decision's ACL outcome through the daemon relay each variant
 * replaced (per the contract), so tests observe the same ACL writes the
 * pre-flip resolvers issued. Throws when the outcome does not land —
 * mirroring the gateway transaction rollback (the caller reverts the CAS).
 */
async function applyAclOutcome(
  outcome: GuardianRequestAclOutcome,
): Promise<{ mintedSession?: DecideAppliedResponse["mintedSession"] }> {
  switch (outcome.type) {
    case "activate_member": {
      const { activateMemberChannel } = await import(
        "../../contacts/member-write-relay.js"
      );
      const { type: _type, ...params } = outcome;
      const result = await activateMemberChannel(params);
      if (result.status !== "activated") {
        throw new Error("bridge: gateway refused the member activation");
      }
      return {};
    }
    case "seed_unverified": {
      const { seedUnverifiedMemberChannel } = await import(
        "../../contacts/member-write-relay.js"
      );
      const { type: _type, ...params } = outcome;
      await seedUnverifiedMemberChannel(params);
      return {};
    }
    case "block": {
      const { blockSenderChannel } = await import(
        "../../contacts/member-write-relay.js"
      );
      const { type: _type, ...params } = outcome;
      const result = await blockSenderChannel(params);
      if (!result.revoked) {
        throw new Error("bridge: block did not land");
      }
      return {};
    }
    case "mint_outbound_session": {
      const { createOutboundSession } = await import(
        "../../channels/gateway-verification-sessions.js"
      );
      const { type: _type, ...params } = outcome;
      return { mintedSession: await createOutboundSession(params) };
    }
  }
}

type DecideAppliedResponse = Extract<
  DecideGuardianRequestIpcResponse,
  { applied: true }
>;

async function decideGuardianRequest(
  params: DecideGuardianRequestIpcParams,
): Promise<DecideGuardianRequestIpcResponse> {
  const parsed = DecideGuardianRequestIpcParamsSchema.parse(params);
  const { resolveCanonicalGuardianRequest } = await store();
  const resolved = resolveCanonicalGuardianRequest(
    parsed.id,
    parsed.expectedStatus,
    {
      status: parsed.status,
      answerText: parsed.answerText,
      decidedByExternalUserId: parsed.decidedByExternalUserId,
      decidedByPrincipalId: parsed.decidedByPrincipalId,
    },
  );
  if (!resolved) {
    return { applied: false, reason: "status_conflict" };
  }

  let mintedSession: DecideAppliedResponse["mintedSession"];
  if (parsed.aclOutcome) {
    try {
      ({ mintedSession } = await applyAclOutcome(parsed.aclOutcome));
    } catch (err) {
      // Mirror the gateway transaction rollback: the CAS never lands.
      resolveCanonicalGuardianRequest(parsed.id, parsed.status, {
        status: "pending",
      });
      throw err;
    }
  }

  return {
    applied: true,
    request: toGuardianRequestWire(resolved),
    ...(mintedSession ? { mintedSession } : {}),
  };
}

async function reopenGuardianRequest(
  id: string,
  fromStatus: GuardianRequestStatus,
): Promise<void> {
  const reopened = (await store()).resolveCanonicalGuardianRequest(
    id,
    fromStatus,
    { status: "pending" },
  );
  if (!reopened) {
    throw new Error(`bridge: reopen CAS miss for ${id}`);
  }
}

async function expireGuardianRequest(id: string): Promise<void> {
  (await store()).expireCanonicalGuardianRequest(id);
}

async function expireInteractionBoundGuardianRequests(): Promise<number> {
  return (await store()).expireAllPendingCanonicalRequests();
}

async function sweepExpiredGuardianRequests(now?: number): Promise<string[]> {
  const s = await store();
  const cutoff = now ?? Date.now();
  const expired = s
    .listCanonicalGuardianRequests({ status: "pending" })
    .filter((row) => row.expiresAt !== null && row.expiresAt < cutoff);
  for (const row of expired) {
    s.expireCanonicalGuardianRequest(row.id);
  }
  return expired.map((row) => row.id);
}

async function getPendingRequestByDestinationMessage(
  channel: string,
  chatId: string,
  messageId: string,
): Promise<GuardianRequestWire | null> {
  return toWireOrNull(
    (await store()).getPendingCanonicalRequestByDestinationMessage(
      channel,
      chatId,
      messageId,
    ),
  );
}

async function listPendingRequestsByDestination(
  params: ListPendingGuardianRequestsByDestinationIpcParams,
): Promise<GuardianRequestWire[]> {
  const s = await store();
  if (params.conversationId) {
    return s
      .listPendingCanonicalGuardianRequestsByDestinationConversation(
        params.conversationId,
        params.channel,
      )
      .map(toGuardianRequestWire);
  }
  return s
    .listPendingCanonicalGuardianRequestsByDestinationChat(
      params.channel ?? "",
      params.chatId ?? "",
    )
    .map(toGuardianRequestWire);
}

async function listPendingRequestsByScope(
  conversationId: string,
  channel?: string,
): Promise<GuardianRequestWire[]> {
  return (await store())
    .listPendingRequestsByConversationScope(conversationId, channel)
    .map(toGuardianRequestWire);
}

async function isGuardianRequestInScope(
  requestId: string,
  conversationId: string,
  channel?: string,
): Promise<boolean> {
  return (await store()).isRequestInConversationScope(
    requestId,
    conversationId,
    channel,
  );
}

async function getPendingRequestByCallSession(
  callSessionId: string,
): Promise<GuardianRequestWire | null> {
  return toWireOrNull(
    (await store()).getPendingCanonicalRequestByCallSessionId(callSessionId),
  );
}

async function getRequestByPendingQuestion(
  pendingQuestionId: string,
): Promise<GuardianRequestWire | null> {
  return toWireOrNull(
    (await store()).getCanonicalRequestByPendingQuestionId(pendingQuestionId),
  );
}

/**
 * Module-shaped delegate for `channels/gateway-guardian-requests.js` covering
 * the full client surface (create, delivery recording, and the decide/lookup
 * cluster). Degrade variants never degrade here — the backing store is local.
 */
export const gatewayGuardianRequestsStoreBridge = {
  createGuardianRequest,
  getGuardianRequest,
  getGuardianRequestOrNull: getGuardianRequest,
  getGuardianRequestByCode,
  getGuardianRequestByCodeOrNull: getGuardianRequestByCode,
  listGuardianRequests,
  listGuardianRequestsOrEmpty: listGuardianRequests,
  updateGuardianRequest,
  decideGuardianRequest,
  reopenGuardianRequest,
  expireGuardianRequest,
  expireInteractionBoundGuardianRequests,
  sweepExpiredGuardianRequests,
  createGuardianRequestDelivery,
  updateGuardianRequestDelivery,
  listGuardianRequestDeliveries,
  listGuardianRequestDeliveriesOrEmpty: listGuardianRequestDeliveries,
  getPendingRequestByDestinationMessage,
  getPendingRequestByDestinationMessageOrNull:
    getPendingRequestByDestinationMessage,
  listPendingRequestsByDestination,
  listPendingRequestsByDestinationOrEmpty: listPendingRequestsByDestination,
  listPendingRequestsByScope,
  listPendingRequestsByScopeOrEmpty: listPendingRequestsByScope,
  isGuardianRequestInScope,
  isGuardianRequestInScopeOrFalse: isGuardianRequestInScope,
  getPendingRequestByCallSession,
  getPendingRequestByCallSessionOrNull: getPendingRequestByCallSession,
  getRequestByPendingQuestion,
  getRequestByPendingQuestionOrNull: getRequestByPendingQuestion,
};
