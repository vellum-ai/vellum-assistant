import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — must be declared before any imports that depend on them
// ---------------------------------------------------------------------------

const BASE_CONFIG = {
  contextWindow: { maxInputTokens: 100000 },
  services: { inference: { model: "test-model", provider: "test-provider" } },
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
    profiles: {},
    callSites: {},
    pricingOverrides: [],
  },
};

let mockConfig: Record<string, unknown> = {
  secretDetection: {
    enabled: true,
    blockIngress: true,
  },
  ...BASE_CONFIG,
};

mock.module("../config/env.js", () => ({ isHttpAuthDisabled: () => true }));

mock.module("../config/loader.js", () => ({
  getConfig: () => mockConfig,
  loadConfig: () => mockConfig,
  invalidateConfigCache: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../memory/conversation-key-store.js", () => ({
  getOrCreateConversation: () => ({ conversationId: "conv-test" }),
  getConversationByKey: () => null,
}));

mock.module("../memory/attachments-store.js", () => ({
  getAttachmentsByIds: () => [],
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

const addMessageMock = mock(
  async (
    _conversationId: string,
    _role: string,
    _content?: string,
    _metadata?: Record<string, unknown>,
  ) => ({
    id: "persisted-msg-id",
  }),
);

mock.module("../memory/conversation-crud.js", () => ({
  addMessage: (
    conversationId: string,
    role: string,
    content: string,
    metadata?: Record<string, unknown>,
  ) => addMessageMock(conversationId, role, content, metadata),
  getMessages: () => [],
  provenanceFromTrustContext: () => undefined,
  setConversationOriginChannelIfUnset: () => {},
  setConversationOriginInterfaceIfUnset: () => {},
  getConversationMemoryScopeId: () => undefined,
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

mock.module("../runtime/guardian-reply-router.js", () => ({
  routeGuardianReply: async () => ({
    consumed: false,
    decisionApplied: false,
    type: "not_consumed" as const,
  }),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import type { AuthContext } from "../runtime/auth/types.js";
import { handleSendMessage } from "../runtime/routes/conversation-routes.js";
import { callHandler } from "./helpers/call-route-handler.js";

const testAuthContext: AuthContext = {
  subject: "actor:self:test-user",
  principalType: "actor",
  assistantId: "self",
  actorPrincipalId: "test-user",
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

function makeRequest(
  body: Record<string, unknown>,
  authContext: AuthContext = testAuthContext,
): Request {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authContext.actorPrincipalId
        ? { "x-vellum-actor-principal-id": authContext.actorPrincipalId }
        : {}),
      "x-vellum-principal-type": authContext.principalType,
    },
    body: JSON.stringify({
      conversationKey: "test-conversation",
      sourceChannel: "vellum",
      interface: "macos",
      ...body,
    }),
  });
}

const persistUserMessageMock = mock(async () => "persisted-id");
const runAgentLoopMock = mock(async () => undefined);

function makeSendMessageDeps() {
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
    persistUserMessage: persistUserMessageMock,
    runAgentLoop: runAgentLoopMock,
    getMessages: () => [] as unknown[],
    assistantId: "self",
    trustContext: undefined,
    hasPendingConfirmation: () => false,
    setHostBrowserProxy: () => {},
    setHostCuProxy: () => {},
    addPreactivatedSkillId: () => {},
  } as unknown as import("../daemon/conversation.js").Conversation;

  return {
    sendMessageDeps: {
      getOrCreateConversation: async () => session,
      assistantEventHub: { publish: async () => {} } as any,
      resolveAttachments: () => [],
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("secret ingress — HTTP route", () => {
  beforeEach(() => {
    mockConfig = {
      secretDetection: {
        enabled: true,
        blockIngress: true,
      },
      ...BASE_CONFIG,
    };
    persistUserMessageMock.mockClear();
    runAgentLoopMock.mockClear();
    addMessageMock.mockClear();
  });

  test("POST /v1/messages with GitHub token returns 422 secret_blocked", async () => {
    const req = makeRequest({
      content: "Here is my token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij1234",
    });

    const res = await callHandler(
      (args) => handleSendMessage(args, makeSendMessageDeps()),
      req,
      undefined,
      202,
    );
    expect(res.status).toBe(422);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("secret_blocked");
    expect(body.accepted).toBe(false);
    expect(body.detectedTypes).toContain("GitHub Token");
  });

  test("POST /v1/messages with normal text returns 202 accepted", async () => {
    const req = makeRequest({
      content: "Hello, can you help me with my project?",
    });

    const res = await callHandler(
      (args) => handleSendMessage(args, makeSendMessageDeps()),
      req,
      undefined,
      202,
    );
    expect(res.status).toBe(202);
  });

  test("POST /v1/messages with bypassSecretCheck: true and secret returns 202", async () => {
    const req = makeRequest({
      content: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij1234",
      bypassSecretCheck: true,
    });

    const res = await callHandler(
      (args) => handleSendMessage(args, makeSendMessageDeps()),
      req,
      undefined,
      202,
    );
    expect(res.status).toBe(202);
  });

  test("POST /v1/messages with JWT eyJ... returns 202 (not in curated patterns)", async () => {
    const req = makeRequest({
      content:
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    });

    const res = await callHandler(
      (args) => handleSendMessage(args, makeSendMessageDeps()),
      req,
      undefined,
      202,
    );
    expect(res.status).toBe(202);
  });

  test("POST /v1/messages with blockIngress: false config and secret returns 202", async () => {
    mockConfig = {
      secretDetection: {
        enabled: true,
        blockIngress: false,
      },
      ...BASE_CONFIG,
    };

    const req = makeRequest({
      content: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij1234",
    });

    const res = await callHandler(
      (args) => handleSendMessage(args, makeSendMessageDeps()),
      req,
      undefined,
      202,
    );
    expect(res.status).toBe(202);
  });

  test("message is NOT persisted when blocked", async () => {
    const req = makeRequest({
      content: "AKIAIOSFODNN7EXAMPLE",
    });

    const res = await callHandler(
      (args) => handleSendMessage(args, makeSendMessageDeps()),
      req,
      undefined,
      202,
    );
    expect(res.status).toBe(422);

    // persistUserMessage should not have been called
    expect(persistUserMessageMock).not.toHaveBeenCalled();
    // addMessage should not have been called
    expect(addMessageMock).not.toHaveBeenCalled();
  });
});
