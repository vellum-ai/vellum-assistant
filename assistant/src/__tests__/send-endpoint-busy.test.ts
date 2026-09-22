/**
 * Tests for POST /v1/messages busy-conversation behavior and hub publishing.
 *
 * Validates that:
 * - Messages are accepted (202) when the conversation is idle, with hub events published.
 * - A busy conversation answers 202 with `messageId`, never 409: an eligible
 *   send interrupts the running turn, and one that may not interrupt waits.
 * - SSE subscribers receive events from messages sent via this endpoint.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../config/env.js", () => ({ isHttpAuthDisabled: () => true }));

import type { AssistantEvent } from "../api/index.js";
import type { Conversation } from "../daemon/conversation.js";
import {
  type MessagingConversationContext,
  persistUserMessage,
} from "../daemon/conversation-messaging.js";
import { ConversationModeSessionCoordinator } from "../daemon/conversation-mode-session.js";
import {
  getConversationByKey,
  getOrCreateConversation,
} from "../persistence/conversation-key-store.js";
import { createGuardianBinding } from "./helpers/create-guardian-binding.js";
import { setConfig } from "./helpers/set-config.js";

// The send path's ingress secret check reads `secretDetection`; keep it off so
// the normal-text fixtures below flow through untouched. `memory` is disabled
// to match the isolated route-level scope (no real indexing on this path).
setConfig("secretDetection", { enabled: false });
setConfig("memory", { enabled: false });

// ---------------------------------------------------------------------------
// Module mocks for direct-import deps used by conversation-routes ROUTES.
// These must appear before any import that triggers conversation-routes.ts
// module evaluation, so the routes pick up the test-controlled instances.
// ---------------------------------------------------------------------------
let _conversationFactory: (() => Conversation) | undefined;
let _approvalGenerator: unknown;

mock.module("../daemon/conversation-registry.js", () => ({
  findConversation: () => {
    if (!_conversationFactory) {
      return undefined;
    }
    return _conversationFactory();
  },
}));

mock.module("../daemon/conversation-store.js", () => ({
  getOrCreateConversation: async (..._args: unknown[]) => {
    if (!_conversationFactory) {
      throw new Error("_conversationFactory not set in test");
    }
    return _conversationFactory();
  },
}));
mock.module("../daemon/approval-generators.js", () => ({
  createApprovalConversationGenerator: () => _approvalGenerator,
}));

// Dev-bypass resolves the real guardian principal, then runs the real
// local-principal trust mapper against the gateway delivery read.
mock.module("../runtime/local-actor-identity.js", () => ({
  findLocalGuardianPrincipalId: async () => "test-principal-id",
}));

// Mock the IPC transport rather than local-principal-trust.js so the sibling
// resolver unit test (which mocks guardian-delivery-reader, not ipcCall) isn't
// shadowed when both files run in one Bun process. resolve_guardian_delivery
// returns a single active vellum guardian whose principal matches the
// dev-bypass-resolved id; any other method throws so unexpected IPC surfaces.
mock.module("../ipc/gateway-client.js", () => ({
  ipcCall: async (method: string) => {
    if (method === "resolve_guardian_delivery") {
      return {
        guardians: [
          {
            channelType: "vellum",
            contactId: "test-contact-id",
            principalId: "test-principal-id",
            address: "test-principal-id",
            externalChatId: "test-principal-id",
            status: "active",
          },
        ],
      };
    }
    throw new Error(`Unexpected ipcCall in test: ${method}`);
  },
}));

// Guardian decisions read and CAS through the gateway client; serve that
// surface from the in-memory sim the tests seed.
import {
  bridgeState,
  gatewayGuardianRequestsStoreBridge,
} from "./helpers/gateway-guardian-requests-store-bridge.js";
import { mockUnownedModeSessions } from "./helpers/mock-conversation.js";

mock.module(
  "../channels/gateway-guardian-requests.js",
  () => gatewayGuardianRequestsStoreBridge,
);

import type { AssistantEventEnvelope } from "../api/index.js";
import { __resetGuardianDeliveryCacheForTest } from "../contacts/guardian-delivery-reader.js";
import { getDb, getSqlite } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { RuntimeHttpServer } from "../runtime/http-server.js";
import type { ApprovalConversationGenerator } from "../runtime/http-types.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";

await initializeDb();

// ---------------------------------------------------------------------------
// Conversation helpers
// ---------------------------------------------------------------------------

/** Conversation that completes its agent loop quickly and emits a text delta + message_complete. */
function makeCompletingConversation(): Conversation {
  let processing = false;
  const messages: unknown[] = [];
  return {
    modeSessions: mockUnownedModeSessions(),
    isProcessing: () => processing,
    persistUserMessage: (options: { requestId?: string }) => {
      processing = true;
      return { id: options.requestId ?? "msg-1", deduplicated: false };
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
    replayActivityState: () => {},
    setHostBrowserProxy: () => {},
    setHostCuProxy: () => {},
    setHostAppControlProxy: () => {},
    addPreactivatedSkillId: () => {},
    hasAnyPendingConfirmation: () => false,
    hasPendingConfirmation: () => false,
    denyAllPendingConfirmations: () => {},
    runAgentLoop: async (
      _content: string,
      _messageId: string,
      options?: { onEvent?: (msg: AssistantEvent) => void },
    ) => {
      const onEvent = options?.onEvent ?? (() => {});
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
  return {
    modeSessions: mockUnownedModeSessions(),
    isProcessing: () => processing,
    // No abort controller, so a send arriving while this turn runs is not
    // eligible to interrupt it and waits for idle instead.
    abortController: null,
    persistUserMessage: (options: { requestId?: string }) => {
      processing = true;
      return { id: options.requestId ?? "msg-1", deduplicated: false };
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
    replayActivityState: () => {},
    setHostBrowserProxy: () => {},
    setHostCuProxy: () => {},
    setHostAppControlProxy: () => {},
    addPreactivatedSkillId: () => {},
    hasAnyPendingConfirmation: () => false,
    hasPendingConfirmation: () => false,
    denyAllPendingConfirmations: () => {},
    runAgentLoop: async () => {
      // Hang forever
      await new Promise<void>(() => {});
    },
    handleConfirmationResponse: () => {},
    handleSecretResponse: () => {},
    getMessages: () => messages as never[],
  } as unknown as Conversation;
}

function makePendingApprovalConversation(
  requestId: string,
  processing: boolean,
): {
  conversation: Conversation;
  runAgentLoopMock: ReturnType<typeof mock>;
  denyAllPendingConfirmationsMock: ReturnType<typeof mock>;
  handleConfirmationResponseMock: ReturnType<typeof mock>;
} {
  const pending = new Set([requestId]);
  const messages: unknown[] = [];
  const runAgentLoopMock = mock(async () => {});
  const denyAllPendingConfirmationsMock = mock(() => {
    pending.clear();
  });
  const handleConfirmationResponseMock = mock((resolvedRequestId: string) => {
    pending.delete(resolvedRequestId);
  });

  const conversation = {
    modeSessions: mockUnownedModeSessions(),
    isProcessing: () => processing,
    persistUserMessage: (options: { requestId?: string }) => ({
      id: options.requestId ?? "msg-1",
      deduplicated: false,
    }),
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
    replayActivityState: () => {},
    setHostBrowserProxy: () => {},
    setHostCuProxy: () => {},
    setHostAppControlProxy: () => {},
    addPreactivatedSkillId: () => {},
    hasAnyPendingConfirmation: () => pending.size > 0,
    hasPendingConfirmation: (candidateRequestId: string) =>
      pending.has(candidateRequestId),
    denyAllPendingConfirmations: denyAllPendingConfirmationsMock,
    emitConfirmationStateChanged: () => {},
    emitActivityState: () => {},
    runAgentLoop: runAgentLoopMock,
    handleConfirmationResponse: handleConfirmationResponseMock,
    handleSecretResponse: () => {},
    getMessages: () => messages as never[],
  } as unknown as Conversation;

  return {
    conversation,
    runAgentLoopMock,
    denyAllPendingConfirmationsMock,
    handleConfirmationResponseMock,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// This suite mocks isHttpAuthDisabled() to true, so a request carrying no
// bearer authenticates through the dev bypass. A bearer that is present is
// verified against the signing key, which these tests do not set up.
const AUTH_HEADERS: Record<string, string> = {};

describe("POST /v1/messages — queue-if-busy and hub publishing", () => {
  let server: RuntimeHttpServer;
  let port: number;
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM messages");
    db.run("DELETE FROM conversations");
    db.run("DELETE FROM conversation_keys");
    bridgeState.reset();
    db.run("DELETE FROM contact_channels");
    db.run("DELETE FROM contacts");
    pendingInteractions.clear();
    __resetGuardianDeliveryCacheForTest();

    createGuardianBinding({
      channel: "vellum",
      guardianExternalUserId: "dev-bypass",
      guardianDeliveryChatId: "vellum",
      guardianPrincipalId: "test-principal-id",
      verifiedVia: "test",
    });
  });

  afterEach(async () => {
    await server?.stop();
  });

  async function startServer(
    conversationFactory: () => Conversation,
    options?: { approvalConversationGenerator?: ApprovalConversationGenerator },
  ): Promise<void> {
    _conversationFactory = conversationFactory;
    _approvalGenerator = options?.approvalConversationGenerator;
    server = new RuntimeHttpServer({
      port: 0,
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

  test.each([
    { failure: "acceptTurn", surface: false },
    { failure: "trackPersistedRow", surface: false },
    { failure: "acceptTurn", surface: true },
    { failure: "trackPersistedRow", surface: true },
  ] as const)(
    "dispatches committed content once despite $failure failure (surface=$surface)",
    async ({ failure, surface }) => {
      const conversationKey = "conv-tracking-failure";
      const { conversationId } = getOrCreateConversation(conversationKey);
      const modeSessions = new ConversationModeSessionCoordinator(
        conversationId,
      );
      const source = surface
        ? modeSessions.activateSource({
            sourceId: "browser-source",
            generation: 1,
            mode: "browser",
            sourceStartedAt: 100,
          })!
        : undefined;
      if (source) {
        modeSessions.claimTurn("turn-origin", source, 110);
        modeSessions.recordStructuralWait("turn-origin", {
          kind: "surface",
          responseId: "surface-123",
        });
        modeSessions.releaseTurn("turn-origin");
      }

      const persistedRows = () =>
        getSqlite()
          .query<
            { id: string; content: string },
            [string]
          >("SELECT id, content FROM messages WHERE conversation_id = ? AND role = 'user'")
          .all(conversationId);
      const acceptTurn = modeSessions.acceptTurn.bind(modeSessions);
      const trackPersistedRow =
        modeSessions.trackPersistedRow.bind(modeSessions);
      const committedCounts: number[] = [];
      const trackingFailure = mock(() => {
        committedCounts.push(persistedRows().length);
        throw new Error("optional session tracking failed");
      });
      modeSessions.acceptTurn = (...args) => {
        const owner = acceptTurn(...args);
        if (failure === "acceptTurn") {
          trackingFailure();
        }
        return owner;
      };
      modeSessions.trackPersistedRow = (...args) => {
        trackPersistedRow(...args);
        if (failure === "trackPersistedRow") {
          trackingFailure();
        }
      };

      let processing = false;
      let processingOwner = 0;
      const releases: number[] = [];
      const ctx = Object.assign(makeCompletingConversation(), {
        conversationId,
        modeSessions,
        messages: [],
        abortController: null as AbortController | null,
        currentRequestId: undefined as string | undefined,
        currentTurnClientMessageId: undefined as string | undefined,
        currentActiveSurfaceId: surface ? "surface-123" : undefined,
        inFlightSendRequestIds: new Map<string, string>(),
        isProcessing: () => processing,
        acquireProcessingFenced: async () => {
          processing = true;
          return ++processingOwner;
        },
        releaseProcessing: (owner: number) => {
          releases.push(owner);
          processing = false;
          return true;
        },
        getTurnChannelContext: () => null,
        getTurnInterfaceContext: () => null,
      });
      ctx.persistUserMessage = (options) =>
        persistUserMessage(
          ctx as unknown as MessagingConversationContext,
          options,
        );
      const runAgentLoop = mock(async (_content: string, messageId: string) => {
        expect(ctx.isProcessing()).toBe(true);
        expect(ctx.messages).toHaveLength(1);
        expect(modeSessions.getTurnOwner(messageId)?.id).toBe(source?.id);
        modeSessions.releaseTurn(messageId, {
          status: "completed",
          endReason: "turn_complete",
        });
        ctx.releaseProcessing(processingOwner);
        ctx.currentRequestId = undefined;
        ctx.currentTurnClientMessageId = undefined;
        ctx.abortController = null;
      });
      ctx.runAgentLoop = runAgentLoop;
      await startServer(() => ctx);

      const send = () =>
        fetch(messagesUrl(), {
          method: "POST",
          headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
          body: JSON.stringify({
            conversationKey,
            content: "Continue the task",
            clientMessageId: "client-message-123",
            sourceChannel: "vellum",
            interface: "macos",
          }),
        });
      const first = await send();
      const firstBody = (await first.json()) as {
        accepted: boolean;
        messageId: string;
      };
      expect(first.status).toBe(202);
      expect(firstBody.accepted).toBe(true);
      expect(runAgentLoop).toHaveBeenCalledTimes(1);
      await runAgentLoop.mock.results[0]!.value;
      expect(trackingFailure).toHaveBeenCalledTimes(1);
      expect(committedCounts).toEqual([1]);

      const retry = await send();
      expect(retry.status).toBe(202);
      expect(await retry.json()).toMatchObject(firstBody);
      expect(runAgentLoop).toHaveBeenCalledTimes(1);
      expect(trackingFailure).toHaveBeenCalledTimes(1);
      expect(persistedRows()).toEqual([
        {
          id: firstBody.messageId,
          content: JSON.stringify([
            { type: "text", text: "Continue the task" },
          ]),
        },
      ]);
      expect(ctx.messages).toHaveLength(1);
      expect(ctx.isProcessing()).toBe(false);
      expect(ctx.abortController).toBeNull();
      expect(ctx.currentRequestId).toBeUndefined();
      expect(ctx.currentTurnClientMessageId).toBeUndefined();
      expect(releases).toEqual([1, 2]);
      expect(modeSessions.getTurnOwner(firstBody.messageId)).toBeUndefined();
      expect(modeSessions.hasResidentWork()).toBe(false);
    },
  );

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
    const publishedEvents: AssistantEventEnvelope[] = [];

    await startServer(() => makeCompletingConversation());

    // Subscribe on the module-level singleton that the route handler publishes to
    const { assistantEventHub: routeEventHub } =
      await import("../runtime/assistant-event-hub.js");
    routeEventHub.subscribe({
      type: "process",
      callback: (event: AssistantEventEnvelope) => {
        publishedEvents.push(event);
      },
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
      denyAllPendingConfirmationsMock,
      handleConfirmationResponseMock,
    } = makePendingApprovalConversation(requestId, false);

    pendingInteractions.register(requestId, {
      conversationId,
      kind: "confirmation",
    });
    bridgeState.seedRequest({
      id: requestId,
      kind: "tool_approval",
      sourceType: "desktop",
      sourceChannel: "vellum",
      sourceConversationId: conversationId,
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
      denyAllPendingConfirmationsMock,
      handleConfirmationResponseMock,
    } = makePendingApprovalConversation(requestId, false);

    pendingInteractions.register(requestId, {
      conversationId,
      kind: "confirmation",
    });
    bridgeState.seedRequest({
      id: requestId,
      kind: "tool_approval",
      sourceType: "voice",
      sourceChannel: "slack",
      sourceConversationId: conversationId,
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
      denyAllPendingConfirmationsMock,
      handleConfirmationResponseMock,
    } = makePendingApprovalConversation(requestId, true);

    pendingInteractions.register(requestId, {
      conversationId,
      kind: "confirmation",
    });
    bridgeState.seedRequest({
      id: requestId,
      kind: "tool_approval",
      sourceType: "desktop",
      sourceChannel: "vellum",
      sourceConversationId: conversationId,
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
      denyAllPendingConfirmationsMock,
      handleConfirmationResponseMock,
    } = makePendingApprovalConversation(requestId, false);

    pendingInteractions.register(requestId, {
      conversationId,
      kind: "confirmation",
    });
    bridgeState.seedRequest({
      id: requestId,
      kind: "tool_approval",
      sourceType: "desktop",
      sourceChannel: "vellum",
      sourceConversationId: conversationId,
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
      conversationId,
      kind: "confirmation",
    });
    bridgeState.seedRequest({
      id: requestId,
      kind: "tool_approval",
      sourceType: "desktop",
      sourceChannel: "vellum",
      sourceConversationId: conversationId,
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

  // ── Busy conversation ───────────────────────────────────────────────

  test("busy send that cannot interrupt defers and answers 202 with messageId", async () => {
    // The hanging conversation holds the lock with no abort controller, so a
    // send arriving mid-turn is `no_abortable_turn`: it waits for idle rather
    // than stopping a turn it is not allowed to stop.
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

    // Second message is accepted and deferred, not rejected
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
      queued?: boolean;
      messageId?: string;
      requestId?: string;
      conversationId: string;
    };

    expect(res2.status).toBe(202);
    expect(body2.accepted).toBe(true);
    // The response contract is not suspended for a send that has not run yet:
    // `postChatMessage` rejects an accepted response without a `messageId`,
    // and the client drops the optimistic row.
    expect(typeof body2.messageId).toBe("string");
    expect(body2.requestId).toBe(body2.messageId);
    expect(body2.queued).toBeUndefined();
    expect(typeof body2.conversationId).toBe("string");
    expect(body2.conversationId.length).toBeGreaterThan(0);

    await stopServer();
  });

  test("busy send that may interrupt answers 202 with messageId and stops the turn", async () => {
    const aborts: unknown[] = [];
    const controller = new AbortController();
    controller.signal.addEventListener("abort", () => {
      aborts.push(controller.signal.reason);
    });
    const conversation = makeHangingConversation() as Conversation & {
      abortController: AbortController | null;
    };
    conversation.abortController = controller;
    await startServer(() => conversation);

    const res1 = await fetch(messagesUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({
        conversationKey: "conv-busy-interrupt",
        content: "First",
        sourceChannel: "vellum",
        interface: "macos",
      }),
    });
    expect(res1.status).toBe(202);

    await new Promise((r) => setTimeout(r, 30));

    const res2 = await fetch(messagesUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({
        conversationKey: "conv-busy-interrupt",
        content: "Second",
        sourceChannel: "vellum",
        interface: "macos",
      }),
    });
    const body2 = (await res2.json()) as {
      accepted: boolean;
      queued?: boolean;
      messageId?: string;
      requestId?: string;
    };

    expect(res2.status).toBe(202);
    expect(body2.accepted).toBe(true);
    expect(typeof body2.messageId).toBe("string");
    expect(body2.requestId).toBe(body2.messageId);
    expect(body2.queued).toBeUndefined();

    // The handover runs off the response, so the abort lands after it.
    await new Promise((r) => setTimeout(r, 30));
    expect(aborts).toHaveLength(1);
    expect((aborts[0] as { kind?: string }).kind).toBe(
      "preempted_by_new_message",
    );

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

  test("accepts message when conversationKey is omitted (vellum channel mints fresh)", async () => {
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
    const body = (await res.json()) as {
      accepted: boolean;
      conversationId: string;
    };
    expect(body.accepted).toBe(true);
    expect(body.conversationId).toBeTruthy();

    // The vellum channel never falls through to the shared
    // `default:vellum:<interface>` thread: each empty-handed send mints
    // a fresh conversation so the first-message id surfaces to the client.
    expect(getConversationByKey("default:vellum:macos")).toBeNull();

    await stopServer();
  });

  test("two empty-handed vellum sends each mint distinct conversations", async () => {
    await startServer(() => makeCompletingConversation());

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
    const body1 = (await res1.json()) as { conversationId: string };

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
    const body2 = (await res2.json()) as { conversationId: string };

    expect(body1.conversationId).toBeTruthy();
    expect(body2.conversationId).toBeTruthy();
    expect(body1.conversationId).not.toBe(body2.conversationId);

    await stopServer();
  });

  test("two empty-handed phone sends share the default channel thread", async () => {
    await startServer(() => makeCompletingConversation());

    const res1 = await fetch(messagesUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({
        content: "First",
        sourceChannel: "phone",
        interface: "phone",
      }),
    });
    expect(res1.status).toBe(202);
    const body1 = (await res1.json()) as { conversationId: string };

    const res2 = await fetch(messagesUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({
        content: "Second",
        sourceChannel: "phone",
        interface: "phone",
      }),
    });
    expect(res2.status).toBe(202);
    const body2 = (await res2.json()) as { conversationId: string };

    // Non-vellum channels keep the legacy `default:<channel>:<interface>`
    // co-location so repeated inbound messages from the same external
    // channel/interface land on a single thread.
    expect(body1.conversationId).toBe(body2.conversationId);
    const mapping = getConversationByKey("default:phone:phone");
    expect(mapping).not.toBeNull();
    expect(mapping!.conversationId).toBe(body1.conversationId);

    await stopServer();
  });

  test("auto-deny resolves the guardian request so stale records do not cause pending_interaction_not_found", async () => {
    const conversationKey = "conv-auto-deny-guardian";
    const { conversationId } = getOrCreateConversation(conversationKey);
    const requestId = "req-auto-deny-guardian";

    // Step 1: Create a pending approval conversation with a guardian request.
    const { conversation, denyAllPendingConfirmationsMock } =
      makePendingApprovalConversation(requestId, false);

    pendingInteractions.register(requestId, {
      conversationId,
      kind: "confirmation",
    });
    bridgeState.seedRequest({
      id: requestId,
      kind: "tool_approval",
      sourceType: "desktop",
      sourceChannel: "vellum",
      sourceConversationId: conversationId,
      toolName: "bash",
      guardianPrincipalId: "test-principal-id",
      status: "pending",
      requestCode: "STALE1",
      expiresAt: Date.now() + 5 * 60 * 1000,
    });

    await startServer(() => conversation);

    // Step 2: Send a non-approval message to trigger auto-deny of the
    // pending confirmation. "do something else" is not an approval phrase,
    // so tryConsumeGuardianReply won't consume it, and the
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

    // Step 3: Verify the guardian request was resolved to "denied".
    // Without the fix, this would remain "pending", causing
    // pending_interaction_not_found errors on subsequent "yes" messages.
    const guardianRequest = bridgeState.getRequest(requestId);
    expect(guardianRequest).toBeDefined();
    expect(guardianRequest!.status).toBe("denied");

    await stopServer();
  });
});
