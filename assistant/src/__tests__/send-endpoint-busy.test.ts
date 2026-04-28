/**
 * Tests for POST /v1/messages queue-if-busy behavior and hub publishing.
 *
 * Validates that:
 * - Messages are accepted (202) when the conversation is idle, with hub events published.
 * - Messages are queued (202, queued: true) when the conversation is busy, not 409.
 * - SSE subscribers receive events from messages sent via this endpoint.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../config/env.js", () => ({ isHttpAuthDisabled: () => true }));

import { createGuardianBinding } from "../contacts/contacts-write.js";
import type { Conversation } from "../daemon/conversation.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import {
  createCanonicalGuardianRequest,
  getCanonicalGuardianRequest,
} from "../memory/canonical-guardian-store.js";
import {
  getConversationByKey,
  getOrCreateConversation,
} from "../memory/conversation-key-store.js";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},

    model: "test",
    provider: "test",
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
      profiles: {},
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

// Mock local-actor-identity to return a stable guardian context that uses
// the same principal as the canonical requests created in tests.
mock.module("../runtime/local-actor-identity.js", () => ({
  resolveLocalTrustContext: () => ({
    sourceChannel: "vellum",
    trustClass: "guardian",
    guardianPrincipalId: "test-principal-id",
    guardianExternalUserId: "test-principal-id",
  }),
}));

import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import type { AssistantEvent } from "../runtime/assistant-event.js";
import { AssistantEventHub } from "../runtime/assistant-event-hub.js";
import { RuntimeHttpServer } from "../runtime/http-server.js";
import type { ApprovalConversationGenerator } from "../runtime/http-types.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";

initializeDb();

// ---------------------------------------------------------------------------
// Conversation helpers
// ---------------------------------------------------------------------------

/** Conversation that completes its agent loop quickly and emits a text delta + message_complete. */
function makeCompletingConversation(): Conversation {
  let processing = false;
  const messages: unknown[] = [];
  return {
    isProcessing: () => processing,
    persistUserMessage: (
      _content: string,
      _attachments: unknown[],
      requestId?: string,
    ) => {
      processing = true;
      return requestId ?? "msg-1";
    },
    memoryPolicy: {
      scopeId: "default",
      includeDefaultFallback: false,
    },
    setChannelCapabilities: () => {},
    setAssistantId: () => {},
    setTrustContext: () => {},
    setAuthContext: () => {},
    setCommandIntent: () => {},
    setTurnChannelContext: () => {},
    setTurnInterfaceContext: () => {},
    ensureActorScopedHistory: async () => {},
    usageStats: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
    updateClient: () => {},
    setHostBashProxy: () => {},
    setHostBrowserProxy: () => {},
    setHostFileProxy: () => {},
    setHostTransferProxy: () => {},
    getHostTransferProxy: () => undefined,
    setHostCuProxy: () => {},
    addPreactivatedSkillId: () => {},
    hasAnyPendingConfirmation: () => false,
    hasPendingConfirmation: () => false,
    denyAllPendingConfirmations: () => {},
    getQueueDepth: () => 0,
    enqueueMessage: () => ({ queued: false, requestId: "noop" }),
    runAgentLoop: async (
      _content: string,
      _messageId: string,
      onEvent: (msg: ServerMessage) => void,
    ) => {
      onEvent({ type: "assistant_text_delta", text: "Hello!" });
      onEvent({ type: "message_complete", conversationId: "test-session" });
      processing = false;
    },
    handleConfirmationResponse: () => {},
    handleSecretResponse: () => {},
    getMessages: () => messages as never[],
  } as unknown as Conversation;
}

