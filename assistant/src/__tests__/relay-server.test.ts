/**
 * Tests for RelayConnection — the WebSocket handler for Twilio
 * ConversationRelay protocol.
 *
 * Tests:
 * - Setup message handling (callSid association, event recording, orchestrator creation)
 * - Prompt message handling (final vs partial, routing to orchestrator)
 * - Interrupt handling (abort propagation)
 * - Error handling (event recording)
 * - DTMF handling (event recording)
 * - sendTextToken / endSession (outbound WebSocket messages)
 * - Conversation history tracking
 * - destroy cleanup
 * - Malformed message resilience
 */
import { createHash, randomUUID } from "node:crypto";
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  jest,
  type Mock,
  mock,
  test,
} from "bun:test";

// ── Platform + logger mocks (must come before any source imports) ────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realLogger = require("../util/logger.js");
mock.module("../util/logger.js", () => ({
  ...realLogger,
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// ── Identity helpers mock ─────────────────────────────────────────────

let mockAssistantName: string | null = "Vellum";
mock.module("../daemon/identity-helpers.js", () => ({
  getAssistantName: () => mockAssistantName,
}));

// ── User-reference mock (isolate from real guardian persona) ────────

let mockUserReference = "my human";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const realUserReference = require("../prompts/user-reference.js");
mock.module("../prompts/user-reference.js", () => ({
  ...realUserReference,
  resolveUserReference: () => mockUserReference,
  resolveUserPronouns: () => null,
  resolveGuardianName: (guardianDisplayName?: string | null) => {
    if (mockUserReference !== "my human") {
      return mockUserReference;
    }
    if (guardianDisplayName && guardianDisplayName.trim().length > 0) {
      return guardianDisplayName.trim();
    }
    return "my human";
  },
}));

// ── Config mock ─────────────────────────────────────────────────────

const mockConfig = {
  provider: "anthropic",
  secretDetection: { enabled: false },
  calls: {
    enabled: true,
    provider: "twilio",
    maxDurationSeconds: 3600,
    userConsultTimeoutSeconds: 120,
    ttsPlaybackDelayMs: 0,
    accessRequestPollIntervalMs: 50,
    guardianWaitUpdateInitialIntervalMs: 100,
    guardianWaitUpdateInitialWindowMs: 300,
    guardianWaitUpdateSteadyMinIntervalMs: 150,
    guardianWaitUpdateSteadyMaxIntervalMs: 200,
    disclosure: { enabled: false, text: "" },
    safety: { denyCategories: [] },
    callerIdentity: {
      allowPerCallOverride: true,
      userNumber: undefined as string | undefined,
    },
    verification: {
      enabled: false,
      maxAttempts: 3,
      codeLength: 6,
    },
  },
  memory: { enabled: false },
};

mock.module("../config/loader.js", () => ({
  getConfig: () => mockConfig,
  loadConfig: () => mockConfig,
}));

// ── TTS provider mocks (for call-speech-output) ─────────────────────

let mockTtsProviderId: string = "elevenlabs";
let mockTtsSupportsStreaming: boolean = false;
let mockTtsSynthesizeStream: Mock<any> | null = null;
let mockTtsSynthesize: Mock<any> | null = null;

mock.module("../tts/tts-config-resolver.js", () => ({
  resolveTtsConfig: () => ({
    provider: mockTtsProviderId,
    providerConfig: {
      voiceId: "test-voice",
      format: "mp3",
      referenceId: "test-ref-id",
    },
  }),
}));

mock.module("../tts/provider-registry.js", () => ({
  getTtsProvider: () => ({
    id: mockTtsProviderId,
    capabilities: {
      supportsStreaming: mockTtsSupportsStreaming,
      supportedFormats: ["mp3"],
    },
    synthesize: mockTtsSynthesize
      ? (...args: unknown[]) => mockTtsSynthesize!(...args)
      : async () => ({
          audio: Buffer.from("fake-audio"),
          contentType: "audio/mpeg",
        }),
    synthesizeStream: mockTtsSynthesizeStream
      ? (...args: unknown[]) => mockTtsSynthesizeStream!(...args)
      : undefined,
  }),
  registerTtsProvider: () => {},
  listTtsProviders: () => [],
  _resetTtsProviderRegistry: () => {},
}));

// Mock public ingress URLs for synthesized TTS path
mock.module("../inbound/public-ingress-urls.js", () => ({
  getPublicBaseUrl: () => "https://test.example.com",
}));

// ── Helpers for building mock provider responses ────────────────────

function createMockProviderResponse(tokens: string[]) {
  const fullText = tokens.join("");
  return async (
    _messages: unknown[],
    _tools: unknown[],
    _systemPrompt: string,
    options?: {
      onEvent?: (event: { type: string; text?: string }) => void;
      signal?: AbortSignal;
    },
  ) => {
    for (const token of tokens) {
      options?.onEvent?.({ type: "text_delta", text: token });
    }
    return {
      content: [{ type: "text", text: fullText }],
      model: "claude-sonnet-4-20250514",
      usage: { inputTokens: 100, outputTokens: 50 },
      stopReason: "end_turn",
    };
  };
}

// ── Provider registry mock ──────────────────────────────────────────

let mockSendMessage: Mock<any>;

mock.module("../providers/registry.js", () => {
  mockSendMessage = mock(createMockProviderResponse(["Hello"]));
  return {
    listProviders: () => ["anthropic"],
    getProvider: () => ({
      name: "anthropic",
      sendMessage: (...args: unknown[]) => mockSendMessage(...args),
    }),
    getDefaultModel: (providerName: string) => {
      const defaults: Record<string, string> = {
        anthropic: "claude-opus-4-6",
        openai: "gpt-5.4",
        gemini: "gemini-2.5-flash",
        ollama: "llama3.2",
        fireworks: "accounts/fireworks/models/kimi-k2p5",
        openrouter: "x-ai/grok-4.20-beta",
      };
      return defaults[providerName] ?? defaults.anthropic;
    },
  };
});

// ── Import source modules after all mocks ────────────────────────────

import {
  registerCallCompletionNotifier,
  unregisterCallCompletionNotifier,
} from "../calls/call-state.js";
import {
  createCallSession,
  getCallEvents,
  getCallSession,
  updateCallSession,
} from "../calls/call-store.js";
import type { RelayWebSocketData } from "../calls/relay-server.js";
import {
  activeRelayConnections,
  RelayConnection,
} from "../calls/relay-server.js";
import { setVoiceBridgeDeps } from "../calls/voice-session-bridge.js";
import { upsertContact } from "../contacts/contact-store.js";
import { upsertContactChannel } from "../contacts/contacts-write.js";
import {
  listCanonicalGuardianRequests,
  resolveCanonicalGuardianRequest,
} from "../memory/canonical-guardian-store.js";
import {
  createInboundSession,
  createVerificationSession,
} from "../memory/channel-verification-sessions.js";
import { addMessage, getMessages } from "../memory/conversation-crud.js";
import { getDb, resetDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { createInvite } from "../memory/invite-store.js";
import { resetTestTables } from "../memory/raw-query.js";
import { conversations } from "../memory/schema.js";
import {
  createOutboundSession,
  getGuardianBinding,
} from "../runtime/channel-verification-service.js";
import { generateVoiceCode, hashVoiceCode } from "../util/voice-code.js";
import { createGuardianBinding } from "./helpers/create-guardian-binding.js";

initializeDb();

afterAll(() => {
  resetDb();
});

// ── Mock WebSocket factory ──────────────────────────────────────────

interface MockWs {
  sentMessages: string[];
  readyState: number;
}

function createMockWs(callSessionId: string): {
  ws: MockWs;
  relay: RelayConnection;
} {
  const sentMessages: string[] = [];
  const ws = {
    sentMessages,
    readyState: 1, // WebSocket.OPEN
    send(data: string) {
      sentMessages.push(data);
    },
    data: { callSessionId } as RelayWebSocketData,
  };

  const relay = new RelayConnection(
    ws as unknown as import("bun").ServerWebSocket<RelayWebSocketData>,
    callSessionId,
  );
  return { ws, relay };
}

// ── Helpers ─────────────────────────────────────────────────────────

let ensuredConvIds = new Set<string>();
function ensureConversation(id: string): void {
  if (ensuredConvIds.has(id)) return;
  const db = getDb();
  const now = Date.now();
  db.insert(conversations)
    .values({
      id,
      title: `Test conversation ${id}`,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  ensuredConvIds.add(id);
}

function resetTables() {
  resetTestTables(
    "guardian_action_deliveries",
    "guardian_action_requests",
    "call_pending_questions",
    "call_events",
    "call_sessions",
    "tool_invocations",
    "messages",
    "conversations",
    "assistant_ingress_invites",
    "channel_verification_sessions",
    "channel_guardian_rate_limits",
    "canonical_guardian_requests",
    "canonical_guardian_deliveries",
    "contact_channels",
    "contacts",
  );
  ensuredConvIds = new Set();
}

/** Create a throwaway contact and return its ID, for use as the invite's contactId. */
function createTargetContact(displayName = "Test Contact"): string {
  return upsertContact({ displayName, role: "contact" }).id;
}

function addTrustedVoiceContact(phoneNumber: string): void {
  upsertContactChannel({
    sourceChannel: "phone",
    externalUserId: phoneNumber,
    externalChatId: phoneNumber,
    status: "active",
    policy: "allow",
  });
}

function createVoiceVerificationSession(
  expectedPhoneE164: string,
  sessionId?: string,
): string {
  const { secret } = createOutboundSession({
    channel: "phone",
    expectedExternalUserId: expectedPhoneE164,
    expectedChatId: expectedPhoneE164,
    expectedPhoneE164,
    sessionId,
  });
  return secret;
}

function createPendingVoiceGuardianChallenge(
  secret: string = "123456",
): string {
  createInboundSession({
    id: randomUUID(),
    channel: "phone",
    challengeHash: createHash("sha256").update(secret).digest("hex"),
    expiresAt: Date.now() + 10 * 60 * 1000,
  });
  return secret;
}

function getLatestAssistantText(conversationId: string): string | null {
  const messages = getMessages(conversationId).filter(
    (m) => m.role === "assistant",
  );
  if (messages.length === 0) return null;
  const latest = messages[messages.length - 1];
  try {
    const parsed = JSON.parse(latest.content) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .filter(
          (
            block,
          ): block is {
            type: string;
            text?: string;
            surfaceType?: string;
            data?: { summaryText?: string };
          } => typeof block === "object" && block != null,
        )
        .map((block) => {
          if (block.type === "text") return block.text ?? "";
          if (
            block.type === "ui_surface" &&
            block.surfaceType === "call_summary"
          )
            return block.data?.summaryText ?? "";
          return "";
        })
        .join("");
    }
    if (typeof parsed === "string") return parsed;
  } catch {
    // Ignore parse failures and fall back to raw content.
  }
  return latest.content;
}

describe("relay-server", () => {
  beforeEach(() => {
    resetTables();
    // Seed the vellum guardian binding (gateway does this at startup in production)
    createGuardianBinding({
      channel: "vellum",
      guardianExternalUserId: "test-principal-id",
      guardianDeliveryChatId: "local",
      guardianPrincipalId: "test-principal-id",
      verifiedVia: "bootstrap",
    });
    activeRelayConnections.clear();
    mockUserReference = "my human";
    mockAssistantName = "Vellum";
    mockSendMessage.mockImplementation(createMockProviderResponse(["Hello"]));
    mockConfig.calls.verification.enabled = false;
    mockConfig.calls.verification.maxAttempts = 3;
    mockConfig.calls.verification.codeLength = 6;
    mockConfig.calls.callerIdentity.userNumber = undefined;
    // Reset TTS provider mocks to native (non-streaming) path
    mockTtsProviderId = "elevenlabs";
    mockTtsSupportsStreaming = false;
    mockTtsSynthesizeStream = null;
    mockTtsSynthesize = null;
    setVoiceBridgeDeps({
      getOrCreateConversation: async (conversationId) => {
        const session = {
          callSessionId: undefined as string | undefined,
          currentRequestId: undefined as string | undefined,
          memoryPolicy: {
            scopeId: "default",
            includeDefaultFallback: false,
          },
          isProcessing: () => false,
          persistUserMessage: async (
            content: string,
            _attachments: unknown[],
            requestId?: string,
          ) => {
            session.currentRequestId = requestId;
            const message = await addMessage(
              conversationId,
              "user",
              JSON.stringify([{ type: "text", text: content }]),
              {
                userMessageChannel: "phone",
                assistantMessageChannel: "phone",
                userMessageInterface: "phone",
                assistantMessageInterface: "phone",
              },
            );
            return message.id;
          },
          setChannelCapabilities: () => {},
          setAssistantId: () => {},
          setTrustContext: () => {},
          setCommandIntent: () => {},
          setTurnChannelContext: () => {},
          setVoiceCallControlPrompt: () => {},
          updateClient: () => {},
          handleConfirmationResponse: () => {},
          handleSecretResponse: () => {},
          abort: () => {},
          runAgentLoop: async (
            _content: string,
            _messageId: string,
            onEvent: (event: {
              type: string;
              conversationId?: string;
              text?: string;
            }) => void,
          ) => {
            const tokens: string[] = [];
            await mockSendMessage([], [], "", {
              onEvent: (event: { type: string; text?: string }) => {
                if (
                  event.type !== "text_delta" ||
                  typeof event.text !== "string"
                )
                  return;
                tokens.push(event.text);
                onEvent({
                  type: "assistant_text_delta",
                  conversationId: conversationId,
                  text: event.text,
                });
              },
            });

            const fullText = tokens.join("");
            if (fullText.length > 0) {
              await addMessage(
                conversationId,
                "assistant",
                JSON.stringify([{ type: "text", text: fullText }]),
                {
                  userMessageChannel: "phone",
                  assistantMessageChannel: "phone",
                  userMessageInterface: "phone",
                  assistantMessageInterface: "phone",
                },
              );
            }

            onEvent({
              type: "message_complete",
              conversationId: conversationId,
            });
          },
        };
        return session as unknown as import("../daemon/conversation.js").Conversation;
      },
      resolveAttachments: () => [],
    });
  });

  // ── Setup message handling ──────────────────────────────────────

  test("handleMessage: setup message associates callSid and records event", async () => {
    ensureConversation("conv-relay-1");
    ensureConversation("conv-relay-1-origin");
    const session = createCallSession({
      conversationId: "conv-relay-1",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
      initiatedFromConversationId: "conv-relay-1-origin",
    });

    const { relay } = createMockWs(session.id);

    await relay.handleMessage(
      JSON.stringify({
        type: "setup",
        callSid: "CA_relay_setup_123",
        from: "+15551111111",
        to: "+15552222222",
      }),
    );

    // Verify callSid was stored on the session
    const updated = getCallSession(session.id);
    expect(updated).not.toBeNull();
    expect(updated!.providerCallSid).toBe("CA_relay_setup_123");
    expect(updated!.status).toBe("in_progress");
    expect(updated!.startedAt).not.toBeNull();

    // Verify event was recorded
    const events = getCallEvents(session.id);
    const connectedEvents = events.filter(
      (e) => e.eventType === "call_connected",
    );
    expect(connectedEvents.length).toBe(1);

    // Verify controller was created
    expect(relay.getController()).not.toBeNull();

    relay.destroy();
  });

  test("handleMessage: setup triggers initial assistant greeting turn", async () => {
    ensureConversation("conv-relay-setup-greet");
    ensureConversation("conv-relay-setup-greet-origin");
    const session = createCallSession({
      conversationId: "conv-relay-setup-greet",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
      task: "Confirm appointment time",
      initiatedFromConversationId: "conv-relay-setup-greet-origin",
    });

    mockSendMessage.mockImplementation(
      createMockProviderResponse([
        "Hello, I am calling to confirm your appointment.",
      ]),
    );

    const { ws, relay } = createMockWs(session.id);

    await relay.handleMessage(
      JSON.stringify({
        type: "setup",
        callSid: "CA_setup_greet_123",
        from: "+15551111111",
        to: "+15552222222",
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 10));

    const textMessages = ws.sentMessages
      .map(
        (raw) =>
          JSON.parse(raw) as { type: string; token?: string; last?: boolean },
      )
      .filter((m) => m.type === "text");
    expect(
      textMessages.some((m) =>
        (m.token ?? "").includes("confirm your appointment"),
      ),
    ).toBe(true);
    expect(textMessages.some((m) => m.last === true)).toBe(true);

    const events = getCallEvents(session.id).filter(
      (e) => e.eventType === "assistant_spoke",
    );
    expect(events.length).toBeGreaterThan(0);

    relay.destroy();
  });

  test("handleTransportClosed: normal close marks call completed and notifies completion", () => {
    ensureConversation("conv-relay-close-normal");
    const session = createCallSession({
      conversationId: "conv-relay-close-normal",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });

    const { relay } = createMockWs(session.id);
    let completionCount = 0;
    registerCallCompletionNotifier("conv-relay-close-normal", () => {
      completionCount += 1;
    });

    relay.handleTransportClosed(1000, "Closing websocket session");

    const updated = getCallSession(session.id);
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("completed");
    expect(updated!.endedAt).not.toBeNull();
    const endedEvents = getCallEvents(session.id).filter(
      (e) => e.eventType === "call_ended",
    );
    expect(endedEvents.length).toBe(1);
    expect(completionCount).toBe(1);
    expect(getLatestAssistantText("conv-relay-close-normal")).toContain(
      "**Call completed**",
    );

    unregisterCallCompletionNotifier("conv-relay-close-normal");
    relay.destroy();
  });

  test("handleTransportClosed: abnormal close marks call failed", () => {
    ensureConversation("conv-relay-close-abnormal");
    const session = createCallSession({
      conversationId: "conv-relay-close-abnormal",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });

    const { relay } = createMockWs(session.id);
    relay.handleTransportClosed(1006, "abnormal closure");

    const updated = getCallSession(session.id);
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("failed");
    expect(updated!.endedAt).not.toBeNull();
    expect(updated!.lastError).toContain("abnormal closure");
    const failEvents = getCallEvents(session.id).filter(
      (e) => e.eventType === "call_failed",
    );
    expect(failEvents.length).toBe(1);
    expect(getLatestAssistantText("conv-relay-close-abnormal")).toContain(
      "**Call failed**",
    );

    relay.destroy();
  });

  test("handleMessage: setup message with custom parameters", async () => {
    ensureConversation("conv-relay-custom");
    const session = createCallSession({
      conversationId: "conv-relay-custom",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
      task: "Book appointment",
    });

    const { relay } = createMockWs(session.id);

    await relay.handleMessage(
      JSON.stringify({
        type: "setup",
        callSid: "CA_relay_custom_123",
        from: "+15551111111",
        to: "+15552222222",
        customParameters: { taskId: "task-1", priority: "high" },
      }),
    );

    // Verify event recorded with custom parameters
    const events = getCallEvents(session.id);
    const connectedEvents = events.filter(
      (e) => e.eventType === "call_connected",
    );
    expect(connectedEvents.length).toBe(1);
    const payload = JSON.parse(connectedEvents[0].payloadJson);
    expect(payload.customParameters).toEqual({
      taskId: "task-1",
      priority: "high",
    });

    relay.destroy();
  });

  // ── Prompt message handling ─────────────────────────────────────

  test("handleMessage: final prompt routes to orchestrator and records event", async () => {
    ensureConversation("conv-relay-prompt");
    ensureConversation("conv-relay-prompt-origin");
    const session = createCallSession({
      conversationId: "conv-relay-prompt",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
      initiatedFromConversationId: "conv-relay-prompt-origin",
    });

    const { ws, relay } = createMockWs(session.id);

    // First, setup to create orchestrator
    await relay.handleMessage(
      JSON.stringify({
        type: "setup",
        callSid: "CA_prompt_123",
        from: "+15551111111",
        to: "+15552222222",
      }),
    );

    // Now send a final prompt
    await relay.handleMessage(
      JSON.stringify({
        type: "prompt",
        voicePrompt: "Hello, I need to make a reservation",
        lang: "en-US",
        last: true,
      }),
    );

    // Verify event was recorded
    const events = getCallEvents(session.id);
    const spokeEvents = events.filter((e) => e.eventType === "caller_spoke");
    expect(spokeEvents.length).toBe(1);
    const payload = JSON.parse(spokeEvents[0].payloadJson);
    expect(payload.transcript).toBe("Hello, I need to make a reservation");

    // Verify conversation history was updated
    const history = relay.getConversationHistory();
    expect(history.length).toBe(1);
    expect(history[0].role).toBe("caller");
    expect(history[0].text).toBe("Hello, I need to make a reservation");

    // Verify tokens were sent through the WebSocket
    expect(ws.sentMessages.length).toBeGreaterThan(0);

    relay.destroy();
  });

  test("handleMessage: partial prompt (last=false) does not route to orchestrator", async () => {
    ensureConversation("conv-relay-partial");
    const session = createCallSession({
      conversationId: "conv-relay-partial",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });

    const { ws, relay } = createMockWs(session.id);

    // Setup
    await relay.handleMessage(
      JSON.stringify({
        type: "setup",
        callSid: "CA_partial_123",
        from: "+15551111111",
        to: "+15552222222",
      }),
    );

    // Let any async initial-greeting turn settle so we can compare only
    // the effect of the partial prompt itself.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const messagesBeforePrompt = ws.sentMessages.length;

    // Send a partial prompt (last=false)
    await relay.handleMessage(
      JSON.stringify({
        type: "prompt",
        voicePrompt: "Hello, I need...",
        lang: "en-US",
        last: false,
      }),
    );

    // Should not have generated any new text tokens (no LLM call for partials)
    // Only the setup-related messages should exist
    expect(ws.sentMessages.length).toBe(messagesBeforePrompt);

    // Conversation history should not have been updated for partials
    const history = relay.getConversationHistory();
    expect(history.length).toBe(0);

    relay.destroy();
  });

  test("handleMessage: prompt without orchestrator sends fallback", async () => {
    ensureConversation("conv-relay-no-orch");
    const session = createCallSession({
      conversationId: "conv-relay-no-orch",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });

    const { ws, relay } = createMockWs(session.id);
    // Note: no setup message, so no orchestrator

    await relay.handleMessage(
      JSON.stringify({
        type: "prompt",
        voicePrompt: "Hello",
        lang: "en-US",
        last: true,
      }),
    );

    // Should have sent a fallback message
    const textMessages = ws.sentMessages
      .map((m) => JSON.parse(m))
      .filter((m: { type: string }) => m.type === "text");
    expect(textMessages.length).toBe(1);
    expect(textMessages[0].token).toContain("still setting up");
    expect(textMessages[0].last).toBe(true);

    relay.destroy();
  });

  // ── Interrupt handling ──────────────────────────────────────────

  test("handleMessage: interrupt message is handled without error", async () => {
    ensureConversation("conv-relay-int");
    const session = createCallSession({
      conversationId: "conv-relay-int",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });

    const { relay } = createMockWs(session.id);

    // Setup
    await relay.handleMessage(
      JSON.stringify({
        type: "setup",
        callSid: "CA_int_123",
        from: "+15551111111",
        to: "+15552222222",
      }),
    );

    // Interrupt should not throw
    await relay.handleMessage(
      JSON.stringify({
        type: "interrupt",
        utteranceUntilInterrupt: "Hello, I was saying...",
      }),
    );

    relay.destroy();
  });

  // ── DTMF handling ───────────────────────────────────────────────

  test("handleMessage: dtmf digit records event", async () => {
    ensureConversation("conv-relay-dtmf");
    const session = createCallSession({
      conversationId: "conv-relay-dtmf",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });

    const { relay } = createMockWs(session.id);

    await relay.handleMessage(
      JSON.stringify({
        type: "dtmf",
        digit: "5",
      }),
    );

    const events = getCallEvents(session.id);
    const dtmfEvents = events.filter((e) => e.eventType === "caller_spoke");
    expect(dtmfEvents.length).toBe(1);
    const payload = JSON.parse(dtmfEvents[0].payloadJson);
    expect(payload.dtmfDigit).toBe("5");

    relay.destroy();
  });

  test("verification failure remains failed if transport closes during goodbye delay", async () => {
    ensureConversation("conv-relay-verify-race");
    ensureConversation("conv-relay-verify-race-initiator");
    const session = createCallSession({
      conversationId: "conv-relay-verify-race",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
      initiatedFromConversationId: "conv-relay-verify-race-initiator",
    });

    mockConfig.calls.verification.enabled = true;
    mockConfig.calls.verification.maxAttempts = 1;
    mockConfig.calls.verification.codeLength = 1;

    const { relay } = createMockWs(session.id);

    await relay.handleMessage(
      JSON.stringify({
        type: "setup",
        callSid: "CA_verify_race_123",
        from: "+15551111111",
        to: "+15552222222",
      }),
    );

    const verificationCode = relay.getVerificationCode();
    expect(verificationCode).not.toBeNull();
    const wrongDigit = verificationCode === "0" ? "1" : "0";

    await relay.handleMessage(
      JSON.stringify({
        type: "dtmf",
        digit: wrongDigit,
      }),
    );

    // Simulate the callee hanging up before the delayed endSession executes.
    relay.handleTransportClosed(1000, "callee hung up");

    const updated = getCallSession(session.id);
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("failed");
    expect(updated!.lastError).toContain("max attempts exceeded");
    expect(getLatestAssistantText("conv-relay-verify-race")).toContain(
      "**Call failed**",
    );

    // Let the delayed endSession callback flush to avoid timer bleed across tests.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const finalState = getCallSession(session.id);
    expect(finalState).not.toBeNull();
    expect(finalState!.status).toBe("failed");

    relay.destroy();
  });

  // ── Error handling ──────────────────────────────────────────────

  test("handleMessage: error message records call_failed event", async () => {
    ensureConversation("conv-relay-err");
    const session = createCallSession({
      conversationId: "conv-relay-err",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });

    const { relay } = createMockWs(session.id);

    await relay.handleMessage(
      JSON.stringify({
        type: "error",
        description: "Audio stream disconnected",
      }),
    );

    const events = getCallEvents(session.id);
    const failEvents = events.filter((e) => e.eventType === "call_failed");
    expect(failEvents.length).toBe(1);
    const payload = JSON.parse(failEvents[0].payloadJson);
    expect(payload.error).toBe("Audio stream disconnected");

    relay.destroy();
  });

  // ── Malformed message resilience ────────────────────────────────

  test("handleMessage: malformed JSON does not throw", async () => {
    ensureConversation("conv-relay-malformed");
    const session = createCallSession({
      conversationId: "conv-relay-malformed",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });

    const { relay } = createMockWs(session.id);

    // Should not throw
    await relay.handleMessage("not-valid-json{{{");

    relay.destroy();
  });

  test("handleMessage: unknown message type does not throw", async () => {
    ensureConversation("conv-relay-unknown");
    const session = createCallSession({
      conversationId: "conv-relay-unknown",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });

    const { relay } = createMockWs(session.id);

    // Should not throw
    await relay.handleMessage(
      JSON.stringify({
        type: "some_future_type",
        data: "whatever",
      }),
    );

    relay.destroy();
  });

  // ── sendTextToken / endSession ──────────────────────────────────

  test("sendTextToken: sends correctly formatted text message", () => {
    ensureConversation("conv-relay-send");
    const session = createCallSession({
      conversationId: "conv-relay-send",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });

    const { ws, relay } = createMockWs(session.id);

    relay.sendTextToken("Hello there", false);
    relay.sendTextToken("", true);

    expect(ws.sentMessages.length).toBe(2);

    const msg1 = JSON.parse(ws.sentMessages[0]);
    expect(msg1.type).toBe("text");
    expect(msg1.token).toBe("Hello there");
    expect(msg1.last).toBe(false);

    const msg2 = JSON.parse(ws.sentMessages[1]);
    expect(msg2.type).toBe("text");
    expect(msg2.token).toBe("");
    expect(msg2.last).toBe(true);

    relay.destroy();
  });

  test("endSession: sends end message without reason", () => {
    ensureConversation("conv-relay-end");
    const session = createCallSession({
      conversationId: "conv-relay-end",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });

    const { ws, relay } = createMockWs(session.id);

    relay.endSession();

    expect(ws.sentMessages.length).toBe(1);
    const msg = JSON.parse(ws.sentMessages[0]);
    expect(msg.type).toBe("end");
    expect(msg.handoffData).toBeUndefined();

    relay.destroy();
  });

  test("endSession: sends end message with reason as handoffData", () => {
    ensureConversation("conv-relay-end-reason");
    const session = createCallSession({
      conversationId: "conv-relay-end-reason",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });

    const { ws, relay } = createMockWs(session.id);

    relay.endSession("Call completed");

    expect(ws.sentMessages.length).toBe(1);
    const msg = JSON.parse(ws.sentMessages[0]);
    expect(msg.type).toBe("end");
    const handoff = JSON.parse(msg.handoffData);
    expect(handoff.reason).toBe("Call completed");

    relay.destroy();
  });

  // ── Conversation history ────────────────────────────────────────

  test("getConversationHistory: returns role and text without timestamps", () => {
    ensureConversation("conv-relay-hist");
    const session = createCallSession({
      conversationId: "conv-relay-hist",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });

    const { relay } = createMockWs(session.id);

    // Empty initially
    expect(relay.getConversationHistory()).toEqual([]);

    relay.destroy();
  });

  // ── Accessors ───────────────────────────────────────────────────

  test("getCallSessionId: returns the call session ID", () => {
    ensureConversation("conv-relay-id");
    const session = createCallSession({
      conversationId: "conv-relay-id",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });

    const { relay } = createMockWs(session.id);
    expect(relay.getCallSessionId()).toBe(session.id);

    relay.destroy();
  });

  // ── destroy ─────────────────────────────────────────────────────

  test("destroy: cleans up orchestrator", async () => {
    ensureConversation("conv-relay-destroy");
    const session = createCallSession({
      conversationId: "conv-relay-destroy",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });

    const { relay } = createMockWs(session.id);

    // Setup creates orchestrator
    await relay.handleMessage(
      JSON.stringify({
        type: "setup",
        callSid: "CA_destroy_123",
        from: "+15551111111",
        to: "+15552222222",
      }),
    );

    expect(relay.getController()).not.toBeNull();

    relay.destroy();

    expect(relay.getController()).toBeNull();
  });

  test("destroy: can be called multiple times without error", () => {
    ensureConversation("conv-relay-destroy2");
    const session = createCallSession({
      conversationId: "conv-relay-destroy2",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });

    const { relay } = createMockWs(session.id);

    relay.destroy();
    expect(() => relay.destroy()).not.toThrow();
  });

  // ── Inbound call setup ────────────────────────────────────────────

  test("handleMessage: inbound call (no task) triggers greeting without verification", async () => {
    ensureConversation("conv-relay-inbound-greet");
    // Inbound sessions have no task and no initiatedFromConversationId
    const session = createCallSession({
      conversationId: "conv-relay-inbound-greet",
      provider: "twilio",
      fromNumber: "+15559999999",
      toNumber: "+15551111111",
      // no task — inbound call
    });

    // Enable verification to prove inbound calls skip it
    mockConfig.calls.verification.enabled = true;
    addTrustedVoiceContact("+15559999999");

    mockSendMessage.mockImplementation(
      createMockProviderResponse(["Hello, how can I help you today?"]),
    );

    const { ws, relay } = createMockWs(session.id);

    await relay.handleMessage(
      JSON.stringify({
        type: "setup",
        callSid: "CA_inbound_greet_123",
        from: "+15559999999",
        to: "+15551111111",
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Should NOT have started verification (no verification code prompt)
    expect(relay.getVerificationCode()).toBeNull();

    // Should have generated a greeting via the orchestrator
    const textMessages = ws.sentMessages
      .map(
        (raw) =>
          JSON.parse(raw) as { type: string; token?: string; last?: boolean },
      )
      .filter((m) => m.type === "text");
    expect(
      textMessages.some((m) => (m.token ?? "").includes("how can I help")),
    ).toBe(true);
    expect(textMessages.some((m) => m.last === true)).toBe(true);

    relay.destroy();
  });

  test("handleMessage: inbound call persists caller transcript to voice conversation", async () => {
    ensureConversation("conv-relay-inbound-persist");
    const session = createCallSession({
      conversationId: "conv-relay-inbound-persist",
      provider: "twilio",
      fromNumber: "+15559999999",
      toNumber: "+15551111111",
      // no task — inbound call
    });

    mockSendMessage.mockImplementation(
      createMockProviderResponse(["Sure, let me help with that."]),
    );
    addTrustedVoiceContact("+15559999999");

    const { relay } = createMockWs(session.id);

    await relay.handleMessage(
      JSON.stringify({
        type: "setup",
        callSid: "CA_inbound_persist_123",
        from: "+15559999999",
        to: "+15551111111",
      }),
    );

    // Wait for initial greeting to settle
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Send a caller utterance
    await relay.handleMessage(
      JSON.stringify({
        type: "prompt",
        voicePrompt: "I would like to schedule an appointment",
        lang: "en-US",
        last: true,
      }),
    );

    // Verify caller transcript is persisted to the voice conversation
    const userMessages = getMessages("conv-relay-inbound-persist").filter(
      (m) => m.role === "user",
    );
    expect(userMessages.length).toBeGreaterThan(0);
    const lastUserMsg = userMessages[userMessages.length - 1];
    expect(lastUserMsg.content).toContain("schedule an appointment");

    // Verify assistant response is also persisted
    const assistantMessages = getMessages("conv-relay-inbound-persist").filter(
      (m) => m.role === "assistant",
    );
    expect(assistantMessages.length).toBeGreaterThan(0);

    relay.destroy();
  });

  test("handleMessage: inbound call supports multi-turn conversation", async () => {
    ensureConversation("conv-relay-inbound-multi");
    const session = createCallSession({
      conversationId: "conv-relay-inbound-multi",
      provider: "twilio",
      fromNumber: "+15559999999",
      toNumber: "+15551111111",
      // no task — inbound call
    });

    let turnCount = 0;
    addTrustedVoiceContact("+15559999999");
    mockSendMessage.mockImplementation(
      async (
        _messages: unknown[],
        _tools: unknown[],
        _systemPrompt: unknown,
        options?: {
          onEvent?: (event: { type: string; text?: string }) => void;
        },
      ) => {
        turnCount++;
        let tokens: string[];
        if (turnCount === 1) tokens = ["Hello, how can I help you?"];
        else if (turnCount === 2) tokens = ["Sure, I can help with that."];
        else tokens = ["Your appointment is confirmed."];
        for (const token of tokens) {
          options?.onEvent?.({ type: "text_delta", text: token });
        }
        return {
          content: [{ type: "text", text: tokens.join("") }],
          model: "claude-sonnet-4-20250514",
          usage: { inputTokens: 100, outputTokens: 50 },
          stopReason: "end_turn",
        };
      },
    );

    const { ws: _ws, relay } = createMockWs(session.id);

    // Setup
    await relay.handleMessage(
      JSON.stringify({
        type: "setup",
        callSid: "CA_inbound_multi_123",
        from: "+15559999999",
        to: "+15551111111",
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 10));

    // First caller turn
    await relay.handleMessage(
      JSON.stringify({
        type: "prompt",
        voicePrompt: "I need to schedule something",
        lang: "en-US",
        last: true,
      }),
    );

    // Second caller turn
    await relay.handleMessage(
      JSON.stringify({
        type: "prompt",
        voicePrompt: "How about next Tuesday?",
        lang: "en-US",
        last: true,
      }),
    );

    // Verify conversation history has multiple turns
    const history = relay.getConversationHistory();
    expect(history.length).toBe(2);
    expect(history[0].text).toBe("I need to schedule something");
    expect(history[1].text).toBe("How about next Tuesday?");

    // Verify LLM was called for each turn (greeting + 2 caller turns)
    expect(turnCount).toBe(3);

    // Verify events were recorded for both caller utterances
    const events = getCallEvents(session.id).filter(
      (e) => e.eventType === "caller_spoke",
    );
    expect(events.length).toBe(2);

    relay.destroy();
  });

  // ── Inbound voice guardian verification gate ────────────────────────

  test("inbound guardian verification: DTMF code entry succeeds and starts normal call flow", async () => {
    ensureConversation("conv-guardian-dtmf-ok");
    const session = createCallSession({
      conversationId: "conv-guardian-dtmf-ok",
      provider: "twilio",
      fromNumber: "+15559999999",
      toNumber: "+15551111111",
      // no task — inbound call
    });

    // Create a pending voice guardian challenge
    const secret = createPendingVoiceGuardianChallenge();

    mockSendMessage.mockImplementation(
      createMockProviderResponse(["Hello, how can I help you?"]),
    );

    const { ws, relay } = createMockWs(session.id);

    await relay.handleMessage(
      JSON.stringify({
        type: "setup",
        callSid: "CA_guardian_dtmf_ok",
        from: "+15559999999",
        to: "+15551111111",
      }),
    );

    // Should be in verification-pending state
    expect(relay.isVerificationSessionActive()).toBe(true);
    expect(relay.getConnectionState()).toBe("verification_pending");

    // Verify TTS prompt was sent asking for code
    const setupMessages = ws.sentMessages
      .map((raw) => JSON.parse(raw) as { type: string; token?: string })
      .filter((m) => m.type === "text");
    expect(
      setupMessages.some((m) => (m.token ?? "").includes("verification code")),
    ).toBe(true);

    // Enter the correct code via DTMF
    for (const digit of secret) {
      await relay.handleMessage(JSON.stringify({ type: "dtmf", digit }));
    }

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Verification should have succeeded
    expect(relay.isVerificationSessionActive()).toBe(false);
    expect(relay.getConnectionState()).toBe("connected");

    // Guardian binding is NOT created by the assistant — the gateway owns
    // binding creation for inbound voice verification. The assistant only
    // transitions to connected state and starts the normal call flow.
    const binding = getGuardianBinding("self", "phone");
    expect(binding).toBeNull();

    // Orchestrator greeting should have fired
    const textMessages = ws.sentMessages
      .map((raw) => JSON.parse(raw) as { type: string; token?: string })
      .filter((m) => m.type === "text");
    expect(
      textMessages.some((m) => (m.token ?? "").includes("how can I help")),
    ).toBe(true);

    // Verify events recorded
    const guardianEvents = getCallEvents(session.id);
    expect(
      guardianEvents.some((e) => e.eventType === "voice_verification_started"),
    ).toBe(true);
    expect(
      guardianEvents.some(
        (e) => e.eventType === "voice_verification_succeeded",
      ),
    ).toBe(true);

    relay.destroy();
  });

  test("inbound guardian verification: speech-based code entry succeeds", async () => {
    ensureConversation("conv-guardian-speech-ok");
    const session = createCallSession({
      conversationId: "conv-guardian-speech-ok",
      provider: "twilio",
      fromNumber: "+15559999999",
      toNumber: "+15551111111",
    });

    const secret = createPendingVoiceGuardianChallenge();

    mockSendMessage.mockImplementation(
      createMockProviderResponse(["Hello, verified caller!"]),
    );

    const { ws, relay } = createMockWs(session.id);

    await relay.handleMessage(
      JSON.stringify({
        type: "setup",
        callSid: "CA_guardian_speech_ok",
        from: "+15559999999",
        to: "+15551111111",
      }),
    );

    expect(relay.isVerificationSessionActive()).toBe(true);

    // Speak the code as individual digit characters
    const spokenCode = secret.split("").join(" ");
    await relay.handleMessage(
      JSON.stringify({
        type: "prompt",
        voicePrompt: spokenCode,
        lang: "en-US",
        last: true,
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Verification should have succeeded
    expect(relay.isVerificationSessionActive()).toBe(false);
    expect(relay.getConnectionState()).toBe("connected");

    // Binding is NOT created by the assistant — gateway owns this.
    const binding = getGuardianBinding("self", "phone");
    expect(binding).toBeNull();

    // Greeting should have started
    const textMessages = ws.sentMessages
      .map((raw) => JSON.parse(raw) as { type: string; token?: string })
      .filter((m) => m.type === "text");
    expect(
      textMessages.some((m) => (m.token ?? "").includes("verified caller")),
    ).toBe(true);

    relay.destroy();
  });

  test("inbound call: caller matching voice guardian binding is classified as guardian", async () => {
    ensureConversation("conv-guardian-role-match");
    const session = createCallSession({
      conversationId: "conv-guardian-role-match",
      provider: "twilio",
      fromNumber: "+15550001111",
      toNumber: "+15551111111",
    });

    createGuardianBinding({
      channel: "phone",
      guardianExternalUserId: "+15550001111",
      guardianDeliveryChatId: "+15550001111",
      guardianPrincipalId: "+15550001111",
      verifiedVia: "test",
    });

    mockSendMessage.mockImplementation(
      createMockProviderResponse(["Hello there."]),
    );

    const { relay } = createMockWs(session.id);

    await relay.handleMessage(
      JSON.stringify({
        type: "setup",
        callSid: "CA_guardian_role_match",
        from: "+15550001111",
        to: "+15551111111",
      }),
    );

    const runtimeContext = (
      relay.getController() as unknown as {
        trustContext?: {
          sourceChannel?: string;
          trustClass?: string;
          guardianExternalUserId?: string;
        };
      }
    )?.trustContext;
    expect(runtimeContext?.sourceChannel).toBe("phone");
    expect(runtimeContext?.trustClass).toBe("guardian");
    expect(runtimeContext?.guardianExternalUserId).toBe("+15550001111");

    relay.destroy();
  });

  test("inbound call: caller not matching voice guardian binding is classified as trusted contact", async () => {
    ensureConversation("conv-guardian-role-mismatch");
    const session = createCallSession({
      conversationId: "conv-guardian-role-mismatch",
      provider: "twilio",
      fromNumber: "+15550002222",
      toNumber: "+15551111111",
    });

    createGuardianBinding({
      channel: "phone",
      guardianExternalUserId: "+15550009999",
      guardianDeliveryChatId: "+15550009999",
      guardianPrincipalId: "+15550009999",
      verifiedVia: "test",
    });
    addTrustedVoiceContact("+15550002222");

    mockSendMessage.mockImplementation(
      createMockProviderResponse(["Hello there."]),
    );

    const { relay } = createMockWs(session.id);

    await relay.handleMessage(
      JSON.stringify({
        type: "setup",
        callSid: "CA_guardian_role_mismatch",
        from: "+15550002222",
        to: "+15551111111",
      }),
    );

    const runtimeContext = (
      relay.getController() as unknown as {
        trustContext?: {
          sourceChannel?: string;
          trustClass?: string;
          guardianExternalUserId?: string;
          requesterExternalUserId?: string;
        };
      }
    )?.trustContext;
    expect(runtimeContext?.sourceChannel).toBe("phone");
    expect(runtimeContext?.trustClass).toBe("trusted_contact");
    expect(runtimeContext?.guardianExternalUserId).toBe("+15550009999");
    expect(runtimeContext?.requesterExternalUserId).toBe("+15550002222");

    relay.destroy();
  });

  test("outbound call: callee matching active voice binding is classified as guardian", async () => {
    ensureConversation("conv-guardian-outbound-voice-match");
    ensureConversation("conv-guardian-outbound-voice-origin");
    const session = createCallSession({
      conversationId: "conv-guardian-outbound-voice-match",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15550001111",
      initiatedFromConversationId: "conv-guardian-outbound-voice-origin",
    });

    createGuardianBinding({
      channel: "phone",
      guardianExternalUserId: "+15550001111",
      guardianDeliveryChatId: "+15550001111",
      guardianPrincipalId: "+15550001111",
      verifiedVia: "test",
    });

    mockSendMessage.mockImplementation(
      createMockProviderResponse(["Hello there."]),
    );

    const { relay } = createMockWs(session.id);

    await relay.handleMessage(
      JSON.stringify({
        type: "setup",
        callSid: "CA_guardian_outbound_voice_match",
        from: "+15551111111",
        to: "+15550001111",
      }),
    );

    const runtimeContext = (
      relay.getController() as unknown as {
        trustContext?: {
          sourceChannel?: string;
          trustClass?: string;
          guardianExternalUserId?: string;
        };
      }
    )?.trustContext;
    expect(runtimeContext?.sourceChannel).toBe("phone");
    expect(runtimeContext?.trustClass).toBe("guardian");
    expect(runtimeContext?.guardianExternalUserId).toBe("+15550001111");

    relay.destroy();
  });

  test("outbound call: matching configured user number does not override strict voice binding checks", async () => {
    ensureConversation("conv-guardian-outbound-strict");
    ensureConversation("conv-guardian-outbound-strict-origin");
    const session = createCallSession({
      conversationId: "conv-guardian-outbound-strict",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15550001111",
      initiatedFromConversationId: "conv-guardian-outbound-strict-origin",
    });

    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "tg-guardian-user",
      guardianDeliveryChatId: "tg-guardian-chat",
      guardianPrincipalId: "tg-guardian-user",
      verifiedVia: "test",
    });

    // Number matches the configured owner number, but there is no active
    // voice guardian binding for this callee.
    mockConfig.calls.callerIdentity.userNumber = "+15550001111";
    mockSendMessage.mockImplementation(
      createMockProviderResponse(["Hello there."]),
    );

    const { relay } = createMockWs(session.id);

    await relay.handleMessage(
      JSON.stringify({
        type: "setup",
        callSid: "CA_guardian_outbound_strict",
        from: "+15551111111",
        to: "+15550001111",
      }),
    );

    const runtimeContext = (
      relay.getController() as unknown as {
        trustContext?: {
          sourceChannel?: string;
          trustClass?: string;
        };
      }
    )?.trustContext;
    expect(runtimeContext?.sourceChannel).toBe("phone");
    expect(runtimeContext?.trustClass).toBe("unknown");

    relay.destroy();
  });

  test("inbound guardian verification updates controller context to guardian", async () => {
    ensureConversation("conv-guardian-context-upgrade");
    const session = createCallSession({
      conversationId: "conv-guardian-context-upgrade",
      provider: "twilio",
      fromNumber: "+15550003333",
      toNumber: "+15551111111",
    });

    const secret = createPendingVoiceGuardianChallenge();
    const spokenCode = secret.split("").join(" ");

    const { relay } = createMockWs(session.id);

    await relay.handleMessage(
      JSON.stringify({
        type: "setup",
        callSid: "CA_guardian_context_upgrade",
        from: session.fromNumber,
        to: session.toNumber,
      }),
    );

    const preVerify = (
      relay.getController() as unknown as {
        trustContext?: { trustClass?: string };
      }
    )?.trustContext;
    expect(preVerify?.trustClass).toBe("unknown");

    await relay.handleMessage(
      JSON.stringify({
        type: "prompt",
        voicePrompt: spokenCode,
        lang: "en-US",
        last: true,
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 10));

    // The gateway creates the guardian binding before the ConversationRelay
    // WebSocket is established, so resolveActorTrust() would find it in
    // production. Without a gateway in this test, trust reflects the
    // resolved state without a binding.
    const postVerify = (
      relay.getController() as unknown as {
        trustContext?: {
          sourceChannel?: string;
          trustClass?: string;
        };
      }
    )?.trustContext;
    expect(postVerify?.sourceChannel).toBe("phone");
    // Trust class is 'unknown' because the gateway creates the binding
    // before the relay is established. Without a gateway in this test,
    // resolveActorTrust finds no guardian binding.
    expect(postVerify?.trustClass).toBe("unknown");

    relay.destroy();
  });

  test("inbound guardian verification: invalid code triggers retry prompt", async () => {
    ensureConversation("conv-guardian-retry");
    const session = createCallSession({
      conversationId: "conv-guardian-retry",
      provider: "twilio",
      fromNumber: "+15559999999",
      toNumber: "+15551111111",
    });

    createPendingVoiceGuardianChallenge();

    const { ws, relay } = createMockWs(session.id);

    await relay.handleMessage(
      JSON.stringify({
        type: "setup",
        callSid: "CA_guardian_retry",
        from: "+15559999999",
        to: "+15551111111",
      }),
    );

    expect(relay.isVerificationSessionActive()).toBe(true);

    // Enter a wrong code via DTMF
    for (const digit of "000000") {
      await relay.handleMessage(JSON.stringify({ type: "dtmf", digit }));
    }

    // Should still be in verification-pending state (retry allowed)
    expect(relay.isVerificationSessionActive()).toBe(true);
    expect(relay.getConnectionState()).toBe("verification_pending");

    // Should have sent a retry prompt
    const textMessages = ws.sentMessages
      .map((raw) => JSON.parse(raw) as { type: string; token?: string })
      .filter((m) => m.type === "text");
    expect(
      textMessages.some((m) => (m.token ?? "").includes("incorrect")),
    ).toBe(true);

    relay.destroy();
  });

  test("inbound guardian verification: max attempts exhaustion terminates call", async () => {
    ensureConversation("conv-guardian-max-attempts");
    const session = createCallSession({
      conversationId: "conv-guardian-max-attempts",
      provider: "twilio",
      fromNumber: "+15559999999",
      toNumber: "+15551111111",
    });

    createPendingVoiceGuardianChallenge();

    const { ws, relay } = createMockWs(session.id);

    await relay.handleMessage(
      JSON.stringify({
        type: "setup",
        callSid: "CA_guardian_max_attempts",
        from: "+15559999999",
        to: "+15551111111",
      }),
    );

    expect(relay.isVerificationSessionActive()).toBe(true);

    // Enter wrong codes 3 times (max attempts = 3)
    for (let attempt = 0; attempt < 3; attempt++) {
      for (const digit of "000000") {
        await relay.handleMessage(JSON.stringify({ type: "dtmf", digit }));
      }
    }

    // Call should be marked as failed
    const updated = getCallSession(session.id);
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("failed");
    expect(updated!.lastError).toContain("Guardian voice verification failed");

    // Should have sent goodbye message
    const textMessages = ws.sentMessages
      .map((raw) => JSON.parse(raw) as { type: string; token?: string })
      .filter((m) => m.type === "text");
    expect(
      textMessages.some((m) =>
        (m.token ?? "").includes("Verification failed. Goodbye."),
      ),
    ).toBe(true);

    // Verify events
    const events = getCallEvents(session.id);
    expect(
      events.some((e) => e.eventType === "voice_verification_failed"),
    ).toBe(true);

    // Let the delayed endSession callback flush
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Verify end message was sent
    const endMessages = ws.sentMessages
      .map((raw) => JSON.parse(raw) as { type: string })
      .filter((m) => m.type === "end");
    expect(endMessages.length).toBe(1);

    relay.destroy();
  });

  test("inbound guardian verification: no pending challenge proceeds with normal flow", async () => {
    ensureConversation("conv-guardian-no-challenge");
    const session = createCallSession({
      conversationId: "conv-guardian-no-challenge",
      provider: "twilio",
      fromNumber: "+15559999999",
      toNumber: "+15551111111",
      // no task — inbound call
    });

    // Do NOT create any pending challenge

    mockSendMessage.mockImplementation(
      createMockProviderResponse(["Welcome to the line."]),
    );
    addTrustedVoiceContact("+15559999999");

    const { ws, relay } = createMockWs(session.id);

    await relay.handleMessage(
      JSON.stringify({
        type: "setup",
        callSid: "CA_guardian_no_challenge",
        from: "+15559999999",
        to: "+15551111111",
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Should NOT be in guardian verification state
    expect(relay.isVerificationSessionActive()).toBe(false);
    expect(relay.getConnectionState()).toBe("connected");

    // Should have started normal greeting
    const textMessages = ws.sentMessages
      .map((raw) => JSON.parse(raw) as { type: string; token?: string })
      .filter((m) => m.type === "text");
    expect(
      textMessages.some((m) => (m.token ?? "").includes("Welcome to the line")),
    ).toBe(true);

    relay.destroy();
  });

  test("inbound guardian verification: speech with partial digits prompts for more", async () => {
    ensureConversation("conv-guardian-partial-speech");
    const session = createCallSession({
      conversationId: "conv-guardian-partial-speech",
      provider: "twilio",
      fromNumber: "+15559999999",
      toNumber: "+15551111111",
    });

    createPendingVoiceGuardianChallenge();

    const { ws, relay } = createMockWs(session.id);

    await relay.handleMessage(
      JSON.stringify({
        type: "setup",
        callSid: "CA_guardian_partial_speech",
        from: "+15559999999",
        to: "+15551111111",
      }),
    );

    expect(relay.isVerificationSessionActive()).toBe(true);

    // Speak only 3 digits
    await relay.handleMessage(
      JSON.stringify({
        type: "prompt",
        voicePrompt: "one two three",
        lang: "en-US",
        last: true,
      }),
    );

    // Should still be in verification state
    expect(relay.isVerificationSessionActive()).toBe(true);

    // Should have prompted for more digits
    const textMessages = ws.sentMessages
      .map((raw) => JSON.parse(raw) as { type: string; token?: string })
      .filter((m) => m.type === "text");
    expect(textMessages.some((m) => (m.token ?? "").includes("3 digits"))).toBe(
      true,
    );
    expect(
      textMessages.some((m) => (m.token ?? "").includes("all 6 digits")),
    ).toBe(true);

    relay.destroy();
  });

  // ── Outbound guardian verification pointer messages ─────────────────

  test("outbound guardian verification success emits pointer to origin conversation", async () => {
    ensureConversation("conv-gv-pointer-success");
    ensureConversation("conv-gv-pointer-success-origin");
    const session = createCallSession({
      conversationId: "conv-gv-pointer-success",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15559999999",
      callMode: "verification",
      verificationSessionId: "gv-session-ptr-success",
      initiatedFromConversationId: "conv-gv-pointer-success-origin",
    });

    const secret = createVoiceVerificationSession(
      "+15559999999",
      "gv-session-ptr-success",
    );

    const { relay } = createMockWs(session.id);

    await relay.handleMessage(
      JSON.stringify({
        type: "setup",
        callSid: "CA_gv_pointer_success",
        from: "+15551111111",
        to: "+15559999999",
        customParameters: {
          verificationSessionId: "gv-session-ptr-success",
        },
      }),
    );

    expect(relay.isVerificationSessionActive()).toBe(true);

    // Enter the correct code via DTMF
    for (const digit of secret) {
      await relay.handleMessage(JSON.stringify({ type: "dtmf", digit }));
    }

    // Verification should have succeeded
    expect(relay.isVerificationSessionActive()).toBe(false);

    // Origin conversation should have a pointer message
    const originText = getLatestAssistantText("conv-gv-pointer-success-origin");
    expect(originText).not.toBeNull();
    expect(originText).toContain("Guardian verification");
    expect(originText).toContain("+15559999999");
    expect(originText).toContain("succeeded");

    // Let the delayed endSession callback flush
    await new Promise((resolve) => setTimeout(resolve, 10));

    relay.destroy();
  });

  test("outbound guardian verification failure emits pointer to origin conversation", async () => {
    ensureConversation("conv-gv-pointer-fail");
    ensureConversation("conv-gv-pointer-fail-origin");
    const session = createCallSession({
      conversationId: "conv-gv-pointer-fail",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15559999999",
      callMode: "verification",
      verificationSessionId: "gv-session-ptr-fail",
      initiatedFromConversationId: "conv-gv-pointer-fail-origin",
    });

    createVoiceVerificationSession("+15559999999", "gv-session-ptr-fail");

    const { relay } = createMockWs(session.id);

    await relay.handleMessage(
      JSON.stringify({
        type: "setup",
        callSid: "CA_gv_pointer_fail",
        from: "+15551111111",
        to: "+15559999999",
        customParameters: {
          verificationSessionId: "gv-session-ptr-fail",
        },
      }),
    );

    expect(relay.isVerificationSessionActive()).toBe(true);

    // Enter wrong codes 3 times (max attempts = 3)
    for (let attempt = 0; attempt < 3; attempt++) {
      for (const digit of "000000") {
        await relay.handleMessage(JSON.stringify({ type: "dtmf", digit }));
      }
    }

    // Call should be marked as failed
    const updated = getCallSession(session.id);
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("failed");

    // Origin conversation should have a failure pointer message
    const originText = getLatestAssistantText("conv-gv-pointer-fail-origin");
    expect(originText).not.toBeNull();
    expect(originText).toContain("Guardian verification");
    expect(originText).toContain("+15559999999");
    expect(originText).toContain("failed");

    // Let the delayed endSession callback flush
    await new Promise((resolve) => setTimeout(resolve, 10));

    relay.destroy();
  });

  // ── Inbound voice invite redemption ──────────────────────────────────

  test("inbound voice invite redemption: personalized welcome prompt with friend/guardian names", async () => {
    ensureConversation("conv-invite-welcome");
    const session = createCallSession({
      conversationId: "conv-invite-welcome",
      provider: "twilio",
      fromNumber: "+15558887777",
      toNumber: "+15551111111",
    });

    // Create a voice invite with friend/guardian names
    const code = generateVoiceCode(6);
    const codeHash = hashVoiceCode(code);
    createInvite({
      sourceChannel: "phone",
      contactId: createTargetContact(),
      maxUses: 1,
      expectedExternalUserId: "+15558887777",
      voiceCodeHash: codeHash,
      voiceCodeDigits: 6,
      friendName: "Alice",
      guardianName: "Bob",
    });

    mockSendMessage.mockImplementation(
      createMockProviderResponse(["Hello, how can I help?"]),
    );

    const { ws, relay } = createMockWs(session.id);

    await relay.handleMessage(
      JSON.stringify({
        type: "setup",
        callSid: "CA_invite_welcome",
        from: "+15558887777",
        to: "+15551111111",
      }),
    );

    // Should be in verification-pending state for invite redemption
    expect(relay.getConnectionState()).toBe("verification_pending");

    // Check that the welcome prompt includes friend/guardian names
    const textMessages = ws.sentMessages
      .map((raw) => JSON.parse(raw) as { type: string; token?: string })
      .filter((m) => m.type === "text");
    expect(
      textMessages.some((m) => (m.token ?? "").includes("Welcome Alice")),
    ).toBe(true);
    expect(
      textMessages.some((m) => (m.token ?? "").includes("Bob provided you")),
    ).toBe(true);

    // Enter the correct code via DTMF
    for (const digit of code) {
      await relay.handleMessage(JSON.stringify({ type: "dtmf", digit }));
    }

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Should have transitioned to connected
    expect(relay.getConnectionState()).toBe("connected");

    // Verify events
    const events = getCallEvents(session.id);
    expect(
      events.some((e) => e.eventType === "invite_redemption_started"),
    ).toBe(true);
    expect(
      events.some((e) => e.eventType === "invite_redemption_succeeded"),
    ).toBe(true);

    relay.destroy();
  });

  test("inbound voice invite redemption: invalid code gets exact failure copy with guardian name and call ends", async () => {
    ensureConversation("conv-invite-fail");
    const session = createCallSession({
      conversationId: "conv-invite-fail",
      provider: "twilio",
      fromNumber: "+15558886666",
      toNumber: "+15551111111",
    });

    // Create a voice invite with friend/guardian names
    const code = generateVoiceCode(6);
    const codeHash = hashVoiceCode(code);
    createInvite({
      sourceChannel: "phone",
      contactId: createTargetContact(),
      maxUses: 1,
      expectedExternalUserId: "+15558886666",
      voiceCodeHash: codeHash,
      voiceCodeDigits: 6,
      friendName: "Carol",
      guardianName: "Dave",
    });

    const { ws, relay } = createMockWs(session.id);

    await relay.handleMessage(
      JSON.stringify({
        type: "setup",
        callSid: "CA_invite_fail",
        from: "+15558886666",
        to: "+15551111111",
      }),
    );

    expect(relay.getConnectionState()).toBe("verification_pending");

    // Enter a wrong code
    for (const digit of "000000") {
      await relay.handleMessage(JSON.stringify({ type: "dtmf", digit }));
    }

    // Call should be marked as failed immediately
    const updated = getCallSession(session.id);
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("failed");

    // Should have sent the exact deterministic failure copy with guardian name
    const textMessages = ws.sentMessages
      .map((raw) => JSON.parse(raw) as { type: string; token?: string })
      .filter((m) => m.type === "text");
    expect(
      textMessages.some((m) =>
        (m.token ?? "").includes(
          "Sorry, the code you provided is incorrect or has since expired",
        ),
      ),
    ).toBe(true);
    expect(
      textMessages.some((m) =>
        (m.token ?? "").includes("Please ask Dave for a new code"),
      ),
    ).toBe(true);

    // Verify events
    const events = getCallEvents(session.id);
    expect(events.some((e) => e.eventType === "invite_redemption_failed")).toBe(
      true,
    );

    // Let the delayed endSession callback flush
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Verify end message was sent
    const endMessages = ws.sentMessages
      .map((raw) => JSON.parse(raw) as { type: string })
      .filter((m) => m.type === "end");
    expect(endMessages.length).toBe(1);

    relay.destroy();
  });

  test("inbound voice: unknown caller with no active invite enters name capture flow", async () => {
    ensureConversation("conv-invite-no-invite");
    const session = createCallSession({
      conversationId: "conv-invite-no-invite",
      provider: "twilio",
      fromNumber: "+15558885555",
      toNumber: "+15551111111",
    });

    // No voice invite created for this caller

    const { ws, relay } = createMockWs(session.id);

    await relay.handleMessage(
      JSON.stringify({
        type: "setup",
        callSid: "CA_invite_no_invite",
        from: "+15558885555",
        to: "+15551111111",
      }),
    );

    // Should be in the name capture state (not denied)
    expect(relay.getConnectionState()).toBe("awaiting_name");

    // Should have sent the name capture prompt with assistant name + guardian label
    const textMessages = ws.sentMessages
      .map((raw) => JSON.parse(raw) as { type: string; token?: string })
      .filter((m) => m.type === "text");
    expect(
      textMessages.some((m) => (m.token ?? "").includes("Hi, this is Vellum,")),
    ).toBe(true);
    expect(
      textMessages.some((m) =>
        (m.token ?? "").includes("don't recognize this number"),
      ),
    ).toBe(true);
    expect(
      textMessages.some((m) => (m.token ?? "").includes("Can I get your name")),
    ).toBe(true);

    // Verify event was recorded
    const events = getCallEvents(session.id);
    expect(
      events.some((e) => e.eventType === "inbound_acl_name_capture_started"),
    ).toBe(true);

    relay.destroy();
  });

  test("inbound voice: guardian's unverified channel gets self-verify guidance", async () => {
    ensureConversation("conv-unverified-guardian");
    const session = createCallSession({
      conversationId: "conv-unverified-guardian",
      provider: "twilio",
      fromNumber: "+15558886666",
      toNumber: "+15551111111",
    });

    upsertContactChannel({
      sourceChannel: "phone",
      externalUserId: "+15558886666",
      externalChatId: "+15558886666",
      displayName: "Vargas",
      role: "guardian",
      status: "unverified",
      policy: "allow",
    });

    const { ws, relay } = createMockWs(session.id);

    await relay.handleMessage(
      JSON.stringify({
        type: "setup",
        callSid: "CA_unverified_guardian",
        from: "+15558886666",
        to: "+15551111111",
      }),
    );

    // Should be disconnecting (not awaiting_name, not normal_call)
    expect(relay.getConnectionState()).toBe("disconnecting");

    const updated = getCallSession(session.id);
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("failed");

    const textMessages = ws.sentMessages
      .map((raw) => JSON.parse(raw) as { type: string; token?: string })
      .filter((m) => m.type === "text");
    const promptText = textMessages.map((m) => m.token ?? "").join("");
    expect(promptText).toContain("Vargas");
    expect(promptText).toContain("has not been verified yet");
    expect(promptText).toContain("contacts page");
    expect(promptText).not.toContain("reach out to the account guardian");
    expect(promptText).not.toContain("don't recognize");

    const events = getCallEvents(session.id);
    const aclEvent = events.find(
      (e) => e.eventType === "inbound_acl_unverified_caller",
    );
    expect(aclEvent).toBeTruthy();
    expect(
      (JSON.parse(aclEvent!.payloadJson) as { isGuardian?: boolean })
        .isGuardian,
    ).toBe(true);

    // Let delayed endSession callback flush
    await new Promise((resolve) => setTimeout(resolve, 10));

    relay.destroy();
  });

  test("inbound voice: non-guardian contact with pending channel gets reach-out copy", async () => {
    ensureConversation("conv-pending-contact");
    const session = createCallSession({
      conversationId: "conv-pending-contact",
      provider: "twilio",
      fromNumber: "+15558887777",
      toNumber: "+15551111111",
    });

    upsertContactChannel({
      sourceChannel: "phone",
      externalUserId: "+15558887777",
      externalChatId: "+15558887777",
      displayName: "Pending Pat",
      // role defaults to "contact" — exercises the non-guardian branch
      status: "pending",
      policy: "allow",
    });

    const { ws, relay } = createMockWs(session.id);

    await relay.handleMessage(
      JSON.stringify({
        type: "setup",
        callSid: "CA_pending_contact",
        from: "+15558887777",
        to: "+15551111111",
      }),
    );

    expect(relay.getConnectionState()).toBe("disconnecting");

    const textMessages = ws.sentMessages
      .map((raw) => JSON.parse(raw) as { type: string; token?: string })
      .filter((m) => m.type === "text");
    const promptText = textMessages.map((m) => m.token ?? "").join("");
    expect(promptText).toContain("Pending Pat");
    expect(promptText).toContain("has not been verified yet");
    expect(promptText).toContain("reach out to the account guardian");
    expect(promptText).not.toContain("contacts page");

    const events = getCallEvents(session.id);
    const aclEvent = events.find(
      (e) => e.eventType === "inbound_acl_unverified_caller",
    );
    expect(aclEvent).toBeTruthy();
    expect(
      (JSON.parse(aclEvent!.payloadJson) as { isGuardian?: boolean })
        .isGuardian,
    ).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 10));
    relay.destroy();
  });

  test("inbound voice: unknown caller name capture uses fallback when assistant name is unavailable", async () => {
    const prevName = mockAssistantName;
    mockAssistantName = null;
    // Clear guardian binding so resolveGuardianLabel falls back to DEFAULT_USER_REFERENCE
    const db = getDb();
    db.run("DELETE FROM contact_channels");
    db.run("DELETE FROM contacts");
    try {
      ensureConversation("conv-invite-no-name");
      const session = createCallSession({
        conversationId: "conv-invite-no-name",
        provider: "twilio",
        fromNumber: "+15558885556",
        toNumber: "+15551111111",
      });

      const { ws, relay } = createMockWs(session.id);

      await relay.handleMessage(
        JSON.stringify({
          type: "setup",
          callSid: "CA_invite_no_name",
          from: "+15558885556",
          to: "+15551111111",
        }),
      );

      expect(relay.getConnectionState()).toBe("awaiting_name");

      // Fallback prompt should use the existing guardian-label wording.
      const textMessages = ws.sentMessages
        .map((raw) => JSON.parse(raw) as { type: string; token?: string })
        .filter((m) => m.type === "text");
      const promptText = textMessages.map((m) => m.token ?? "").join("");
      expect(promptText).toContain("Hi, this is my human's assistant.");
      expect(promptText).not.toContain("Vellum");
      expect(promptText).toContain("don't recognize this number");
      expect(promptText).toContain("Can I get your name");

      relay.destroy();
    } finally {
      mockAssistantName = prevName;
    }
  });

  test("inbound voice: unknown caller name capture does not speak a UUID assistant name", async () => {
    const prevName = mockAssistantName;
    mockAssistantName = "11111111-2222-4333-8444-555555555555";
    const db = getDb();
    db.run("DELETE FROM contact_channels");
    db.run("DELETE FROM contacts");
    try {
      ensureConversation("conv-invite-uuid-name");
      const session = createCallSession({
        conversationId: "conv-invite-uuid-name",
        provider: "twilio",
        fromNumber: "+12125550157",
        toNumber: "+12125550111",
      });

      const { ws, relay } = createMockWs(session.id);

      await relay.handleMessage(
        JSON.stringify({
          type: "setup",
          callSid: "CA_invite_uuid_name",
          from: "+12125550157",
          to: "+12125550111",
        }),
      );

      expect(relay.getConnectionState()).toBe("awaiting_name");

      const promptText = ws.sentMessages
        .map((raw) => JSON.parse(raw) as { type: string; token?: string })
        .filter((m) => m.type === "text")
        .map((m) => m.token ?? "")
        .join("");
      expect(promptText).toContain("Hi, this is my human's assistant.");
      expect(promptText).not.toContain("11111111-2222-4333-8444-555555555555");

      relay.destroy();
    } finally {
      mockAssistantName = prevName;
    }
  });

  // ── Friend-initiated in-call guardian approval flow ────────────────────

  test("name capture flow: caller provides name and enters guardian decision wait", async () => {
    ensureConversation("conv-name-capture");
    const session = createCallSession({
      conversationId: "conv-name-capture",
      provider: "twilio",
      fromNumber: "+15558884444",
      toNumber: "+15551111111",
    });

    const { ws, relay } = createMockWs(session.id);

    await relay.handleMessage(
      JSON.stringify({
        type: "setup",
        callSid: "CA_name_capture",
        from: "+15558884444",
        to: "+15551111111",
      }),
    );

    // Should be in name capture state
    expect(relay.getConnectionState()).toBe("awaiting_name");

    // Caller speaks their name
    await relay.handleMessage(
      JSON.stringify({
        type: "prompt",
        voicePrompt: "My name is John",
        lang: "en-US",
        last: true,
      }),
    );

    // Should have transitioned to awaiting guardian decision
    expect(relay.getConnectionState()).toBe("awaiting_guardian_decision");

    // Should have sent the hold message with guardian label and hold instruction.
    // After the access request self-heals a vellum binding, the guardian label
    // resolves to the vellum principal's display name rather than the static
    // "my human" fallback, so we check structural copy without a specific label.
    const textMessages = ws.sentMessages
      .map((raw) => JSON.parse(raw) as { type: string; token?: string })
      .filter((m) => m.type === "text");
    expect(textMessages.some((m) => (m.token ?? "").includes("I've let"))).toBe(
      true,
    );
    expect(
      textMessages.some((m) => (m.token ?? "").includes("Please hold")),
    ).toBe(true);

    // Verify events were recorded
    const events = getCallEvents(session.id);
    expect(
      events.some((e) => e.eventType === "inbound_acl_name_captured"),
    ).toBe(true);

    // Session should be in waiting_on_user status
    const updated = getCallSession(session.id);
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("waiting_on_user");

    relay.destroy();
  });

  test("name capture flow: DTMF input is ignored during awaiting_name state", async () => {
    ensureConversation("conv-name-dtmf-ignore");
    const session = createCallSession({
      conversationId: "conv-name-dtmf-ignore",
      provider: "twilio",
      fromNumber: "+15558883333",
      toNumber: "+15551111111",
    });

    const { ws, relay } = createMockWs(session.id);

    await relay.handleMessage(
      JSON.stringify({
        type: "setup",
        callSid: "CA_name_dtmf_ignore",
        from: "+15558883333",
        to: "+15551111111",
      }),
    );

    expect(relay.getConnectionState()).toBe("awaiting_name");
    const msgCountBefore = ws.sentMessages.length;

    // DTMF should be ignored during name capture
    await relay.handleMessage(JSON.stringify({ type: "dtmf", digit: "5" }));

    // No new messages should be sent (DTMF is ignored)
    expect(ws.sentMessages.length).toBe(msgCountBefore);
    expect(relay.getConnectionState()).toBe("awaiting_name");

    relay.destroy();
  });

  test("name capture flow: voice prompts during guardian wait get reassurance response", async () => {
    ensureConversation("conv-wait-prompt-reassure");
    const session = createCallSession({
      conversationId: "conv-wait-prompt-reassure",
      provider: "twilio",
      fromNumber: "+15558882222",
      toNumber: "+15551111111",
    });

    const { ws, relay } = createMockWs(session.id);

    await relay.handleMessage(
      JSON.stringify({
        type: "setup",
        callSid: "CA_wait_prompt_reassure",
        from: "+15558882222",
        to: "+15551111111",
      }),
    );

    // Provide name to enter guardian decision wait
    await relay.handleMessage(
      JSON.stringify({
        type: "prompt",
        voicePrompt: "Jane Doe",
        lang: "en-US",
        last: true,
      }),
    );

    expect(relay.getConnectionState()).toBe("awaiting_guardian_decision");
    const msgCountBefore = ws.sentMessages.length;

    // Voice prompts during guardian wait should get a reassurance reply
    await relay.handleMessage(
      JSON.stringify({
        type: "prompt",
        voicePrompt: "Are you still there?",
        lang: "en-US",
        last: true,
      }),
    );

    // A reassurance message should have been sent
    const newMessages = ws.sentMessages.slice(msgCountBefore);
    const textMessages = newMessages
      .map((raw) => JSON.parse(raw) as { type: string; token?: string })
      .filter((m) => m.type === "text");
    expect(textMessages.length).toBeGreaterThan(0);
    expect(
      textMessages.some((m) => (m.token ?? "").includes("still here")),
    ).toBe(true);
    expect(relay.getConnectionState()).toBe("awaiting_guardian_decision");

    relay.destroy();
  });

  test("blocked caller gets immediate denial even with name capture flow", async () => {
    ensureConversation("conv-blocked-deny");
    const session = createCallSession({
      conversationId: "conv-blocked-deny",
      provider: "twilio",
      fromNumber: "+15558881111",
      toNumber: "+15551111111",
    });

    // Create a blocked member
    upsertContactChannel({
      sourceChannel: "phone",
      externalUserId: "+15558881111",
      externalChatId: "+15558881111",
      status: "blocked",
      policy: "allow",
    });

    const { ws, relay } = createMockWs(session.id);

    await relay.handleMessage(
      JSON.stringify({
        type: "setup",
        callSid: "CA_blocked_deny",
        from: "+15558881111",
        to: "+15551111111",
      }),
    );

    // Blocked callers should NOT enter name capture — they get immediate denial
    expect(relay.getConnectionState()).toBe("disconnecting");

    const updated = getCallSession(session.id);
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("failed");

    const textMessages = ws.sentMessages
      .map((raw) => JSON.parse(raw) as { type: string; token?: string })
      .filter((m) => m.type === "text");
    expect(
      textMessages.some((m) => (m.token ?? "").includes("not authorized")),
    ).toBe(true);

    // Let delayed endSession callback flush
    await new Promise((resolve) => setTimeout(resolve, 10));

    relay.destroy();
  });

  test("name capture flow: access request creates canonical request for guardian", async () => {
    ensureConversation("conv-access-req-canonical");
    const session = createCallSession({
      conversationId: "conv-access-req-canonical",
      provider: "twilio",
      fromNumber: "+15557770001",
      toNumber: "+15551111111",
    });

    const { relay } = createMockWs(session.id);

    await relay.handleMessage(
      JSON.stringify({
        type: "setup",
        callSid: "CA_access_req_canonical",
        from: "+15557770001",
        to: "+15551111111",
      }),
    );

    expect(relay.getConnectionState()).toBe("awaiting_name");

    // Provide name
    await relay.handleMessage(
      JSON.stringify({
        type: "prompt",
        voicePrompt: "Sarah Connor",
        lang: "en-US",
        last: true,
      }),
    );

    expect(relay.getConnectionState()).toBe("awaiting_guardian_decision");

    // A canonical access request should have been created
    const pending = listCanonicalGuardianRequests({
      status: "pending",
      requesterExternalUserId: "+15557770001",
      sourceChannel: "phone",
      kind: "access_request",
    });
    expect(pending.length).toBe(1);
    expect(pending[0].requesterExternalUserId).toBe("+15557770001");

    relay.destroy();
  });

  test("name capture flow: approved access request activates caller with deterministic handoff copy", async () => {
    ensureConversation("conv-access-approved");
    const session = createCallSession({
      conversationId: "conv-access-approved",
      provider: "twilio",
      fromNumber: "+15557770002",
      toNumber: "+15551111111",
    });

    // Track provider calls to verify no LLM turn is triggered on approval
    const providerCallCountBefore = mockSendMessage.mock.calls.length;

    const { ws, relay } = createMockWs(session.id);

    await relay.handleMessage(
      JSON.stringify({
        type: "setup",
        callSid: "CA_access_approved",
        from: "+15557770002",
        to: "+15551111111",
      }),
    );

    // Provide name to enter wait state
    await relay.handleMessage(
      JSON.stringify({
        type: "prompt",
        voicePrompt: "Bob Smith",
        lang: "en-US",
        last: true,
      }),
    );

    expect(relay.getConnectionState()).toBe("awaiting_guardian_decision");

    // Find the canonical request and simulate guardian approval
    const pending = listCanonicalGuardianRequests({
      status: "pending",
      requesterExternalUserId: "+15557770002",
      sourceChannel: "phone",
      kind: "access_request",
    });
    expect(pending.length).toBe(1);

    // Resolve the request to approved status
    resolveCanonicalGuardianRequest(pending[0].id, "pending", {
      status: "approved",
      answerText: undefined,
      decidedByExternalUserId: undefined,
    });

    // Wait for the poll interval to detect the approval
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Should have transitioned to connected state
    expect(relay.getConnectionState()).toBe("connected");

    // Verify deterministic handoff copy was sent (not an LLM-generated response)
    const textMessages = ws.sentMessages
      .map((raw) => JSON.parse(raw) as { type: string; token?: string })
      .filter((m) => m.type === "text");
    expect(
      textMessages.some((m) =>
        (m.token ?? "").includes("said I can speak with you. How can I help?"),
      ),
    ).toBe(true);

    // Verify no provider (LLM) call was made as part of the approval handoff
    expect(mockSendMessage.mock.calls.length).toBe(providerCallCountBefore);

    // Verify events — including assistant_spoke for transcript parity
    const events = getCallEvents(session.id);
    expect(
      events.some((e) => e.eventType === "inbound_acl_access_approved"),
    ).toBe(true);
    expect(events.some((e) => e.eventType === "assistant_spoke")).toBe(true);
    expect(
      events.some(
        (e) => e.eventType === "inbound_acl_post_approval_handoff_spoken",
      ),
    ).toBe(true);

    // Session should be in_progress
    const updated = getCallSession(session.id);
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("in_progress");

    relay.destroy();
  });

  test("name capture flow: denied access request ends call with deterministic copy", async () => {
    ensureConversation("conv-access-denied");
    const session = createCallSession({
      conversationId: "conv-access-denied",
      provider: "twilio",
      fromNumber: "+15557770003",
      toNumber: "+15551111111",
    });

    const { ws, relay } = createMockWs(session.id);

    await relay.handleMessage(
      JSON.stringify({
        type: "setup",
        callSid: "CA_access_denied",
        from: "+15557770003",
        to: "+15551111111",
      }),
    );

    // Provide name
    await relay.handleMessage(
      JSON.stringify({
        type: "prompt",
        voicePrompt: "Eve",
        lang: "en-US",
        last: true,
      }),
    );

    expect(relay.getConnectionState()).toBe("awaiting_guardian_decision");

    // Simulate guardian denial
    const pending = listCanonicalGuardianRequests({
      status: "pending",
      requesterExternalUserId: "+15557770003",
      sourceChannel: "phone",
      kind: "access_request",
    });
    expect(pending.length).toBe(1);

    resolveCanonicalGuardianRequest(pending[0].id, "pending", {
      status: "denied",
      answerText: undefined,
      decidedByExternalUserId: undefined,
    });

    // Wait for poll to detect the denial
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Should be disconnecting
    expect(relay.getConnectionState()).toBe("disconnecting");

    // Should have sent the denial message
    const textMessages = ws.sentMessages
      .map((raw) => JSON.parse(raw) as { type: string; token?: string })
      .filter((m) => m.type === "text");
    expect(
      textMessages.some((m) =>
        (m.token ?? "").includes("says I'm not allowed"),
      ),
    ).toBe(true);

    // Session should be failed
    const updated = getCallSession(session.id);
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("failed");

    // Verify event
    const events = getCallEvents(session.id);
    expect(
      events.some((e) => e.eventType === "inbound_acl_access_denied"),
    ).toBe(true);

    // Let the delayed endSession callback flush
    await new Promise((resolve) => setTimeout(resolve, 10));

    relay.destroy();
  });

  test("name capture flow: timeout ends call with deterministic copy", async () => {
    // Override the consultation timeout to a very short value for testing
    mockConfig.calls.userConsultTimeoutSeconds = 2; // 2 seconds

    ensureConversation("conv-access-timeout");
    const session = createCallSession({
      conversationId: "conv-access-timeout",
      provider: "twilio",
      fromNumber: "+15557770004",
      toNumber: "+15551111111",
    });

    const { ws, relay } = createMockWs(session.id);

    await relay.handleMessage(
      JSON.stringify({
        type: "setup",
        callSid: "CA_access_timeout",
        from: "+15557770004",
        to: "+15551111111",
      }),
    );

    jest.useFakeTimers();
    try {
      // Provide name
      await relay.handleMessage(
        JSON.stringify({
          type: "prompt",
          voicePrompt: "Timeout Tester",
          lang: "en-US",
          last: true,
        }),
      );

      expect(relay.getConnectionState()).toBe("awaiting_guardian_decision");

      // Advance past the 2s timeout + endSession delay
      jest.advanceTimersByTime(2500);
    } finally {
      jest.useRealTimers();
    }

    // Let async fire-and-forget work settle
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Should be disconnecting after timeout
    expect(relay.getConnectionState()).toBe("disconnecting");

    // Should have sent the timeout message
    const textMessages = ws.sentMessages
      .map((raw) => JSON.parse(raw) as { type: string; token?: string })
      .filter((m) => m.type === "text");
    expect(
      textMessages.some((m) => (m.token ?? "").includes("can't get ahold of")),
    ).toBe(true);
    expect(
      textMessages.some((m) =>
        (m.token ?? "").includes("let them know you called"),
      ),
    ).toBe(true);

    // Session should be failed
    const updated = getCallSession(session.id);
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("failed");

    // Verify event
    const events = getCallEvents(session.id);
    expect(
      events.some((e) => e.eventType === "inbound_acl_access_timeout"),
    ).toBe(true);

    // Restore default timeout
    mockConfig.calls.userConsultTimeoutSeconds = 120;

    relay.destroy();
  });

  test("name capture flow: transport close during guardian wait cleans up timers", async () => {
    ensureConversation("conv-access-transport-close");
    const session = createCallSession({
      conversationId: "conv-access-transport-close",
      provider: "twilio",
      fromNumber: "+15557770005",
      toNumber: "+15551111111",
    });

    const { relay } = createMockWs(session.id);

    await relay.handleMessage(
      JSON.stringify({
        type: "setup",
        callSid: "CA_access_transport_close",
        from: "+15557770005",
        to: "+15551111111",
      }),
    );

    // Provide name
    await relay.handleMessage(
      JSON.stringify({
        type: "prompt",
        voicePrompt: "Disconnector",
        lang: "en-US",
        last: true,
      }),
    );

    expect(relay.getConnectionState()).toBe("awaiting_guardian_decision");

    // Simulate transport close while waiting for guardian
    relay.handleTransportClosed(1000, "caller hung up");

    // Session should be completed (normal close)
    const updated = getCallSession(session.id);
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("completed");

    relay.destroy();
  });

  // ── Guardian wait heartbeat and impatience handling ──────────────────

  test("guardian wait: heartbeat timer emits periodic updates", async () => {
    ensureConversation("conv-heartbeat-basic");
    const session = createCallSession({
      conversationId: "conv-heartbeat-basic",
      provider: "twilio",
      fromNumber: "+15557770010",
      toNumber: "+15551111111",
    });

    const { ws, relay } = createMockWs(session.id);

    await relay.handleMessage(
      JSON.stringify({
        type: "setup",
        callSid: "CA_heartbeat_basic",
        from: "+15557770010",
        to: "+15551111111",
      }),
    );

    // Provide name to enter guardian wait
    await relay.handleMessage(
      JSON.stringify({
        type: "prompt",
        voicePrompt: "Heartbeat Tester",
        lang: "en-US",
        last: true,
      }),
    );

    expect(relay.getConnectionState()).toBe("awaiting_guardian_decision");
    const msgCountAfterHold = ws.sentMessages.length;

    // Wait for at least one heartbeat (initial interval is 100ms in test config)
    await new Promise((resolve) => setTimeout(resolve, 250));

    const newMessages = ws.sentMessages.slice(msgCountAfterHold);
    const textMessages = newMessages
      .map((raw) => JSON.parse(raw) as { type: string; token?: string })
      .filter((m) => m.type === "text");
    expect(textMessages.length).toBeGreaterThan(0);
    // Heartbeat messages mention "waiting" or "guardian"
    expect(
      textMessages.some((m) =>
        (m.token ?? "").toLowerCase().includes("waiting"),
      ),
    ).toBe(true);

    // Verify heartbeat event was recorded
    const events = getCallEvents(session.id);
    expect(
      events.some((e) => e.eventType === "voice_guardian_wait_heartbeat_sent"),
    ).toBe(true);

    relay.destroy();
  });

  test("guardian wait: heartbeat stops on approval", async () => {
    ensureConversation("conv-heartbeat-stop-approve");
    const session = createCallSession({
      conversationId: "conv-heartbeat-stop-approve",
      provider: "twilio",
      fromNumber: "+15557770011",
      toNumber: "+15551111111",
    });

    mockSendMessage.mockImplementation(
      createMockProviderResponse(["Welcome!"]),
    );

    const { ws, relay } = createMockWs(session.id);

    await relay.handleMessage(
      JSON.stringify({
        type: "setup",
        callSid: "CA_heartbeat_stop_approve",
        from: "+15557770011",
        to: "+15551111111",
      }),
    );

    await relay.handleMessage(
      JSON.stringify({
        type: "prompt",
        voicePrompt: "Approve Tester",
        lang: "en-US",
        last: true,
      }),
    );

    expect(relay.getConnectionState()).toBe("awaiting_guardian_decision");

    // Approve the request
    const pending = listCanonicalGuardianRequests({
      status: "pending",
      requesterExternalUserId: "+15557770011",
      sourceChannel: "phone",
      kind: "access_request",
    });
    expect(pending.length).toBe(1);

    resolveCanonicalGuardianRequest(pending[0].id, "pending", {
      status: "approved",
      answerText: undefined,
      decidedByExternalUserId: undefined,
    });

    await new Promise((resolve) => setTimeout(resolve, 200));

    // Connection should have transitioned
    expect(relay.getConnectionState()).toBe("connected");

    // Record message count after approval
    const msgCountAfterApproval = ws.sentMessages.length;

    // Wait and verify no more heartbeats
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(ws.sentMessages.length).toBe(msgCountAfterApproval);

    relay.destroy();
  });

  test("guardian wait: heartbeat stops on destroy", async () => {
    ensureConversation("conv-heartbeat-stop-destroy");
    const session = createCallSession({
      conversationId: "conv-heartbeat-stop-destroy",
      provider: "twilio",
      fromNumber: "+15557770012",
      toNumber: "+15551111111",
    });

    const { relay } = createMockWs(session.id);

    await relay.handleMessage(
      JSON.stringify({
        type: "setup",
        callSid: "CA_heartbeat_stop_destroy",
        from: "+15557770012",
        to: "+15551111111",
      }),
    );

    await relay.handleMessage(
      JSON.stringify({
        type: "prompt",
        voicePrompt: "Destroy Tester",
        lang: "en-US",
        last: true,
      }),
    );

    expect(relay.getConnectionState()).toBe("awaiting_guardian_decision");

    // Destroy should not throw and should clean up timers
    expect(() => relay.destroy()).not.toThrow();
  });

  test("guardian wait: impatience utterance triggers callback offer", async () => {
    ensureConversation("conv-impatience-offer");
    const session = createCallSession({
      conversationId: "conv-impatience-offer",
      provider: "twilio",
      fromNumber: "+15557770013",
      toNumber: "+15551111111",
    });

    const { ws, relay } = createMockWs(session.id);

    await relay.handleMessage(
      JSON.stringify({
        type: "setup",
        callSid: "CA_impatience_offer",
        from: "+15557770013",
        to: "+15551111111",
      }),
    );

    await relay.handleMessage(
      JSON.stringify({
        type: "prompt",
        voicePrompt: "Impatient Tester",
        lang: "en-US",
        last: true,
      }),
    );

    expect(relay.getConnectionState()).toBe("awaiting_guardian_decision");
    const msgCountBefore = ws.sentMessages.length;

    // Send an impatient utterance
    await relay.handleMessage(
      JSON.stringify({
        type: "prompt",
        voicePrompt: "This is taking too long!",
        lang: "en-US",
        last: true,
      }),
    );

    const newMessages = ws.sentMessages.slice(msgCountBefore);
    const textMessages = newMessages
      .map((raw) => JSON.parse(raw) as { type: string; token?: string })
      .filter((m) => m.type === "text");
    expect(textMessages.length).toBeGreaterThan(0);
    // Should offer callback
    expect(
      textMessages.some((m) =>
        (m.token ?? "").toLowerCase().includes("call you back"),
      ),
    ).toBe(true);

    // Verify event
    const events = getCallEvents(session.id);
    expect(
      events.some(
        (e) => e.eventType === "voice_guardian_wait_callback_offer_sent",
      ),
    ).toBe(true);
    expect(
      events.some(
        (e) => e.eventType === "voice_guardian_wait_prompt_classified",
      ),
    ).toBe(true);

    relay.destroy();
  });

  test("guardian wait: explicit callback opt-in after offer is acknowledged", async () => {
    ensureConversation("conv-callback-optin");
    const session = createCallSession({
      conversationId: "conv-callback-optin",
      provider: "twilio",
      fromNumber: "+15557770014",
      toNumber: "+15551111111",
    });

    const { ws, relay } = createMockWs(session.id);

    await relay.handleMessage(
      JSON.stringify({
        type: "setup",
        callSid: "CA_callback_optin",
        from: "+15557770014",
        to: "+15551111111",
      }),
    );

    jest.useFakeTimers();
    try {
      await relay.handleMessage(
        JSON.stringify({
          type: "prompt",
          voicePrompt: "OptIn Tester",
          lang: "en-US",
          last: true,
        }),
      );

      expect(relay.getConnectionState()).toBe("awaiting_guardian_decision");

      // Trigger impatience to get callback offer
      await relay.handleMessage(
        JSON.stringify({
          type: "prompt",
          voicePrompt: "Hurry up please",
          lang: "en-US",
          last: true,
        }),
      );

      // Advance past the 3s cooldown
      jest.advanceTimersByTime(3200);
    } finally {
      jest.useRealTimers();
    }

    const msgCountBeforeOptIn = ws.sentMessages.length;

    // Accept the callback offer
    await relay.handleMessage(
      JSON.stringify({
        type: "prompt",
        voicePrompt: "Yes, please call me back",
        lang: "en-US",
        last: true,
      }),
    );

    const newMessages = ws.sentMessages.slice(msgCountBeforeOptIn);
    const textMessages = newMessages
      .map((raw) => JSON.parse(raw) as { type: string; token?: string })
      .filter((m) => m.type === "text");
    expect(textMessages.length).toBeGreaterThan(0);
    // Should acknowledge the callback opt-in
    expect(
      textMessages.some((m) => (m.token ?? "").toLowerCase().includes("noted")),
    ).toBe(true);

    // Verify events
    const events = getCallEvents(session.id);
    expect(
      events.some(
        (e) => e.eventType === "voice_guardian_wait_callback_opt_in_set",
      ),
    ).toBe(true);

    // Connection should still be in guardian wait (callback not auto-dispatched)
    expect(relay.getConnectionState()).toBe("awaiting_guardian_decision");

    relay.destroy();
  });

  test("guardian wait: neutral utterance gets acknowledgment", async () => {
    ensureConversation("conv-wait-neutral");
    const session = createCallSession({
      conversationId: "conv-wait-neutral",
      provider: "twilio",
      fromNumber: "+15557770015",
      toNumber: "+15551111111",
    });

    const { ws, relay } = createMockWs(session.id);

    await relay.handleMessage(
      JSON.stringify({
        type: "setup",
        callSid: "CA_wait_neutral",
        from: "+15557770015",
        to: "+15551111111",
      }),
    );

    await relay.handleMessage(
      JSON.stringify({
        type: "prompt",
        voicePrompt: "Neutral Tester",
        lang: "en-US",
        last: true,
      }),
    );

    expect(relay.getConnectionState()).toBe("awaiting_guardian_decision");
    const msgCountBefore = ws.sentMessages.length;

    // Send a neutral utterance
    await relay.handleMessage(
      JSON.stringify({
        type: "prompt",
        voicePrompt: "I just wanted to say thanks",
        lang: "en-US",
        last: true,
      }),
    );

    const newMessages = ws.sentMessages.slice(msgCountBefore);
    const textMessages = newMessages
      .map((raw) => JSON.parse(raw) as { type: string; token?: string })
      .filter((m) => m.type === "text");
    expect(textMessages.length).toBeGreaterThan(0);
    // Should get an acknowledgment
    expect(
      textMessages.some((m) =>
        (m.token ?? "").toLowerCase().includes("waiting"),
      ),
    ).toBe(true);

    relay.destroy();
  });

  test("guardian wait: empty utterance is ignored without response", async () => {
    ensureConversation("conv-wait-empty");
    const session = createCallSession({
      conversationId: "conv-wait-empty",
      provider: "twilio",
      fromNumber: "+15557770016",
      toNumber: "+15551111111",
    });

    const { ws, relay } = createMockWs(session.id);

    await relay.handleMessage(
      JSON.stringify({
        type: "setup",
        callSid: "CA_wait_empty",
        from: "+15557770016",
        to: "+15551111111",
      }),
    );

    await relay.handleMessage(
      JSON.stringify({
        type: "prompt",
        voicePrompt: "Empty Tester",
        lang: "en-US",
        last: true,
      }),
    );

    expect(relay.getConnectionState()).toBe("awaiting_guardian_decision");
    const msgCountBefore = ws.sentMessages.length;

    // Send an empty utterance
    await relay.handleMessage(
      JSON.stringify({
        type: "prompt",
        voicePrompt: "   ",
        lang: "en-US",
        last: true,
      }),
    );

    // No new messages should be sent
    expect(ws.sentMessages.length).toBe(msgCountBefore);

    relay.destroy();
  });

  test("guardian wait: cooldown prevents rapid-fire responses", async () => {
    ensureConversation("conv-wait-cooldown");
    const session = createCallSession({
      conversationId: "conv-wait-cooldown",
      provider: "twilio",
      fromNumber: "+15557770017",
      toNumber: "+15551111111",
    });

    const { ws, relay } = createMockWs(session.id);

    await relay.handleMessage(
      JSON.stringify({
        type: "setup",
        callSid: "CA_wait_cooldown",
        from: "+15557770017",
        to: "+15551111111",
      }),
    );

    await relay.handleMessage(
      JSON.stringify({
        type: "prompt",
        voicePrompt: "Cooldown Tester",
        lang: "en-US",
        last: true,
      }),
    );

    expect(relay.getConnectionState()).toBe("awaiting_guardian_decision");

    // First utterance should get a response
    await relay.handleMessage(
      JSON.stringify({
        type: "prompt",
        voicePrompt: "Hello?",
        lang: "en-US",
        last: true,
      }),
    );

    const msgCountAfterFirst = ws.sentMessages.length;

    // Immediate second utterance should be suppressed by cooldown
    await relay.handleMessage(
      JSON.stringify({
        type: "prompt",
        voicePrompt: "Hello again?",
        lang: "en-US",
        last: true,
      }),
    );

    // No new messages due to cooldown
    expect(ws.sentMessages.length).toBe(msgCountAfterFirst);

    relay.destroy();
  });

  // ── Callback handoff notification tests ────────────────────────────

  test("callback opt-in + access timeout -> emits callback handoff notification exactly once", async () => {
    mockConfig.calls.userConsultTimeoutSeconds = 2;

    ensureConversation("conv-cb-handoff-timeout");
    const session = createCallSession({
      conversationId: "conv-cb-handoff-timeout",
      provider: "twilio",
      fromNumber: "+15557770020",
      toNumber: "+15551111111",
    });

    const { ws, relay } = createMockWs(session.id);

    await relay.handleMessage(
      JSON.stringify({
        type: "setup",
        callSid: "CA_cb_handoff_timeout",
        from: "+15557770020",
        to: "+15551111111",
      }),
    );

    jest.useFakeTimers();
    try {
      // Provide name to enter guardian wait
      await relay.handleMessage(
        JSON.stringify({
          type: "prompt",
          voicePrompt: "Callback Tester",
          lang: "en-US",
          last: true,
        }),
      );

      expect(relay.getConnectionState()).toBe("awaiting_guardian_decision");

      // Trigger impatience to get callback offer
      await relay.handleMessage(
        JSON.stringify({
          type: "prompt",
          voicePrompt: "Hurry up please",
          lang: "en-US",
          last: true,
        }),
      );

      // Accept callback offer (callback decisions bypass cooldown)
      await relay.handleMessage(
        JSON.stringify({
          type: "prompt",
          voicePrompt: "Yes, please call me back",
          lang: "en-US",
          last: true,
        }),
      );

      // Verify callback opt-in was set
      const eventsBeforeTimeout = getCallEvents(session.id);
      expect(
        eventsBeforeTimeout.some(
          (e) => e.eventType === "voice_guardian_wait_callback_opt_in_set",
        ),
      ).toBe(true);

      // Advance past the 2s timeout + endSession delay
      jest.advanceTimersByTime(2500);
    } finally {
      jest.useRealTimers();
    }

    // Let async notification emission settle
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(relay.getConnectionState()).toBe("disconnecting");

    const events = getCallEvents(session.id);
    // Should have exactly one callback_handoff_notified event (or callback_handoff_failed
    // if the notification pipeline isn't fully wired in tests — either proves emission)
    const handoffEvents = events.filter(
      (e) =>
        e.eventType === "callback_handoff_notified" ||
        e.eventType === "callback_handoff_failed",
    );
    expect(handoffEvents.length).toBe(1);

    // Verify the timeout event was also recorded
    expect(
      events.some((e) => e.eventType === "inbound_acl_access_timeout"),
    ).toBe(true);

    // Timeout copy should include callback note
    const textMessages = ws.sentMessages
      .map((raw) => JSON.parse(raw) as { type: string; token?: string })
      .filter((m) => m.type === "text");
    expect(textMessages.some((m) => (m.token ?? "").includes("callback"))).toBe(
      true,
    );

    mockConfig.calls.userConsultTimeoutSeconds = 120;
    relay.destroy();
  });

  test("no callback opt-in + access timeout -> no callback handoff notification", async () => {
    mockConfig.calls.userConsultTimeoutSeconds = 2;

    ensureConversation("conv-no-cb-handoff");
    const session = createCallSession({
      conversationId: "conv-no-cb-handoff",
      provider: "twilio",
      fromNumber: "+15557770021",
      toNumber: "+15551111111",
    });

    const { relay } = createMockWs(session.id);

    await relay.handleMessage(
      JSON.stringify({
        type: "setup",
        callSid: "CA_no_cb_handoff",
        from: "+15557770021",
        to: "+15551111111",
      }),
    );

    jest.useFakeTimers();
    try {
      await relay.handleMessage(
        JSON.stringify({
          type: "prompt",
          voicePrompt: "No Callback Tester",
          lang: "en-US",
          last: true,
        }),
      );

      expect(relay.getConnectionState()).toBe("awaiting_guardian_decision");

      // Advance past the 2s timeout + endSession delay
      jest.advanceTimersByTime(2500);
    } finally {
      jest.useRealTimers();
    }

    // Let async work settle
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(relay.getConnectionState()).toBe("disconnecting");

    const events = getCallEvents(session.id);
    // Should NOT have callback handoff events
    const handoffEvents = events.filter(
      (e) =>
        e.eventType === "callback_handoff_notified" ||
        e.eventType === "callback_handoff_failed",
    );
    expect(handoffEvents.length).toBe(0);

    mockConfig.calls.userConsultTimeoutSeconds = 120;
    relay.destroy();
  });

  test("callback opt-in + transport close during guardian wait -> emits callback handoff notification", async () => {
    ensureConversation("conv-cb-handoff-transport");
    const session = createCallSession({
      conversationId: "conv-cb-handoff-transport",
      provider: "twilio",
      fromNumber: "+15557770022",
      toNumber: "+15551111111",
    });

    const { relay } = createMockWs(session.id);

    await relay.handleMessage(
      JSON.stringify({
        type: "setup",
        callSid: "CA_cb_handoff_transport",
        from: "+15557770022",
        to: "+15551111111",
      }),
    );

    await relay.handleMessage(
      JSON.stringify({
        type: "prompt",
        voicePrompt: "Transport Close Tester",
        lang: "en-US",
        last: true,
      }),
    );

    expect(relay.getConnectionState()).toBe("awaiting_guardian_decision");

    // Trigger callback offer and opt-in (callback decisions bypass cooldown)
    await relay.handleMessage(
      JSON.stringify({
        type: "prompt",
        voicePrompt: "Hurry up please",
        lang: "en-US",
        last: true,
      }),
    );

    await relay.handleMessage(
      JSON.stringify({
        type: "prompt",
        voicePrompt: "Yes, call me back please",
        lang: "en-US",
        last: true,
      }),
    );

    // Simulate transport close while still in guardian wait
    relay.handleTransportClosed(1001, "Going away");

    await new Promise((resolve) => setTimeout(resolve, 200));

    const events = getCallEvents(session.id);
    const handoffEvents = events.filter(
      (e) =>
        e.eventType === "callback_handoff_notified" ||
        e.eventType === "callback_handoff_failed",
    );
    expect(handoffEvents.length).toBe(1);

    relay.destroy();
  });

  test("timeout then transport-close race -> still emits only one handoff notification", async () => {
    mockConfig.calls.userConsultTimeoutSeconds = 2;

    ensureConversation("conv-cb-handoff-race");
    const session = createCallSession({
      conversationId: "conv-cb-handoff-race",
      provider: "twilio",
      fromNumber: "+15557770023",
      toNumber: "+15551111111",
    });

    const { relay } = createMockWs(session.id);

    await relay.handleMessage(
      JSON.stringify({
        type: "setup",
        callSid: "CA_cb_handoff_race",
        from: "+15557770023",
        to: "+15551111111",
      }),
    );

    jest.useFakeTimers();
    try {
      await relay.handleMessage(
        JSON.stringify({
          type: "prompt",
          voicePrompt: "Race Tester",
          lang: "en-US",
          last: true,
        }),
      );

      // Opt into callback (callback decisions bypass cooldown)
      await relay.handleMessage(
        JSON.stringify({
          type: "prompt",
          voicePrompt: "Hurry up please",
          lang: "en-US",
          last: true,
        }),
      );

      await relay.handleMessage(
        JSON.stringify({
          type: "prompt",
          voicePrompt: "Yes call me back",
          lang: "en-US",
          last: true,
        }),
      );

      // Advance past the 2s timeout
      jest.advanceTimersByTime(2500);
    } finally {
      jest.useRealTimers();
    }

    // Now transport close too (simulating race)
    relay.handleTransportClosed(1000, "Normal closure");

    // Let async work settle
    await new Promise((resolve) => setTimeout(resolve, 10));

    const events = getCallEvents(session.id);
    // Guard should ensure only ONE handoff event
    const handoffEvents = events.filter(
      (e) =>
        e.eventType === "callback_handoff_notified" ||
        e.eventType === "callback_handoff_failed",
    );
    expect(handoffEvents.length).toBe(1);

    mockConfig.calls.userConsultTimeoutSeconds = 120;
    relay.destroy();
  });

  test("callback handoff payload includes requesterMemberId when voice caller maps to existing member", async () => {
    mockConfig.calls.userConsultTimeoutSeconds = 2;

    ensureConversation("conv-cb-handoff-member");
    const session = createCallSession({
      conversationId: "conv-cb-handoff-member",
      provider: "twilio",
      fromNumber: "+15557770024",
      toNumber: "+15551111111",
    });

    const { relay } = createMockWs(session.id);

    await relay.handleMessage(
      JSON.stringify({
        type: "setup",
        callSid: "CA_cb_handoff_member",
        from: "+15557770024",
        to: "+15551111111",
      }),
    );

    jest.useFakeTimers();
    try {
      await relay.handleMessage(
        JSON.stringify({
          type: "prompt",
          voicePrompt: "Member Tester",
          lang: "en-US",
          last: true,
        }),
      );

      expect(relay.getConnectionState()).toBe("awaiting_guardian_decision");

      // Add the caller as a trusted contact AFTER the access request flow
      // is entered so resolveActorTrust doesn't skip the flow. The handoff
      // code uses findMember to resolve requesterMemberId at handoff time.
      addTrustedVoiceContact("+15557770024");

      // Opt into callback (callback decisions bypass cooldown)
      await relay.handleMessage(
        JSON.stringify({
          type: "prompt",
          voicePrompt: "Hurry up",
          lang: "en-US",
          last: true,
        }),
      );

      await relay.handleMessage(
        JSON.stringify({
          type: "prompt",
          voicePrompt: "Yes please call me back",
          lang: "en-US",
          last: true,
        }),
      );

      // Advance past the 2s timeout
      jest.advanceTimersByTime(2500);
    } finally {
      jest.useRealTimers();
    }

    // Let async work settle
    await new Promise((resolve) => setTimeout(resolve, 10));

    const events = getCallEvents(session.id);
    const handoffEvents = events.filter(
      (e) =>
        e.eventType === "callback_handoff_notified" ||
        e.eventType === "callback_handoff_failed",
    );
    expect(handoffEvents.length).toBe(1);

    // Parse the payload to verify requesterMemberId is present
    const handoffEvent = handoffEvents[0];
    const payload = JSON.parse(handoffEvent.payloadJson) as Record<
      string,
      unknown
    >;
    // The member was added, so requesterMemberId should be populated
    expect(payload.requesterMemberId).toBeDefined();
    expect(typeof payload.requesterMemberId).toBe("string");

    mockConfig.calls.userConsultTimeoutSeconds = 120;
    relay.destroy();
  });

  test("callback handoff payload omits member reference when no member record exists", async () => {
    mockConfig.calls.userConsultTimeoutSeconds = 2;

    ensureConversation("conv-cb-handoff-no-member");
    const session = createCallSession({
      conversationId: "conv-cb-handoff-no-member",
      provider: "twilio",
      fromNumber: "+15557770025",
      toNumber: "+15551111111",
    });

    // Do NOT add caller as trusted contact

    const { relay } = createMockWs(session.id);

    await relay.handleMessage(
      JSON.stringify({
        type: "setup",
        callSid: "CA_cb_handoff_no_member",
        from: "+15557770025",
        to: "+15551111111",
      }),
    );

    jest.useFakeTimers();
    try {
      await relay.handleMessage(
        JSON.stringify({
          type: "prompt",
          voicePrompt: "No Member Tester",
          lang: "en-US",
          last: true,
        }),
      );

      expect(relay.getConnectionState()).toBe("awaiting_guardian_decision");

      // Opt into callback (callback decisions bypass cooldown)
      await relay.handleMessage(
        JSON.stringify({
          type: "prompt",
          voicePrompt: "Come on hurry up",
          lang: "en-US",
          last: true,
        }),
      );

      await relay.handleMessage(
        JSON.stringify({
          type: "prompt",
          voicePrompt: "Yes callback please",
          lang: "en-US",
          last: true,
        }),
      );

      // Advance past the 2s timeout
      jest.advanceTimersByTime(2500);
    } finally {
      jest.useRealTimers();
    }

    // Let async work settle
    await new Promise((resolve) => setTimeout(resolve, 10));

    const events = getCallEvents(session.id);
    const handoffEvents = events.filter(
      (e) =>
        e.eventType === "callback_handoff_notified" ||
        e.eventType === "callback_handoff_failed",
    );
    expect(handoffEvents.length).toBe(1);

    // Parse the payload to verify requesterMemberId is null
    const handoffEvent = handoffEvents[0];
    const payload = JSON.parse(handoffEvent.payloadJson) as Record<
      string,
      unknown
    >;
    expect(payload.requesterMemberId).toBeNull();

    mockConfig.calls.userConsultTimeoutSeconds = 120;
    relay.destroy();
  });

  // ── Pointer message regression tests for non-guardian paths ───────

  test("normal relay close (1000) writes completed pointer to origin conversation", async () => {
    ensureConversation("conv-relay-ptr-complete");
    ensureConversation("conv-relay-ptr-complete-origin");
    const session = createCallSession({
      conversationId: "conv-relay-ptr-complete",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15559876543",
      initiatedFromConversationId: "conv-relay-ptr-complete-origin",
    });
    updateCallSession(session.id, {
      status: "in_progress",
      startedAt: Date.now() - 30_000,
    });

    const { relay } = createMockWs(session.id);

    await relay.handleMessage(
      JSON.stringify({
        type: "setup",
        callSid: "CA_relay_ptr_complete",
        from: "+15551111111",
        to: "+15559876543",
        customParameters: {},
      }),
    );

    relay.handleTransportClosed(1000, "normal");
    await new Promise((r) => setTimeout(r, 100));

    const text = getLatestAssistantText("conv-relay-ptr-complete-origin");
    expect(text).not.toBeNull();
    expect(text!).toContain("+15559876543");
    expect(text!).toContain("completed");

    relay.destroy();
  });

  test("abnormal relay close writes failed pointer to origin conversation", async () => {
    ensureConversation("conv-relay-ptr-fail");
    ensureConversation("conv-relay-ptr-fail-origin");
    const session = createCallSession({
      conversationId: "conv-relay-ptr-fail",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15559876543",
      initiatedFromConversationId: "conv-relay-ptr-fail-origin",
    });
    updateCallSession(session.id, { status: "in_progress" });

    const { relay } = createMockWs(session.id);

    await relay.handleMessage(
      JSON.stringify({
        type: "setup",
        callSid: "CA_relay_ptr_fail",
        from: "+15551111111",
        to: "+15559876543",
        customParameters: {},
      }),
    );

    relay.handleTransportClosed(1006, "abnormal");
    await new Promise((r) => setTimeout(r, 100));

    const text = getLatestAssistantText("conv-relay-ptr-fail-origin");
    expect(text).not.toBeNull();
    expect(text!).toContain("+15559876543");
    expect(text!).toContain("failed");

    relay.destroy();
  });

  // ── Trusted-contact in-call continuation ─────────────────────────────

  test("inbound trusted-contact verification: DTMF code entry continues same call with handoff copy", async () => {
    ensureConversation("conv-tc-verify-continue");
    const session = createCallSession({
      conversationId: "conv-tc-verify-continue",
      provider: "twilio",
      fromNumber: "+15553334444",
      toNumber: "+15551111111",
    });

    // Create a trusted-contact verification challenge with status 'pending'
    // so getPendingSession finds it during inbound setup, and
    // verificationPurpose 'trusted_contact' so validateAndConsumeVerification
    // returns the correct verificationType.
    const tcSecret = "654321";
    createVerificationSession({
      id: randomUUID(),
      channel: "phone",
      challengeHash: createHash("sha256").update(tcSecret).digest("hex"),
      expiresAt: Date.now() + 10 * 60 * 1000,
      status: "pending",
      verificationPurpose: "trusted_contact",
    });
    const secret = tcSecret;

    mockSendMessage.mockImplementation(
      createMockProviderResponse(["Sure, I can help with that."]),
    );

    const { ws, relay } = createMockWs(session.id);

    await relay.handleMessage(
      JSON.stringify({
        type: "setup",
        callSid: "CA_tc_verify_continue",
        from: "+15553334444",
        to: "+15551111111",
      }),
    );

    // Should be in verification-pending state
    expect(relay.isVerificationSessionActive()).toBe(true);
    expect(relay.getConnectionState()).toBe("verification_pending");

    // Enter the correct code via DTMF
    for (const digit of secret) {
      await relay.handleMessage(JSON.stringify({ type: "dtmf", digit }));
    }

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Verification should have succeeded — call remains connected
    expect(relay.isVerificationSessionActive()).toBe(false);
    expect(relay.getConnectionState()).toBe("connected");

    // Deterministic handoff copy should have been sent (not a fresh greeting)
    const textMessages = ws.sentMessages
      .map((raw) => JSON.parse(raw) as { type: string; token?: string })
      .filter((m) => m.type === "text");
    expect(
      textMessages.some((m) =>
        (m.token ?? "").includes("said I can speak with you"),
      ),
    ).toBe(true);

    // No end message should have been sent — call stays alive
    const endMessages = ws.sentMessages
      .map((raw) => JSON.parse(raw) as { type: string })
      .filter((m) => m.type === "end");
    expect(endMessages.length).toBe(0);

    // assistant_spoke event should have been recorded for the handoff
    const events = getCallEvents(session.id);
    expect(events.some((e) => e.eventType === "assistant_spoke")).toBe(true);

    // Session should be in_progress (not completed/failed)
    const updated = getCallSession(session.id);
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("in_progress");

    relay.destroy();
  });

  test("inbound guardian verification (non-trusted-contact): still starts normal call flow", async () => {
    ensureConversation("conv-guardian-verify-normal");
    const session = createCallSession({
      conversationId: "conv-guardian-verify-normal",
      provider: "twilio",
      fromNumber: "+15552223333",
      toNumber: "+15551111111",
    });

    // Create a guardian challenge (default verificationPurpose = 'guardian')
    const secret = createPendingVoiceGuardianChallenge();

    mockSendMessage.mockImplementation(
      createMockProviderResponse(["Hello, how can I help you?"]),
    );

    const { ws, relay } = createMockWs(session.id);

    await relay.handleMessage(
      JSON.stringify({
        type: "setup",
        callSid: "CA_guardian_verify_normal",
        from: "+15552223333",
        to: "+15551111111",
      }),
    );

    expect(relay.isVerificationSessionActive()).toBe(true);

    // Enter the correct code
    for (const digit of secret) {
      await relay.handleMessage(JSON.stringify({ type: "dtmf", digit }));
    }

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Should have transitioned to connected with normal greeting (not handoff copy)
    expect(relay.isVerificationSessionActive()).toBe(false);
    expect(relay.getConnectionState()).toBe("connected");

    // Guardian binding is NOT created by the assistant — gateway owns this.
    const binding = getGuardianBinding("self", "phone");
    expect(binding).toBeNull();

    // Normal greeting should fire (from mockSendMessage), not the handoff copy
    const textMessages = ws.sentMessages
      .map((raw) => JSON.parse(raw) as { type: string; token?: string })
      .filter((m) => m.type === "text");
    expect(
      textMessages.some((m) => (m.token ?? "").includes("how can I help")),
    ).toBe(true);

    relay.destroy();
  });

  test("invite redemption success: continues call with handoff copy instead of ending", async () => {
    ensureConversation("conv-invite-continue");
    const session = createCallSession({
      conversationId: "conv-invite-continue",
      provider: "twilio",
      fromNumber: "+15557776666",
      toNumber: "+15551111111",
    });

    const code = generateVoiceCode(6);
    const codeHash = hashVoiceCode(code);
    createInvite({
      sourceChannel: "phone",
      contactId: createTargetContact(),
      maxUses: 1,
      expectedExternalUserId: "+15557776666",
      voiceCodeHash: codeHash,
      voiceCodeDigits: 6,
      friendName: "Eve",
      guardianName: "Frank",
    });

    mockSendMessage.mockImplementation(
      createMockProviderResponse(["I'd be happy to help."]),
    );

    const { ws, relay } = createMockWs(session.id);

    await relay.handleMessage(
      JSON.stringify({
        type: "setup",
        callSid: "CA_invite_continue",
        from: "+15557776666",
        to: "+15551111111",
      }),
    );

    // Should be in verification-pending for invite redemption
    expect(relay.getConnectionState()).toBe("verification_pending");

    // Enter the correct code via DTMF
    for (const digit of code) {
      await relay.handleMessage(JSON.stringify({ type: "dtmf", digit }));
    }

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Call should remain connected
    expect(relay.getConnectionState()).toBe("connected");

    // Handoff copy should have been sent
    const textMessages = ws.sentMessages
      .map((raw) => JSON.parse(raw) as { type: string; token?: string })
      .filter((m) => m.type === "text");
    expect(
      textMessages.some((m) =>
        (m.token ?? "").includes("verified that you are Eve"),
      ),
    ).toBe(true);

    // No end message — call stays alive
    const endMessages = ws.sentMessages
      .map((raw) => JSON.parse(raw) as { type: string })
      .filter((m) => m.type === "end");
    expect(endMessages.length).toBe(0);

    // Session should be in_progress
    const updated = getCallSession(session.id);
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("in_progress");

    // invite_redemption_succeeded event should exist
    const events = getCallEvents(session.id);
    expect(
      events.some((e) => e.eventType === "invite_redemption_succeeded"),
    ).toBe(true);

    relay.destroy();
  });

  test("outbound invite prompt uses assistant introduction", async () => {
    ensureConversation("conv-outbound-invite-origin");
    ensureConversation("conv-outbound-invite");
    const session = createCallSession({
      conversationId: "conv-outbound-invite",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15558887777",
      callMode: "invite",
      inviteFriendName: "Grace",
      inviteGuardianName: "Hank",
      initiatedFromConversationId: "conv-outbound-invite-origin",
    });

    mockAssistantName = "Vellum";

    const { ws, relay } = createMockWs(session.id);

    await relay.handleMessage(
      JSON.stringify({
        type: "setup",
        callSid: "CA_outbound_invite",
        from: "+15551111111",
        to: "+15558887777",
      }),
    );

    // Should be in verification-pending for invite redemption
    expect(relay.getConnectionState()).toBe("verification_pending");

    // The prompt should use the outbound assistant introduction
    const textMessages = ws.sentMessages
      .map((raw) => JSON.parse(raw) as { type: string; token?: string })
      .filter((m) => m.type === "text");
    expect(
      textMessages.some(
        (m) =>
          (m.token ?? "").includes("this is Vellum") &&
          (m.token ?? "").includes("Hank's assistant"),
      ),
    ).toBe(true);

    relay.destroy();
  });

  // ── resolveGuardianLabel resolution priority ─────────────────────────

  test("guardian label: guardian persona name takes precedence over Contact.displayName", async () => {
    mockUserReference = "Alice";

    // Create a guardian binding with a different displayName
    createGuardianBinding({
      channel: "phone",
      guardianExternalUserId: "+15559990001",
      guardianDeliveryChatId: "+15559990001",
      guardianPrincipalId: "+15559990001",
      verifiedVia: "test",
      metadataJson: JSON.stringify({ displayName: "Bob" }),
    });

    ensureConversation("conv-label-user-md");
    const session = createCallSession({
      conversationId: "conv-label-user-md",
      provider: "twilio",
      fromNumber: "+15559990099",
      toNumber: "+15551111111",
    });

    const { ws, relay } = createMockWs(session.id);

    await relay.handleMessage(
      JSON.stringify({
        type: "setup",
        callSid: "CA_label_user_md",
        from: "+15559990099",
        to: "+15551111111",
      }),
    );

    expect(relay.getConnectionState()).toBe("awaiting_name");

    // The greeting should use the guardian persona name ("Alice"), not Contact.displayName ("Bob")
    const textMessages = ws.sentMessages
      .map((raw) => JSON.parse(raw) as { type: string; token?: string })
      .filter((m) => m.type === "text");
    const promptText = textMessages.map((m) => m.token ?? "").join("");
    expect(promptText).toContain("Alice");
    expect(promptText).not.toContain("Bob");

    relay.destroy();
  });

  test("guardian label: Contact.displayName used when guardian persona name is empty", async () => {
    mockUserReference = "my human";

    // Create a guardian binding with a displayName
    createGuardianBinding({
      channel: "phone",
      guardianExternalUserId: "+15559990002",
      guardianDeliveryChatId: "+15559990002",
      guardianPrincipalId: "+15559990002",
      verifiedVia: "test",
      metadataJson: JSON.stringify({ displayName: "Charlie" }),
    });

    ensureConversation("conv-label-contact");
    const session = createCallSession({
      conversationId: "conv-label-contact",
      provider: "twilio",
      fromNumber: "+15559990098",
      toNumber: "+15551111111",
    });

    const { ws, relay } = createMockWs(session.id);

    await relay.handleMessage(
      JSON.stringify({
        type: "setup",
        callSid: "CA_label_contact",
        from: "+15559990098",
        to: "+15551111111",
      }),
    );

    expect(relay.getConnectionState()).toBe("awaiting_name");

    // The greeting should use Contact.displayName ("Charlie")
    const textMessages = ws.sentMessages
      .map((raw) => JSON.parse(raw) as { type: string; token?: string })
      .filter((m) => m.type === "text");
    const promptText = textMessages.map((m) => m.token ?? "").join("");
    expect(promptText).toContain("Charlie");

    relay.destroy();
  });

  test("guardian label: DEFAULT_USER_REFERENCE used when both guardian persona name and Contact.displayName are empty", async () => {
    mockUserReference = "my human";

    // Clear guardian binding so resolveGuardianLabel falls back to DEFAULT_USER_REFERENCE
    const db = getDb();
    db.run("DELETE FROM contact_channels");
    db.run("DELETE FROM contacts");

    ensureConversation("conv-label-default");
    const session = createCallSession({
      conversationId: "conv-label-default",
      provider: "twilio",
      fromNumber: "+15559990097",
      toNumber: "+15551111111",
    });

    const { ws, relay } = createMockWs(session.id);

    await relay.handleMessage(
      JSON.stringify({
        type: "setup",
        callSid: "CA_label_default",
        from: "+15559990097",
        to: "+15551111111",
      }),
    );

    expect(relay.getConnectionState()).toBe("awaiting_name");

    // The greeting should use the default "my human"
    const textMessages = ws.sentMessages
      .map((raw) => JSON.parse(raw) as { type: string; token?: string })
      .filter((m) => m.type === "text");
    const promptText = textMessages.map((m) => m.token ?? "").join("");
    expect(promptText).toContain("my human");

    relay.destroy();
  });

  // ── Provider-aware call speech output ──────────────────────────────

  describe("provider-aware system prompts", () => {
    test("native TTS provider: verification prompt uses sendTextToken (text messages)", async () => {
      // Ensure native (non-streaming) TTS path
      mockTtsSupportsStreaming = false;
      mockTtsSynthesizeStream = null;

      ensureConversation("conv-native-tts-verify");
      const session = createCallSession({
        conversationId: "conv-native-tts-verify",
        provider: "twilio",
        fromNumber: "+15559999999",
        toNumber: "+15551111111",
      });

      createPendingVoiceGuardianChallenge("654321");

      const { ws, relay } = createMockWs(session.id);

      await relay.handleMessage(
        JSON.stringify({
          type: "setup",
          callSid: "CA_native_tts_verify",
          from: "+15559999999",
          to: "+15551111111",
        }),
      );

      expect(relay.getConnectionState()).toBe("verification_pending");

      // With native TTS, the prompt should appear as a text message (not play)
      const textMessages = ws.sentMessages
        .map((raw) => JSON.parse(raw) as { type: string; token?: string })
        .filter((m) => m.type === "text");
      const playMessages = ws.sentMessages
        .map((raw) => JSON.parse(raw) as { type: string; source?: string })
        .filter((m) => m.type === "play");

      expect(
        textMessages.some((m) => (m.token ?? "").includes("verification code")),
      ).toBe(true);
      expect(playMessages.length).toBe(0);

      relay.destroy();
    });

    test("synthesized TTS provider: verification prompt uses sendPlayUrl (play messages)", async () => {
      // Enable synthesized (streaming) TTS path
      mockTtsProviderId = "fish-audio";
      mockTtsSupportsStreaming = true;
      mockTtsSynthesizeStream = jest.fn(
        async (_request: unknown, onChunk: (chunk: Uint8Array) => void) => {
          onChunk(new Uint8Array([0x01, 0x02, 0x03]));
          return {
            audio: Buffer.from([0x01, 0x02, 0x03]),
            contentType: "audio/mpeg",
          };
        },
      );

      ensureConversation("conv-synth-tts-verify");
      const session = createCallSession({
        conversationId: "conv-synth-tts-verify",
        provider: "twilio",
        fromNumber: "+15559999998",
        toNumber: "+15551111111",
      });

      createPendingVoiceGuardianChallenge("654321");

      const { ws, relay } = createMockWs(session.id);

      await relay.handleMessage(
        JSON.stringify({
          type: "setup",
          callSid: "CA_synth_tts_verify",
          from: "+15559999998",
          to: "+15551111111",
        }),
      );

      expect(relay.getConnectionState()).toBe("verification_pending");

      // Allow async synthesis to complete
      await new Promise((resolve) => setTimeout(resolve, 50));

      // With synthesized TTS, the prompt should appear as a play message
      const playMessages = ws.sentMessages
        .map((raw) => JSON.parse(raw) as { type: string; source?: string })
        .filter((m) => m.type === "play");

      expect(playMessages.length).toBeGreaterThan(0);
      expect(playMessages[0].source).toContain("/v1/audio/");

      // The synthesizeStream mock should have been called
      expect(mockTtsSynthesizeStream).toHaveBeenCalled();

      relay.destroy();
    });

    test("native TTS provider: name capture greeting uses text messages", async () => {
      // Ensure native (non-streaming) TTS path
      mockTtsSupportsStreaming = false;
      mockTtsSynthesizeStream = null;

      ensureConversation("conv-native-name-capture");
      const session = createCallSession({
        conversationId: "conv-native-name-capture",
        provider: "twilio",
        fromNumber: "+15559990097",
        toNumber: "+15551111111",
      });

      mockAssistantName = "Jarvis";

      const { ws, relay } = createMockWs(session.id);

      await relay.handleMessage(
        JSON.stringify({
          type: "setup",
          callSid: "CA_native_name_capture",
          from: "+15559990097",
          to: "+15551111111",
        }),
      );

      expect(relay.getConnectionState()).toBe("awaiting_name");

      // With native TTS, the greeting should be a text message
      const textMessages = ws.sentMessages
        .map((raw) => JSON.parse(raw) as { type: string; token?: string })
        .filter((m) => m.type === "text");
      const playMessages = ws.sentMessages
        .map((raw) => JSON.parse(raw) as { type: string; source?: string })
        .filter((m) => m.type === "play");

      expect(
        textMessages.some((m) => (m.token ?? "").includes("don't recognize")),
      ).toBe(true);
      expect(playMessages.length).toBe(0);

      // Reset
      mockAssistantName = "Vellum";
      relay.destroy();
    });

    test("synthesized TTS provider: name capture greeting uses play messages", async () => {
      // Enable synthesized (streaming) TTS path
      mockTtsProviderId = "fish-audio";
      mockTtsSupportsStreaming = true;
      mockTtsSynthesizeStream = jest.fn(
        async (_request: unknown, onChunk: (chunk: Uint8Array) => void) => {
          onChunk(new Uint8Array([0x04, 0x05, 0x06]));
          return {
            audio: Buffer.from([0x04, 0x05, 0x06]),
            contentType: "audio/mpeg",
          };
        },
      );

      ensureConversation("conv-synth-name-capture");
      const session = createCallSession({
        conversationId: "conv-synth-name-capture",
        provider: "twilio",
        fromNumber: "+15559990098",
        toNumber: "+15551111111",
      });

      mockAssistantName = "Jarvis";

      const { ws, relay } = createMockWs(session.id);

      await relay.handleMessage(
        JSON.stringify({
          type: "setup",
          callSid: "CA_synth_name_capture",
          from: "+15559990098",
          to: "+15551111111",
        }),
      );

      expect(relay.getConnectionState()).toBe("awaiting_name");

      // Allow async synthesis to complete
      await new Promise((resolve) => setTimeout(resolve, 50));

      // With synthesized TTS, the greeting should be a play message
      const playMessages = ws.sentMessages
        .map((raw) => JSON.parse(raw) as { type: string; source?: string })
        .filter((m) => m.type === "play");

      expect(playMessages.length).toBeGreaterThan(0);
      expect(playMessages[0].source).toContain("/v1/audio/");

      // The synthesizeStream mock should have been called
      expect(mockTtsSynthesizeStream).toHaveBeenCalled();

      // Reset
      mockAssistantName = "Vellum";
      relay.destroy();
    });

    test("synthesized TTS provider: falls back to text on synthesis failure", async () => {
      // Configure synthesized path but make it fail
      mockTtsProviderId = "fish-audio";
      mockTtsSupportsStreaming = true;
      mockTtsSynthesizeStream = jest.fn(async () => {
        throw new Error("Synthesis service unavailable");
      });

      ensureConversation("conv-synth-fallback");
      const session = createCallSession({
        conversationId: "conv-synth-fallback",
        provider: "twilio",
        fromNumber: "+15559990099",
        toNumber: "+15551111111",
      });

      createPendingVoiceGuardianChallenge("654321");

      const { ws, relay } = createMockWs(session.id);

      await relay.handleMessage(
        JSON.stringify({
          type: "setup",
          callSid: "CA_synth_fallback",
          from: "+15559990099",
          to: "+15551111111",
        }),
      );

      expect(relay.getConnectionState()).toBe("verification_pending");

      // Allow async synthesis (and fallback) to complete
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should have fallen back to text messages after synthesis failure
      const textMessages = ws.sentMessages
        .map((raw) => JSON.parse(raw) as { type: string; token?: string })
        .filter((m) => m.type === "text");

      expect(
        textMessages.some((m) => (m.token ?? "").includes("verification code")),
      ).toBe(true);

      relay.destroy();
    });

    test("Deepgram TTS provider: synthesis failure does NOT fall back to text (fail-fast policy)", async () => {
      // Configure Deepgram as the synthesized provider with failing synthesis.
      // Deepgram uses buffer synthesis (no streaming), so we fail synthesize().
      mockTtsProviderId = "deepgram";
      mockTtsSupportsStreaming = false;
      mockTtsSynthesizeStream = null;
      mockTtsSynthesize = jest.fn(async () => {
        const err = new Error("Deepgram TTS returned 503: service unavailable");
        (err as Error & { code?: string }).code = "DEEPGRAM_TTS_HTTP_ERROR";
        throw err;
      });

      ensureConversation("conv-deepgram-fail");
      const session = createCallSession({
        conversationId: "conv-deepgram-fail",
        provider: "twilio",
        fromNumber: "+15559990088",
        toNumber: "+15551111111",
      });

      createPendingVoiceGuardianChallenge("123456");

      const { ws, relay } = createMockWs(session.id);

      await relay.handleMessage(
        JSON.stringify({
          type: "setup",
          callSid: "CA_deepgram_fail",
          from: "+15559990088",
          to: "+15551111111",
        }),
      );

      // Allow async synthesis (and error propagation) to complete
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Deepgram failure should NOT have produced text fallback messages
      // containing the verification prompt content, because Deepgram
      // synthesis failures propagate rather than falling back to native TTS.
      const textMessages = ws.sentMessages
        .map((raw) => JSON.parse(raw) as { type: string; token?: string })
        .filter((m) => m.type === "text");
      const playMessages = ws.sentMessages
        .map((raw) => JSON.parse(raw) as { type: string })
        .filter((m) => m.type === "play");

      // No play URL should have been sent either (synthesis failed before
      // first chunk).
      expect(playMessages.length).toBe(0);

      // Unlike Fish Audio which falls back to text, Deepgram should NOT
      // have any text tokens containing the verification prompt.
      const hasVerificationText = textMessages.some((m) =>
        (m.token ?? "").includes("verification code"),
      );
      expect(hasVerificationText).toBe(false);

      relay.destroy();
    });

    test("native TTS provider: DTMF callee verification failure prompt uses text messages", async () => {
      // Ensure native (non-streaming) TTS path
      mockTtsSupportsStreaming = false;
      mockTtsSynthesizeStream = null;

      ensureConversation("conv-native-callee-fail");
      ensureConversation("conv-native-callee-fail-origin");
      mockConfig.calls.verification.enabled = true;
      mockConfig.calls.verification.maxAttempts = 1;

      const session = createCallSession({
        conversationId: "conv-native-callee-fail",
        provider: "twilio",
        fromNumber: "+15551111111",
        toNumber: "+15552222222",
        task: "Call +15552222222",
        initiatedFromConversationId: "conv-native-callee-fail-origin",
      });

      const { ws, relay } = createMockWs(session.id);

      await relay.handleMessage(
        JSON.stringify({
          type: "setup",
          callSid: "CA_native_callee_fail",
          from: "+15551111111",
          to: "+15552222222",
        }),
      );

      expect(relay.getConnectionState()).toBe("verification_pending");
      expect(relay.getVerificationCode()).not.toBeNull();

      // Send wrong digits
      for (const digit of "000000") {
        await relay.handleMessage(JSON.stringify({ type: "dtmf", digit }));
      }

      // Should have sent "Verification failed" as text (not play)
      const textMessages = ws.sentMessages
        .map((raw) => JSON.parse(raw) as { type: string; token?: string })
        .filter((m) => m.type === "text");
      const playMessages = ws.sentMessages
        .map((raw) => JSON.parse(raw) as { type: string; source?: string })
        .filter((m) => m.type === "play");

      expect(
        textMessages.some((m) =>
          (m.token ?? "").includes("Verification failed"),
        ),
      ).toBe(true);
      expect(playMessages.length).toBe(0);

      relay.destroy();
    });
  });
});
