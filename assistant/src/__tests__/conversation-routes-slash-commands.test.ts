/**
 * Tests for slash command interception in the POST /v1/messages handler.
 *
 * Validates that:
 * - Built-in slash commands (/context, /models, /commands) are intercepted and
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

const formatCompactResultMock = mock(
  (result: { maxInputTokens: number }) =>
    `Context Compacted\n\nContext: 10,000 / ${result.maxInputTokens.toLocaleString(
      "en-US",
    )} tokens`,
);

mock.module("../daemon/conversation-slash.js", () => ({
  resolveSlash: resolveSlashMock,
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    model: "claude-opus-4-7",
    provider: "anthropic",
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0 },
    secretDetection: { enabled: false },
    contextWindow: { maxInputTokens: 200000 },
    llm: {
      default: {
        provider: "anthropic",
        model: "claude-opus-4-7",
        maxTokens: 64000,
        effort: "max" as const,
        speed: "standard" as const,
        temperature: null,
        thinking: { enabled: true, streamThinking: true },
        contextWindow: {
          enabled: true,
          maxInputTokens: 200000,
          targetBudgetRatio: 0.3,
          compactThreshold: 0.8,
          summaryBudgetRatio: 0.05,
          overflowRecovery: {
            enabled: true,
            safetyMarginRatio: 0.05,
            maxAttempts: 3,
            interactiveLatestTurnCompression: "summarize",
            nonInteractiveLatestTurnCompression: "truncate",
          },
        },
      },
      profiles: {
        "short-context": {
          contextWindow: { maxInputTokens: 150000 },
        },
      },
      callSites: {},
      pricingOverrides: [],
    },
    services: {
      inference: {
        mode: "your-own",
        provider: "anthropic",
        model: "claude-opus-4-7",
      },
      "image-generation": {
        mode: "your-own",
        provider: "gemini",
        model: "gemini-3.1-flash-image-preview",
      },
      "web-search": { mode: "your-own", provider: "inference-provider-native" },
    },
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
  getConversationOverrideProfile: () => "short-context",
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
    return content.trim() === "/models";
  },
  formatCompactResult: formatCompactResultMock,
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

const ipcCallMock = mock(
  async (): Promise<Record<string, unknown> | undefined> => ({ ok: true }),
);
mock.module("../ipc/gateway-client.js", () => ({
  ipcCall: ipcCallMock,
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

function makeConversation() {
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
  const forceCompact = mock(async () => ({
    messages: [],
    compacted: true,
    previousEstimatedInputTokens: 12000,
    estimatedInputTokens: 10000,
    maxInputTokens: 150000,
    thresholdTokens: 120000,
    compactedMessages: 2,
    compactedPersistedMessages: 2,
    summaryCalls: 1,
    summaryInputTokens: 500,
    summaryOutputTokens: 100,
    summaryModel: "claude-opus-4-7",
    summaryText: "Summary",
  }));
  const events: unknown[] = [];
  const messages: unknown[] = [];
  const conversation = {
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
    forceCompact,
    setPreactivatedSkillIds,
    drainQueue: async () => {},
    getMessages: () => messages,
    assistantId: "self",
    trustContext: undefined,
    hasPendingConfirmation: () => false,
    setHostBashProxy: () => {},
    setHostBrowserProxy: () => {},
    setHostFileProxy: () => {},
    setHostTransferProxy: () => {},
    getHostTransferProxy: () => undefined,
    setHostCuProxy: () => {},
    addPreactivatedSkillId: () => {},
    usageStats: {
      inputTokens: 1000,
      outputTokens: 500,
      estimatedCost: 0.05,
    },
  } as unknown as import("../daemon/conversation.js").Conversation;
  return {
    conversation,
    persistUserMessage,
    runAgentLoop,
    setPreactivatedSkillIds,
    events,
    messages,
    forceCompact,
  };
}

function makeRequest(content: string, extras: Record<string, unknown> = {}) {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-vellum-actor-principal-id": "test-user",
      "x-vellum-principal-type": "actor",
    },
    body: JSON.stringify({
      conversationKey: "slash-test-key",
      content,
      sourceChannel: "vellum",
      interface: "macos",
      ...extras,
    }),
  });
}

function makeDeps(
  conversation: import("../daemon/conversation.js").Conversation,
) {
  return {
    sendMessageDeps: {
      getOrCreateConversation: async () => conversation,
      assistantEventHub: { publish: async () => {} } as any,
      resolveAttachments: () => [],
    },
  };
}

describe("handleSendMessage slash command interception", () => {
  beforeEach(() => {
    resolveSlashMock.mockClear();
    formatCompactResultMock.mockClear();
    addMessageMock.mockClear();
    ipcCallMock.mockClear();
  });

  test("intercepts built-in slash commands (unknown kind) without calling agent loop", async () => {
    resolveSlashMock.mockReturnValue({
      kind: "unknown",
      message: "Conversation Status\n\nContext: 5%",
    });

    const { conversation, persistUserMessage, runAgentLoop } =
      makeConversation();
    const res = await callHandler(
      (args) => handleSendMessage(args, makeDeps(conversation)),
      makeRequest("/context"),
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

    // Slash command was resolved
    expect(resolveSlashMock).toHaveBeenCalledTimes(1);
    expect(resolveSlashMock.mock.calls[0][0]).toBe("/context");

    // User + assistant messages persisted, but agent loop NOT called
    expect(addMessageMock).toHaveBeenCalledTimes(2);
    const roles = addMessageMock.mock.calls.map((c) => c[1]);
    expect(roles).toEqual(["user", "assistant"]);
    expect(persistUserMessage).not.toHaveBeenCalled();
    expect(runAgentLoop).not.toHaveBeenCalled();
  });

  test("handles /compact without calling agent loop and formats the compaction max", async () => {
    resolveSlashMock.mockReturnValue({
      kind: "compact",
    });

    const { conversation, persistUserMessage, runAgentLoop, forceCompact } =
      makeConversation();
    const res = await callHandler(
      (args) => handleSendMessage(args, makeDeps(conversation)),
      makeRequest("/compact"),
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

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(resolveSlashMock).toHaveBeenCalledTimes(1);
    expect(resolveSlashMock.mock.calls[0][0]).toBe("/compact");
    expect(forceCompact).toHaveBeenCalledTimes(1);
    expect(formatCompactResultMock).toHaveBeenCalledWith(
      expect.objectContaining({ maxInputTokens: 150000 }),
    );
    expect(persistUserMessage).not.toHaveBeenCalled();
    expect(runAgentLoop).not.toHaveBeenCalled();
  });

  test("passes regular messages through to agent loop unchanged", async () => {
    resolveSlashMock.mockReturnValue({
      kind: "passthrough",
      content: "hello there",
    });

    const {
      conversation,
      persistUserMessage,
      runAgentLoop,
      setPreactivatedSkillIds,
    } = makeConversation();
    const res = await callHandler(
      (args) => handleSendMessage(args, makeDeps(conversation)),
      makeRequest("hello there"),
      undefined,
      202,
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

  test("passes SlashContext with resolved profile context budget", async () => {
    resolveSlashMock.mockReturnValue({
      kind: "unknown",
      message: "Conversation Status\n\nContext: 50%",
    });

    const { conversation } = makeConversation();
    await callHandler(
      (args) => handleSendMessage(args, makeDeps(conversation)),
      makeRequest("/context"),
      undefined,
      202,
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
      model: "claude-opus-4-7",
      provider: "anthropic",
      maxInputTokens: 150000,
    });
  });

  test("applies riskThreshold override when provided", async () => {
    resolveSlashMock.mockReturnValue({
      kind: "passthrough",
      content: "hello there",
    });

    const { conversation } = makeConversation();
    const res = await callHandler(
      (args) => handleSendMessage(args, makeDeps(conversation)),
      makeRequest("hello there", { riskThreshold: "none" }),
      undefined,
      202,
    );

    expect(res.status).toBe(202);
    expect(ipcCallMock).toHaveBeenCalledWith("set_conversation_threshold", {
      conversationId: "conv-slash-test",
      threshold: "none",
    });
  });

  test("returns 500 when riskThreshold IPC fails", async () => {
    resolveSlashMock.mockReturnValue({
      kind: "passthrough",
      content: "hello there",
    });
    ipcCallMock.mockImplementationOnce(async () => undefined);

    const { conversation } = makeConversation();
    const res = await callHandler(
      (args) => handleSendMessage(args, makeDeps(conversation)),
      makeRequest("hello there", { riskThreshold: "none" }),
      undefined,
      202,
    );

    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).toContain("risk threshold");
  });

  test("rejects invalid riskThreshold values", async () => {
    const { conversation } = makeConversation();
    const res = await callHandler(
      (args) => handleSendMessage(args, makeDeps(conversation)),
      makeRequest("hello there", { riskThreshold: "critical" }),
      undefined,
      202,
    );

    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("riskThreshold");
    expect(ipcCallMock).not.toHaveBeenCalled();
  });
});
