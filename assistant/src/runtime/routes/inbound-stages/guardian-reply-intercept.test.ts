import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the module under test
// ---------------------------------------------------------------------------

let mockDeliveryScopedRequests: { id: string }[] = [];
let mockIdentityRequests: { id: string }[] = [];
let routeGuardianReplyCalls: unknown[] = [];
let deliverChannelReplyCalls: unknown[][] = [];

mock.module("../../../contacts/canonical-guardian-store.js", () => ({
  listPendingCanonicalGuardianRequestsByDestinationChat: () =>
    mockDeliveryScopedRequests,
  listCanonicalGuardianRequests: () => mockIdentityRequests,
}));

mock.module("../../gateway-client.js", () => ({
  deliverChannelReply: (url: unknown, payload: unknown, token: unknown) => {
    deliverChannelReplyCalls.push([url, payload, token]);
    return Promise.resolve({ ok: true });
  },
}));

mock.module("../../guardian-reply-router.js", () => ({
  routeGuardianReply: (ctx: unknown) => {
    routeGuardianReplyCalls.push(ctx);
    return Promise.resolve({
      consumed: false,
      decisionApplied: false,
      type: "not_consumed",
    });
  },
}));

// Import after mocks are installed
const { handleGuardianReplyIntercept } =
  await import("./guardian-reply-intercept.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeParams(
  overrides: Partial<Parameters<typeof handleGuardianReplyIntercept>[0]> = {},
) {
  return {
    isDuplicate: false,
    trimmedContent: "hello",
    hasCallbackData: false,
    callbackData: undefined,
    rawSenderId: "user-42",
    canonicalSenderId: "user-42",
    canonicalAssistantId: "self",
    sourceChannel: "slack" as const,
    conversationExternalId: "chat-123",
    conversationId: "conv-abc",
    eventId: "evt-1",
    replyCallbackUrl: "https://gateway/reply",
    trustClass: "guardian",
    guardianPrincipalId: "principal-1",
    approvalConversationGenerator: undefined,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handleGuardianReplyIntercept", () => {
  beforeEach(() => {
    mockDeliveryScopedRequests = [];
    mockIdentityRequests = [];
    routeGuardianReplyCalls = [];
    deliverChannelReplyCalls = [];
  });

  test("passes a blocked scope when Slack guardian sends message in non-delivery chat", async () => {
    // No delivery-scoped requests for this chat
    mockDeliveryScopedRequests = [];
    // Identity-based lookup would find a pending request in a different chat
    mockIdentityRequests = [{ id: "identity-req" }];

    await handleGuardianReplyIntercept(makeParams({ sourceChannel: "slack" }));

    expect(routeGuardianReplyCalls).toHaveLength(1);
    const ctx = routeGuardianReplyCalls[0] as Record<string, unknown>;
    // Must be a blocked scope, NOT undefined — blocks identity fallback
    expect(ctx.pendingScope).toEqual({ mode: "blocked" });
  });

  test("preserves identity fallback for non-Slack channels when no deliveries exist", async () => {
    // No delivery-scoped requests for this chat
    mockDeliveryScopedRequests = [];
    mockIdentityRequests = [{ id: "identity-req" }];

    await handleGuardianReplyIntercept(
      makeParams({ sourceChannel: "telegram" }),
    );

    expect(routeGuardianReplyCalls).toHaveLength(1);
    const ctx = routeGuardianReplyCalls[0] as Record<string, unknown>;
    // Must be unset — identity-based fallback stays active
    expect(ctx.pendingScope).toBeUndefined();
  });

  test("passes an identity-unioned scoped set when Slack guardian is in delivery chat", async () => {
    mockDeliveryScopedRequests = [{ id: "delivered-req" }];
    mockIdentityRequests = [
      { id: "delivered-req" },
      { id: "identity-only-req" },
    ];

    await handleGuardianReplyIntercept(makeParams({ sourceChannel: "slack" }));

    expect(routeGuardianReplyCalls).toHaveLength(1);
    const ctx = routeGuardianReplyCalls[0] as Record<string, unknown>;
    const ids = (ctx.pendingScope as { requestIds: string[] }).requestIds;
    expect(ids).toContain("delivered-req");
    expect(ids).toContain("identity-only-req");
  });

  test("skips intercept for non-guardian trust class", async () => {
    const result = await handleGuardianReplyIntercept(
      makeParams({ trustClass: "unknown" }),
    );

    expect(routeGuardianReplyCalls).toHaveLength(0);
    expect(result).toEqual({
      response: null,
      skipApprovalInterception: false,
    });
  });

  test("skips intercept when replyCallbackUrl is missing", async () => {
    const result = await handleGuardianReplyIntercept(
      makeParams({ replyCallbackUrl: undefined }),
    );

    expect(routeGuardianReplyCalls).toHaveLength(0);
    expect(result).toEqual({
      response: null,
      skipApprovalInterception: false,
    });
  });
});
