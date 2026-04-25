import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Module mocks — must be in place before dynamic imports resolve transitive
// dependencies (emit-feed-event -> feed-writer -> assistant-event-hub).
// ---------------------------------------------------------------------------

const publishSpy = mock<(event: unknown) => Promise<void>>(async () => {});

mock.module("../../runtime/assistant-event-hub.js", () => ({
  assistantEventHub: {
    publish: publishSpy,
    subscribe: () => () => {},
  },
}));

// Capture emitFeedEvent calls without hitting the real persistence layer.
const emitFeedEventCalls: Array<{
  source: string;
  title: string;
  summary: string;
  dedupKey?: string;
  urgency?: string;
}> = [];

mock.module("../../home/emit-feed-event.js", () => ({
  emitFeedEvent: async (params: {
    source: string;
    title: string;
    summary: string;
    dedupKey?: string;
    urgency?: string;
  }) => {
    emitFeedEventCalls.push(params);
    return { id: params.dedupKey ?? "mock-id", ...params };
  },
}));

// Stub heavy transitive dependencies that the resolvers import so the
// test can load the module without standing up a full daemon environment.

mock.module("../../calls/call-domain.js", () => ({
  answerCall: async () => ({ ok: true }),
}));

mock.module("../../config/env.js", () => ({
  getGatewayInternalBaseUrl: () => "http://localhost:0",
}));

mock.module("../../contacts/contact-store.js", () => ({
  findContactChannel: () => null,
}));

mock.module("../../contacts/contacts-write.js", () => ({
  upsertContactChannel: () => {},
}));

mock.module("../../memory/canonical-guardian-store.js", () => ({
  getCanonicalGuardianRequest: () => null,
}));

mock.module("../../notifications/emit-signal.js", () => ({
  emitNotificationSignal: async () => {},
}));

mock.module("../../notifications/signal.js", () => ({
  isNotificationSourceChannel: () => false,
}));

mock.module("../../permissions/trust-store.js", () => ({
  addRule: () => {},
}));

mock.module("../../permissions/v2-consent-policy.js", () => ({
  isPermissionControlsV2Enabled: () => false,
}));

mock.module("../../runtime/assistant-scope.js", () => ({
  DAEMON_INTERNAL_ASSISTANT_ID: "self",
}));

mock.module("../../runtime/auth/token-service.js", () => ({}));

mock.module("../../runtime/channel-approval-types.js", () => ({}));

mock.module("../../runtime/channel-verification-service.js", () => ({
  createOutboundSession: () => ({
    sessionId: "mock-session",
    secret: "123456",
  }),
}));

mock.module("../../runtime/gateway-client.js", () => ({
  deliverChannelReply: async () => {},
}));

// Stub pending-interactions so tool_approval resolver can find/resolve.
let mockInteraction: Record<string, unknown> | null = null;
let mockResolved: Record<string, unknown> | null = null;

mock.module("../../runtime/pending-interactions.js", () => ({
  get: () => mockInteraction,
  resolve: () => mockResolved,
}));

mock.module("../../tools/registry.js", () => ({
  getTool: () => null,
}));

mock.module("../../tools/tool-approval-handler.js", () => ({
  TC_GRANT_WAIT_MAX_MS: 30_000,
}));

// ---------------------------------------------------------------------------
// Import the resolvers after all mocks are in place.
// ---------------------------------------------------------------------------

const { getResolver } = await import("../guardian-request-resolvers.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: "req-001",
    kind: "tool_approval",
    status: "pending",
    conversationId: "conv-abc",
    toolName: "web_fetch",
    sourceChannel: "vellum",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as never;
}