/** Conversation that hangs forever in the agent loop (simulates a busy conversation). */
function makeHangingConversation(): Conversation {
  let processing = false;
  const messages: unknown[] = [];
  const enqueuedMessages: Array<{
    content: string;
    onEvent: (msg: ServerMessage) => void;
    requestId: string;
  }> = [];
  return {
    isProcessing: () => processing,
    persistUserMessage: (
      _content: string,
      _attachments: unknown[],
      requestId?: string,
    ) => {
      processing = true;
      return requestId ?? "msg-1";
    },
    memoryPolicy: {
      scopeId: "default",
      includeDefaultFallback: false,
    },
    setChannelCapabilities: () => {},
    setAssistantId: () => {},
    setTrustContext: () => {},
    setAuthContext: () => {},
    setCommandIntent: () => {},
    setTurnChannelContext: () => {},
    setTurnInterfaceContext: () => {},
    ensureActorScopedHistory: async () => {},
    usageStats: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
    updateClient: () => {},
    setHostBashProxy: () => {},
    setHostBrowserProxy: () => {},
    setHostFileProxy: () => {},
    setHostTransferProxy: () => {},
    getHostTransferProxy: () => undefined,
    setHostCuProxy: () => {},
    addPreactivatedSkillId: () => {},
    hasAnyPendingConfirmation: () => false,
    hasPendingConfirmation: () => false,
    denyAllPendingConfirmations: () => {},
    getQueueDepth: () => enqueuedMessages.length,
    enqueueMessage: (
      content: string,
      _attachments: unknown[],
      onEvent: (msg: ServerMessage) => void,
      requestId: string,
    ) => {
      enqueuedMessages.push({ content, onEvent, requestId });
      return { queued: true, requestId };
    },
    runAgentLoop: async () => {
      // Hang forever
      await new Promise<void>(() => {});
    },
    handleConfirmationResponse: () => {},
    handleSecretResponse: () => {},
    getMessages: () => messages as never[],
    _enqueuedMessages: enqueuedMessages,
  } as unknown as Conversation;
}

