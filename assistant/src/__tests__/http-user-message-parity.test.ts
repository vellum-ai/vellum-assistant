/**
 * Tests for HTTP POST /v1/messages behavior after the legacy handleUserMessage
 * legacy entry point was retired.
 *
 * Secret ingress blocking has been ported to the HTTP path. Recording intent
 * interception has been deliberately retired — the HTTP path has dedicated
 * /v1/recording/* endpoints and the model handles recording-related messages
 * through the agent loop.
 *
 * Approval reply interception has parity and is covered by
 * conversation-routes-guardian-reply.test.ts and send-endpoint-busy.test.ts.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

// ────────────────────────────────────────────────────────────────────────────
// Module mocks — must be set up before any imports that pull in the mocked
// modules. These are shared across all describe blocks in this file.
// ────────────────────────────────────────────────────────────────────────────

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

mock.module("../memory/conversation-key-store.js", () => ({
  getOrCreateConversation: () => ({ conversationId: "conv-parity-test" }),
  getConversationByKey: () => null,
}));

mock.module("../memory/attachments-store.js", () => ({
  getAttachmentsByIds: () => [],
}));

mock.module("../runtime/guardian-reply-router.js", () => ({
  routeGuardianReply: routeGuardianReplyMock,
}));

mock.module("../memory/canonical-guardian-store.js", () => ({
  createCanonicalGuardianRequest: () => ({
    id: "canonical-id",
    requestCode: "ABC123",
  }),
  generateCanonicalRequestCode: () => "ABC123",
  listPendingCanonicalGuardianRequestsByDestinationConversation: (
    conversationId: string,
    sourceChannel?: string,
  ) => listPendingByDestinationMock(conversationId, sourceChannel),
  listCanonicalGuardianRequests: (filters?: Record<string, unknown>) =>
    listCanonicalMock(filters),
  listPendingRequestsByConversationScope: (conversationId: string) => {
    const byDest = listPendingByDestinationMock(conversationId);
    const bySrc = listCanonicalMock({ status: "pending", conversationId });
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

mock.module("../memory/conversation-crud.js", () => ({
  addMessage: (
    conversationId: string,
    role: string,
    content: string,
    metadata?: Record<string, unknown>,
  ) => addMessageMock(conversationId, role, content, metadata),
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

// Mock config to enable secret detection + ingress blocking
mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    secretDetection: {
      enabled: true,
      blockIngress: true,
      customPatterns: [],
      entropyThreshold: 3.5,
    },
    model: "test",
    provider: "test",
    contextWindow: { maxInputTokens: 200000 },
  }),
}));

import type { AuthContext } from "../runtime/auth/types.js";
import { handleSendMessage } from "../runtime/routes/conversation-routes.js";

const testAuthContext: AuthContext = {
  subject: "actor:self:test-actor",
  principalType: "actor",
  assistantId: "self",
  actorPrincipalId: "test-actor",
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

// ── Helper: create a minimal mock session ──────────────────────────────────
function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    setTrustContext: () => {},
    updateClient: () => {},
    setHostBashProxy: () => {},
    setHostFileProxy: () => {},
    setHostCuProxy: () => {},
    addPreactivatedSkillId: () => {},
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
    persistUserMessage: mock(async () => "persisted-user-id"),
    runAgentLoop: mock(async () => undefined),
    getMessages: () => [] as unknown[],
    assistantId: "self",
    trustContext: undefined,
    hasPendingConfirmation: () => false,
    ...overrides,
  } as unknown as import("../daemon/session.js").Session;
}

// ── Helper: create an HTTP request to POST /v1/messages ────────────────────
function makeRequest(content: string, extra: Record<string, unknown> = {}) {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      conversationKey: "parity-test-key",
      content,
      sourceChannel: "vellum",
      interface: "macos",
      ...extra,
    }),
  });
}

// ── Helper: send a message through handleSendMessage ───────────────────────
async function sendMessage(
  content: string,
  session: import("../daemon/session.js").Session,
  extra: Record<string, unknown> = {},
) {
  return handleSendMessage(
    makeRequest(content, extra),
    {
      sendMessageDeps: {
        getOrCreateSession: async () => session,
        assistantEventHub: { publish: async () => {} } as any,
        resolveAttachments: () => [],
      },
    },
    testAuthContext,
  );
}

// ============================================================================
// SECRET INGRESS BLOCKING — now ported to HTTP path
// ============================================================================
describe("HTTP POST /v1/messages blocks secret ingress", () => {
  beforeEach(() => {
    routeGuardianReplyMock.mockClear();
    listPendingByDestinationMock.mockClear();
    listCanonicalMock.mockClear();
    addMessageMock.mockClear();
  });

  test("handleSendMessage rejects messages containing Telegram bot token patterns", async () => {
    const secretContent =
      "Set up Telegram with my bot token 123456789:ABCDefGHIJklmnopQRSTuvwxyz012345678";
    const persistUserMessage = mock(async () => "persisted-msg-id");
    const runAgentLoop = mock(async () => undefined);
    const session = makeSession({ persistUserMessage, runAgentLoop });

    const res = await sendMessage(secretContent, session);

    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      accepted: boolean;
      error: string;
      message: string;
      detectedTypes: string[];
    };
    expect(body.accepted).toBe(false);
    expect(body.error).toBe("secret_blocked");
    expect(body.detectedTypes.length).toBeGreaterThan(0);

    // The message should NOT reach the agent loop
    expect(persistUserMessage).toHaveBeenCalledTimes(0);
    expect(runAgentLoop).toHaveBeenCalledTimes(0);
  });

  test("handleSendMessage rejects messages containing AWS credentials", async () => {
    const secretContent =
      "Here is my AWS key AKIAQRSTUVWXYZ123456 and secret wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const persistUserMessage = mock(async () => "persisted-msg-id");
    const runAgentLoop = mock(async () => undefined);
    const session = makeSession({ persistUserMessage, runAgentLoop });

    const res = await sendMessage(secretContent, session);

    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      accepted: boolean;
      error: string;
    };
    expect(body.accepted).toBe(false);
    expect(body.error).toBe("secret_blocked");

    // The message should NOT reach the agent loop
    expect(persistUserMessage).toHaveBeenCalledTimes(0);
    expect(runAgentLoop).toHaveBeenCalledTimes(0);
  });

  test("handleSendMessage rejects messages containing Stripe live API keys", async () => {
    const secretContent = "My Stripe key is sk_live_4eC39HqLyjWDarjtT1zdp7dc";
    const persistUserMessage = mock(async () => "persisted-msg-id");
    const runAgentLoop = mock(async () => undefined);
    const session = makeSession({ persistUserMessage, runAgentLoop });

    const res = await sendMessage(secretContent, session);

    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      accepted: boolean;
      error: string;
    };
    expect(body.accepted).toBe(false);
    expect(body.error).toBe("secret_blocked");

    // The message should NOT reach the agent loop
    expect(persistUserMessage).toHaveBeenCalledTimes(0);
    expect(runAgentLoop).toHaveBeenCalledTimes(0);
  });

  test("handleSendMessage allows normal messages without secrets", async () => {
    const normalContent = "What is the weather today?";
    const persistUserMessage = mock(async () => "persisted-msg-id");
    const runAgentLoop = mock(async () => undefined);
    const session = makeSession({ persistUserMessage, runAgentLoop });

    const res = await sendMessage(normalContent, session);

    expect(res.status).toBe(202);
    const body = (await res.json()) as { accepted: boolean };
    expect(body.accepted).toBe(true);

    // Normal messages proceed to the agent loop
    expect(persistUserMessage).toHaveBeenCalledTimes(1);
    expect(runAgentLoop).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// RECORDING INTENT — deliberately NOT intercepted on HTTP path
// ============================================================================
describe("HTTP POST /v1/messages does not intercept recording intents (by design)", () => {
  beforeEach(() => {
    routeGuardianReplyMock.mockClear();
    listPendingByDestinationMock.mockClear();
    listCanonicalMock.mockClear();
    addMessageMock.mockClear();
  });

  test("recording commands pass through to the agent loop as regular messages", async () => {
    // The HTTP path deliberately does not intercept recording commands.
    // Dedicated /v1/recording/* endpoints handle recording lifecycle.
    // Text-based recording intent interception was retired with the
    // legacy handleUserMessage entry point.
    const persistUserMessage = mock(async () => "persisted-msg-id");
    const runAgentLoop = mock(async () => undefined);
    const session = makeSession({ persistUserMessage, runAgentLoop });

    const res = await sendMessage("start recording", session);

    expect(res.status).toBe(202);
    expect(persistUserMessage).toHaveBeenCalledTimes(1);
    expect(runAgentLoop).toHaveBeenCalledTimes(1);
  });

  test("stop recording commands pass through to the agent loop", async () => {
    const persistUserMessage = mock(async () => "persisted-msg-id");
    const runAgentLoop = mock(async () => undefined);
    const session = makeSession({ persistUserMessage, runAgentLoop });

    const res = await sendMessage("stop recording", session);

    expect(res.status).toBe(202);
    expect(persistUserMessage).toHaveBeenCalledTimes(1);
    expect(runAgentLoop).toHaveBeenCalledTimes(1);
  });
});