function makeCtx(
  request: ReturnType<typeof makeRequest>,
  decision: { action: string; userText?: string },
) {
  return {
    request,
    decision,
    actor: {
      actorPrincipalId: "principal-1",
      actorExternalUserId: undefined,
      channel: "vellum",
      guardianPrincipalId: "principal-1",
    },
  } as never;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("guardian approval feed events", () => {
  beforeEach(() => {
    emitFeedEventCalls.length = 0;
    mockInteraction = {
      confirmationDetails: { toolName: "web_fetch" },
    };
    mockResolved = {
      conversation: {
        handleConfirmationResponse: () => {},
      },
    };
  });

  afterEach(() => {
    mockInteraction = null;
    mockResolved = null;
  });

  // -----------------------------------------------------------------------
  // tool_approval (pendingInteractionResolver)
  // -----------------------------------------------------------------------

  describe("tool_approval", () => {
    test("approval emits with title 'Tool Request Approved'", async () => {
      const resolver = getResolver("tool_approval")!;
      expect(resolver).toBeDefined();

      const request = makeRequest();
      const ctx = makeCtx(request, { action: "approve_once" });
      await resolver.resolve(ctx);

      // Allow microtask for the void promise to settle.
      await new Promise((r) => setTimeout(r, 10));

      const call = emitFeedEventCalls.find(
        (c) => c.title === "Tool Request Approved",
      );
      expect(call).toBeDefined();
      expect(call!.source).toBe("assistant");
      expect(call!.summary).toContain("Approved");
      expect(call!.summary).toContain("web_fetch");
      expect(call!.urgency).toBeUndefined();
    });

    test("rejection emits with title 'Tool Request Denied' and urgency 'medium'", async () => {
      const resolver = getResolver("tool_approval")!;

      const request = makeRequest();
      const ctx = makeCtx(request, { action: "reject" });
      await resolver.resolve(ctx);

      await new Promise((r) => setTimeout(r, 10));

      const call = emitFeedEventCalls.find(
        (c) => c.title === "Tool Request Denied",
      );
      expect(call).toBeDefined();
      expect(call!.urgency).toBe("medium");
      expect(call!.summary).toContain("Denied");
    });

    test("dedupKey includes request ID", async () => {
      const resolver = getResolver("tool_approval")!;

      const request = makeRequest({ id: "req-unique-42" });
      const ctx = makeCtx(request, { action: "approve_once" });
      await resolver.resolve(ctx);

      await new Promise((r) => setTimeout(r, 10));

      const call = emitFeedEventCalls[0];
      expect(call).toBeDefined();
      expect(call!.dedupKey).toBe("guardian-approval:req-unique-42");
    });
  });

  // -----------------------------------------------------------------------
  // access_request (accessRequestResolver)
  // -----------------------------------------------------------------------

  describe("access_request", () => {
    test("approval emits with title 'Access Request Approved'", async () => {
      const resolver = getResolver("access_request")!;
      expect(resolver).toBeDefined();

      const request = makeRequest({
        kind: "access_request",
        requesterExternalUserId: "user-123",
        requesterChatId: "chat-456",
      });
      const ctx = makeCtx(request, { action: "approve_once" });
      await resolver.resolve(ctx);

      await new Promise((r) => setTimeout(r, 10));

      const call = emitFeedEventCalls.find(
        (c) => c.title === "Access Request Approved",
      );
      expect(call).toBeDefined();
      expect(call!.source).toBe("assistant");
      expect(call!.summary).toContain("Granted");
      expect(call!.urgency).toBeUndefined();
    });

    test("denial emits with title 'Access Request Denied' and urgency 'medium'", async () => {
      const resolver = getResolver("access_request")!;

      const request = makeRequest({
        kind: "access_request",
        requesterExternalUserId: "user-123",
        requesterChatId: "chat-456",
      });
      const ctx = makeCtx(request, { action: "reject" });
      await resolver.resolve(ctx);

      await new Promise((r) => setTimeout(r, 10));

      const call = emitFeedEventCalls.find(
        (c) => c.title === "Access Request Denied",
      );
      expect(call).toBeDefined();
      expect(call!.urgency).toBe("medium");
      expect(call!.summary).toContain("Denied");
    });

    test("dedupKey includes request ID", async () => {
      const resolver = getResolver("access_request")!;

      const request = makeRequest({
        id: "req-access-99",
        kind: "access_request",
        requesterExternalUserId: "user-123",
        requesterChatId: "chat-456",
      });
      const ctx = makeCtx(request, { action: "approve_once" });
      await resolver.resolve(ctx);

      await new Promise((r) => setTimeout(r, 10));

      const call = emitFeedEventCalls[0];
      expect(call).toBeDefined();
      expect(call!.dedupKey).toBe("guardian-access:req-access-99");
    });
  });
});