function makePendingApprovalConversation(
  requestId: string,
  processing: boolean,
  options?: { queueDepth?: number },
): {
  conversation: Conversation;
  runAgentLoopMock: ReturnType<typeof mock>;
  enqueueMessageMock: ReturnType<typeof mock>;
  denyAllPendingConfirmationsMock: ReturnType<typeof mock>;
  handleConfirmationResponseMock: ReturnType<typeof mock>;
} {
  const queueDepth = options?.queueDepth ?? 0;
  const pending = new Set([requestId]);
  const messages: unknown[] = [];
  const runAgentLoopMock = mock(async () => {});
  const enqueueMessageMock = mock(
    (
      _content: string,
      _attachments: unknown[],
      _onEvent: (msg: ServerMessage) => void,
      queuedRequestId: string,
    ) => ({
      queued: true,
      requestId: queuedRequestId,
    }),
  );
  const denyAllPendingConfirmationsMock = mock(() => {
    pending.clear();
  });
  const handleConfirmationResponseMock = mock((resolvedRequestId: string) => {
    pending.delete(resolvedRequestId);
  });

  const conversation = {
    isProcessing: () => processing,
    persistUserMessage: (
      _content: string,
      _attachments: unknown[],
      reqId?: string,
    ) => reqId ?? "msg-1",
    memoryPolicy: {
      scopeId: "default",
      includeDefaultFallback: false,
    },
    setChannelCapabilities: () => {},
    setAssistantId: () => {},
    trustContext: undefined as unknown,
    setTrustContext(this: { trustContext: unknown }, ctx: unknown) {
      this.trustContext = ctx;
    },
    setAuthContext: () => {},
    setCommandIntent: () => {},
    setTurnChannelContext: () => {},
    setTurnInterfaceContext: () => {},
    ensureActorScopedHistory: async () => {},
    usageStats: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
    updateClient: () => {},
    setHostBashProxy: () => {},
    setHostBrowserProxy: () => {},
    setHostFileProxy: () => {},
    setHostTransferProxy: () => {},
    getHostTransferProxy: () => undefined,
    setHostCuProxy: () => {},
    addPreactivatedSkillId: () => {},
    hasAnyPendingConfirmation: () => pending.size > 0,
    hasPendingConfirmation: (candidateRequestId: string) =>
      pending.has(candidateRequestId),
    denyAllPendingConfirmations: denyAllPendingConfirmationsMock,
    emitConfirmationStateChanged: () => {},
    emitActivityState: () => {},
    getQueueDepth: () => queueDepth,
    enqueueMessage: enqueueMessageMock,
    runAgentLoop: runAgentLoopMock,
    handleConfirmationResponse: handleConfirmationResponseMock,
    handleSecretResponse: () => {},
    getMessages: () => messages as never[],
  } as unknown as Conversation;

  return {
    conversation,
    runAgentLoopMock,
    enqueueMessageMock,
    denyAllPendingConfirmationsMock,
    handleConfirmationResponseMock,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const TEST_TOKEN = "test-bearer-token-send";
const AUTH_HEADERS = { Authorization: `Bearer ${TEST_TOKEN}` };

describe("POST /v1/messages — queue-if-busy and hub publishing", () => {
  let server: RuntimeHttpServer;
  let port: number;
  let eventHub: AssistantEventHub;

  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM messages");
    db.run("DELETE FROM conversations");
    db.run("DELETE FROM conversation_keys");
    db.run("DELETE FROM canonical_guardian_deliveries");
    db.run("DELETE FROM canonical_guardian_requests");
    db.run("DELETE FROM contact_channels");
    db.run("DELETE FROM contacts");
    pendingInteractions.clear();

    createGuardianBinding({
      channel: "vellum",
      guardianExternalUserId: "dev-bypass",
      guardianDeliveryChatId: "vellum",
      guardianPrincipalId: "test-principal-id",
      verifiedVia: "test",
    });

    eventHub = new AssistantEventHub();
  });

  afterEach(async () => {
    await server?.stop();
  });

  async function startServer(
    conversationFactory: () => Conversation,
    options?: { approvalConversationGenerator?: ApprovalConversationGenerator },
  ): Promise<void> {
    server = new RuntimeHttpServer({
      port: 0,
      approvalConversationGenerator: options?.approvalConversationGenerator,
      sendMessageDeps: {
        getOrCreateConversation: async () => conversationFactory(),
        assistantEventHub: eventHub,
        resolveAttachments: () => [],
      },
    });
    await server.start();
    port = server.actualPort;
  }

  async function stopServer(): Promise<void> {
    await server?.stop();
  }

  function messagesUrl(): string {
    return `http://127.0.0.1:${port}/v1/messages`;
  }

  // ── Idle conversation: immediate processing ─────────────────────────

  test("returns 202 with accepted: true and messageId when conversation is idle", async () => {
    await startServer(() => makeCompletingConversation());

    const res = await fetch(messagesUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({
        conversationKey: "conv-idle",
        content: "Hello",
        sourceChannel: "vellum",
        interface: "macos",
      }),
    });
    const body = (await res.json()) as {
      accepted: boolean;
      messageId: string;
      conversationId: string;
    };

    expect(res.status).toBe(202);
    expect(body.accepted).toBe(true);
    expect(body.messageId).toBeDefined();
    expect(typeof body.conversationId).toBe("string");
    expect(body.conversationId.length).toBeGreaterThan(0);

    await stopServer();
  });

  test("publishes events to assistantEventHub when conversation is idle", async () => {
    const publishedEvents: AssistantEvent[] = [];

    await startServer(() => makeCompletingConversation());

    eventHub.subscribe({ assistantId: "self" }, (event) => {
      publishedEvents.push(event);
    });

    const res = await fetch(messagesUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({
        conversationKey: "conv-hub",
        content: "Hello hub",
        sourceChannel: "vellum",
        interface: "macos",
      }),
    });
    expect(res.status).toBe(202);

    // Wait for the async agent loop to complete and events to be published
    await new Promise((r) => setTimeout(r, 100));

    // Should have received assistant_text_delta and message_complete
    const types = publishedEvents.map((e) => e.message.type);
    expect(types).toContain("assistant_text_delta");
    expect(types).toContain("message_complete");

    await stopServer();
  });

  test("consumes explicit approval text when a single pending confirmation exists (idle)", async () => {
    const conversationKey = "conv-inline-idle";
    const { conversationId } = getOrCreateConversation(conversationKey);
    const requestId = "req-inline-idle";
    const {
      conversation,
      runAgentLoopMock,
      enqueueMessageMock,
      denyAllPendingConfirmationsMock,
      handleConfirmationResponseMock,
    } = makePendingApprovalConversation(requestId, false);

    pendingInteractions.register(requestId, {
      conversation,
      conversationId,
      kind: "confirmation",
    });
    createCanonicalGuardianRequest({
      id: requestId,
      kind: "tool_approval",
      sourceType: "desktop",
      sourceChannel: "vellum",
      conversationId,
      toolName: "call_start",
      guardianPrincipalId: "test-principal-id",
      status: "pending",
      requestCode: "ABC123",
      expiresAt: Date.now() + 5 * 60 * 1000,
    });

    await startServer(() => conversation);

    const res = await fetch(messagesUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({
        conversationKey,
        content: "yes",
        sourceChannel: "vellum",
        interface: "macos",
      }),
    });
    const body = (await res.json()) as {
      accepted: boolean;
      messageId?: string;
      queued?: boolean;
    };

    expect(res.status).toBe(202);
    expect(body.accepted).toBe(true);
    expect(body.messageId).toBeDefined();
    expect(body.queued).toBeUndefined();
    expect(handleConfirmationResponseMock).toHaveBeenCalledTimes(1);
    expect(denyAllPendingConfirmationsMock).toHaveBeenCalledTimes(0);
    expect(enqueueMessageMock).toHaveBeenCalledTimes(0);
    expect(runAgentLoopMock).toHaveBeenCalledTimes(0);

    await stopServer();
  });

  test("consumes natural-language approval text when approval conversation generator is configured", async () => {
    const conversationKey = "conv-inline-nl";
    const { conversationId } = getOrCreateConversation(conversationKey);
    const requestId = "req-inline-nl";
    const {
      conversation,
      runAgentLoopMock,
      enqueueMessageMock,
      denyAllPendingConfirmationsMock,
      handleConfirmationResponseMock,
    } = makePendingApprovalConversation(requestId, false);

    pendingInteractions.register(requestId, {
      conversation,
      conversationId,
      kind: "confirmation",
    });
    createCanonicalGuardianRequest({
      id: requestId,
      kind: "tool_approval",
      sourceType: "voice",
      sourceChannel: "slack",
      conversationId,
      toolName: "call_start",
      status: "pending",
      guardianPrincipalId: "test-principal-id",
      requestCode: "C0FFEE",
      expiresAt: Date.now() + 5 * 60 * 1000,
    });

    const approvalConversationGenerator: ApprovalConversationGenerator = async (
      context,
    ) => ({
      disposition: "approve_once",
      replyText: "Approved.",
      targetRequestId: context.pendingApprovals[0]?.requestId,
    });

    await startServer(() => conversation, { approvalConversationGenerator });

    const res = await fetch(messagesUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({
        conversationKey,
        content: "sure let's do that",
        sourceChannel: "slack",
        interface: "slack",
      }),
    });
    const body = (await res.json()) as {
      accepted: boolean;
      messageId?: string;
      queued?: boolean;
    };

    expect(res.status).toBe(202);
    expect(body.accepted).toBe(true);
    expect(body.messageId).toBeDefined();
    expect(body.queued).toBeUndefined();
    expect(handleConfirmationResponseMock).toHaveBeenCalledTimes(1);
    expect(denyAllPendingConfirmationsMock).toHaveBeenCalledTimes(0);
    expect(enqueueMessageMock).toHaveBeenCalledTimes(0);
    expect(runAgentLoopMock).toHaveBeenCalledTimes(0);

    await stopServer();
  });

  test("consumes explicit approval text while busy instead of auto-denying and queueing", async () => {
    const conversationKey = "conv-inline-busy";
    const { conversationId } = getOrCreateConversation(conversationKey);
    const requestId = "req-inline-busy";
    const {
      conversation,
      runAgentLoopMock,
      enqueueMessageMock,
      denyAllPendingConfirmationsMock,
      handleConfirmationResponseMock,
    } = makePendingApprovalConversation(requestId, true);

    pendingInteractions.register(requestId, {
      conversation,
      conversationId,
      kind: "confirmation",
    });
    createCanonicalGuardianRequest({
      id: requestId,
      kind: "tool_approval",
      sourceType: "desktop",
      sourceChannel: "vellum",
      conversationId,
      toolName: "call_start",
      status: "pending",
      guardianPrincipalId: "test-principal-id",
      requestCode: "DEF456",
      expiresAt: Date.now() + 5 * 60 * 1000,
    });

    await startServer(() => conversation);

    const res = await fetch(messagesUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({
        conversationKey,
        content: "approve",
        sourceChannel: "vellum",
        interface: "macos",
      }),
    });
    const body = (await res.json()) as {
      accepted: boolean;
      messageId?: string;
      queued?: boolean;
    };

    expect(res.status).toBe(202);
    expect(body.accepted).toBe(true);
    expect(body.messageId).toBeDefined();
    expect(body.queued).toBeUndefined();
    expect(handleConfirmationResponseMock).toHaveBeenCalledTimes(1);
    expect(denyAllPendingConfirmationsMock).toHaveBeenCalledTimes(0);
    expect(enqueueMessageMock).toHaveBeenCalledTimes(0);
    expect(runAgentLoopMock).toHaveBeenCalledTimes(0);

    await stopServer();
  });

  test("consumes explicit approval text while busy even when queue depth is non-zero", async () => {
    const conversationKey = "conv-inline-busy-queued";
    const { conversationId } = getOrCreateConversation(conversationKey);
    const requestId = "req-inline-busy-queued";
    const {
      conversation,
      runAgentLoopMock,
      enqueueMessageMock,
      denyAllPendingConfirmationsMock,
      handleConfirmationResponseMock,
    } = makePendingApprovalConversation(requestId, true, { queueDepth: 2 });

    pendingInteractions.register(requestId, {
      conversation,
      conversationId,
      kind: "confirmation",
    });
    createCanonicalGuardianRequest({
      id: requestId,
      kind: "tool_approval",
      sourceType: "desktop",
      sourceChannel: "vellum",
      conversationId,
      toolName: "call_start",
      status: "pending",
      guardianPrincipalId: "test-principal-id",
      requestCode: "Q2D456",
      expiresAt: Date.now() + 5 * 60 * 1000,
    });

    await startServer(() => conversation);

    const res = await fetch(messagesUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({
        conversationKey,
        content: "approve",
        sourceChannel: "vellum",
        interface: "macos",
      }),
    });
    const body = (await res.json()) as {
      accepted: boolean;
      messageId?: string;
      queued?: boolean;
    };

    expect(res.status).toBe(202);
    expect(body.accepted).toBe(true);
    expect(body.messageId).toBeDefined();
    expect(body.queued).toBeUndefined();
    expect(handleConfirmationResponseMock).toHaveBeenCalledTimes(1);
    expect(denyAllPendingConfirmationsMock).toHaveBeenCalledTimes(0);
    expect(enqueueMessageMock).toHaveBeenCalledTimes(0);
    expect(runAgentLoopMock).toHaveBeenCalledTimes(0);

    await stopServer();
  });

  test("consumes explicit rejection text when a single pending confirmation exists (idle)", async () => {
    const conversationKey = "conv-inline-reject";
    const { conversationId } = getOrCreateConversation(conversationKey);
    const requestId = "req-inline-reject";
    const {
      conversation,
      runAgentLoopMock,
      enqueueMessageMock,
      denyAllPendingConfirmationsMock,
      handleConfirmationResponseMock,
    } = makePendingApprovalConversation(requestId, false);

    pendingInteractions.register(requestId, {
      conversation,
      conversationId,
      kind: "confirmation",
    });
    createCanonicalGuardianRequest({
      id: requestId,
      kind: "tool_approval",
      sourceType: "desktop",
      sourceChannel: "vellum",
      conversationId,
      toolName: "call_start",
      status: "pending",
      guardianPrincipalId: "test-principal-id",
      requestCode: "GHI789",
      expiresAt: Date.now() + 5 * 60 * 1000,
    });

    await startServer(() => conversation);

    const res = await fetch(messagesUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({
        conversationKey,
        content: "no",
        sourceChannel: "vellum",
        interface: "macos",
      }),
    });
    const body = (await res.json()) as {
      accepted: boolean;
      messageId?: string;
      queued?: boolean;
    };

    expect(res.status).toBe(202);
    expect(body.accepted).toBe(true);
    expect(body.messageId).toBeDefined();
    expect(body.queued).toBeUndefined();
    // Rejection still flows through handleConfirmationResponse (with reject action)
    expect(handleConfirmationResponseMock).toHaveBeenCalledTimes(1);
    expect(denyAllPendingConfirmationsMock).toHaveBeenCalledTimes(0);
    expect(enqueueMessageMock).toHaveBeenCalledTimes(0);
    expect(runAgentLoopMock).toHaveBeenCalledTimes(0);

    await stopServer();
  });

  test("does not consume ambiguous text — falls through to normal message handling", async () => {
    const conversationKey = "conv-inline-ambiguous";
    const { conversationId } = getOrCreateConversation(conversationKey);
    const requestId = "req-inline-ambiguous";
    const { conversation, runAgentLoopMock } = makePendingApprovalConversation(
      requestId,
      false,
    );

    pendingInteractions.register(requestId, {
      conversation,
      conversationId,
      kind: "confirmation",
    });
    createCanonicalGuardianRequest({
      id: requestId,
      kind: "tool_approval",
      sourceType: "desktop",
      sourceChannel: "vellum",
      conversationId,
      toolName: "call_start",
      status: "pending",
      guardianPrincipalId: "test-principal-id",
      requestCode: "JKL012",
      expiresAt: Date.now() + 5 * 60 * 1000,
    });

    await startServer(() => conversation);

    const res = await fetch(messagesUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({
        conversationKey,
        content: "What is the weather today?",
        sourceChannel: "vellum",
        interface: "macos",
      }),
    });
    const body = (await res.json()) as {
      accepted: boolean;
      messageId?: string;
      queued?: boolean;
    };

    // Ambiguous text should NOT be consumed — falls through to normal send path
    expect(res.status).toBe(202);
    expect(body.accepted).toBe(true);
    expect(body.messageId).toBeDefined();
    // The normal idle send path fires runAgentLoop
    expect(runAgentLoopMock).toHaveBeenCalledTimes(1);

    await stopServer();
  });

  // ── Busy conversation: queue-if-busy ────────────────────────────────

  test("returns 202 with queued: true when conversation is busy (not 409)", async () => {
    const conversation = makeHangingConversation();
    await startServer(() => conversation);

    // First message starts the agent loop and makes the conversation busy
    const res1 = await fetch(messagesUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({
        conversationKey: "conv-busy",
        content: "First",
        sourceChannel: "vellum",
        interface: "macos",
      }),
    });
    expect(res1.status).toBe(202);
    const body1 = (await res1.json()) as {
      accepted: boolean;
      messageId: string;
    };
    expect(body1.accepted).toBe(true);
    expect(body1.messageId).toBeDefined();

    // Wait for the agent loop to start
    await new Promise((r) => setTimeout(r, 30));

    // Second message should be queued, not rejected
    const res2 = await fetch(messagesUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({
        conversationKey: "conv-busy",
        content: "Second",
        sourceChannel: "vellum",
        interface: "macos",
      }),
    });
    const body2 = (await res2.json()) as {
      accepted: boolean;
      queued: boolean;
      conversationId: string;
    };

    expect(res2.status).toBe(202);
    expect(body2.accepted).toBe(true);
    expect(body2.queued).toBe(true);
    expect(typeof body2.conversationId).toBe("string");
    expect(body2.conversationId.length).toBeGreaterThan(0);

    await stopServer();
  });

  // ── Validation ──────────────────────────────────────────────────────

  test("returns 400 when sourceChannel is missing", async () => {
    await startServer(() => makeCompletingConversation());

    const res = await fetch(messagesUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({ conversationKey: "conv-val", content: "Hello" }),
    });
    expect(res.status).toBe(400);

    await stopServer();
  });

  test("returns 400 when content is empty", async () => {
    await startServer(() => makeCompletingConversation());

    const res = await fetch(messagesUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({
        conversationKey: "conv-empty",
        content: "",
        sourceChannel: "vellum",
        interface: "macos",
      }),
    });
    expect(res.status).toBe(400);

    await stopServer();
  });

  test("accepts message when conversationKey is omitted (defaults to stable channel key)", async () => {
    await startServer(() => makeCompletingConversation());

    const res = await fetch(messagesUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({
        content: "Hello",
        sourceChannel: "vellum",
        interface: "macos",
      }),
    });
    expect(res.status).toBe(202);

    await stopServer();
  });

  test("two calls without conversationKey use the same conversation", async () => {
    await startServer(() => makeCompletingConversation());

    // First message — no conversationKey
    const res1 = await fetch(messagesUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({
        content: "First",
        sourceChannel: "vellum",
        interface: "macos",
      }),
    });
    expect(res1.status).toBe(202);

    // Second message — same channel/interface, still no conversationKey
    const res2 = await fetch(messagesUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({
        content: "Second",
        sourceChannel: "vellum",
        interface: "macos",
      }),
    });
    expect(res2.status).toBe(202);

    // Both should have resolved to the same default conversation key
    // ("default:vellum:macos"), which maps to the same conversationId.
    const mapping = getConversationByKey("default:vellum:macos");
    expect(mapping).not.toBeNull();
    expect(mapping!.conversationId).toBeTruthy();

    await stopServer();
  });

  test("auto-deny resolves canonical guardian request so stale records do not cause pending_interaction_not_found", async () => {
    const conversationKey = "conv-auto-deny-canonical";
    const { conversationId } = getOrCreateConversation(conversationKey);
    const requestId = "req-auto-deny-canonical";

    // Step 1: Create a pending approval conversation with a canonical request.
    const { conversation, denyAllPendingConfirmationsMock } =
      makePendingApprovalConversation(requestId, false);

    pendingInteractions.register(requestId, {
      conversation,
      conversationId,
      kind: "confirmation",
    });
    createCanonicalGuardianRequest({
      id: requestId,
      kind: "tool_approval",
      sourceType: "desktop",
      sourceChannel: "vellum",
      conversationId,
      toolName: "bash",
      guardianPrincipalId: "test-principal-id",
      status: "pending",
      requestCode: "STALE1",
      expiresAt: Date.now() + 5 * 60 * 1000,
    });

    await startServer(() => conversation);

    // Step 2: Send a non-approval message to trigger auto-deny of the
    // pending confirmation. "do something else" is not an approval phrase,
    // so tryConsumeCanonicalGuardianReply won't consume it, and the
    // auto-deny path will fire.
    const res = await fetch(messagesUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({
        conversationKey,
        content: "do something else instead",
        sourceChannel: "vellum",
        interface: "macos",
      }),
    });
    expect(res.status).toBe(202);
    expect(denyAllPendingConfirmationsMock).toHaveBeenCalledTimes(1);

    // Step 3: Verify the canonical guardian request was resolved to "denied".
    // Without the fix, this would remain "pending", causing
    // pending_interaction_not_found errors on subsequent "yes" messages.
    const canonicalRequest = getCanonicalGuardianRequest(requestId);
    expect(canonicalRequest).toBeDefined();
    expect(canonicalRequest!.status).toBe("denied");

    await stopServer();
  });
});
