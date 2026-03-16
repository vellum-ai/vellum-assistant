/**
 * Tests for slash command interception in the POST /v1/messages handler.
 *
 * Validates that:
 * - Built-in slash commands (/status, /model, /commands) are intercepted and
 *   do NOT trigger the agent loop.
 * - Regular messages pass through to the agent loop unchanged.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../config/env.js", () => ({ isHttpAuthDisabled: () => true }));

import type { SlashResolution } from "../daemon/conversation-slash.js";

const resolveSlashMock = mock(
  (_content: string, _context?: unknown): SlashResolution => ({
    kind: "passthrough",
    content: _content,
  }),
);

mock.module("../daemon/conversation-slash.js", () => ({
  resolveSlash: resolveSlashMock,
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    model: "claude-opus-4-6",
    provider: "anthropic",
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0, maxTokensPerSession: 0 },
    secretDetection: { enabled: false },
    contextWindow: { maxInputTokens: 200000 },
  }),
}));

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

mock.module("../memory/conversation-key-store.js", () => ({
  getOrCreateConversation: () => ({ conversationId: "conv-slash-test" }),
  getConversationByKey: () => null,
}));

mock.module("../memory/attachments-store.js", () => ({
  getAttachmentsByIds: () => [],
}));

mock.module("../runtime/guardian-reply-router.js", () => ({
  routeGuardianReply: async () => ({
    consumed: false,
    decisionApplied: false,
    type: "not_consumed",
  }),
}));

mock.module("../memory/canonical-guardian-store.js", () => ({
  createCanonicalGuardianRequest: () => ({
    id: "canonical-id",
    requestCode: "ABC123",
  }),
  generateCanonicalRequestCode: () => "ABC123",
  listPendingCanonicalGuardianRequestsByDestinationConversation: () => [],
  listCanonicalGuardianRequests: () => [],
  listPendingRequestsByConversationScope: () => [],
}));

mock.module("../runtime/confirmation-request-guardian-bridge.js", () => ({
  bridgeConfirmationRequestToGuardian: async () => undefined,
}));

mock.module("../memory/conversation-crud.js", () => ({
  addMessage: (
    conversationId: string,
    role: string,
    content: string,
    metadata?: Record<string, unknown>,
  ) => addMessageMock(conversationId, role, content, metadata),
  getMessages: () => [],
  provenanceFromTrustContext: (ctx: unknown) =>
    ctx
      ? { provenanceTrustClass: (ctx as Record<string, unknown>).trustClass }
      : { provenanceTrustClass: "unknown" },
  setConversationOriginChannelIfUnset: () => {},
  setConversationOriginInterfaceIfUnset: () => {},
}));

mock.module("../daemon/conversation-process.js", () => ({
  buildModelInfoEvent: () => ({
    type: "model_info",
    model: "claude-opus-4-6",
    provider: "anthropic",
    configuredProviders: ["anthropic", "ollama"],
  }),
  isModelSlashCommand: (content: string) => {
    const trimmed = content.trim();
    return (
      trimmed === "/model" ||
      trimmed === "/models" ||
      trimmed.startsWith("/model ")
    );
  },
}));

mock.module("../runtime/local-actor-identity.js", () => ({
  resolveLocalTrustContext: () => ({
    trustClass: "guardian",
    sourceChannel: "vellum",
  }),
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

import type { AuthContext } from "../runtime/auth/types.js";
import { handleSendMessage } from "../runtime/routes/conversation-routes.js";

const testAuthContext: AuthContext = {
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

function makeSession() {
  const persistUserMessage = mock(
    async (_content: string, _attachments: unknown[], _requestId?: string) =>
      "persisted-user-id",
  );
  const runAgentLoop = mock(
    async (
      _content: string,
      _messageId: string,
      _onEvent: unknown,
      _options?: unknown,
    ) => undefined,
  );
  const setPreactivatedSkillIds = mock((_ids: string[] | undefined) => {});
  const events: unknown[] = [];
  const messages: unknown[] = [];
  const session = {
    setTrustContext: () => {},
    updateClient: (_fn: unknown, _b: boolean) => {},
    emitConfirmationStateChanged: () => {},
    emitActivityState: () => {},
    setTurnChannelContext: () => {},
    setTurnInterfaceContext: () => {},
    ensureActorScopedHistory: async () => {},
    isProcessing: () => false,
    hasAnyPendingConfirmation: () => false,
    denyAllPendingConfirmations: () => {},
    enqueueMessage: () => ({ queued: true, requestId: "queued-id" }),
    persistUserMessage,
    runAgentLoop,
    setPreactivatedSkillIds,
    drainQueue: async () => {},
    getMessages: () => messages,
    assistantId: "self",
    trustContext: undefined,
    hasPendingConfirmation: () => false,
    setHostBashProxy: () => {},
    setHostFileProxy: () => {},
    setHostCuProxy: () => {},
    addPreactivatedSkillId: () => {},
    usageStats: {
      inputTokens: 1000,
      outputTokens: 500,
      estimatedCost: 0.05,
    },
  } as unknown as import("../daemon/conversation.js").Conversation;
  return {
    session,
    persistUserMessage,
    runAgentLoop,
    setPreactivatedSkillIds,
    events,
    messages,
  };
}

function makeRequest(content: string) {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      conversationKey: "slash-test-key",
      content,
      sourceChannel: "vellum",
      interface: "macos",
    }),
  });
}

function makeDeps(session: import("../daemon/conversation.js").Conversation) {
  return {
    sendMessageDeps: {
      getOrCreateConversation: async () => session,
      assistantEventHub: { publish: async () => {} } as any,
      resolveAttachments: () => [],
    },
  };
}

describe("handleSendMessage slash command interception", () => {
  beforeEach(() => {
    resolveSlashMock.mockClear();
    addMessageMock.mockClear();
  });

  test("intercepts built-in slash commands (unknown kind) without calling agent loop", async () => {
    resolveSlashMock.mockReturnValue({
      kind: "unknown",
      message: "Conversation Status\n\nContext: 5%",
    });

    const { session, persistUserMessage, runAgentLoop } = makeSession();
    const res = await handleSendMessage(
      makeRequest("/status"),
      makeDeps(session),
      testAuthContext,
    );

    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      accepted: boolean;
      messageId?: string;
    };
    expect(body.accepted).toBe(true);
    expect(body.messageId).toBe("persisted-user-id");

    // Slash command was resolved
    expect(resolveSlashMock).toHaveBeenCalledTimes(1);
    expect(resolveSlashMock.mock.calls[0][0]).toBe("/status");

    // User + assistant messages persisted, but agent loop NOT called
    expect(addMessageMock).toHaveBeenCalledTimes(2);
    const roles = addMessageMock.mock.calls.map((c) => c[1]);
    expect(roles).toEqual(["user", "assistant"]);
    expect(persistUserMessage).not.toHaveBeenCalled();
    expect(runAgentLoop).not.toHaveBeenCalled();
  });

  test("passes regular messages through to agent loop unchanged", async () => {
    resolveSlashMock.mockReturnValue({
      kind: "passthrough",
      content: "hello there",
    });

    const {
      session,
      persistUserMessage,
      runAgentLoop,
      setPreactivatedSkillIds,
    } = makeSession();
    const res = await handleSendMessage(
      makeRequest("hello there"),
      makeDeps(session),
      testAuthContext,
    );

    expect(res.status).toBe(202);

    // Slash command was resolved but passed through
    expect(resolveSlashMock).toHaveBeenCalledTimes(1);

    // No skill preactivation
    expect(setPreactivatedSkillIds).not.toHaveBeenCalled();

    // Agent loop called with original content
    expect(persistUserMessage).toHaveBeenCalledTimes(1);
    expect(runAgentLoop).toHaveBeenCalledTimes(1);
    const loopContent = runAgentLoop.mock.calls[0][0];
    expect(loopContent).toBe("hello there");
  });

  test("passes SlashContext with session usage stats", async () => {
    resolveSlashMock.mockReturnValue({
      kind: "passthrough",
      content: "test",
    });

    const { session } = makeSession();
    await handleSendMessage(
      makeRequest("test"),
      makeDeps(session),
      testAuthContext,
    );

    expect(resolveSlashMock).toHaveBeenCalledTimes(1);
    const context = resolveSlashMock.mock.calls[0][1] as Record<
      string,
      unknown
    >;
    expect(context).toMatchObject({
      inputTokens: 1000,
      outputTokens: 500,
      estimatedCost: 0.05,
      model: "claude-opus-4-6",
      provider: "anthropic",
      maxInputTokens: 200000,
    });
  });
});
