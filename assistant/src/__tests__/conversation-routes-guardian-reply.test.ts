import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../config/env.js", () => ({ isHttpAuthDisabled: () => true }));

const routeGuardianReplyMock = mock(async () => ({
  consumed: false,
  decisionApplied: false,
  type: "not_consumed" as const,
})) as any;
const listPendingByDestinationMock = mock(
  (_conversationId: string, _sourceChannel?: string) =>
    [] as Array<{ id: string; kind?: string }>,
);
const listCanonicalMock = mock(
  (_filters?: Record<string, unknown>) => [] as Array<{ id: string }>,
);
const addMessageMock = mock(
  async (
    _conversationId: string,
    role: string,
    _content?: string,
    _metadata?: Record<string, unknown>,
  ) => ({
    id: role === "user" ? "persisted-user-id" : "persisted-assistant-id",
  }),
);

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../persistence/conversation-key-store.js", () => ({
  getOrCreateConversation: () => ({ conversationId: "conv-canonical-reply" }),
  getConversationByKey: () => null,
}));

mock.module("../persistence/attachments-store.js", () => ({
  getAttachmentsByIds: () => [],
}));

mock.module("../runtime/guardian-reply-router.js", () => ({
  routeGuardianReply: routeGuardianReplyMock,
}));

mock.module("../channels/gateway-guardian-requests.js", () => ({
  createGuardianRequest: async (params: Record<string, unknown>) => ({
    ...params,
    requestCode: "ABC123",
  }),
  listGuardianRequestsOrEmpty: async (filters?: Record<string, unknown>) =>
    listCanonicalMock(filters),
  expireGuardianRequest: async () => {},
  listPendingRequestsByScopeOrEmpty: async (conversationId: string) => {
    const byDest = listPendingByDestinationMock(conversationId);
    const bySrc = listCanonicalMock({
      status: "pending",
      sourceConversationId: conversationId,
    });
    const seen = new Set<string>();
    const result: Array<{ id: string; kind?: string }> = [];
    for (const r of [...bySrc, ...byDest]) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        result.push(r);
      }
    }
    return result;
  },
}));

mock.module("../runtime/confirmation-request-guardian-bridge.js", () => ({
  bridgeConfirmationRequestToGuardian: async () => undefined,
}));

mock.module("../persistence/conversation-crud.js", () => ({
  setConversationProcessingStartedAt: () => {},
  isConversationProcessing: () => false,
  addMessage: (
    conversationId: string,
    role: string,
    content: string,
    options?: { metadata?: Record<string, unknown> },
  ) => addMessageMock(conversationId, role, content, options),
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
  recordConversationPersistedSeq: () => {},
}));

const realLocalActorIdentity =
  await import("../runtime/local-actor-identity.js");
mock.module("../runtime/local-actor-identity.js", () => ({
  ...realLocalActorIdentity,
}));

mock.module("../runtime/trust-context-resolver.js", () => ({
  resolveTrustContext: () => ({
    trustClass: "guardian",
    sourceChannel: "vellum",
  }),
  withSourceChannel: (sourceChannel: unknown, ctx: unknown) => ({
    ...(ctx as Record<string, unknown>),
    sourceChannel,
  }),
}));

mock.module("../contacts/guardian-delivery-reader.js", () => ({
  getGuardianDelivery: async () => [
    {
      channelType: "vellum",
      contactId: "guardian-contact",
      principalId: "test-user",
      address: "test-user",
      status: "active",
    },
  ],
}));

import type { AuthContext } from "../runtime/auth/types.js";
import { handleSendMessage } from "../runtime/routes/conversation-routes.js";
import { callHandler } from "./helpers/call-route-handler.js";

const _testAuthContext: AuthContext = {
  subject: "actor:self:test-guardian",
  principalType: "actor",
  assistantId: "self",
  actorPrincipalId: "test-guardian",
  scopeProfile: "actor_client_v1",
  scopes: new Set([
    "chat.read",
    "chat.write",
    "approval.read",
    "approval.write",
    "settings.read",
    "settings.write",
    "attachments.read",
    "attachments.write",
    "calls.read",
    "calls.write",
    "feature_flags.read",
    "feature_flags.write",
  ]),
  policyEpoch: 1,
};

