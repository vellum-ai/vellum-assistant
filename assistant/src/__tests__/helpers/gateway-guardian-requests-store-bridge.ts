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
  type GuardianRequestDeliveryWire,
  type GuardianRequestSourceType,
  type GuardianRequestWire,
  type ListGuardianRequestsIpcParams,
  type UpdateGuardianRequestDeliveryIpcParams,
} from "@vellumai/gateway-client";

import {
  type CanonicalGuardianRequest,
  createCanonicalGuardianDelivery,
  createCanonicalGuardianRequest,
  listCanonicalGuardianDeliveries,
  listCanonicalGuardianRequests,
  updateCanonicalGuardianDelivery,
} from "../../contacts/canonical-guardian-store.js";

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
    createCanonicalGuardianRequest({
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
  let rows = listCanonicalGuardianRequests({
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
  return createCanonicalGuardianDelivery(
    CreateGuardianRequestDeliveryIpcParamsSchema.parse(params),
  );
}

async function updateGuardianRequestDelivery(
  id: string,
  patch: UpdateGuardianRequestDeliveryIpcParams["patch"],
): Promise<void> {
  updateCanonicalGuardianDelivery(id, patch);
}

async function listGuardianRequestDeliveries(
  requestId: string,
): Promise<GuardianRequestDeliveryWire[]> {
  return listCanonicalGuardianDeliveries(requestId);
}

/**
 * Module-shaped delegate for `channels/gateway-guardian-requests.js` covering
 * the client surface the create + delivery-recording cluster uses. Degrade
 * variants never degrade here — the backing store is local.
 */
export const gatewayGuardianRequestsStoreBridge: {
  createGuardianRequest: typeof createGuardianRequest;
  listGuardianRequests: typeof listGuardianRequests;
  listGuardianRequestsOrEmpty: typeof listGuardianRequests;
  createGuardianRequestDelivery: typeof createGuardianRequestDelivery;
  updateGuardianRequestDelivery: typeof updateGuardianRequestDelivery;
  listGuardianRequestDeliveries: typeof listGuardianRequestDeliveries;
  listGuardianRequestDeliveriesOrEmpty: typeof listGuardianRequestDeliveries;
} = {
  createGuardianRequest,
  listGuardianRequests,
  listGuardianRequestsOrEmpty: listGuardianRequests,
  createGuardianRequestDelivery,
  updateGuardianRequestDelivery,
  listGuardianRequestDeliveries,
  listGuardianRequestDeliveriesOrEmpty: listGuardianRequestDeliveries,
};
