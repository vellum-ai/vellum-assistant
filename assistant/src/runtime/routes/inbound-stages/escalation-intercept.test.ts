/**
 * Unit tests for `handleEscalationIntercept` guardian-principal resolution.
 *
 * A guardian binding whose gateway row carries no principal is UNRESOLVED, not
 * present-but-empty: the intercept adopts the principal from the assistant's
 * vellum anchor, and when neither resolves it fails closed instead of creating
 * an undecidable (principal-less) canonical request.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

let mockBinding: Record<string, unknown> | null = null;
mock.module("../../channel-verification-service.js", () => ({
  getGuardianBinding: async () => mockBinding,
}));

let mockAnchorPrincipal: string | undefined;
mock.module("../../local-actor-identity.js", () => ({
  findLocalGuardianPrincipalId: async () => mockAnchorPrincipal,
}));

const createdRequests: Array<Record<string, unknown>> = [];
mock.module("../../../contacts/canonical-guardian-store.js", () => ({
  createCanonicalGuardianRequest: (params: Record<string, unknown>) => {
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

function makeParams() {
  return {
    resolvedMember: {
      contactId: "contact-1",
      channelId: "channel-1",
      status: "active" as const,
      policy: "escalate" as const,
      verifiedAt: null,
      displayName: "Member",
    },
    canonicalAssistantId: "self",
    sourceChannel: "telegram" as const,
    sourceInterface: "telegram" as const,
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
  };
}

beforeEach(() => {
  mockBinding = null;
  mockAnchorPrincipal = undefined;
  createdRequests.length = 0;
});

describe("handleEscalationIntercept — guardian principal resolution", () => {
  test("binding with a principal creates the request with that principal", async () => {
    mockBinding = {
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: "principal-1",
    };

    const response = await handleEscalationIntercept(makeParams());

    expect(response).toMatchObject({ accepted: true, escalated: true });
    expect(createdRequests).toHaveLength(1);
    expect(createdRequests[0].guardianPrincipalId).toBe("principal-1");
  });

  test("null-principal binding adopts the vellum anchor principal (repair path)", async () => {
    mockBinding = {
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: null,
    };
    mockAnchorPrincipal = "anchor-principal";

    const response = await handleEscalationIntercept(makeParams());

    expect(response).toMatchObject({ accepted: true, escalated: true });
    expect(createdRequests).toHaveLength(1);
    expect(createdRequests[0].guardianPrincipalId).toBe("anchor-principal");
  });

  test("unresolvable principal fails closed — no principal-less request is created", async () => {
    mockBinding = {
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: null,
    };
    mockAnchorPrincipal = undefined;

    const response = await handleEscalationIntercept(makeParams());

    expect(response).toMatchObject({
      accepted: true,
      denied: true,
      reason: "escalate_no_guardian",
    });
    expect(createdRequests).toHaveLength(0);
  });

  test("empty-string principal is never written downstream", async () => {
    // Even a malformed binding carrying "" must not flow into the canonical
    // store — "" is falsy, so the adopt path runs instead.
    mockBinding = {
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: "",
    };
    mockAnchorPrincipal = "anchor-principal";

    await handleEscalationIntercept(makeParams());

    expect(createdRequests).toHaveLength(1);
    expect(createdRequests[0].guardianPrincipalId).toBe("anchor-principal");
  });

  test("no binding at all still denies fail-closed", async () => {
    mockBinding = null;

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
    params.resolvedMember = {
      ...params.resolvedMember,
      policy: "allow" as never,
    };

    expect(await handleEscalationIntercept(params)).toBeNull();
  });
});