describe("handleSendMessage canonical guardian reply interception", () => {
  beforeEach(() => {
    routeGuardianReplyMock.mockClear();
    listPendingByDestinationMock.mockClear();
    listCanonicalMock.mockClear();
    addMessageMock.mockClear();
  });

  test("consumes access-request code replies on desktop HTTP path without pending confirmations", async () => {
    listPendingByDestinationMock.mockReturnValue([{ id: "access-req-1" }]);
    listCanonicalMock.mockReturnValue([]);
    routeGuardianReplyMock.mockResolvedValue({
      consumed: true,
      decisionApplied: true,
      type: "canonical_decision_applied",
      requestId: "access-req-1",
      replyText: "Access approved. Verification code: 123456.",
    });

    const persistUserMessage = mock(async () => ({
      id: "should-not-be-called",
      deduplicated: false,
    }));
    const runAgentLoop = mock(async () => undefined);
    const session = {
      setTrustContext: () => {},
      updateClient: () => {},
      emitConfirmationStateChanged: () => {},
      emitActivityState: () => {},
      setTurnChannelContext: () => {},
      setTurnInterfaceContext: () => {},
      ensureActorScopedHistory: async () => {},
      usageStats: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
      isProcessing: () => false,
      hasAnyPendingConfirmation: () => false,
      denyAllPendingConfirmations: () => {},
      enqueueMessage: () => ({ queued: true, requestId: "queued-id" }),
      persistUserMessage,
      runAgentLoop,
      getMessages: () => [] as unknown[],
      assistantId: "self",
      trustContext: undefined,
      hasPendingConfirmation: () => false,
      setHostBrowserProxy: () => {},
      setHostCuProxy: () => {},
      setHostAppControlProxy: () => {},
      restoreBrowserProxyAvailability: () => {},
      addPreactivatedSkillId: () => {},
    } as unknown as import("../daemon/conversation.js").Conversation;

    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-vellum-actor-principal-id": "test-user",
        "x-vellum-principal-type": "actor",
      },
      body: JSON.stringify({
        conversationKey: "guardian-conversation-key",
        content: "05BECB approve",
        sourceChannel: "vellum",
        interface: "macos",
      }),
    });

    const res = await callHandler(
      (args) =>
        handleSendMessage(args, {
          sendMessageDeps: {
            getOrCreateConversation: async () => session,
            assistantEventHub: { publish: async () => {} } as any,
            resolveAttachments: () => [],
          },
        }),
      req,
      undefined,
      202,
    );

    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      accepted: boolean;
      messageId?: string;
    };
    expect(body.accepted).toBe(true);
    expect(body.messageId).toBe("persisted-user-id");

    expect(routeGuardianReplyMock).toHaveBeenCalledTimes(1);
    const routerCall = (routeGuardianReplyMock as any).mock
      .calls[0][0] as Record<string, unknown>;
    expect(routerCall.messageText).toBe("05BECB approve");
    expect(routerCall.pendingScope).toEqual({
      mode: "scoped",
      requestIds: ["access-req-1"],
    });
    expect(addMessageMock).toHaveBeenCalledTimes(2);
    expect(persistUserMessage).toHaveBeenCalledTimes(0);
    expect(runAgentLoop).toHaveBeenCalledTimes(0);
  });

  test("passes a blocked scope when no canonical hints are found", async () => {
    listPendingByDestinationMock.mockReturnValue([]);
    listCanonicalMock.mockReturnValue([]);
    routeGuardianReplyMock.mockResolvedValue({
      consumed: false,
      decisionApplied: false,
      type: "not_consumed",
    });

    const persistUserMessage = mock(async () => ({
      id: "persisted-user-id",
      deduplicated: false,
    }));
    const runAgentLoop = mock(async () => undefined);
    const session = {
      setTrustContext: () => {},
      updateClient: () => {},
      emitConfirmationStateChanged: () => {},
      emitActivityState: () => {},
      setTurnChannelContext: () => {},
      setTurnInterfaceContext: () => {},
      ensureActorScopedHistory: async () => {},
      usageStats: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
      isProcessing: () => false,
      hasAnyPendingConfirmation: () => false,
      denyAllPendingConfirmations: () => {},
      enqueueMessage: () => ({ queued: true, requestId: "queued-id" }),
      persistUserMessage,
      runAgentLoop,
      getMessages: () => [] as unknown[],
      assistantId: "self",
      trustContext: undefined,
      hasPendingConfirmation: () => false,
      setHostBrowserProxy: () => {},
      setHostCuProxy: () => {},
      setHostAppControlProxy: () => {},
      restoreBrowserProxyAvailability: () => {},
      addPreactivatedSkillId: () => {},
    } as unknown as import("../daemon/conversation.js").Conversation;

    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-vellum-actor-principal-id": "test-user",
        "x-vellum-principal-type": "actor",
      },
      body: JSON.stringify({
        conversationKey: "guardian-conversation-key",
        content: "hello there",
        sourceChannel: "vellum",
        interface: "macos",
      }),
    });

    const res = await callHandler(
      (args) =>
        handleSendMessage(args, {
          sendMessageDeps: {
            getOrCreateConversation: async () => session,
            assistantEventHub: { publish: async () => {} } as any,
            resolveAttachments: () => [],
          },
        }),
      req,
      undefined,
      202,
    );

    expect(res.status).toBe(202);
    expect(routeGuardianReplyMock).toHaveBeenCalledTimes(1);
    const routerCall = (routeGuardianReplyMock as any).mock
      .calls[0][0] as Record<string, unknown>;
    expect(routerCall.pendingScope).toEqual({ mode: "blocked" });
    expect(persistUserMessage).toHaveBeenCalledTimes(1);
    expect(runAgentLoop).toHaveBeenCalledTimes(1);
  });

  test("hidden:true persists hidden metadata and still runs the turn", async () => {
    listPendingByDestinationMock.mockReturnValue([]);
    listCanonicalMock.mockReturnValue([]);
    routeGuardianReplyMock.mockResolvedValue({
      consumed: false,
      decisionApplied: false,
      type: "not_consumed",
    });

    const persistUserMessage = mock(async () => ({
      id: "persisted-user-id",
      deduplicated: false,
    }));
    const runAgentLoop = mock(async () => undefined);
    const session = {
      setTrustContext: () => {},
      updateClient: () => {},
      emitConfirmationStateChanged: () => {},
      emitActivityState: () => {},
      setTurnChannelContext: () => {},
      setTurnInterfaceContext: () => {},
      ensureActorScopedHistory: async () => {},
      usageStats: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
      isProcessing: () => false,
      hasAnyPendingConfirmation: () => false,
      denyAllPendingConfirmations: () => {},
      enqueueMessage: () => ({ queued: true, requestId: "queued-id" }),
      persistUserMessage,
      runAgentLoop,
      getMessages: () => [] as unknown[],
      assistantId: "self",
      trustContext: undefined,
      hasPendingConfirmation: () => false,
      setHostBrowserProxy: () => {},
      setHostCuProxy: () => {},
      setHostAppControlProxy: () => {},
      restoreBrowserProxyAvailability: () => {},
      addPreactivatedSkillId: () => {},
    } as unknown as import("../daemon/conversation.js").Conversation;

    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-vellum-actor-principal-id": "test-user",
        "x-vellum-principal-type": "actor",
      },
      body: JSON.stringify({
        conversationKey: "guardian-conversation-key",
        content: "Hey, how are you? Show me what you can do.",
        sourceChannel: "vellum",
        interface: "web",
        hidden: true,
      }),
    });

    const res = await callHandler(
      (args) =>
        handleSendMessage(args, {
          sendMessageDeps: {
            getOrCreateConversation: async () => session,
            assistantEventHub: { publish: async () => {} } as any,
            resolveAttachments: () => [],
          },
        }),
      req,
      undefined,
      202,
    );

    expect(res.status).toBe(202);
    // The hidden message is persisted with metadata.hidden so the list-messages
    // filter suppresses it from the UI transcript while keeping it in LLM-side
    // history (see list-messages-hidden-metadata.test.ts for the filter).
    expect(persistUserMessage).toHaveBeenCalledTimes(1);
    const persistArgs = (persistUserMessage as any).mock.calls[0][0] as {
      metadata?: { hidden?: boolean };
    };
    expect(persistArgs.metadata?.hidden).toBe(true);
    // The turn still runs — the assistant's reply streams normally, so the chat
    // reads as a proactive greeting.
    expect(runAgentLoop).toHaveBeenCalledTimes(1);
  });

  test("excludes stale tool_approval hints without a live pending confirmation", async () => {
    listPendingByDestinationMock.mockReturnValue([
      { id: "tool-approval-live", kind: "tool_approval" },
      { id: "tool-approval-stale", kind: "tool_approval" },
      { id: "access-req-1", kind: "access_request" },
    ]);
    listCanonicalMock.mockReturnValue([]);
    routeGuardianReplyMock.mockResolvedValue({
      consumed: false,
      decisionApplied: false,
      type: "not_consumed",
    });

    const persistUserMessage = mock(async () => ({
      id: "persisted-user-id",
      deduplicated: false,
    }));
    const runAgentLoop = mock(async () => undefined);
    const session = {
      setTrustContext: () => {},
      updateClient: () => {},
      emitConfirmationStateChanged: () => {},
      emitActivityState: () => {},
      setTurnChannelContext: () => {},
      setTurnInterfaceContext: () => {},
      ensureActorScopedHistory: async () => {},
      usageStats: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
      isProcessing: () => false,
      hasAnyPendingConfirmation: () => true,
      denyAllPendingConfirmations: () => {},
      enqueueMessage: () => ({ queued: true, requestId: "queued-id" }),
      persistUserMessage,
      runAgentLoop,
      getMessages: () => [] as unknown[],
      assistantId: "self",
      trustContext: undefined,
      hasPendingConfirmation: (requestId: string) =>
        requestId === "tool-approval-live",
      setHostBrowserProxy: () => {},
      setHostCuProxy: () => {},
      setHostAppControlProxy: () => {},
      restoreBrowserProxyAvailability: () => {},
      addPreactivatedSkillId: () => {},
    } as unknown as import("../daemon/conversation.js").Conversation;

    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-vellum-actor-principal-id": "test-user",
        "x-vellum-principal-type": "actor",
      },
      body: JSON.stringify({
        conversationKey: "guardian-conversation-key",
        content: "approve",
        sourceChannel: "vellum",
        interface: "macos",
      }),
    });

    const res = await callHandler(
      (args) =>
        handleSendMessage(args, {
          sendMessageDeps: {
            getOrCreateConversation: async () => session,
            assistantEventHub: { publish: async () => {} } as any,
            resolveAttachments: () => [],
          },
        }),
      req,
      undefined,
      202,
    );

    expect(res.status).toBe(202);
    expect(routeGuardianReplyMock).toHaveBeenCalledTimes(1);
    const routerCall = (routeGuardianReplyMock as any).mock
      .calls[0][0] as Record<string, unknown>;
    const scope = routerCall.pendingScope as {
      mode: string;
      requestIds: string[];
    };
    expect(scope).toEqual({
      mode: "scoped",
      requestIds: ["tool-approval-live", "access-req-1"],
    });
    expect(scope.requestIds.includes("tool-approval-stale")).toBe(false);
  });

  test("text fallback: request-code approve routes through guardian reply router", async () => {
    listPendingByDestinationMock.mockReturnValue([
      { id: "tool-req-code-1", kind: "tool_approval" },
    ]);
    listCanonicalMock.mockReturnValue([]);
    routeGuardianReplyMock.mockResolvedValue({
      consumed: true,
      decisionApplied: true,
      type: "canonical_decision_applied",
      requestId: "tool-req-code-1",
    });

    const persistUserMessage = mock(async () => ({
      id: "should-not-be-called",
      deduplicated: false,
    }));
    const runAgentLoop = mock(async () => undefined);
    const session = {
      setTrustContext: () => {},
      updateClient: () => {},
      emitConfirmationStateChanged: () => {},
      emitActivityState: () => {},
      setTurnChannelContext: () => {},
      setTurnInterfaceContext: () => {},
      ensureActorScopedHistory: async () => {},
      usageStats: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
      isProcessing: () => false,
      hasAnyPendingConfirmation: () => true,
      denyAllPendingConfirmations: () => {},
      enqueueMessage: () => ({ queued: true, requestId: "queued-id" }),
      persistUserMessage,
      runAgentLoop,
      getMessages: () => [] as unknown[],
      assistantId: "self",
      trustContext: undefined,
      hasPendingConfirmation: (id: string) => id === "tool-req-code-1",
      setHostBrowserProxy: () => {},
      setHostCuProxy: () => {},
      setHostAppControlProxy: () => {},
      restoreBrowserProxyAvailability: () => {},
      addPreactivatedSkillId: () => {},
    } as unknown as import("../daemon/conversation.js").Conversation;

    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-vellum-actor-principal-id": "test-user",
        "x-vellum-principal-type": "actor",
      },
      body: JSON.stringify({
        conversationKey: "guardian-conversation-key",
        content: "A1B2C3 approve",
        sourceChannel: "vellum",
        interface: "macos",
      }),
    });

    const res = await callHandler(
      (args) =>
        handleSendMessage(args, {
          sendMessageDeps: {
            getOrCreateConversation: async () => session,
            assistantEventHub: { publish: async () => {} } as any,
            resolveAttachments: () => [],
          },
        }),
      req,
      undefined,
      202,
    );

    expect(res.status).toBe(202);
    expect(routeGuardianReplyMock).toHaveBeenCalledTimes(1);
    const routerCall = (routeGuardianReplyMock as any).mock
      .calls[0][0] as Record<string, unknown>;
    // The message text should be the full request-code + decision text
    expect(routerCall.messageText).toBe("A1B2C3 approve");
    // Router consumed the message, so the agent loop should NOT run
    expect(persistUserMessage).toHaveBeenCalledTimes(0);
    expect(runAgentLoop).toHaveBeenCalledTimes(0);
  });

  test("text fallback: plain-text reject with single pending request routes through guardian reply router", async () => {
    listPendingByDestinationMock.mockReturnValue([
      { id: "pending-reject-1", kind: "tool_approval" },
    ]);
    listCanonicalMock.mockReturnValue([]);
    routeGuardianReplyMock.mockResolvedValue({
      consumed: true,
      decisionApplied: true,
      type: "canonical_decision_applied",
      requestId: "pending-reject-1",
    });

    const persistUserMessage = mock(async () => ({
      id: "should-not-be-called",
      deduplicated: false,
    }));
    const runAgentLoop = mock(async () => undefined);
    const session = {
      setTrustContext: () => {},
      updateClient: () => {},
      emitConfirmationStateChanged: () => {},
      emitActivityState: () => {},
      setTurnChannelContext: () => {},
      setTurnInterfaceContext: () => {},
      ensureActorScopedHistory: async () => {},
      usageStats: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
      isProcessing: () => false,
      hasAnyPendingConfirmation: () => true,
      denyAllPendingConfirmations: () => {},
      enqueueMessage: () => ({ queued: true, requestId: "queued-id" }),
      persistUserMessage,
      runAgentLoop,
      getMessages: () => [] as unknown[],
      assistantId: "self",
      trustContext: undefined,
      hasPendingConfirmation: (id: string) => id === "pending-reject-1",
      setHostBrowserProxy: () => {},
      setHostCuProxy: () => {},
      setHostAppControlProxy: () => {},
      restoreBrowserProxyAvailability: () => {},
      addPreactivatedSkillId: () => {},
    } as unknown as import("../daemon/conversation.js").Conversation;

    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-vellum-actor-principal-id": "test-user",
        "x-vellum-principal-type": "actor",
      },
      body: JSON.stringify({
        conversationKey: "guardian-conversation-key",
        content: "reject",
        sourceChannel: "vellum",
        interface: "macos",
      }),
    });

    const res = await callHandler(
      (args) =>
        handleSendMessage(args, {
          sendMessageDeps: {
            getOrCreateConversation: async () => session,
            assistantEventHub: { publish: async () => {} } as any,
            resolveAttachments: () => [],
          },
        }),
      req,
      undefined,
      202,
    );

    expect(res.status).toBe(202);
    expect(routeGuardianReplyMock).toHaveBeenCalledTimes(1);
    expect(persistUserMessage).toHaveBeenCalledTimes(0);
    expect(runAgentLoop).toHaveBeenCalledTimes(0);
  });

  test("text fallback: non-consumed messages fall through to agent loop", async () => {
    listPendingByDestinationMock.mockReturnValue([
      { id: "pending-1", kind: "tool_approval" },
    ]);
    listCanonicalMock.mockReturnValue([]);
    routeGuardianReplyMock.mockResolvedValue({
      consumed: false,
      decisionApplied: false,
      type: "not_consumed",
    });

    const persistUserMessage = mock(async () => ({
      id: "persisted-user-id",
      deduplicated: false,
    }));
    const runAgentLoop = mock(async () => undefined);
    const session = {
      setTrustContext: () => {},
      updateClient: () => {},
      emitConfirmationStateChanged: () => {},
      emitActivityState: () => {},
      setTurnChannelContext: () => {},
      setTurnInterfaceContext: () => {},
      ensureActorScopedHistory: async () => {},
      usageStats: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
      isProcessing: () => false,
      hasAnyPendingConfirmation: () => true,
      denyAllPendingConfirmations: () => {},
      enqueueMessage: () => ({ queued: true, requestId: "queued-id" }),
      persistUserMessage,
      runAgentLoop,
      getMessages: () => [] as unknown[],
      assistantId: "self",
      trustContext: undefined,
      hasPendingConfirmation: (id: string) => id === "pending-1",
      setHostBrowserProxy: () => {},
      setHostCuProxy: () => {},
      setHostAppControlProxy: () => {},
      restoreBrowserProxyAvailability: () => {},
      addPreactivatedSkillId: () => {},
    } as unknown as import("../daemon/conversation.js").Conversation;

    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-vellum-actor-principal-id": "test-user",
        "x-vellum-principal-type": "actor",
      },
      body: JSON.stringify({
        conversationKey: "guardian-conversation-key",
        content: "tell me more about this request",
        sourceChannel: "vellum",
        interface: "macos",
      }),
    });

    const res = await callHandler(
      (args) =>
        handleSendMessage(args, {
          sendMessageDeps: {
            getOrCreateConversation: async () => session,
            assistantEventHub: { publish: async () => {} } as any,
            resolveAttachments: () => [],
          },
        }),
      req,
      undefined,
      202,
    );

    expect(res.status).toBe(202);
    expect(routeGuardianReplyMock).toHaveBeenCalledTimes(1);
    // Router did not consume: message should fall through to agent loop
    expect(persistUserMessage).toHaveBeenCalledTimes(1);
    expect(runAgentLoop).toHaveBeenCalledTimes(1);
  });

  test("desktop conversations do not pass approvalConversationGenerator to routeGuardianReply", async () => {
    listPendingByDestinationMock.mockReturnValue([
      { id: "pending-1", kind: "access_request" },
    ]);
    listCanonicalMock.mockReturnValue([]);
    routeGuardianReplyMock.mockResolvedValue({
      consumed: false,
      decisionApplied: false,
      type: "not_consumed",
    });

    const mockGenerator = mock(async () => ({}));
    const persistUserMessage = mock(async () => ({
      id: "persisted-user-id",
      deduplicated: false,
    }));
    const runAgentLoop = mock(async () => undefined);
    const session = {
      setTrustContext: () => {},
      updateClient: () => {},
      emitConfirmationStateChanged: () => {},
      emitActivityState: () => {},
      setTurnChannelContext: () => {},
      setTurnInterfaceContext: () => {},
      ensureActorScopedHistory: async () => {},
      usageStats: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
      isProcessing: () => false,
      hasAnyPendingConfirmation: () => false,
      denyAllPendingConfirmations: () => {},
      enqueueMessage: () => ({ queued: true, requestId: "queued-id" }),
      persistUserMessage,
      runAgentLoop,
      getMessages: () => [] as unknown[],
      assistantId: "self",
      trustContext: undefined,
      hasPendingConfirmation: () => false,
      setHostBrowserProxy: () => {},
      setHostCuProxy: () => {},
      setHostAppControlProxy: () => {},
      restoreBrowserProxyAvailability: () => {},
      addPreactivatedSkillId: () => {},
    } as unknown as import("../daemon/conversation.js").Conversation;

    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-vellum-actor-principal-id": "test-user",
        "x-vellum-principal-type": "actor",
      },
      body: JSON.stringify({
        conversationKey: "guardian-conversation-key",
        content: "no sorry, beats 0 and 3 should be new threads",
        sourceChannel: "vellum",
        interface: "macos",
      }),
    });

    await callHandler(
      (args) =>
        handleSendMessage(args, {
          sendMessageDeps: {
            getOrCreateConversation: async () => session,
            assistantEventHub: { publish: async () => {} } as any,
            resolveAttachments: () => [],
          },
          approvalConversationGenerator: mockGenerator as any,
        }),
      req,
      undefined,
      202,
    );

    expect(routeGuardianReplyMock).toHaveBeenCalledTimes(1);
    const routerCall = (routeGuardianReplyMock as any).mock
      .calls[0][0] as Record<string, unknown>;
    // Desktop (vellum) should suppress the NL engine
    expect(routerCall.approvalConversationGenerator).toBeUndefined();
  });

  test("channel conversations pass approvalConversationGenerator to routeGuardianReply", async () => {
    listPendingByDestinationMock.mockReturnValue([
      { id: "pending-1", kind: "access_request" },
    ]);
    listCanonicalMock.mockReturnValue([]);
    routeGuardianReplyMock.mockResolvedValue({
      consumed: false,
      decisionApplied: false,
      type: "not_consumed",
    });

    const mockGenerator = mock(async () => ({}));
    const persistUserMessage = mock(async () => ({
      id: "persisted-user-id",
      deduplicated: false,
    }));
    const runAgentLoop = mock(async () => undefined);
    const session = {
      setTrustContext: () => {},
      updateClient: () => {},
      emitConfirmationStateChanged: () => {},
      emitActivityState: () => {},
      setTurnChannelContext: () => {},
      setTurnInterfaceContext: () => {},
      ensureActorScopedHistory: async () => {},
      usageStats: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
      isProcessing: () => false,
      hasAnyPendingConfirmation: () => false,
      denyAllPendingConfirmations: () => {},
      enqueueMessage: () => ({ queued: true, requestId: "queued-id" }),
      persistUserMessage,
      runAgentLoop,
      getMessages: () => [] as unknown[],
      assistantId: "self",
      trustContext: undefined,
      hasPendingConfirmation: () => false,
      setHostBrowserProxy: () => {},
      setHostCuProxy: () => {},
      setHostAppControlProxy: () => {},
      restoreBrowserProxyAvailability: () => {},
      addPreactivatedSkillId: () => {},
    } as unknown as import("../daemon/conversation.js").Conversation;

    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-vellum-actor-principal-id": "test-user",
        "x-vellum-principal-type": "actor",
      },
      body: JSON.stringify({
        conversationKey: "guardian-conversation-key",
        content: "no sorry, beats 0 and 3 should be new threads",
        sourceChannel: "telegram",
        interface: "telegram",
      }),
    });

    await callHandler(
      (args) =>
        handleSendMessage(args, {
          sendMessageDeps: {
            getOrCreateConversation: async () => session,
            assistantEventHub: { publish: async () => {} } as any,
            resolveAttachments: () => [],
          },
          approvalConversationGenerator: mockGenerator as any,
        }),
      req,
      undefined,
      202,
    );

    expect(routeGuardianReplyMock).toHaveBeenCalledTimes(1);
    const routerCall = (routeGuardianReplyMock as any).mock
      .calls[0][0] as Record<string, unknown>;
    // Channel sessions should receive the NL engine
    expect(routerCall.approvalConversationGenerator).toBe(mockGenerator);
  });
});
