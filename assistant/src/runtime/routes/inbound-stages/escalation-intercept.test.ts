/**
 * Unit tests for `handleEscalationIntercept` guardian-principal resolution.
 *
 * A guardian binding whose gateway row carries no principal is UNRESOLVED, not
 * present-but-empty: the intercept adopts the principal from the assistant's
 * vellum anchor (via `resolveDecidableGuardianPrincipalId`), and when neither
 * resolves it fails closed instead of creating an undecidable (principal-less)
 * canonical request. The `""`-is-unresolved contract itself is pinned in
 * `local-actor-identity.test.ts`.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

let mockBindingPrincipalId: string | null = null;
let mockBindingPresent = true;
mock.module("../../channel-verification-service.js", () => ({
  getGuardianBinding: async () =>
    mockBindingPresent
      ? {
          guardianExternalUserId: "guardian-1",
          guardianPrincipalId: mockBindingPrincipalId,
        }
      : null,
}));

// Faithful stand-in for the shared adopt/repair helper: binding principal
// when present, else the (test-controlled) vellum anchor principal.
let mockAnchorPrincipal: string | undefined;
mock.module("../../local-actor-identity.js", () => ({
  resolveDecidableGuardianPrincipalId: async (
    bindingPrincipalId: string | null,
  ) => bindingPrincipalId || mockAnchorPrincipal,
}));

const createdRequests: Array<Record<string, unknown>> = [];
mock.module("../../../channels/gateway-guardian-requests.js", () => ({
  createGuardianRequest: async (params: Record<string, unknown>) => {
    createdRequests.push(params);
    return { ...params, requestCode: "ABC123" };
  },
}));

mock.module("../../../notifications/emit-signal.js", () => ({
  emitNotificationSignal: async () => ({ deliveryResults: [] }),
}));

mock.module("../../../persistence/delivery-crud.js", () => ({
  storePayload: () => {},
}));

const { handleEscalationIntercept } = await import("./escalation-intercept.js");
type EscalationInterceptParams = Parameters<
  typeof handleEscalationIntercept
>[0];

function makeParams(
  overrides: Partial<EscalationInterceptParams> = {},
): EscalationInterceptParams {
  return {
    resolvedMember: {
      contactId: "contact-1",
      channelId: "channel-1",
      status: "active",
      policy: "escalate",
      verifiedAt: null,
      displayName: "Member",
    },
    canonicalAssistantId: "self",
    sourceChannel: "telegram",
    sourceInterface: "telegram",
    conversationExternalId: "chat-1",
    externalMessageId: "msg-1",
    conversationId: "conv-1",
    eventId: "evt-1",
    content: "hello",
    attachmentIds: undefined,
    sourceMetadata: undefined,
    actorDisplayName: "Member",
    actorExternalId: "member-1",
    actorUsername: "member_one",
    replyCallbackUrl: "http://localhost/deliver",
    canonicalSenderId: "member-1",
    rawSenderId: "member-1",
    ...overrides,
  };
}

beforeEach(() => {
  mockBindingPresent = true;
  mockBindingPrincipalId = null;
  mockAnchorPrincipal = undefined;
  createdRequests.length = 0;
});

describe("handleEscalationIntercept — guardian principal resolution", () => {
  test("binding with a principal creates the request with that principal", async () => {
    mockBindingPrincipalId = "principal-1";

    const response = await handleEscalationIntercept(makeParams());

    expect(response).toMatchObject({ accepted: true, escalated: true });
    expect(createdRequests).toHaveLength(1);
    expect(createdRequests[0].guardianPrincipalId).toBe("principal-1");
  });

  test("null-principal binding adopts the vellum anchor principal (repair path)", async () => {
    mockBindingPrincipalId = null;
    mockAnchorPrincipal = "anchor-principal";

    const response = await handleEscalationIntercept(makeParams());

    expect(response).toMatchObject({ accepted: true, escalated: true });
    expect(createdRequests).toHaveLength(1);
    expect(createdRequests[0].guardianPrincipalId).toBe("anchor-principal");
  });

  test("unresolvable principal fails closed — no principal-less request is created", async () => {
    mockBindingPrincipalId = null;
    mockAnchorPrincipal = undefined;

    const response = await handleEscalationIntercept(makeParams());

    expect(response).toMatchObject({
      accepted: true,
      denied: true,
      reason: "escalate_no_guardian",
    });
    expect(createdRequests).toHaveLength(0);
  });

  test("no binding at all still denies fail-closed", async () => {
    mockBindingPresent = false;

    const response = await handleEscalationIntercept(makeParams());

    expect(response).toMatchObject({
      accepted: true,
      denied: true,
      reason: "escalate_no_guardian",
    });
    expect(createdRequests).toHaveLength(0);
  });

  test("non-escalate member policy is a pass-through", async () => {
    const params = makeParams();
    const response = await handleEscalationIntercept(
      makeParams({
        resolvedMember: { ...params.resolvedMember!, policy: "allow" },
      }),
    );

    expect(response).toBeNull();
  });
});
