import {
  afterAll,
  beforeEach,
  describe,
  expect,
  type Mock,
  mock,
  test,
} from "bun:test";

mock.module("../config/env.js", () => ({ isHttpAuthDisabled: () => true }));

// Guardian requests/deliveries are created through the gateway client; serve
// that surface from the in-memory sim so dispatch never opens IPC.
import {
  bridgeState,
  gatewayGuardianRequestsStoreBridge,
} from "./helpers/gateway-guardian-requests-store-bridge.js";

mock.module(
  "../channels/gateway-guardian-requests.js",
  () => gatewayGuardianRequestsStoreBridge,
);

// ── Config ──────────────────────────────────────────────────────────
// These tests run against the real config loader. `loadConfig()` returns the
// loader's live cached object, so tests set TTS/ingress fields by mutating it
// in place; `beforeEach` restores the fields the tests touch. The workspace
// config file itself is seeded once below (memory off, ingress base URL).

// ── Credential mock (prevents real key lookups) ──────────────────────

// Provider API keys resolve by default so telephony playability checks
// (PCM-transport tests) can select providers; tests can narrow the
// resolvable set. Reset to null (all resolve) in beforeEach.
let mockResolvableProviderKeys: ((service: string) => string | null) | null =
  null;

mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: async () => null,
  getSecureKey: () => null,
  getProviderKeyAsync: async (service: string) =>
    mockResolvableProviderKeys
      ? mockResolvableProviderKeys(service)
      : "test-key",
}));

mock.module("../security/credential-key.js", () => ({
  credentialKey: (...args: string[]) => args.join("/"),
}));

// ── Call constants mock ──────────────────────────────────────────────

let mockConsultationTimeoutMs = 90_000;
let mockSilenceTimeoutMs = 30_000;
let mockEndCallListenWindowMs = 0;

mock.module("../calls/call-constants.js", () => ({
  getMaxCallDurationMs: () => 12 * 60 * 1000,
  getUserConsultationTimeoutMs: () => mockConsultationTimeoutMs,
  getSilenceTimeoutMs: () => mockSilenceTimeoutMs,
  getEndCallListenWindowMs: () => mockEndCallListenWindowMs,
}));

// ── Voice session bridge mock ────────────────────────────────────────

/**
 * Creates a mock startVoiceTurn implementation that emits text_delta
 * events for each token and calls onComplete when done.
 */
function createMockVoiceTurn(tokens: string[]) {
  return async (opts: {
    conversationId: string;
    content: string;
    assistantId?: string;
    onTextDelta: (text: string) => void;
    onComplete: () => void;
    onError: (message: string) => void;
    signal?: AbortSignal;
  }) => {
    // Check for abort before proceeding
    if (opts.signal?.aborted) {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }

    // Emit text deltas
    for (const token of tokens) {
      if (opts.signal?.aborted) {
        break;
      }
      opts.onTextDelta(token);
    }

    if (!opts.signal?.aborted) {
      opts.onComplete();
    }

    return {
      turnId: `run-${Date.now()}`,
      abort: () => {},
    };
  };
}

let mockStartVoiceTurn: Mock<any>;

// ── Notification pipeline mock (prevent async handle leaks from fire-and-forget dispatches) ──

mock.module("../notifications/emit-signal.js", () => ({
  emitNotificationSignal: async () => ({
    signalId: "mock-signal",
    deduplicated: false,
    dispatched: true,
    reason: "mocked",
    deliveryResults: [],
  }),
}));

// Guardian principalId is resolved from the gateway binding reader. Mirror the
// vellum binding seeded by resetTables so guardian dispatch can resolve it.
mock.module("../contacts/guardian-delivery-reader.js", () => ({
  getGuardianDelivery: async () => [
    {
      channelType: "vellum",
      contactId: "guardian-vellum",
      principalId: "test-principal-id",
      address: "local",
      status: "active",
    },
  ],
  guardianForChannel: (
    list: Array<{ channelType: string; status: string }>,
    channelType: string,
  ) => list.find((g) => g.channelType === channelType && g.status === "active"),
  anyGuardian: (list: unknown[]) => list[0],
}));

mock.module("../calls/voice-session-bridge.js", () => {
  mockStartVoiceTurn = mock(createMockVoiceTurn(["Hello", " there"]));
  return {
    startVoiceTurn: (...args: unknown[]) => mockStartVoiceTurn(...args),
  };
});

// ── TTS provider override setup ──────────────────────────────────────
// Install test adapters that shadow the static catalog adapters so
// call-controller resolves stubs instead of real HTTP-backed providers.
// ElevenLabs is the default native provider (no streaming), while Fish
// Audio is a synthesized provider (streaming).

import {
  _resetTtsProviderOverridesForTests,
  _setTtsProviderForTests,
} from "../tts/provider-catalog.js";
import type { TtsProvider } from "../tts/types.js";

function registerTestTtsProviders(): void {
  _resetTtsProviderOverridesForTests();

  const elevenlabs: TtsProvider = {
    id: "elevenlabs",
    capabilities: { supportsStreaming: false, supportedFormats: ["mp3"] },
    async synthesize() {
      return { audio: Buffer.from(""), contentType: "audio/mpeg" };
    },
  };
  _setTtsProviderForTests(elevenlabs);

  const fishAudio: TtsProvider = {
    id: "fish-audio",
    capabilities: {
      supportsStreaming: true,
      supportedFormats: ["mp3", "wav", "opus"],
    },
    async synthesize() {
      return { audio: Buffer.from(""), contentType: "audio/mpeg" };
    },
    async synthesizeStream(_req, _onChunk) {
      return { audio: Buffer.from(""), contentType: "audio/mpeg" };
    },
  };
  _setTtsProviderForTests(fishAudio);

  const deepgram: TtsProvider = {
    id: "deepgram",
    capabilities: {
      supportsStreaming: false,
      supportedFormats: ["mp3", "wav", "opus"],
    },
    async synthesize() {
      return {
        audio: Buffer.from("fake-deepgram-audio"),
        contentType: "audio/mpeg",
      };
    },
  };
  _setTtsProviderForTests(deepgram);
}

// Register providers immediately so they're available for all tests
registerTestTtsProviders();

// ── Import source modules after all mocks are registered ────────────

import { CallController } from "../calls/call-controller.js";
import { getCallController } from "../calls/call-state.js";
import {
  createCallSession,
  getCallEvents,
  getCallSession,
  getPendingQuestion,
  updateCallSession,
} from "../calls/call-store.js";
import type { CallTransport } from "../calls/call-transport.js";
import { resolveCallTtsProvider } from "../calls/resolve-call-tts-provider.js";
import { loadConfig } from "../config/loader.js";
import { getMessages } from "../persistence/conversation-crud.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { resetTestTables } from "../persistence/raw-query.js";
import { conversations } from "../persistence/schema/index.js";
import { resetDbForTesting } from "./db-test-helpers.js";
import { createGuardianBinding } from "./helpers/create-guardian-binding.js";
import { setConfig } from "./helpers/set-config.js";

// Disable memory so persisted call messages skip background indexing, and
// seed the ingress base URL used for synthesized-audio play URLs.
setConfig("memory", { enabled: false });
setConfig("ingress", {
  enabled: true,
  publicBaseUrl: "https://generic.example.com",
});

await initializeDb();

afterAll(() => {
  resetDbForTesting();
});

// ── CallTransport mock factory ───────────────────────────────────────

interface MockTransport extends CallTransport {
  sentTokens: Array<{ token: string; last: boolean }>;
  sentPlayUrls: string[];
  endCalled: boolean;
  endReason: string | undefined;
}

function createMockTransport(): MockTransport {
  const state = {
    sentTokens: [] as Array<{ token: string; last: boolean }>,
    sentPlayUrls: [] as string[],
    _endCalled: false,
    _endReason: undefined as string | undefined,
  };

  return {
    get sentTokens() {
      return state.sentTokens;
    },
    get sentPlayUrls() {
      return state.sentPlayUrls;
    },
    get endCalled() {
      return state._endCalled;
    },
    get endReason() {
      return state._endReason;
    },
    sendTextToken(token: string, last: boolean) {
      state.sentTokens.push({ token, last });
    },
    sendPlayUrl(url: string) {
      state.sentPlayUrls.push(url);
    },
    endSession(reason?: string) {
      state._endCalled = true;
      state._endReason = reason;
    },
  } as MockTransport;
}

// ── Helpers ─────────────────────────────────────────────────────────

let ensuredConvIds = new Set<string>();
function ensureConversation(id: string): void {
  if (ensuredConvIds.has(id)) {
    return;
  }
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

function pendingRequestByCallSession(callSessionId: string) {
  return (
    [...bridgeState.requests.values()]
      .filter(
        (r) => r.callSessionId === callSessionId && r.status === "pending",
      )
      .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null
  );
}

function resetTables() {
  bridgeState.reset();
  resetTestTables(
    "call_pending_questions",
    "call_events",
    "call_sessions",
    "tool_invocations",
    "messages",
    "conversations",
    "contact_channels",
    "contacts",
  );
  // Seed the vellum guardian binding (gateway does this at startup in production)
  createGuardianBinding({
    channel: "vellum",
    guardianExternalUserId: "test-principal-id",
    guardianDeliveryChatId: "local",
    guardianPrincipalId: "test-principal-id",
    verifiedVia: "bootstrap",
  });
  ensuredConvIds = new Set();
}

/**
 * Poll until a condition is met, with a timeout. Yields the event loop
 * between checks so fire-and-forget async work (guardian dispatch, etc.)
 * can complete even on slow CI runners where setTimeout callbacks may
 * be delayed by synchronous DB operations.
 */
async function pollUntil(
  predicate: () => boolean,
  timeoutMs = 2000,
  intervalMs = 5,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`pollUntil timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * Create a call session and a controller wired to a mock transport.
 */
function setupController(
  task?: string,
  opts?: {
    assistantId?: string;
    trustContext?: import("../daemon/trust-context-types.js").TrustContext;
    /** Simulate the media-stream transport's PCM requirement. */
    requiresPcmAudio?: boolean;
  },
) {
  ensureConversation("conv-ctrl-test");
  const session = createCallSession({
    conversationId: "conv-ctrl-test",
    provider: "twilio",
    fromNumber: "+15551111111",
    toNumber: "+15552222222",
    task,
  });
  updateCallSession(session.id, { status: "in_progress" });
  const transport = createMockTransport();
  if (opts?.requiresPcmAudio) {
    Object.assign(transport, { requiresPcmAudio: true });
  }
  const controller = new CallController(session.id, transport, task ?? null, {
    assistantId: opts?.assistantId,
    trustContext: opts?.trustContext,
  });
  return { session, relay: transport, controller };
}

function getLatestAssistantText(conversationId: string): string | null {
  const msgs = getMessages(conversationId).filter(
    (m) => m.role === "assistant",
  );
  if (msgs.length === 0) {
    return null;
  }
  const latest = msgs[msgs.length - 1];
  return latest.content
    .filter(
      (b): b is { type: "text"; text: string } =>
        b.type === "text" && typeof (b as { text?: unknown }).text === "string",
    )
    .map((b) => b.text)
    .join("");
}

function setupControllerWithOrigin(task?: string) {
  ensureConversation("conv-ctrl-voice");
  ensureConversation("conv-ctrl-origin");
  const session = createCallSession({
    conversationId: "conv-ctrl-voice",
    provider: "twilio",
    fromNumber: "+15551111111",
    toNumber: "+15552222222",
    task,
    initiatedFromConversationId: "conv-ctrl-origin",
  });
  updateCallSession(session.id, {
    status: "in_progress",
    startedAt: Date.now() - 30_000,
  });
  const transport = createMockTransport();
  const controller = new CallController(
    session.id,
    transport,
    task ?? null,
    {},
  );
  return { session, relay: transport, controller };
}

describe("call-controller", () => {
  beforeEach(() => {
    resetTables();
    // Reset the bridge mock to default behaviour
    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn(["Hello", " there"]),
    );
    // Reset consultation timeout to the default (long) value
    mockConsultationTimeoutMs = 90_000;
    mockSilenceTimeoutMs = 30_000;
    mockEndCallListenWindowMs = 0;
    // Reset TTS config to defaults so per-test mutations don't leak.
    const cfg = loadConfig();
    cfg.services.tts.provider = "elevenlabs";
    cfg.services.tts.providers["fish-audio"].referenceId = "";
    cfg.ingress.publicBaseUrl = "https://generic.example.com";
    mockResolvableProviderKeys = null;
    // Reset TTS provider registry to ensure clean state
    registerTestTtsProviders();
  });

  // ── handleCallerUtterance ─────────────────────────────────────────

  test("handleCallerUtterance: streams tokens via sendTextToken", async () => {
    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn(["Hi", ", how", " are you?"]),
    );
    const { relay, controller } = setupController();

    await controller.handleCallerUtterance("Hello");

    // Verify tokens were sent to the relay
    const nonEmptyTokens = relay.sentTokens.filter((t) => t.token.length > 0);
    expect(nonEmptyTokens.length).toBeGreaterThan(0);
    // The last token should have last=true (empty string token signaling end)
    const lastToken = relay.sentTokens[relay.sentTokens.length - 1];
    expect(lastToken.last).toBe(true);

    controller.destroy();
  });

  test("handleCallerUtterance: sends last=true at end of turn", async () => {
    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn(["Simple response."]),
    );
    const { relay, controller } = setupController();

    await controller.handleCallerUtterance("Test");

    // Find the final empty-string token that marks end of turn
    const endMarkers = relay.sentTokens.filter((t) => t.last === true);
    expect(endMarkers.length).toBeGreaterThanOrEqual(1);

    controller.destroy();
  });

  test("handleCallerUtterance: includes speaker context in voice turn content", async () => {
    mockStartVoiceTurn.mockImplementation(
      async (opts: {
        content: string;
        onTextDelta: (t: string) => void;
        onComplete: () => void;
      }) => {
        expect(opts.content).toContain(
          '[SPEAKER id="speaker-1" label="Aaron" source="provider" confidence="0.91"]',
        );
        expect(opts.content).toContain("Can you summarize this meeting?");
        opts.onTextDelta("Sure, here is a summary.");
        opts.onComplete();
        return { turnId: "run-1", abort: () => {} };
      },
    );

    const { controller } = setupController();

    await controller.handleCallerUtterance("Can you summarize this meeting?", {
      speakerId: "speaker-1",
      speakerLabel: "Aaron",
      speakerConfidence: 0.91,
      source: "provider",
    });

    controller.destroy();
  });

  test("startInitialGreeting: sends CALL_OPENING content and strips control marker from speech", async () => {
    let turnCount = 0;
    mockStartVoiceTurn.mockImplementation(
      async (opts: {
        content: string;
        onTextDelta: (t: string) => void;
        onComplete: () => void;
      }) => {
        turnCount++;
        expect(opts.content).toContain("[CALL_OPENING]");
        const tokens = [
          "Hi, I am calling about your appointment request. Is now a good time to talk?",
        ];
        for (const token of tokens) {
          opts.onTextDelta(token);
        }
        opts.onComplete();
        return { turnId: "run-1", abort: () => {} };
      },
    );

    const { relay, controller } = setupController("Confirm appointment");

    await controller.startInitialGreeting();
    await controller.startInitialGreeting(); // should be no-op

    const allText = relay.sentTokens.map((t) => t.token).join("");
    expect(allText).toContain("appointment request");
    expect(allText).toContain("good time to talk");
    expect(allText).not.toContain("[CALL_OPENING]");
    expect(turnCount).toBe(1); // idempotent

    controller.destroy();
  });

  test("startInitialGreeting: tags only the first caller response with CALL_OPENING_ACK", async () => {
    let turnCount = 0;
    mockStartVoiceTurn.mockImplementation(
      async (opts: {
        content: string;
        onTextDelta: (t: string) => void;
        onComplete: () => void;
      }) => {
        turnCount++;

        let tokens: string[];
        if (turnCount === 1) {
          expect(opts.content).toContain("[CALL_OPENING]");
          tokens = [
            "Hey Noa, it's Credence calling about your joke request. Is now okay for a quick one?",
          ];
        } else if (turnCount === 2) {
          expect(opts.content).toContain("[CALL_OPENING_ACK]");
          expect(opts.content).toContain("Yeah. Sure. What's up?");
          tokens = [
            "Great, here's one right away. Why did the scarecrow win an award?",
          ];
        } else {
          expect(opts.content).not.toContain("[CALL_OPENING_ACK]");
          expect(opts.content).toContain("Tell me the punchline");
          tokens = ["Because he was outstanding in his field."];
        }

        for (const token of tokens) {
          opts.onTextDelta(token);
        }
        opts.onComplete();
        return { turnId: `run-${turnCount}`, abort: () => {} };
      },
    );

    const { controller } = setupController("Tell a joke immediately");

    await controller.startInitialGreeting();
    await controller.handleCallerUtterance("Yeah. Sure. What's up?");
    await controller.handleCallerUtterance("Tell me the punchline");

    expect(turnCount).toBe(3);

    controller.destroy();
  });

  test("markNextCallerTurnAsOpeningAck: tags the next caller turn with CALL_OPENING_ACK without requiring a prior CALL_OPENING", async () => {
    let turnCount = 0;
    mockStartVoiceTurn.mockImplementation(
      async (opts: {
        content: string;
        onTextDelta: (t: string) => void;
        onComplete: () => void;
      }) => {
        turnCount++;

        if (turnCount === 1) {
          // First caller utterance after markNextCallerTurnAsOpeningAck
          expect(opts.content).toContain("[CALL_OPENING_ACK]");
          expect(opts.content).toContain("I want to check my balance");
          for (const token of ["Sure, let me check your balance."]) {
            opts.onTextDelta(token);
          }
        } else {
          // Subsequent utterance should NOT have the marker
          expect(opts.content).not.toContain("[CALL_OPENING_ACK]");
          for (const token of ["Your balance is $42."]) {
            opts.onTextDelta(token);
          }
        }
        opts.onComplete();
        return { turnId: `run-${turnCount}`, abort: () => {} };
      },
    );

    const { controller } = setupController();

    // Simulate post-approval: call markNextCallerTurnAsOpeningAck directly
    // without any prior startInitialGreeting / CALL_OPENING
    controller.markNextCallerTurnAsOpeningAck();

    await controller.handleCallerUtterance("I want to check my balance");
    await controller.handleCallerUtterance("How much exactly?");

    expect(turnCount).toBe(2);

    controller.destroy();
  });

  // ── ASK_GUARDIAN pattern ──────────────────────────────────────────

  test("ASK_GUARDIAN pattern: detects pattern, creates pending question, sets session to waiting_on_user", async () => {
    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn([
        "Let me check on that. ",
        "[ASK_GUARDIAN: What date works best?]",
      ]),
    );
    const { session, relay, controller } = setupController("Book appointment");

    await controller.handleCallerUtterance("I need to schedule something");

    // Verify a pending question was created
    const question = getPendingQuestion(session.id);
    expect(question).not.toBeNull();
    expect(question!.questionText).toBe("What date works best?");
    expect(question!.status).toBe("pending");

    // Controller state returns to idle (non-blocking); consultation is
    // tracked separately via pendingConsultation.
    expect(controller.getState()).toBe("idle");

    // Session status in the store is still set to waiting_on_user for
    // external consumers (e.g. the answer route).
    const updatedSession = getCallSession(session.id);
    expect(updatedSession!.status).toBe("waiting_on_user");

    // A pending consultation should be active
    expect(controller.getPendingConsultationQuestionId()).not.toBeNull();

    // The ASK_GUARDIAN marker text should NOT appear in the relay tokens
    const allText = relay.sentTokens.map((t) => t.token).join("");
    expect(allText).not.toContain("[ASK_GUARDIAN:");

    controller.destroy();
  });

  test("strips internal context markers from spoken output", async () => {
    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn([
        "Thanks for waiting. ",
        "[USER_ANSWERED: The guardian said 3 PM works.] ",
        "[USER_INSTRUCTION: Keep this short.] ",
        "[CALL_OPENING_ACK] ",
        "I can confirm 3 PM works.",
      ]),
    );
    const { relay, controller } = setupController();

    await controller.handleCallerUtterance("Any update?");

    const allText = relay.sentTokens.map((t) => t.token).join("");
    expect(allText).toContain("Thanks for waiting.");
    expect(allText).toContain("I can confirm 3 PM works.");
    expect(allText).not.toContain("[USER_ANSWERED:");
    expect(allText).not.toContain("[USER_INSTRUCTION:");
    expect(allText).not.toContain("[CALL_OPENING_ACK]");
    expect(allText).not.toContain("USER_ANSWERED");
    expect(allText).not.toContain("USER_INSTRUCTION");
    expect(allText).not.toContain("CALL_OPENING_ACK");

    controller.destroy();
  });

  // ── END_CALL pattern ──────────────────────────────────────────────

  test("END_CALL pattern: detects marker, calls endSession, updates status to completed", async () => {
    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn(["Thank you for calling, goodbye! ", "[END_CALL]"]),
    );
    const { session, relay, controller } = setupController();

    await controller.handleCallerUtterance("That is all, thanks");

    // endSession should have been called
    expect(relay.endCalled).toBe(true);

    // Session status should be completed
    const updatedSession = getCallSession(session.id);
    expect(updatedSession!.status).toBe("completed");
    expect(updatedSession!.endedAt).not.toBeNull();

    // The END_CALL marker text should NOT appear in the relay tokens
    const allText = relay.sentTokens.map((t) => t.token).join("");
    expect(allText).not.toContain("[END_CALL]");

    controller.destroy();
  });

  test("END_CALL waits through the listen window before completing", async () => {
    mockEndCallListenWindowMs = 25;
    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn(["Thank you for calling, goodbye! ", "[END_CALL]"]),
    );
    const { session, relay, controller } = setupController();

    await controller.handleCallerUtterance("That is all, thanks");

    expect(relay.endCalled).toBe(false);
    expect(getCallSession(session.id)!.status).toBe("in_progress");

    await new Promise((r) => setTimeout(r, 35));

    expect(relay.endCalled).toBe(true);
    const updatedSession = getCallSession(session.id);
    expect(updatedSession!.status).toBe("completed");
    expect(updatedSession!.endedAt).not.toBeNull();

    controller.destroy();
  });

  test("delayed END_CALL completion skips side effects when session is already terminal", async () => {
    mockEndCallListenWindowMs = 25;
    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn(["Thank you for calling, goodbye! ", "[END_CALL]"]),
    );
    const { session, relay, controller } = setupController();

    await controller.handleCallerUtterance("That is all, thanks");

    const externalEndedAt = Date.now();
    updateCallSession(session.id, {
      status: "completed",
      endedAt: externalEndedAt,
    });

    await new Promise((r) => setTimeout(r, 35));

    expect(relay.endCalled).toBe(false);
    const updatedSession = getCallSession(session.id);
    expect(updatedSession!.status).toBe("completed");
    expect(updatedSession!.endedAt).toBe(externalEndedAt);

    controller.destroy();
  });

  test("callee speech during END_CALL listen window cancels pending completion", async () => {
    mockEndCallListenWindowMs = 30;
    const turnContents: string[] = [];
    mockStartVoiceTurn.mockImplementation(
      async (opts: {
        content: string;
        onTextDelta: (t: string) => void;
        onComplete: () => void;
      }) => {
        turnContents.push(opts.content);
        if (turnContents.length === 1) {
          opts.onTextDelta("Goodbye! [END_CALL]");
        } else {
          opts.onTextDelta("Of course. I'm still here.");
        }
        opts.onComplete();
        return { turnId: `run-${turnContents.length}`, abort: () => {} };
      },
    );
    const { session, relay, controller } = setupController();

    await controller.handleCallerUtterance("That is all, thanks");
    expect(relay.endCalled).toBe(false);

    await controller.handleCallerUtterance("Wait, one more thing");
    await new Promise((r) => setTimeout(r, 40));

    expect(relay.endCalled).toBe(false);
    expect(getCallSession(session.id)!.status).toBe("in_progress");
    expect(turnContents).toContain("Wait, one more thing");
    const allText = relay.sentTokens.map((t) => t.token).join("");
    expect(allText).toContain("I'm still here.");

    controller.destroy();
  });

  test("second END_CALL after a deferral completes immediately (no listen window)", async () => {
    mockEndCallListenWindowMs = 30;
    const turnContents: string[] = [];
    mockStartVoiceTurn.mockImplementation(
      async (opts: {
        content: string;
        onTextDelta: (t: string) => void;
        onComplete: () => void;
      }) => {
        turnContents.push(opts.content);
        if (turnContents.length === 1) {
          opts.onTextDelta("Goodbye! [END_CALL]");
        } else if (turnContents.length === 2) {
          // Re-engaged by caller, responds without END_CALL — but then
          // the caller speaks again and we want out.
          opts.onTextDelta("Okay, one quick thing.");
        } else {
          opts.onTextDelta("I have to go now. Goodbye! [END_CALL]");
        }
        opts.onComplete();
        return { turnId: `run-${turnContents.length}`, abort: () => {} };
      },
    );
    const { session, relay, controller } = setupController();

    // First turn: assistant says goodbye with END_CALL (listen window starts)
    await controller.handleCallerUtterance("That is all, thanks");
    expect(relay.endCalled).toBe(false);

    // Caller re-engages during listen window (deferral #1)
    await controller.handleCallerUtterance("Wait, one more thing");
    await new Promise((r) => setTimeout(r, 40));
    expect(relay.endCalled).toBe(false);

    // Caller speaks again — assistant emits END_CALL a second time.
    // After one deferral, this must complete immediately — no listen window.
    await controller.handleCallerUtterance("Just kidding, keep going");
    await new Promise((r) => setTimeout(r, 5));

    expect(relay.endCalled).toBe(true);
    expect(getCallSession(session.id)!.status).toBe("completed");
    controller.destroy();
  });

  test("END_CALL listen window restores in_progress after clearing pending guardian input", async () => {
    mockEndCallListenWindowMs = 30;
    const turnContents: string[] = [];
    mockStartVoiceTurn.mockImplementation(
      async (opts: {
        content: string;
        onTextDelta: (t: string) => void;
        onComplete: () => void;
      }) => {
        turnContents.push(opts.content);
        if (turnContents.length === 1) {
          opts.onTextDelta("Let me check. [ASK_GUARDIAN: Is this okay?]");
        } else if (turnContents.length === 2) {
          opts.onTextDelta("Never mind, goodbye. [END_CALL]");
        } else {
          opts.onTextDelta("I'm still here.");
        }
        opts.onComplete();
        return { turnId: `run-${turnContents.length}`, abort: () => {} };
      },
    );
    const { session, relay, controller } = setupController();

    await controller.handleCallerUtterance("Can you ask?");
    expect(controller.getPendingConsultationQuestionId()).not.toBeNull();
    expect(getCallSession(session.id)!.status).toBe("waiting_on_user");

    await controller.handleCallerUtterance("Actually never mind");
    expect(controller.getPendingConsultationQuestionId()).toBeNull();
    expect(getCallSession(session.id)!.status).toBe("in_progress");
    expect(relay.endCalled).toBe(false);

    await controller.handleCallerUtterance("Wait, one more thing");
    await new Promise((r) => setTimeout(r, 40));

    expect(relay.endCalled).toBe(false);
    expect(getCallSession(session.id)!.status).toBe("in_progress");

    controller.destroy();
  });

  // ── handleUserAnswer ──────────────────────────────────────────────

  test("handleUserAnswer: returns true immediately and fires LLM asynchronously", async () => {
    // First utterance triggers ASK_GUARDIAN
    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn(["Hold on. [ASK_GUARDIAN: Preferred time?]"]),
    );
    const { relay, controller } = setupController();

    await controller.handleCallerUtterance("I need an appointment");

    // Now provide the answer — reset mock for second turn
    mockStartVoiceTurn.mockImplementation(
      async (opts: {
        content: string;
        onTextDelta: (t: string) => void;
        onComplete: () => void;
      }) => {
        expect(opts.content).toContain("[USER_ANSWERED: 3pm tomorrow]");
        const tokens = ["Great, I have scheduled for 3pm tomorrow."];
        for (const token of tokens) {
          opts.onTextDelta(token);
        }
        opts.onComplete();
        return { turnId: "run-2", abort: () => {} };
      },
    );

    const accepted = await controller.handleUserAnswer("3pm tomorrow");
    expect(accepted).toBe(true);

    // handleUserAnswer fires runTurn without awaiting, so give the
    // microtask queue a tick to let the async work complete.
    await new Promise((r) => setTimeout(r, 10));

    // Should have streamed a response for the answer
    const tokensAfterAnswer = relay.sentTokens.filter((t) =>
      t.token.includes("3pm"),
    );
    expect(tokensAfterAnswer.length).toBeGreaterThan(0);

    controller.destroy();
  });

  // ── Full mid-call question flow ──────────────────────────────────

  test("mid-call question flow: unavailable time -> ask user -> user confirms -> resumed call", async () => {
    // Step 1: Caller says "7:30" but it's unavailable. The LLM asks the user.
    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn([
        "I'm sorry, 7:30 is not available. ",
        "[ASK_GUARDIAN: Is 8:00 okay instead?]",
      ]),
    );

    const { session, relay, controller } =
      setupController("Schedule a haircut");

    await controller.handleCallerUtterance("Can I book for 7:30?");

    // Controller returns to idle (non-blocking); consultation tracked separately
    expect(controller.getState()).toBe("idle");
    expect(controller.getPendingConsultationQuestionId()).not.toBeNull();
    const question = getPendingQuestion(session.id);
    expect(question).not.toBeNull();
    expect(question!.questionText).toBe("Is 8:00 okay instead?");

    // Session status in store reflects consultation state
    const midSession = getCallSession(session.id);
    expect(midSession!.status).toBe("waiting_on_user");

    // Step 2: User answers "Yes, 8:00 works"
    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn([
        "Great, I've booked you for 8:00. See you then! ",
        "[END_CALL]",
      ]),
    );

    const accepted = await controller.handleUserAnswer(
      "Yes, 8:00 works for me",
    );
    expect(accepted).toBe(true);

    // Give the fire-and-forget LLM call time to complete
    await new Promise((r) => setTimeout(r, 10));

    // Step 3: Verify call completed
    const endSession = getCallSession(session.id);
    expect(endSession!.status).toBe("completed");
    expect(endSession!.endedAt).not.toBeNull();

    // Verify the END_CALL marker triggered endSession on relay
    expect(relay.endCalled).toBe(true);

    controller.destroy();
  });

  // ── Error handling ────────────────────────────────────────────────

  test("Voice turn error: sends error message to caller and returns to idle", async () => {
    mockStartVoiceTurn.mockImplementation(
      async (opts: { onError: (msg: string) => void }) => {
        opts.onError("API rate limit exceeded");
        return { turnId: "run-err", abort: () => {} };
      },
    );

    const { relay, controller } = setupController();

    await controller.handleCallerUtterance("Hello");

    // Should have sent an error recovery message
    const errorTokens = relay.sentTokens.filter((t) =>
      t.token.includes("technical issue"),
    );
    expect(errorTokens.length).toBeGreaterThan(0);

    // State should return to idle after error
    expect(controller.getState()).toBe("idle");

    controller.destroy();
  });

  test("lock-contention rejection: speaks a brief re-prompt, no technical-issue speech, returns to idle", async () => {
    mockStartVoiceTurn.mockImplementation(async () => {
      throw new Error("Conversation is already processing a message");
    });

    const { relay, controller } = setupController();

    await controller.handleCallerUtterance("Hello");

    // A wedged prior turn must never surface a technical-error message.
    const errorTokens = relay.sentTokens.filter((t) =>
      t.token.includes("technical issue"),
    );
    expect(errorTokens.length).toBe(0);

    // A brief natural re-prompt (last=true) is spoken so the caller knows to
    // repeat themselves and the relay transitions back to listening.
    const reprompts = relay.sentTokens.filter(
      (t) => t.token === "Sorry, could you say that again?" && t.last === true,
    );
    expect(reprompts.length).toBeGreaterThan(0);

    // Controller goes idle and re-arms the silence watchdog.
    expect(controller.getState()).toBe("idle");

    controller.destroy();
  });

  test("genuine non-lock-contention error still speaks the technical-issue fallback", async () => {
    mockStartVoiceTurn.mockImplementation(async () => {
      throw new Error("boom");
    });

    const { relay, controller } = setupController();

    await controller.handleCallerUtterance("Hello");

    const errorTokens = relay.sentTokens.filter((t) =>
      t.token.includes("technical issue"),
    );
    expect(errorTokens.length).toBeGreaterThan(0);
    expect(controller.getState()).toBe("idle");

    controller.destroy();
  });

  test("handleUserAnswer: returns false when no pending consultation exists", async () => {
    const { controller } = setupController();

    // No consultation is pending — answer should be rejected
    const result = await controller.handleUserAnswer("some answer");
    expect(result).toBe(false);

    controller.destroy();
  });

  // ── handleInterrupt ───────────────────────────────────────────────

  test("handleInterrupt: resets state to idle", () => {
    const { controller } = setupController();

    // Calling handleInterrupt should not throw
    controller.handleInterrupt();

    controller.destroy();
  });

  test("handleInterrupt: sends turn terminator when interrupting active speech", async () => {
    mockStartVoiceTurn.mockImplementation(
      async (opts: {
        signal?: AbortSignal;
        onTextDelta: (t: string) => void;
        onComplete: () => void;
      }) => {
        return new Promise((resolve) => {
          // Emit a token right away so the assistant is actively speaking
          // (state flips to `speaking`) before the interrupt arrives.
          opts.onTextDelta("This should be interrupted");

          opts.signal?.addEventListener(
            "abort",
            () => {
              // In the real system, generation_cancelled triggers
              // onComplete via the event sink. The AbortSignal listener
              // in call-controller also resolves turnComplete defensively.
              opts.onComplete();
              resolve({ turnId: "run-1", abort: () => {} });
            },
            { once: true },
          );
        });
      },
    );

    const { relay, controller } = setupController();
    const turnPromise = controller.handleCallerUtterance("Start speaking");
    await new Promise((r) => setTimeout(r, 5));
    controller.handleInterrupt();
    await turnPromise;

    const endTurnMarkers = relay.sentTokens.filter(
      (t) => t.token === "" && t.last === true,
    );
    expect(endTurnMarkers.length).toBeGreaterThan(0);

    controller.destroy();
  });

  test("handleInterrupt: turnComplete settles even when event sink callbacks are not called", async () => {
    // Simulate a turn that never calls onComplete or onError on abort —
    // the defensive AbortSignal listener in runTurn() should settle the promise.
    mockStartVoiceTurn.mockImplementation(
      async (opts: {
        signal?: AbortSignal;
        onTextDelta: (t: string) => void;
        onComplete: () => void;
      }) => {
        return new Promise((resolve) => {
          const timeout = setTimeout(() => {
            opts.onTextDelta("Long running turn");
            opts.onComplete();
            resolve({ turnId: "run-1", abort: () => {} });
          }, 5000);

          opts.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timeout);
              // Intentionally do NOT call onComplete — simulates the old
              // broken path where generation_cancelled was not forwarded.
              resolve({ turnId: "run-1", abort: () => {} });
            },
            { once: true },
          );
        });
      },
    );

    const { controller } = setupController();
    const turnPromise = controller.handleCallerUtterance("Start speaking");
    await new Promise((r) => setTimeout(r, 5));
    controller.handleInterrupt();

    // Should not hang — the AbortSignal listener resolves the promise
    await turnPromise;

    expect(controller.getState()).toBe("idle");

    controller.destroy();
  });

  // ── Guardian context pass-through ──────────────────────────────────

  test("handleCallerUtterance: passes guardian context to startVoiceTurn", async () => {
    const trustCtx = {
      sourceChannel: "phone" as const,
      trustClass: "trusted_contact" as const,
      guardianExternalUserId: "+15550009999",
      guardianChatId: "+15550009999",
      requesterExternalUserId: "+15550002222",
    };

    let capturedTrustContext: unknown = undefined;
    mockStartVoiceTurn.mockImplementation(
      async (opts: {
        trustContext?: unknown;
        onTextDelta: (t: string) => void;
        onComplete: () => void;
      }) => {
        capturedTrustContext = opts.trustContext;
        opts.onTextDelta("Hello.");
        opts.onComplete();
        return { turnId: "run-gc", abort: () => {} };
      },
    );

    const { controller } = setupController(undefined, {
      trustContext: trustCtx,
    });

    await controller.handleCallerUtterance("Hello");

    expect(capturedTrustContext).toEqual(trustCtx);

    controller.destroy();
  });

  test("handleCallerUtterance: passes assistantId to startVoiceTurn", async () => {
    let capturedAssistantId: string | undefined;
    mockStartVoiceTurn.mockImplementation(
      async (opts: {
        assistantId?: string;
        onTextDelta: (t: string) => void;
        onComplete: () => void;
      }) => {
        capturedAssistantId = opts.assistantId;
        opts.onTextDelta("Hello.");
        opts.onComplete();
        return { turnId: "run-aid", abort: () => {} };
      },
    );

    const { controller } = setupController(undefined, {
      assistantId: "my-assistant",
    });

    await controller.handleCallerUtterance("Hello");

    expect(capturedAssistantId).toBe("my-assistant");

    controller.destroy();
  });

  test("setTrustContext: subsequent turns use updated guardian context", async () => {
    const initialCtx = {
      sourceChannel: "phone" as const,
      trustClass: "unknown" as const,
    };

    const upgradedCtx = {
      sourceChannel: "phone" as const,
      trustClass: "guardian" as const,
      guardianExternalUserId: "+15550003333",
      guardianChatId: "+15550003333",
    };

    const capturedContexts: unknown[] = [];
    mockStartVoiceTurn.mockImplementation(
      async (opts: {
        trustContext?: unknown;
        onTextDelta: (t: string) => void;
        onComplete: () => void;
      }) => {
        capturedContexts.push(opts.trustContext);
        opts.onTextDelta("Response.");
        opts.onComplete();
        return { turnId: `run-${capturedContexts.length}`, abort: () => {} };
      },
    );

    const { controller } = setupController(undefined, {
      trustContext: initialCtx,
    });

    // First turn: unverified
    await controller.handleCallerUtterance("Hello");
    expect(capturedContexts[0]).toEqual(initialCtx);

    // Simulate guardian verification succeeding
    controller.setTrustContext(upgradedCtx);

    // Second turn: should use upgraded guardian context
    await controller.handleCallerUtterance("I verified");
    expect(capturedContexts[1]).toEqual(upgradedCtx);

    controller.destroy();
  });

  // ── destroy ───────────────────────────────────────────────────────

  test("destroy: unregisters controller", () => {
    const { session, controller } = setupController();

    // Controller should be registered
    expect(getCallController(session.id)).toBeDefined();

    controller.destroy();

    // After destroy, controller should be unregistered
    expect(getCallController(session.id)).toBeUndefined();
  });

  test("destroy: can be called multiple times without error", () => {
    const { controller } = setupController();

    controller.destroy();
    // Second destroy should not throw
    expect(() => controller.destroy()).not.toThrow();
  });

  test("destroy: during active turn does not trigger post-turn side effects", async () => {
    // Simulate a turn that completes after destroy() is called
    mockStartVoiceTurn.mockImplementation(
      async (opts: {
        signal?: AbortSignal;
        onTextDelta: (t: string) => void;
        onComplete: () => void;
      }) => {
        return new Promise((resolve) => {
          const timeout = setTimeout(() => {
            opts.onTextDelta("This is a long response");
            opts.onComplete();
            resolve({ turnId: "run-1", abort: () => {} });
          }, 1000);

          opts.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timeout);
              // The defensive abort listener in runTurn resolves turnComplete
              opts.onComplete();
              resolve({ turnId: "run-1", abort: () => {} });
            },
            { once: true },
          );
        });
      },
    );

    const { relay, controller } = setupController();
    const turnPromise = controller.handleCallerUtterance("Start speaking");

    // Let the turn start
    await new Promise((r) => setTimeout(r, 5));

    // Destroy the controller while the turn is active
    controller.destroy();

    // Wait for the turn to settle
    await turnPromise;

    // Verify that NO spurious post-turn side effects occurred after destroy:
    // - No final empty-string sendTextToken('', true) call after abort
    // The only end marker should be from handleInterrupt, not from post-turn logic
    const endMarkers = relay.sentTokens.filter(
      (t) => t.token === "" && t.last === true,
    );

    // destroy() increments llmRunVersion, so isCurrentRun() returns false
    // for the aborted turn, preventing post-turn side effects including
    // the spurious relay.sendTextToken('', true) on line 418.
    expect(endMarkers.length).toBe(0);
  });

  // ── handleUserInstruction ─────────────────────────────────────────

  test("handleUserInstruction: injects instruction marker and triggers turn when idle", async () => {
    mockStartVoiceTurn.mockImplementation(
      async (opts: {
        content: string;
        onTextDelta: (t: string) => void;
        onComplete: () => void;
      }) => {
        expect(opts.content).toContain(
          "[USER_INSTRUCTION: Ask about their weekend plans]",
        );
        const tokens = ["Sure, do you have any weekend plans?"];
        for (const token of tokens) {
          opts.onTextDelta(token);
        }
        opts.onComplete();
        return { turnId: "run-instr", abort: () => {} };
      },
    );

    const { relay, controller } = setupController();

    await controller.handleUserInstruction("Ask about their weekend plans");

    // Should have streamed a response since controller was idle
    const nonEmptyTokens = relay.sentTokens.filter((t) => t.token.length > 0);
    expect(nonEmptyTokens.length).toBeGreaterThan(0);

    controller.destroy();
  });

  test("handleUserInstruction: emits user_instruction_relayed event", async () => {
    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn(["Understood, adjusting approach."]),
    );

    const { session, controller } = setupController();

    await controller.handleUserInstruction("Be more formal in your tone");

    const events = getCallEvents(session.id);
    const instructionEvents = events.filter(
      (e) => e.eventType === "user_instruction_relayed",
    );
    expect(instructionEvents.length).toBe(1);

    const payload = JSON.parse(instructionEvents[0].payloadJson);
    expect(payload.instruction).toBe("Be more formal in your tone");

    controller.destroy();
  });

  // ── Non-blocking consultation: caller follow-up during pending consultation ──

  test("handleCallerUtterance: triggers normal turn while consultation is pending (non-blocking)", async () => {
    // Trigger ASK_GUARDIAN to start a consultation
    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn(["Hold on. [ASK_GUARDIAN: What time works?]"]),
    );
    const { controller } = setupController();
    await controller.handleCallerUtterance("Book me in");
    // Controller returns to idle; consultation tracked separately
    expect(controller.getState()).toBe("idle");
    expect(controller.getPendingConsultationQuestionId()).not.toBeNull();

    // Track calls to startVoiceTurn from this point
    let turnCallCount = 0;
    mockStartVoiceTurn.mockImplementation(
      async (opts: {
        onTextDelta: (t: string) => void;
        onComplete: () => void;
      }) => {
        turnCallCount++;
        opts.onTextDelta("Sure, let me help with that.");
        opts.onComplete();
        return { turnId: "run-followup", abort: () => {} };
      },
    );

    // Caller speaks while consultation is pending — should trigger a normal turn
    await controller.handleCallerUtterance("Hello? Are you still there?");
    expect(turnCallCount).toBe(1);
    // Controller returns to idle after the turn completes
    expect(controller.getState()).toBe("idle");
    // Consultation should still be pending
    expect(controller.getPendingConsultationQuestionId()).not.toBeNull();

    controller.destroy();
  });

  test("guardian answer arriving while controller idle: queued as instruction and flushed immediately", async () => {
    // Trigger ASK_GUARDIAN to start a consultation
    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn(["Checking. [ASK_GUARDIAN: Confirm appointment?]"]),
    );
    const { controller } = setupController();
    await controller.handleCallerUtterance("I want to schedule");
    expect(controller.getState()).toBe("idle");
    expect(controller.getPendingConsultationQuestionId()).not.toBeNull();

    // Set up mock for the answer turn
    const turnContents: string[] = [];
    mockStartVoiceTurn.mockImplementation(
      async (opts: {
        content: string;
        onTextDelta: (t: string) => void;
        onComplete: () => void;
      }) => {
        turnContents.push(opts.content);
        opts.onTextDelta("Confirmed.");
        opts.onComplete();
        return { turnId: `run-${turnContents.length}`, abort: () => {} };
      },
    );

    const accepted = await controller.handleUserAnswer("Yes, confirmed");
    expect(accepted).toBe(true);

    // Give fire-and-forget turns time to complete
    await new Promise((r) => setTimeout(r, 10));

    // The answer turn should have fired with the USER_ANSWERED marker
    expect(
      turnContents.some((c) => c.includes("[USER_ANSWERED: Yes, confirmed]")),
    ).toBe(true);
    // Consultation should now be cleared
    expect(controller.getPendingConsultationQuestionId()).toBeNull();

    controller.destroy();
  });

  test("no duplicate guardian dispatch: repeated informational ASK_GUARDIAN coalesces with existing consultation", async () => {
    // Trigger ASK_GUARDIAN to start first consultation
    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn(["Let me ask. [ASK_GUARDIAN: Preferred date?]"]),
    );
    const { session, controller } = setupController();
    await controller.handleCallerUtterance("Schedule please");
    expect(controller.getState()).toBe("idle");
    const firstQuestionId = controller.getPendingConsultationQuestionId();
    expect(firstQuestionId).not.toBeNull();

    // Model emits another informational ASK_GUARDIAN in a subsequent turn —
    // should coalesce (same tool scope: both lack tool metadata)
    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn([
        "Actually let me re-check. [ASK_GUARDIAN: Preferred date again?]",
      ]),
    );
    await controller.handleCallerUtterance("Hello?");

    // Consultation should be coalesced — same question ID retained
    const secondQuestionId = controller.getPendingConsultationQuestionId();
    expect(secondQuestionId).not.toBeNull();
    expect(secondQuestionId).toBe(firstQuestionId);

    // The session status should still be waiting_on_user
    const updatedSession = getCallSession(session.id);
    expect(updatedSession!.status).toBe("waiting_on_user");

    controller.destroy();
  });

  test("handleUserAnswer: returns false when no pending consultation (stale/duplicate guard)", async () => {
    const { controller } = setupController();

    // No consultation pending — idle state, answer rejected
    expect(await controller.handleUserAnswer("some answer")).toBe(false);

    // Start a turn to enter processing state — still no consultation
    mockStartVoiceTurn.mockImplementation(
      async (opts: {
        onTextDelta: (t: string) => void;
        onComplete: () => void;
      }) => {
        await new Promise((r) => setTimeout(r, 20));
        opts.onTextDelta("Response.");
        opts.onComplete();
        return { turnId: "run-proc", abort: () => {} };
      },
    );
    const turnPromise = controller.handleCallerUtterance("Test");
    await new Promise((r) => setTimeout(r, 10));
    // No consultation → answer rejected regardless of controller state
    expect(await controller.handleUserAnswer("stale answer")).toBe(false);

    // Clean up
    await turnPromise.catch(() => {});
    controller.destroy();
  });

  test("duplicate answer to same consultation: first accepted, second rejected", async () => {
    // Trigger ASK_GUARDIAN consultation
    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn(["Hold on. [ASK_GUARDIAN: What time?]"]),
    );
    const { controller } = setupController();
    await controller.handleCallerUtterance("Book me");
    expect(controller.getPendingConsultationQuestionId()).not.toBeNull();

    // Set up mock for the answer turn
    mockStartVoiceTurn.mockImplementation(
      async (opts: {
        content: string;
        onTextDelta: (t: string) => void;
        onComplete: () => void;
      }) => {
        opts.onTextDelta("Got it.");
        opts.onComplete();
        return { turnId: "run-answer", abort: () => {} };
      },
    );

    // First answer is accepted
    const first = await controller.handleUserAnswer("3pm");
    expect(first).toBe(true);
    expect(controller.getPendingConsultationQuestionId()).toBeNull();

    // Second answer is rejected — consultation already consumed
    const second = await controller.handleUserAnswer("4pm");
    expect(second).toBe(false);

    await new Promise((r) => setTimeout(r, 10));
    controller.destroy();
  });

  test("handleUserInstruction: queues when processing, but triggers when idle", async () => {
    // Track content passed to each voice turn invocation
    const turnContents: string[] = [];
    let turnCount = 0;

    // Start a slow turn to put controller in processing/speaking state.
    // After the first turn completes, the mock switches to a fast handler
    // that captures content so we can verify the flushed instruction.
    mockStartVoiceTurn.mockImplementation(
      async (opts: {
        content: string;
        onTextDelta: (t: string) => void;
        onComplete: () => void;
      }) => {
        turnCount++;
        if (turnCount === 1) {
          // First turn: slow, simulates processing state
          await new Promise((r) => setTimeout(r, 20));
          opts.onTextDelta("Response.");
          opts.onComplete();
          return { turnId: "run-1", abort: () => {} };
        }
        // Subsequent turns: capture content and complete immediately
        turnContents.push(opts.content);
        opts.onTextDelta("Noted.");
        opts.onComplete();
        return { turnId: `run-${turnCount}`, abort: () => {} };
      },
    );

    const { session, controller } = setupController();
    const turnPromise = controller.handleCallerUtterance("Hello");
    await new Promise((r) => setTimeout(r, 10));

    // Inject instruction while processing — should be queued
    await controller.handleUserInstruction("Suggest morning slots");

    // Event should be recorded even when queued
    const events = getCallEvents(session.id);
    const instructionEvents = events.filter(
      (e) => e.eventType === "user_instruction_relayed",
    );
    expect(instructionEvents.length).toBe(1);

    // Wait for the first turn to finish (instructions flushed at turn boundary)
    await turnPromise;

    // Allow the fire-and-forget flush turn to execute
    await new Promise((r) => setTimeout(r, 10));

    // The queued instruction should have been flushed into a new turn
    expect(turnContents.length).toBeGreaterThanOrEqual(1);
    expect(
      turnContents.some((c) =>
        c.includes("[USER_INSTRUCTION: Suggest morning slots]"),
      ),
    ).toBe(true);

    // Controller should return to idle after the flush turn completes
    expect(controller.getState()).toBe("idle");

    controller.destroy();
  });

  // ── Post-end-call drain guard ───────────────────────────────────

  test("handleUserAnswer: answer turn ends call with END_CALL, no further turns after completion", async () => {
    // Trigger ASK_GUARDIAN to start a consultation
    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn(["Checking. [ASK_GUARDIAN: Confirm cancellation?]"]),
    );
    const { session, relay, controller } = setupController();
    await controller.handleCallerUtterance("I want to cancel");
    expect(controller.getState()).toBe("idle");
    expect(controller.getPendingConsultationQuestionId()).not.toBeNull();

    // Set up mock so the answer turn ends the call with [END_CALL]
    const turnContents: string[] = [];
    mockStartVoiceTurn.mockImplementation(
      async (opts: {
        content: string;
        onTextDelta: (t: string) => void;
        onComplete: () => void;
      }) => {
        turnContents.push(opts.content);
        opts.onTextDelta(
          "Alright, your appointment is cancelled. Goodbye! [END_CALL]",
        );
        opts.onComplete();
        return { turnId: `run-${turnContents.length}`, abort: () => {} };
      },
    );

    const accepted = await controller.handleUserAnswer("Yes, cancel it");
    expect(accepted).toBe(true);

    // Give fire-and-forget turns time to complete
    await new Promise((r) => setTimeout(r, 10));

    // The answer turn should have fired
    expect(
      turnContents.some((c) => c.includes("[USER_ANSWERED: Yes, cancel it]")),
    ).toBe(true);

    // Call should be completed
    const updatedSession = getCallSession(session.id);
    expect(updatedSession!.status).toBe("completed");
    expect(relay.endCalled).toBe(true);

    controller.destroy();
  });

  // ── Consultation timeout with generated turn ─────────────────────

  test("consultation timeout: fires generated turn with GUARDIAN_TIMEOUT instruction instead of hardcoded text", async () => {
    // Use a short consultation timeout so we can wait for it in the test
    mockConsultationTimeoutMs = 200;

    // Trigger ASK_GUARDIAN to start a consultation
    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn(["Let me check. [ASK_GUARDIAN: What time works?]"]),
    );
    const { session, relay, controller } = setupController();
    try {
      await controller.handleCallerUtterance("Book me in");
      expect(controller.getState()).toBe("idle");
      expect(controller.getPendingConsultationQuestionId()).not.toBeNull();

      // Set up mock to capture what content the timeout turn receives
      const turnContents: string[] = [];
      mockStartVoiceTurn.mockImplementation(
        async (opts: {
          content: string;
          onTextDelta: (t: string) => void;
          onComplete: () => void;
        }) => {
          turnContents.push(opts.content);
          opts.onTextDelta(
            "I'm sorry, I wasn't able to reach them. Would you like a callback?",
          );
          opts.onComplete();
          return { turnId: `run-${turnContents.length}`, abort: () => {} };
        },
      );

      // Poll until the consultation timeout fires and generates a turn
      await pollUntil(() => turnContents.length > 0);

      // A generated turn should have been fired with the GUARDIAN_TIMEOUT instruction.
      // The instruction starts with '[' so flushPendingInstructions passes it through
      // without wrapping it in [USER_INSTRUCTION:].
      expect(turnContents.length).toBe(1);
      expect(turnContents[0]).toContain("[GUARDIAN_TIMEOUT]");
      expect(turnContents[0]).toContain("What time works?");

      // No hardcoded timeout text should appear in relay tokens
      const allText = relay.sentTokens.map((t) => t.token).join("");
      expect(allText).not.toContain(
        "I'm sorry, I wasn't able to get that information in time",
      );
      expect(allText).toContain("callback");

      // Session should be back in progress
      const updatedSession = getCallSession(session.id);
      expect(updatedSession!.status).toBe("in_progress");
    } finally {
      controller.destroy();
    }
  });

  test("consultation timeout: timeout instruction fires even when controller is idle", async () => {
    // Use a short consultation timeout so we can wait for it in the test
    mockConsultationTimeoutMs = 200;

    // Trigger ASK_GUARDIAN to start a consultation
    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn(["Let me check. [ASK_GUARDIAN: What time works?]"]),
    );
    const { controller } = setupController();
    try {
      await controller.handleCallerUtterance("Book me in");
      expect(controller.getState()).toBe("idle");
      expect(controller.getPendingConsultationQuestionId()).not.toBeNull();

      // Set up mock to capture what content the timeout turn receives
      const turnContents: string[] = [];
      mockStartVoiceTurn.mockImplementation(
        async (opts: {
          content: string;
          onTextDelta: (t: string) => void;
          onComplete: () => void;
        }) => {
          turnContents.push(opts.content);
          opts.onTextDelta("Got it, I was unable to reach them.");
          opts.onComplete();
          return { turnId: `run-${turnContents.length}`, abort: () => {} };
        },
      );

      // Poll until the consultation timeout fires and generates a turn
      await pollUntil(() => turnContents.length > 0);

      // The timeout instruction turn should have fired
      const timeoutTurns = turnContents.filter((c) =>
        c.includes("[GUARDIAN_TIMEOUT]"),
      );
      expect(timeoutTurns.length).toBe(1);
      expect(timeoutTurns[0]).toContain("What time works?");

      // Consultation should be cleared after timeout
      expect(controller.getPendingConsultationQuestionId()).toBeNull();
    } finally {
      controller.destroy();
    }
  });

  test("consultation timeout: marks linked guardian action request as timed out", async () => {
    mockConsultationTimeoutMs = 200;

    // Trigger ASK_GUARDIAN to start a consultation
    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn(["Let me check. [ASK_GUARDIAN: What time works?]"]),
    );
    const { session, controller } = setupController();
    try {
      await controller.handleCallerUtterance("Book me in");
      expect(controller.getState()).toBe("idle");
      expect(controller.getPendingConsultationQuestionId()).not.toBeNull();

      // Poll until the async dispatchGuardianQuestion creates the request
      // (the dispatch is fire-and-forget and may take longer on slow CI)
      await pollUntil(() => !!pendingRequestByCallSession(session.id));

      // Verify a guardian action request was created
      const pendingRequest = pendingRequestByCallSession(session.id);
      expect(pendingRequest).not.toBeNull();
      expect(pendingRequest!.status).toBe("pending");

      // Set up mock for the timeout-generated turn
      mockStartVoiceTurn.mockImplementation(
        createMockVoiceTurn([
          "I'm sorry, I couldn't reach them. Would you like a callback?",
        ]),
      );

      // Poll until the consultation timeout fires and expires the request
      await pollUntil(() => {
        const req = bridgeState.getRequest(pendingRequest!.id);
        return req?.status === "expired";
      });

      // Event should be recorded
      const events = getCallEvents(session.id);
      const timeoutEvents = events.filter(
        (e) => e.eventType === "guardian_consultation_timed_out",
      );
      expect(timeoutEvents.length).toBe(1);
    } finally {
      controller.destroy();
    }
  });

  // ── Guardian unavailable skip after timeout ────────────────────────

  test("ASK_GUARDIAN after timeout: skips wait and injects GUARDIAN_UNAVAILABLE instruction", async () => {
    mockConsultationTimeoutMs = 200;

    // Step 1: Trigger ASK_GUARDIAN to start a consultation
    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn(["Let me check. [ASK_GUARDIAN: What time works?]"]),
    );
    const { session, controller } = setupController();
    try {
      await controller.handleCallerUtterance("Book me in");
      expect(controller.getState()).toBe("idle");
      expect(controller.getPendingConsultationQuestionId()).not.toBeNull();

      // Step 2: Set up mock for timeout-generated turn
      mockStartVoiceTurn.mockImplementation(
        createMockVoiceTurn([
          "I'm sorry, I couldn't reach them. Would you like a callback?",
        ]),
      );

      // Poll until the consultation timeout fires and clears the pending consultation
      await pollUntil(() => !controller.getPendingConsultationQuestionId());
      expect(controller.getState()).toBe("idle");

      // Step 3: Model tries ASK_GUARDIAN again in a subsequent turn
      const turnContents: string[] = [];
      let turnCount = 0;
      mockStartVoiceTurn.mockImplementation(
        async (opts: {
          content: string;
          onTextDelta: (t: string) => void;
          onComplete: () => void;
        }) => {
          turnCount++;
          turnContents.push(opts.content);
          if (turnCount === 1) {
            // First turn: model emits ASK_GUARDIAN again
            opts.onTextDelta(
              "Let me check on that. [ASK_GUARDIAN: What about 3pm?]",
            );
          } else {
            // Second turn: model should handle the GUARDIAN_UNAVAILABLE instruction
            opts.onTextDelta(
              "Unfortunately I can't reach them. Anything else I can help with?",
            );
          }
          opts.onComplete();
          return { turnId: `run-${turnCount}`, abort: () => {} };
        },
      );

      await controller.handleCallerUtterance("Can we try another time?");

      // Give the queued instruction flush time to fire
      await new Promise((r) => setTimeout(r, 10));

      // The second turn should contain the GUARDIAN_UNAVAILABLE instruction
      expect(turnCount).toBeGreaterThanOrEqual(2);
      expect(
        turnContents.some((c) => c.includes("[GUARDIAN_UNAVAILABLE]")),
      ).toBe(true);
      // Controller remains idle; no new consultation created
      expect(controller.getState()).toBe("idle");
      expect(controller.getPendingConsultationQuestionId()).toBeNull();

      // The skip should be recorded as an event
      const events = getCallEvents(session.id);
      const skipEvents = events.filter(
        (e) => e.eventType === "guardian_unavailable_skipped",
      );
      expect(skipEvents.length).toBe(1);
    } finally {
      controller.destroy();
    }
  });

  // ── Structured tool-approval ASK_GUARDIAN_APPROVAL ──────────────────

  test("ASK_GUARDIAN_APPROVAL: persists toolName and inputDigest on guardian action request", async () => {
    const approvalPayload = JSON.stringify({
      question: "Allow send_email to bob@example.com?",
      toolName: "send_email",
      input: { to: "bob@example.com", subject: "Hello" },
    });
    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn([
        `Let me check with your guardian. [ASK_GUARDIAN_APPROVAL: ${approvalPayload}]`,
      ]),
    );
    const { session, relay, controller } = setupController("Send an email");

    await controller.handleCallerUtterance("Send an email to Bob");

    // Give the async dispatchGuardianQuestion a tick to create the request
    await new Promise((r) => setTimeout(r, 10));

    // Controller returns to idle (non-blocking); consultation tracked separately
    expect(controller.getState()).toBe("idle");
    expect(controller.getPendingConsultationQuestionId()).not.toBeNull();

    // Verify a pending question was created with the correct text
    const question = getPendingQuestion(session.id);
    expect(question).not.toBeNull();
    expect(question!.questionText).toBe("Allow send_email to bob@example.com?");

    // Verify the guardian action request has tool metadata
    const pendingRequest = pendingRequestByCallSession(session.id);
    expect(pendingRequest).not.toBeNull();
    expect(pendingRequest!.toolName).toBe("send_email");
    expect(pendingRequest!.inputDigest).not.toBeNull();
    expect(pendingRequest!.inputDigest!.length).toBe(64); // SHA-256 hex = 64 chars

    // The ASK_GUARDIAN_APPROVAL marker should NOT appear in the relay tokens
    const allText = relay.sentTokens.map((t) => t.token).join("");
    expect(allText).not.toContain("[ASK_GUARDIAN_APPROVAL:");
    expect(allText).not.toContain("send_email");

    controller.destroy();
  });

  test("ASK_GUARDIAN_APPROVAL: computes deterministic digest for same tool+input", async () => {
    const approvalPayload = JSON.stringify({
      question: "Allow send_email?",
      toolName: "send_email",
      input: { subject: "Hello", to: "bob@example.com" },
    });
    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn([
        `Checking. [ASK_GUARDIAN_APPROVAL: ${approvalPayload}]`,
      ]),
    );
    const { session, controller } = setupController("Send email");

    await controller.handleCallerUtterance("Send it");
    await new Promise((r) => setTimeout(r, 10));

    const request1 = pendingRequestByCallSession(session.id);
    expect(request1).not.toBeNull();

    // Compute expected digest independently using the same utility
    const { computeToolApprovalDigest } =
      await import("../security/tool-approval-digest.js");
    const expectedDigest = computeToolApprovalDigest("send_email", {
      subject: "Hello",
      to: "bob@example.com",
    });
    expect(request1!.inputDigest).toBe(expectedDigest);

    controller.destroy();
  });

  test("informational ASK_GUARDIAN: does NOT persist tool metadata (null toolName/inputDigest)", async () => {
    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn([
        "Let me check. [ASK_GUARDIAN: What date works best?]",
      ]),
    );
    const { session, controller } = setupController("Book appointment");

    await controller.handleCallerUtterance("I need to schedule something");
    await new Promise((r) => setTimeout(r, 10));

    // Verify the guardian action request has NO tool metadata
    const pendingRequest = pendingRequestByCallSession(session.id);
    expect(pendingRequest).not.toBeNull();
    expect(pendingRequest!.toolName).toBeNull();
    expect(pendingRequest!.inputDigest).toBeNull();
    expect(pendingRequest!.questionText).toBe("What date works best?");

    controller.destroy();
  });

  test("ASK_GUARDIAN_APPROVAL: strips marker from TTS output", async () => {
    const approvalPayload = JSON.stringify({
      question: "Allow calendar_create?",
      toolName: "calendar_create",
      input: { date: "2026-03-01", title: "Meeting" },
    });
    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn([
        "Let me get approval for that. ",
        `[ASK_GUARDIAN_APPROVAL: ${approvalPayload}]`,
        " Thank you.",
      ]),
    );
    const { relay, controller } = setupController("Create event");

    await controller.handleCallerUtterance("Create a meeting");

    const allText = relay.sentTokens.map((t) => t.token).join("");
    expect(allText).toContain("Let me get approval");
    expect(allText).not.toContain("[ASK_GUARDIAN_APPROVAL:");
    expect(allText).not.toContain("calendar_create");
    expect(allText).not.toContain("inputDigest");

    controller.destroy();
  });

  test("ASK_GUARDIAN_APPROVAL: handles JSON payloads containing }] in string values", async () => {
    // The `}]` sequence inside a JSON string value previously caused the
    // non-greedy regex to terminate early, truncating the JSON and leaking
    // partial data into TTS output.
    const approvalPayload = JSON.stringify({
      question: "Allow send_message?",
      toolName: "send_message",
      input: { msg: "test}]more", nested: { key: "value with }] braces" } },
    });
    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn([
        `Let me check. [ASK_GUARDIAN_APPROVAL: ${approvalPayload}]`,
      ]),
    );
    const { session, relay, controller } = setupController("Send a message");

    await controller.handleCallerUtterance("Send it");
    await new Promise((r) => setTimeout(r, 10));

    // Controller returns to idle (non-blocking); consultation tracked separately
    expect(controller.getState()).toBe("idle");
    expect(controller.getPendingConsultationQuestionId()).not.toBeNull();
    const question = getPendingQuestion(session.id);
    expect(question).not.toBeNull();
    expect(question!.questionText).toBe("Allow send_message?");

    // Verify tool metadata was parsed correctly
    const pendingRequest = pendingRequestByCallSession(session.id);
    expect(pendingRequest).not.toBeNull();
    expect(pendingRequest!.toolName).toBe("send_message");
    expect(pendingRequest!.inputDigest).not.toBeNull();

    // No partial JSON or marker text should leak into TTS output
    const allText = relay.sentTokens.map((t) => t.token).join("");
    expect(allText).not.toContain("[ASK_GUARDIAN_APPROVAL:");
    expect(allText).not.toContain("send_message");
    expect(allText).not.toContain("}]");
    expect(allText).not.toContain("test}]more");
    expect(allText).toContain("Let me check.");

    controller.destroy();
  });

  test("ASK_GUARDIAN_APPROVAL with malformed JSON: falls through to informational ASK_GUARDIAN", async () => {
    // Malformed JSON in the approval marker — should be ignored, and if there's
    // also an informational ASK_GUARDIAN marker, it should be used instead
    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn([
        "Checking. [ASK_GUARDIAN_APPROVAL: {invalid json}] [ASK_GUARDIAN: Fallback question?]",
      ]),
    );
    const { session, controller } = setupController("Test fallback");

    await controller.handleCallerUtterance("Do something");
    await new Promise((r) => setTimeout(r, 10));

    const pendingRequest = pendingRequestByCallSession(session.id);
    expect(pendingRequest).not.toBeNull();
    expect(pendingRequest!.questionText).toBe("Fallback question?");
    // Tool metadata should be null since the approval marker was malformed
    expect(pendingRequest!.toolName).toBeNull();
    expect(pendingRequest!.inputDigest).toBeNull();

    controller.destroy();
  });

  // ── Non-blocking race safety ───────────────────────────────────────

  test("guardian answer during processing/speaking: queued in pendingInstructions and applied at next turn boundary", async () => {
    // Trigger ASK_GUARDIAN to start a consultation
    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn(["Checking. [ASK_GUARDIAN: Confirm appointment?]"]),
    );
    const { controller } = setupController();
    await controller.handleCallerUtterance("I want to schedule");
    expect(controller.getState()).toBe("idle");
    expect(controller.getPendingConsultationQuestionId()).not.toBeNull();

    // Start a new turn (caller follow-up) to put controller in processing state
    let firstTurnResolve: (() => void) | null = null;
    const turnContents: string[] = [];
    mockStartVoiceTurn.mockImplementation(
      async (opts: {
        content: string;
        onTextDelta: (t: string) => void;
        onComplete: () => void;
      }) => {
        turnContents.push(opts.content);
        if (!firstTurnResolve) {
          // First turn: pause to simulate processing state
          await new Promise<void>((resolve) => {
            firstTurnResolve = resolve;
          });
        }
        opts.onTextDelta("Response.");
        opts.onComplete();
        return { turnId: `run-${turnContents.length}`, abort: () => {} };
      },
    );

    // Start a caller turn that will pause mid-processing
    const callerTurnPromise = controller.handleCallerUtterance(
      "Are you still there?",
    );
    await new Promise((r) => setTimeout(r, 10));
    // The turn is paused before emitting any token, so the controller is still
    // in the pre-speech `processing` phase (it only flips to `speaking` once
    // real outbound audio/tokens begin).
    expect(controller.getState()).toBe("processing");

    // Answer arrives while the controller is processing/speaking
    const accepted = await controller.handleUserAnswer("3pm works");
    expect(accepted).toBe(true);
    // Consultation is consumed immediately
    expect(controller.getPendingConsultationQuestionId()).toBeNull();

    // Complete the first turn so the answer instruction flushes
    firstTurnResolve!();
    await callerTurnPromise;

    // Give the flushed instruction turn time to complete
    await new Promise((r) => setTimeout(r, 10));

    // The queued USER_ANSWERED instruction should have been applied
    expect(
      turnContents.some((c) => c.includes("[USER_ANSWERED: 3pm works]")),
    ).toBe(true);

    controller.destroy();
  });

  test("timeout + late answer: after timeout, a late answer is rejected as stale", async () => {
    mockConsultationTimeoutMs = 200;

    // Trigger ASK_GUARDIAN to start a consultation
    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn(["Let me check. [ASK_GUARDIAN: What time works?]"]),
    );
    const { controller } = setupController();
    try {
      await controller.handleCallerUtterance("Book me in");
      expect(controller.getPendingConsultationQuestionId()).not.toBeNull();

      // Set up mock for the timeout-generated turn
      mockStartVoiceTurn.mockImplementation(
        createMockVoiceTurn(["Sorry, I could not reach them."]),
      );

      // Poll until the consultation timeout clears the pending consultation
      await pollUntil(() => !controller.getPendingConsultationQuestionId());

      // A late answer should be rejected
      const lateResult = await controller.handleUserAnswer("3pm is fine");
      expect(lateResult).toBe(false);
    } finally {
      controller.destroy();
    }
  });

  test("caller follow-up processed normally while consultation pending", async () => {
    // Trigger ASK_GUARDIAN to start a consultation
    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn(["Let me check. [ASK_GUARDIAN: What date?]"]),
    );
    const { relay, controller } = setupController();
    await controller.handleCallerUtterance("Schedule something");
    expect(controller.getPendingConsultationQuestionId()).not.toBeNull();

    // Caller follows up while consultation is pending
    const turnContents: string[] = [];
    mockStartVoiceTurn.mockImplementation(
      async (opts: {
        content: string;
        onTextDelta: (t: string) => void;
        onComplete: () => void;
      }) => {
        turnContents.push(opts.content);
        opts.onTextDelta("Of course, what else can I help with?");
        opts.onComplete();
        return { turnId: `run-${turnContents.length}`, abort: () => {} };
      },
    );

    await controller.handleCallerUtterance("Can you also check availability?");

    // The follow-up should trigger a normal turn (non-blocking)
    expect(turnContents.length).toBe(1);
    expect(turnContents[0]).toContain("Can you also check availability?");

    // Consultation should still be pending
    expect(controller.getPendingConsultationQuestionId()).not.toBeNull();

    // Response should appear in relay
    const allText = relay.sentTokens.map((t) => t.token).join("");
    expect(allText).toContain("what else can I help with");

    controller.destroy();
  });

  // ── Consultation coalescing (Incident C) ────────────────────────────

  test("coalescing: repeated identical informational ASK_GUARDIAN does not create a new request", async () => {
    // Trigger first ASK_GUARDIAN
    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn(["Let me ask. [ASK_GUARDIAN: Preferred date?]"]),
    );
    const { session, controller } = setupController();
    await controller.handleCallerUtterance("Schedule please");
    await new Promise((r) => setTimeout(r, 10));

    const firstQuestionId = controller.getPendingConsultationQuestionId();
    expect(firstQuestionId).not.toBeNull();
    const firstRequest = pendingRequestByCallSession(session.id);
    expect(firstRequest).not.toBeNull();

    // Repeated ASK_GUARDIAN with same informational question (no tool metadata)
    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn(["Still checking. [ASK_GUARDIAN: Preferred date?]"]),
    );
    await controller.handleCallerUtterance("Hello? Still there?");
    await new Promise((r) => setTimeout(r, 10));

    // Should coalesce: same consultation ID, same request
    expect(controller.getPendingConsultationQuestionId()).toBe(firstQuestionId);
    const currentRequest = pendingRequestByCallSession(session.id);
    expect(currentRequest).not.toBeNull();
    expect(currentRequest!.id).toBe(firstRequest!.id);
    expect(currentRequest!.status).toBe("pending");

    // Coalesce event should be recorded
    const events = getCallEvents(session.id);
    const coalesceEvents = events.filter(
      (e) => e.eventType === "guardian_consult_coalesced",
    );
    expect(coalesceEvents.length).toBe(1);

    controller.destroy();
  });

  test("coalescing: repeated ASK_GUARDIAN_APPROVAL with same tool/input does not create a new request", async () => {
    const approvalPayload = JSON.stringify({
      question: "Allow send_email to bob@example.com?",
      toolName: "send_email",
      input: { to: "bob@example.com", subject: "Hello" },
    });

    // First ASK_GUARDIAN_APPROVAL
    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn([
        `Checking. [ASK_GUARDIAN_APPROVAL: ${approvalPayload}]`,
      ]),
    );
    const { session, controller } = setupController("Send email");
    await controller.handleCallerUtterance("Send email to Bob");
    await new Promise((r) => setTimeout(r, 10));

    const firstQuestionId = controller.getPendingConsultationQuestionId();
    expect(firstQuestionId).not.toBeNull();
    const firstRequest = pendingRequestByCallSession(session.id);
    expect(firstRequest).not.toBeNull();

    // Repeated ASK_GUARDIAN_APPROVAL with same tool/input
    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn([
        `Still checking. [ASK_GUARDIAN_APPROVAL: ${approvalPayload}]`,
      ]),
    );
    await controller.handleCallerUtterance("Can you send it already?");
    await new Promise((r) => setTimeout(r, 10));

    // Should coalesce: same consultation, same request
    expect(controller.getPendingConsultationQuestionId()).toBe(firstQuestionId);
    const currentRequest = pendingRequestByCallSession(session.id);
    expect(currentRequest!.id).toBe(firstRequest!.id);
    expect(currentRequest!.status).toBe("pending");

    controller.destroy();
  });

  test("supersession: materially different tool triggers new request with superseded metadata", async () => {
    const firstPayload = JSON.stringify({
      question: "Allow send_email?",
      toolName: "send_email",
      input: { to: "bob@example.com" },
    });

    // First ASK_GUARDIAN_APPROVAL for send_email
    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn([
        `Checking. [ASK_GUARDIAN_APPROVAL: ${firstPayload}]`,
      ]),
    );
    const { session, controller } = setupController("Process request");
    await controller.handleCallerUtterance("Send email");
    await new Promise((r) => setTimeout(r, 10));

    const firstRequest = pendingRequestByCallSession(session.id);
    expect(firstRequest).not.toBeNull();
    expect(firstRequest!.toolName).toBe("send_email");

    // Different tool — should supersede
    const secondPayload = JSON.stringify({
      question: "Allow calendar_create?",
      toolName: "calendar_create",
      input: { date: "2026-03-01" },
    });
    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn([
        `Actually, let me do this. [ASK_GUARDIAN_APPROVAL: ${secondPayload}]`,
      ]),
    );
    await controller.handleCallerUtterance(
      "Actually, create a calendar event instead",
    );
    await new Promise((r) => setTimeout(r, 10));

    // New consultation should be active
    const secondRequest = pendingRequestByCallSession(session.id);
    expect(secondRequest).not.toBeNull();
    expect(secondRequest!.id).not.toBe(firstRequest!.id);
    expect(secondRequest!.toolName).toBe("calendar_create");

    // Old request should be expired (superseded by the new one)
    const expiredRequest = bridgeState.getRequest(firstRequest!.id);
    expect(expiredRequest).not.toBeNull();
    expect(expiredRequest!.status).toBe("expired");

    controller.destroy();
  });

  test("tool metadata continuity: re-ask without structured metadata inherits tool scope from prior consultation", async () => {
    const approvalPayload = JSON.stringify({
      question: "Allow send_email?",
      toolName: "send_email",
      input: { to: "bob@example.com", subject: "Hello" },
    });

    // First ask with structured tool metadata
    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn([
        `Let me check. [ASK_GUARDIAN_APPROVAL: ${approvalPayload}]`,
      ]),
    );
    const { session, controller } = setupController("Send email");
    await controller.handleCallerUtterance("Send email to Bob");
    await new Promise((r) => setTimeout(r, 10));

    const firstRequest = pendingRequestByCallSession(session.id);
    expect(firstRequest).not.toBeNull();
    expect(firstRequest!.toolName).toBe("send_email");

    // Re-ask with informational ASK_GUARDIAN (no structured metadata).
    // Since the tool metadata matches the existing consultation (inherited),
    // this should coalesce rather than supersede.
    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn([
        "Checking again. [ASK_GUARDIAN: Can I send that email?]",
      ]),
    );
    await controller.handleCallerUtterance("Can you hurry up?");
    await new Promise((r) => setTimeout(r, 10));

    // Should coalesce: the inherited tool metadata matches the existing consultation
    const currentRequest = pendingRequestByCallSession(session.id);
    expect(currentRequest!.id).toBe(firstRequest!.id);
    expect(currentRequest!.status).toBe("pending");

    // Coalesce event should be recorded
    const events = getCallEvents(session.id);
    const coalesceEvents = events.filter(
      (e) => e.eventType === "guardian_consult_coalesced",
    );
    expect(coalesceEvents.length).toBe(1);

    controller.destroy();
  });

  // ── Silence suppression during guardian wait ──────────────────────

  test("silence timeout fires normally when not in guardian wait", async () => {
    mockSilenceTimeoutMs = 20; // Short timeout for testing
    const { relay, controller } = setupController();

    // No pending guardian consultation — the nudge should fire.

    // Wait for the silence timeout to fire
    await new Promise((r) => setTimeout(r, 30));

    // "Are you still there?" SHOULD have been sent
    const silenceTokens = relay.sentTokens.filter((t) =>
      t.token.includes("Are you still there?"),
    );
    expect(silenceTokens.length).toBe(1);

    controller.destroy();
  });

  test("silence timeout suppressed during in-call guardian consultation (pendingGuardianInput)", async () => {
    mockSilenceTimeoutMs = 20; // Short timeout for testing
    mockConsultationTimeoutMs = 10_000; // Long enough to not interfere

    // LLM emits an ASK_GUARDIAN marker so the controller creates a pendingGuardianInput
    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn([
        "Let me check with your guardian. [ASK_GUARDIAN: Can this caller access the account?]",
      ]),
    );
    const { relay, controller } = setupController();

    // Trigger a turn that creates a pending guardian input request
    await controller.handleCallerUtterance("I need to access the account");
    // Allow turn to complete
    await new Promise((r) => setTimeout(r, 10));

    // Verify a guardian input request is now pending
    expect(controller.getPendingConsultationQuestionId()).not.toBeNull();

    // Clear any tokens from the turn itself
    relay.sentTokens.length = 0;

    // Wait for the silence timeout to fire
    await new Promise((r) => setTimeout(r, 30));

    // "Are you still there?" should NOT have been sent because
    // pendingGuardianInput is active
    const silenceTokens = relay.sentTokens.filter((t) =>
      t.token.includes("Are you still there?"),
    );
    expect(silenceTokens.length).toBe(0);

    controller.destroy();
  });

  test("silence nudge resumes after guardian consultation resolves", async () => {
    mockSilenceTimeoutMs = 25; // Short timeout for testing
    mockConsultationTimeoutMs = 10_000; // Long enough to not interfere

    // LLM emits an ASK_GUARDIAN marker so the controller creates a pendingGuardianInput
    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn(["Let me check. [ASK_GUARDIAN: Is this approved?]"]),
    );
    const { relay, controller } = setupController();

    // Trigger a turn that creates a pending guardian input request
    await controller.handleCallerUtterance("Can I do this?");
    await new Promise((r) => setTimeout(r, 10));

    // Verify guardian input request is pending
    expect(controller.getPendingConsultationQuestionId()).not.toBeNull();

    // Now resolve the consultation by providing an answer
    // Mock the next LLM turn for the answer-driven follow-up
    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn(["Great news, your guardian approved the request."]),
    );
    await controller.handleUserAnswer("Yes, approved");
    // Allow the fire-and-forget answer turn to complete (mock is sync,
    // only needs microtask ticks). Must be shorter than the silence
    // timeout (25ms) so the nudge timer hasn't fired when we clear tokens.
    await new Promise((r) => setTimeout(r, 10));

    // Guardian input request should now be cleared
    expect(controller.getPendingConsultationQuestionId()).toBeNull();

    // Clear tokens from the answer turn
    relay.sentTokens.length = 0;

    // Wait for the silence timeout to fire again
    await new Promise((r) => setTimeout(r, 30));

    // "Are you still there?" SHOULD fire now that guardian wait is resolved
    const silenceTokens = relay.sentTokens.filter((t) =>
      t.token.includes("Are you still there?"),
    );
    expect(silenceTokens.length).toBe(1);

    controller.destroy();
  });

  // ── Pointer message regression tests ─────────────────────────────

  test("END_CALL marker writes completed pointer to origin conversation", async () => {
    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn(["Goodbye! [END_CALL]"]),
    );
    const { controller } = setupControllerWithOrigin();

    await controller.handleCallerUtterance("Bye");
    // Allow async pointer write to flush
    await new Promise((r) => setTimeout(r, 10));

    const text = getLatestAssistantText("conv-ctrl-origin");
    expect(text).not.toBeNull();
    expect(text!).toContain("+15552222222");
    expect(text!).toContain("completed");

    controller.destroy();
  });

  test("max duration timeout writes completed pointer to origin conversation", async () => {
    // Use a very short max duration to trigger the timeout quickly.
    // The real MAX_CALL_DURATION_MS mock is 12 minutes; override via
    // call-constants mock (already set to 12*60*1000). Instead, we
    // directly test the timer-based path by creating a session with
    // startedAt in the past and triggering the path manually.

    // For this test, we check that when the session has an
    // initiatedFromConversationId and startedAt, the completion pointer
    // is written with a duration.
    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn(["Goodbye! [END_CALL]"]),
    );
    const { controller } = setupControllerWithOrigin();

    await controller.handleCallerUtterance("End call");
    await new Promise((r) => setTimeout(r, 10));

    const text = getLatestAssistantText("conv-ctrl-origin");
    expect(text).not.toBeNull();
    expect(text!).toContain("+15552222222");
    expect(text!).toContain("completed");

    controller.destroy();
  });

  // ── TTS provider abstraction: native-token path ─────────────────────

  test("native provider (ElevenLabs): streams text tokens directly to relay", async () => {
    // Default config uses ElevenLabs (native, no streaming) — the text
    // tokens should flow directly through sendTextToken to the relay.
    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn(["Hello", ", how", " are you?"]),
    );
    const { relay, controller } = setupController();

    await controller.handleCallerUtterance("Hi");

    // Verify text tokens were sent directly (not empty — real text content)
    const nonEmptyTokens = relay.sentTokens.filter((t) => t.token.length > 0);
    expect(nonEmptyTokens.length).toBeGreaterThan(0);
    // At least one token should contain actual text content
    const allText = nonEmptyTokens.map((t) => t.token).join("");
    expect(allText).toContain("Hello");
    expect(allText).toContain("how");
    expect(allText).toContain("are you");

    // The final token should signal end of turn
    const lastToken = relay.sentTokens[relay.sentTokens.length - 1];
    expect(lastToken.last).toBe(true);

    controller.destroy();
  });

  test("native provider (ElevenLabs): strips control markers from streamed text tokens", async () => {
    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn([
        "I will check on that. ",
        "[ASK_GUARDIAN: Is 3pm ok?]",
      ]),
    );
    const { relay, controller } = setupController();

    await controller.handleCallerUtterance("Book an appointment");

    const allText = relay.sentTokens.map((t) => t.token).join("");
    expect(allText).toContain("I will check on that.");
    expect(allText).not.toContain("[ASK_GUARDIAN:");

    controller.destroy();
  });

  test("native provider (ElevenLabs): END_CALL marker handled correctly with text tokens", async () => {
    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn(["Thanks for calling! ", "[END_CALL]"]),
    );
    const { session, relay, controller } = setupController();

    await controller.handleCallerUtterance("Goodbye");

    expect(relay.endCalled).toBe(true);
    const updatedSession = getCallSession(session.id);
    expect(updatedSession!.status).toBe("completed");

    const allText = relay.sentTokens.map((t) => t.token).join("");
    expect(allText).not.toContain("[END_CALL]");
    expect(allText).toContain("Thanks for calling!");

    controller.destroy();
  });

  test("synthesized provider: if synthesis fails before first chunk, falls back to text-token speech without sending play URL", async () => {
    const cfg = loadConfig();
    cfg.services.tts.provider = "fish-audio";
    cfg.services.tts.providers["fish-audio"].referenceId = "fish-ref-123";

    _resetTtsProviderOverridesForTests();
    const elevenlabs: TtsProvider = {
      id: "elevenlabs",
      capabilities: { supportsStreaming: false, supportedFormats: ["mp3"] },
      async synthesize() {
        return { audio: Buffer.from(""), contentType: "audio/mpeg" };
      },
    };
    _setTtsProviderForTests(elevenlabs);

    const fishAudioFailing: TtsProvider = {
      id: "fish-audio",
      capabilities: {
        supportsStreaming: true,
        supportedFormats: ["mp3", "wav", "opus"],
      },
      async synthesize() {
        throw new Error("fish-audio synth failure");
      },
      async synthesizeStream() {
        throw new Error("fish-audio stream failure");
      },
    };
    _setTtsProviderForTests(fishAudioFailing);

    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn(["Hello from synthesized path"]),
    );
    const { relay, controller } = setupController();

    await controller.handleCallerUtterance("Hi");

    // No play URL should be emitted when synthesis fails before first chunk.
    expect(relay.sentPlayUrls.length).toBe(0);

    // Fallback token speech should still reach the caller.
    const fallbackText = relay.sentTokens.map((t) => t.token).join("");
    expect(fallbackText).toContain("Hello from synthesized path");

    const lastToken = relay.sentTokens[relay.sentTokens.length - 1];
    expect(lastToken.last).toBe(true);

    controller.destroy();
  });

  test("synthesized provider: a superseded run does not emit native fallback text", async () => {
    const cfg = loadConfig();
    cfg.services.tts.provider = "fish-audio";
    cfg.services.tts.providers["fish-audio"].referenceId = "fish-ref-123";

    _resetTtsProviderOverridesForTests();
    // elevenlabs present so native fallback is available for fish-audio.
    const elevenlabs: TtsProvider = {
      id: "elevenlabs",
      capabilities: { supportsStreaming: false, supportedFormats: ["mp3"] },
      async synthesize() {
        return { audio: Buffer.from(""), contentType: "audio/mpeg" };
      },
    };
    _setTtsProviderForTests(elevenlabs);

    let releaseSynth: (() => void) | undefined;
    const synthGate = new Promise<void>((resolve) => {
      releaseSynth = resolve;
    });
    const fishAudioGatedFailing: TtsProvider = {
      id: "fish-audio",
      capabilities: {
        supportsStreaming: true,
        supportedFormats: ["mp3", "wav", "opus"],
      },
      async synthesize() {
        throw new Error("fish-audio synth failure");
      },
      async synthesizeStream() {
        // Ignore the abort signal, block, then fail with no audio — this would
        // normally trigger the native fallback text emission.
        await synthGate;
        throw new Error("fish-audio stream failure");
      },
    };
    _setTtsProviderForTests(fishAudioGatedFailing);

    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn(["Stale synthesized response"]),
    );
    const { relay, controller } = setupController();

    const turn = controller.handleCallerUtterance("Hi");
    await new Promise((r) => setTimeout(r, 20)); // reach synthesis, blocked

    // Supersede the turn mid-synthesis, then let synthesis fail.
    controller.handleInterrupt();
    releaseSynth?.();
    await turn;

    // The stale run must NOT leak its native fallback text into the relay.
    const emitted = relay.sentTokens.map((t) => t.token).join("");
    expect(emitted).not.toContain("Stale synthesized response");
    expect(relay.sentPlayUrls.length).toBe(0);

    controller.destroy();
  });

  test("synthesized provider: play URL uses public base URL", async () => {
    const cfg = loadConfig();
    cfg.ingress.publicBaseUrl = "https://twilio.example.com/";
    cfg.services.tts.provider = "fish-audio";
    cfg.services.tts.providers["fish-audio"].referenceId = "fish-ref-123";

    _resetTtsProviderOverridesForTests();
    const fishAudioStreaming: TtsProvider = {
      id: "fish-audio",
      capabilities: {
        supportsStreaming: true,
        supportedFormats: ["mp3", "wav", "opus"],
      },
      async synthesize() {
        return {
          audio: Buffer.from("fish-audio-buffer"),
          contentType: "audio/mpeg",
        };
      },
      async synthesizeStream(_request, onChunk) {
        onChunk(Buffer.from("fish-audio-stream"));
        return {
          audio: Buffer.from("fish-audio-stream"),
          contentType: "audio/mpeg",
        };
      },
    };
    _setTtsProviderForTests(fishAudioStreaming);

    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn(["Hello from synthesized path."]),
    );
    const { relay, controller } = setupController();

    await controller.handleCallerUtterance("Hi");

    expect(relay.sentPlayUrls.length).toBeGreaterThan(0);
    expect(relay.sentPlayUrls[0]).toStartWith(
      "https://twilio.example.com/v1/audio/",
    );

    controller.destroy();
  });

  test("synthesized provider: stays 'processing' during synthesis latency, so barge-in cannot abort an inaudible turn", async () => {
    const cfg = loadConfig();
    cfg.services.tts.provider = "fish-audio";
    cfg.services.tts.providers["fish-audio"].referenceId = "fish-ref-123";

    _resetTtsProviderOverridesForTests();
    let releaseChunk: (() => void) | undefined;
    const chunkGate = new Promise<void>((resolve) => {
      releaseChunk = resolve;
    });
    const fishAudioStreaming: TtsProvider = {
      id: "fish-audio",
      capabilities: {
        supportsStreaming: true,
        supportedFormats: ["mp3", "wav", "opus"],
      },
      async synthesize() {
        return { audio: Buffer.from("x"), contentType: "audio/mpeg" };
      },
      async synthesizeStream(_request, onChunk) {
        // Simulate provider latency: emit no audio until the gate releases.
        await chunkGate;
        onChunk(Buffer.from("fish-audio-stream"));
        return {
          audio: Buffer.from("fish-audio-stream"),
          contentType: "audio/mpeg",
        };
      },
    };
    _setTtsProviderForTests(fishAudioStreaming);

    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn(["Hello from synthesized path."]),
    );
    const { relay, controller } = setupController();

    const turn = controller.handleCallerUtterance("Hi");
    // Let the turn generate its text and reach synthesis, blocked on the gate.
    await new Promise((r) => setTimeout(r, 20));

    // No audio has reached the caller yet (play URL not sent), so the controller
    // must stay in `processing` — a barge-in here would abort a turn the caller
    // cannot hear. See JARVIS-1232.
    expect(relay.sentPlayUrls.length).toBe(0);
    expect(controller.getState()).toBe("processing");
    expect(controller.handleBargeIn()).toBe(false);

    // Release audio → play URL sent → turn finishes and returns to idle.
    releaseChunk?.();
    await turn;
    expect(relay.sentPlayUrls.length).toBeGreaterThan(0);
    expect(controller.getState()).toBe("idle");

    controller.destroy();
  });

  test("synthesized provider: a superseded turn does not send a stale play URL", async () => {
    const cfg = loadConfig();
    cfg.services.tts.provider = "fish-audio";
    cfg.services.tts.providers["fish-audio"].referenceId = "fish-ref-123";

    _resetTtsProviderOverridesForTests();
    let releaseChunk: (() => void) | undefined;
    const chunkGate = new Promise<void>((resolve) => {
      releaseChunk = resolve;
    });
    const fishAudioStreaming: TtsProvider = {
      id: "fish-audio",
      capabilities: {
        supportsStreaming: true,
        supportedFormats: ["mp3", "wav", "opus"],
      },
      async synthesize() {
        return { audio: Buffer.from("x"), contentType: "audio/mpeg" };
      },
      async synthesizeStream(_request, onChunk) {
        // Block until released so we can supersede the turn mid-synthesis.
        await chunkGate;
        onChunk(Buffer.from("stale-audio"));
        return { audio: Buffer.from("stale-audio"), contentType: "audio/mpeg" };
      },
    };
    _setTtsProviderForTests(fishAudioStreaming);

    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn(["Hello from synthesized path."]),
    );
    const { relay, controller } = setupController();

    const turn = controller.handleCallerUtterance("first");
    // Let the turn generate text and block inside provider synthesis.
    await new Promise((r) => setTimeout(r, 20));
    expect(relay.sentPlayUrls.length).toBe(0);

    // Supersede the in-flight synthesized turn (bumps run version + aborts synthesis).
    controller.handleInterrupt();

    // Releasing the stale synthesis must NOT send a play URL for the old run,
    // nor inject a stale end-of-turn marker into the relay stream.
    releaseChunk?.();
    await turn;
    expect(relay.sentPlayUrls.length).toBe(0);
    expect(relay.sentTokens.filter((t) => t.last).length).toBe(0);

    controller.destroy();
  });

  test("synthesized provider: a turn error cancels the queued synthesis chain so no stale speech follows the recovery prompt", async () => {
    const cfg = loadConfig();
    cfg.services.tts.provider = "fish-audio";
    cfg.services.tts.providers["fish-audio"].referenceId = "fish-ref-123";

    _resetTtsProviderOverridesForTests();
    // elevenlabs present so a native fallback route exists for fish-audio.
    const elevenlabs: TtsProvider = {
      id: "elevenlabs",
      capabilities: { supportsStreaming: false, supportedFormats: ["mp3"] },
      async synthesize() {
        return { audio: Buffer.from(""), contentType: "audio/mpeg" };
      },
    };
    _setTtsProviderForTests(elevenlabs);

    // Slow provider: blocks until the test releases it, but honors the
    // abort signal like real providers do.
    let releaseSynth: (() => void) | undefined;
    const synthGate = new Promise<void>((resolve) => {
      releaseSynth = resolve;
    });
    let synthStartedResolve: (() => void) | undefined;
    const synthStarted = new Promise<void>((resolve) => {
      synthStartedResolve = resolve;
    });
    let providerSawAbort = false;
    const fishAudioSlow: TtsProvider = {
      id: "fish-audio",
      capabilities: {
        supportsStreaming: true,
        supportedFormats: ["mp3", "wav", "opus"],
      },
      async synthesize() {
        return { audio: Buffer.from("x"), contentType: "audio/mpeg" };
      },
      async synthesizeStream(request, onChunk) {
        synthStartedResolve?.();
        await new Promise<void>((resolve, reject) => {
          const abortErr = new Error("aborted");
          abortErr.name = "AbortError";
          if (request.signal?.aborted) {
            providerSawAbort = true;
            reject(abortErr);
            return;
          }
          request.signal?.addEventListener(
            "abort",
            () => {
              providerSawAbort = true;
              reject(abortErr);
            },
            { once: true },
          );
          void synthGate.then(resolve);
        });
        onChunk(Buffer.from("stale-partial-answer-audio"));
        return {
          audio: Buffer.from("stale-partial-answer-audio"),
          contentType: "audio/mpeg",
        };
      },
    };
    _setTtsProviderForTests(fishAudioSlow);

    // Emit a speakable segment, then error the turn once that segment's
    // synthesis is in flight — the run is never superseded, so only the
    // turn-error cancellation keeps the chain from speaking.
    mockStartVoiceTurn.mockImplementation(
      async (opts: {
        onTextDelta: (text: string) => void;
        onError: (msg: string) => void;
      }) => {
        opts.onTextDelta("Partial answer for the caller. And more");
        void synthStarted.then(() => {
          opts.onError("voice pipeline failure");
        });
        return { turnId: "run-err-synth", abort: () => {} };
      },
    );

    const { relay, controller } = setupController();

    await controller.handleCallerUtterance("Hi");

    // The in-flight segment was aborted and the recovery message spoken.
    expect(providerSawAbort).toBe(true);
    const spoken = relay.sentTokens.map((t) => t.token).join("");
    expect(spoken).toContain("technical issue");
    expect(controller.getState()).toBe("idle");

    // Releasing the slow provider must not surface the cancelled chain's
    // play URL or native-fallback text after the recovery prompt.
    releaseSynth?.();
    await new Promise((r) => setTimeout(r, 30));
    expect(relay.sentPlayUrls.length).toBe(0);
    const allText = relay.sentTokens.map((t) => t.token).join("");
    expect(allText).not.toContain("Partial answer for the caller");

    controller.destroy();
  });

  test("Deepgram selected path resolves useSynthesizedPath to true", async () => {
    const cfg = loadConfig();
    cfg.services.tts.provider = "deepgram";

    const result = await resolveCallTtsProvider();
    expect(result.provider).not.toBeNull();
    expect(result.provider!.id).toBe("deepgram");
    expect(result.useSynthesizedPath).toBe(true);
  });

  test("Deepgram synthesis failure does NOT fall back to native token TTS", async () => {
    const cfg = loadConfig();
    cfg.services.tts.provider = "deepgram";

    _resetTtsProviderOverridesForTests();
    const elevenlabs: TtsProvider = {
      id: "elevenlabs",
      capabilities: { supportsStreaming: false, supportedFormats: ["mp3"] },
      async synthesize() {
        return { audio: Buffer.from(""), contentType: "audio/mpeg" };
      },
    };
    _setTtsProviderForTests(elevenlabs);

    const deepgramFailing: TtsProvider = {
      id: "deepgram",
      capabilities: {
        supportsStreaming: false,
        supportedFormats: ["mp3", "wav", "opus"],
      },
      async synthesize() {
        const err = new Error("Deepgram TTS returned 503: service unavailable");
        (err as Error & { code?: string }).code = "DEEPGRAM_TTS_HTTP_ERROR";
        throw err;
      },
    };
    _setTtsProviderForTests(deepgramFailing);

    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn(["Hello from deepgram path"]),
    );
    const { relay, controller } = setupController();

    await controller.handleCallerUtterance("Hi");

    // No play URL should be emitted when synthesis fails.
    expect(relay.sentPlayUrls.length).toBe(0);

    // Deepgram should NOT have fallen back to sending the LLM text as
    // native token TTS. Instead, the outer error handler should have
    // produced a recovery message ("Could you repeat that?").
    const allTokenText = relay.sentTokens.map((t) => t.token).join("");
    expect(allTokenText).not.toContain("Hello from deepgram path");
    expect(allTokenText).toContain("technical issue");

    controller.destroy();
  });

  test("Fish Audio synthesis failure still falls back to native token TTS (unchanged behavior)", async () => {
    const cfg = loadConfig();
    cfg.services.tts.provider = "fish-audio";
    cfg.services.tts.providers["fish-audio"].referenceId = "fish-ref-abc";

    _resetTtsProviderOverridesForTests();
    const elevenlabs: TtsProvider = {
      id: "elevenlabs",
      capabilities: { supportsStreaming: false, supportedFormats: ["mp3"] },
      async synthesize() {
        return { audio: Buffer.from(""), contentType: "audio/mpeg" };
      },
    };
    _setTtsProviderForTests(elevenlabs);

    const fishAudioFailing: TtsProvider = {
      id: "fish-audio",
      capabilities: {
        supportsStreaming: true,
        supportedFormats: ["mp3", "wav", "opus"],
      },
      async synthesize() {
        throw new Error("fish-audio synth failure");
      },
      async synthesizeStream() {
        throw new Error("fish-audio stream failure");
      },
    };
    _setTtsProviderForTests(fishAudioFailing);

    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn(["Hello from fish path"]),
    );
    const { relay, controller } = setupController();

    await controller.handleCallerUtterance("Hi");

    // Fish Audio fallback: the LLM text should reach the caller
    // via native token TTS despite synthesis failure.
    const allTokenText = relay.sentTokens.map((t) => t.token).join("");
    expect(allTokenText).toContain("Hello from fish path");

    controller.destroy();
  });

  // ── Incremental per-segment synthesis (synthesized-play path) ───────

  function registerFishAudioSegmentRecorder(opts?: {
    onSynthesizeStream?: (
      text: string,
      request: import("../tts/types.js").TtsSynthesisRequest,
      onChunk: (chunk: Buffer) => void,
    ) => Promise<void>;
  }): { synthesizedTexts: string[] } {
    const cfg = loadConfig();
    cfg.services.tts.provider = "fish-audio";
    cfg.services.tts.providers["fish-audio"].referenceId = "fish-ref-123";

    _resetTtsProviderOverridesForTests();
    const synthesizedTexts: string[] = [];
    const fishAudioStreaming: TtsProvider = {
      id: "fish-audio",
      capabilities: {
        supportsStreaming: true,
        supportedFormats: ["mp3", "wav", "opus"],
      },
      async synthesize() {
        return { audio: Buffer.from("audio"), contentType: "audio/mpeg" };
      },
      async synthesizeStream(request, onChunk) {
        synthesizedTexts.push(request.text);
        await opts?.onSynthesizeStream?.(request.text, request, onChunk);
        onChunk(Buffer.from(`audio:${request.text}`));
        return {
          audio: Buffer.from(`audio:${request.text}`),
          contentType: "audio/mpeg",
        };
      },
    };
    _setTtsProviderForTests(fishAudioStreaming);
    return { synthesizedTexts };
  }

  test("synthesized provider: segments synthesize during the stream — first play URL before turn completion", async () => {
    const { synthesizedTexts } = registerFishAudioSegmentRecorder();
    const { relay, controller } = setupController();

    let playUrlsAtTurnCompletion = -1;
    mockStartVoiceTurn.mockImplementation(
      async (opts: {
        onTextDelta: (t: string) => void;
        onComplete: () => void;
      }) => {
        opts.onTextDelta("First sentence done. ");
        // The first segment's play URL must reach the transport while the
        // LLM turn is still streaming.
        await pollUntil(() => relay.sentPlayUrls.length > 0);
        opts.onTextDelta("Second sentence follows.");
        playUrlsAtTurnCompletion = relay.sentPlayUrls.length;
        opts.onComplete();
        return { turnId: "run-incremental", abort: () => {} };
      },
    );

    await controller.handleCallerUtterance("Hi");

    expect(playUrlsAtTurnCompletion).toBe(1);
    expect(synthesizedTexts).toEqual([
      "First sentence done.",
      "Second sentence follows.",
    ]);
    expect(relay.sentPlayUrls.length).toBe(2);
    // End-of-turn signal fires only after the synthesis chain drains.
    const lastToken = relay.sentTokens[relay.sentTokens.length - 1];
    expect(lastToken).toEqual({ token: "", last: true });

    controller.destroy();
  });

  test("synthesized provider: segments synthesize serially in order even when the first is slow", async () => {
    const events: string[] = [];
    registerFishAudioSegmentRecorder({
      onSynthesizeStream: async (text) => {
        events.push(`start:${text}`);
        if (text.startsWith("One")) {
          await new Promise((r) => setTimeout(r, 20));
        }
        events.push(`emit:${text}`);
      },
    });
    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn(["One is here. ", "Two is here."]),
    );
    const { relay, controller } = setupController();

    await controller.handleCallerUtterance("Hi");

    // Serialized chain: the second segment must not start until the first
    // finished, so play URLs hit the transport FIFO in segment order.
    expect(events).toEqual([
      "start:One is here.",
      "emit:One is here.",
      "start:Two is here.",
      "emit:Two is here.",
    ]);
    expect(relay.sentPlayUrls.length).toBe(2);

    controller.destroy();
  });

  test("synthesized provider: a control marker spanning delta boundaries is never synthesized", async () => {
    const { synthesizedTexts } = registerFishAudioSegmentRecorder();
    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn([
        "Let me check that for you. [ASK_GUARD",
        "IAN: What time works?] One moment.",
      ]),
    );
    const { session, controller } = setupController();

    await controller.handleCallerUtterance("Hi");

    expect(synthesizedTexts).toEqual([
      "Let me check that for you.",
      "One moment.",
    ]);
    // The consultation is still dispatched from the full response text.
    expect(getPendingQuestion(session.id)?.questionText).toBe(
      "What time works?",
    );

    controller.destroy();
  });

  test("synthesized provider: markdown spanning delta boundaries is stripped before synthesis", async () => {
    const { synthesizedTexts } = registerFishAudioSegmentRecorder();
    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn(["This is **very", " important**. Please note it."]),
    );
    const { controller } = setupController();

    await controller.handleCallerUtterance("Hi");

    expect(synthesizedTexts).toEqual([
      "This is very important.",
      "Please note it.",
    ]);

    controller.destroy();
  });

  test("synthesized provider: barge-in mid-turn stops subsequent segment synthesis", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((r) => {
      releaseFirst = r;
    });
    const { synthesizedTexts } = registerFishAudioSegmentRecorder({
      // Block the first segment mid-synthesis (ignoring the abort signal)
      // so the barge-in lands while later segments are still queued.
      onSynthesizeStream: () => firstGate,
    });
    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn(["One is done. ", "Two is done. ", "Three is done."]),
    );
    const { relay, controller } = setupController();

    const turn = controller.handleCallerUtterance("Hi");
    await pollUntil(() => synthesizedTexts.length === 1);

    controller.handleInterrupt();
    releaseFirst?.();
    await turn;
    await new Promise((r) => setTimeout(r, 10));

    // Queued segments never synthesize after the barge-in, and the aborted
    // first segment's late audio never reaches the caller.
    expect(synthesizedTexts).toEqual(["One is done."]);
    expect(relay.sentPlayUrls.length).toBe(0);

    controller.destroy();
  });

  test("synthesized provider: a late-finishing stale segment neither clobbers the new turn's abort handle nor emits audio", async () => {
    let releaseStale: (() => void) | undefined;
    const staleGate = new Promise<void>((r) => {
      releaseStale = r;
    });
    let newTurnAborted = false;
    const { synthesizedTexts } = registerFishAudioSegmentRecorder({
      onSynthesizeStream: async (text, request) => {
        if (text.startsWith("Old")) {
          // Stale turn's provider ignores the abort and finishes late.
          await staleGate;
          return;
        }
        // New turn's provider hangs until its own abort signal fires.
        await new Promise<void>((resolve) => {
          request.signal?.addEventListener(
            "abort",
            () => {
              newTurnAborted = true;
              resolve();
            },
            { once: true },
          );
        });
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      },
    });
    let voiceTurnCalls = 0;
    mockStartVoiceTurn.mockImplementation(
      async (opts: { onTextDelta: (t: string) => void }) => {
        voiceTurnCalls++;
        opts.onTextDelta(
          voiceTurnCalls === 1 ? "Old news here. " : "New reply here. ",
        );
        // Hold the turn open; barge-in resolves it via the abort listener.
        return { turnId: `run-clobber-${voiceTurnCalls}`, abort: () => {} };
      },
    );
    const { relay, controller } = setupController();

    const turn1 = controller.handleCallerUtterance("Hi");
    let turn1Settled = false;
    void turn1.finally(() => {
      turn1Settled = true;
    });
    await pollUntil(() => synthesizedTexts.length === 1);

    // Barge-in while the first segment's synthesis is still in flight.
    controller.handleInterrupt();

    // The stale run drains its chain before settling, so the interrupted
    // turn stays pending until its hung segment resolves.
    await new Promise((r) => setTimeout(r, 10));
    expect(turn1Settled).toBe(false);

    // Start the next turn while the stale segment is still in flight.
    const turn2 = controller.handleUserInstruction("follow up");
    await pollUntil(() => synthesizedTexts.length === 2);

    // The stale segment finishes late — after the new turn registered its
    // own abort handle.
    releaseStale?.();
    await turn1;

    // A barge-in on the NEW turn must still abort its in-flight synthesis:
    // the stale segment's completion must not have cleared the handle.
    controller.handleInterrupt();
    await pollUntil(() => newTurnAborted);
    await turn2;

    expect(synthesizedTexts).toEqual(["Old news here.", "New reply here."]);
    // Neither the stale segment's late chunk nor the aborted new segment
    // ever reaches the caller.
    expect(relay.sentPlayUrls.length).toBe(0);

    controller.destroy();
  });

  test("synthesized provider: after a segment synthesis failure, remaining segments take the native fallback in order", async () => {
    const { synthesizedTexts } = registerFishAudioSegmentRecorder({
      onSynthesizeStream: async () => {
        throw new Error("fish-audio stream failure");
      },
    });
    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn(["First part is done. ", "Second part is done."]),
    );
    const { relay, controller } = setupController();

    await controller.handleCallerUtterance("Hi");

    // Only the first segment attempts synthesis; the rest short-circuit to
    // the native route so text is never dropped, duplicated, or reordered.
    expect(synthesizedTexts).toEqual(["First part is done."]);
    const tokenTexts = relay.sentTokens
      .filter((t) => t.token.length > 0)
      .map((t) => t.token);
    expect(tokenTexts).toEqual([
      "First part is done. ",
      "Second part is done. ",
    ]);
    // Trimmed segments carry a separator so back-to-back tokens never
    // fuse into "…done.Second part…".
    expect(tokenTexts.join("")).toContain("done. Second");
    expect(relay.sentPlayUrls.length).toBe(0);
    // End-of-turn still fires after the chain drains.
    const lastToken = relay.sentTokens[relay.sentTokens.length - 1];
    expect(lastToken).toEqual({ token: "", last: true });

    controller.destroy();
  });

  test("synthesized provider: a mid-stream failure after the play URL went out is not re-sent natively; later segments take the native route", async () => {
    const { synthesizedTexts } = registerFishAudioSegmentRecorder({
      onSynthesizeStream: async (_text, _request, onChunk) => {
        onChunk(Buffer.from("partial-audio"));
        // Let the queued emit flush so the play URL goes out before the
        // failure lands (mirrors a real mid-stream stall).
        await new Promise((r) => setTimeout(r, 0));
        throw new Error("fish-audio mid-stream failure");
      },
    });
    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn(["First part is done. ", "Second part is done."]),
    );
    const { relay, controller } = setupController();

    await controller.handleCallerUtterance("Hi");

    // The failed segment's truncated audio already played, so its text is
    // never re-sent as native tokens; later segments still take the
    // native route.
    expect(synthesizedTexts).toEqual(["First part is done."]);
    expect(relay.sentPlayUrls.length).toBe(1);
    const tokenTexts = relay.sentTokens
      .filter((t) => t.token.length > 0)
      .map((t) => t.token);
    expect(tokenTexts).toEqual(["Second part is done. "]);
    const lastToken = relay.sentTokens[relay.sentTokens.length - 1];
    expect(lastToken).toEqual({ token: "", last: true });

    controller.destroy();
  });

  // ── Eager first segment (synthesized-play path) ─────────────────────

  test("synthesized provider: the turn's first segment flushes eagerly at a clause boundary before any sentence ends", async () => {
    const { synthesizedTexts } = registerFishAudioSegmentRecorder();
    const { relay, controller } = setupController();

    let segmentsBeforeSentenceEnd = -1;
    mockStartVoiceTurn.mockImplementation(
      async (opts: {
        onTextDelta: (t: string) => void;
        onComplete: () => void;
      }) => {
        opts.onTextDelta("Let me take a look at that, ");
        // The clause-bounded prefix must reach synthesis while no sentence
        // has ended yet — full-sentence rules would still be buffering.
        await pollUntil(() => synthesizedTexts.length > 0);
        segmentsBeforeSentenceEnd = synthesizedTexts.length;
        opts.onTextDelta("and get right back to you.");
        opts.onComplete();
        return { turnId: "run-eager", abort: () => {} };
      },
    );

    await controller.handleCallerUtterance("Hi");

    expect(segmentsBeforeSentenceEnd).toBe(1);
    expect(synthesizedTexts).toEqual([
      "Let me take a look at that,",
      "and get right back to you.",
    ]);
    expect(relay.sentPlayUrls.length).toBe(2);

    controller.destroy();
  });

  test("synthesized provider: eager mode applies only to the first segment — later clauses wait for sentence ends", async () => {
    const { synthesizedTexts } = registerFishAudioSegmentRecorder();
    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn([
        "Let me take a look at that, and then, after checking, I will confirm.",
      ]),
    );
    const { controller } = setupController();

    await controller.handleCallerUtterance("Hi");

    expect(synthesizedTexts).toEqual([
      "Let me take a look at that,",
      "and then, after checking, I will confirm.",
    ]);

    controller.destroy();
  });

  test("synthesized provider: a long unpunctuated opening flushes at the eager 60-char cap; the force-flushed tail is unaffected", async () => {
    const { synthesizedTexts } = registerFishAudioSegmentRecorder();
    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn([
        "The quick brown fox jumps over the lazy dog near the quiet river bank",
      ]),
    );
    const { controller } = setupController();

    await controller.handleCallerUtterance("Hi");

    // First segment splits at the last whitespace under the 60-char eager
    // cap (the default cap is 180); the short remainder never reaches a
    // boundary and force-flushes at turn completion.
    expect(synthesizedTexts).toEqual([
      "The quick brown fox jumps over the lazy dog near the quiet",
      "river bank",
    ]);

    controller.destroy();
  });

  test("synthesized provider: a short reply below every eager threshold only force-flushes at turn completion", async () => {
    const { synthesizedTexts } = registerFishAudioSegmentRecorder();
    mockStartVoiceTurn.mockImplementation(createMockVoiceTurn(["Quick note"]));
    const { relay, controller } = setupController();

    await controller.handleCallerUtterance("Hi");

    expect(synthesizedTexts).toEqual(["Quick note"]);
    expect(relay.sentPlayUrls.length).toBe(1);

    controller.destroy();
  });

  test("synthesized provider: each turn's first segment is eager again", async () => {
    const { synthesizedTexts } = registerFishAudioSegmentRecorder();
    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn(["Let me take a look at that, one moment."]),
    );
    const { controller } = setupController();

    await controller.handleCallerUtterance("Hi");
    await controller.handleCallerUtterance("Thanks");

    expect(synthesizedTexts).toEqual([
      "Let me take a look at that,",
      "one moment.",
      "Let me take a look at that,",
      "one moment.",
    ]);

    controller.destroy();
  });

  // ── Per-segment fallback on WAV-requiring transports ────────────────

  // ── Per-segment fallback on PCM-requiring transports ────────────────

  /**
   * Register a failing fish-audio primary and a recording elevenlabs
   * fallback, with fish-audio configured as the active provider. Used by
   * the PCM-transport segment-fallback tests. With
   * `fishEmitsChunkBeforeFailing`, the primary emits one audio chunk (so
   * the play URL reaches the transport) before failing mid-stream.
   */
  function registerPcmFallbackProviders(opts?: {
    fishEmitsChunkBeforeFailing?: boolean;
  }): {
    fishTexts: string[];
    fallbackTexts: string[];
  } {
    const cfg = loadConfig();
    cfg.services.tts.provider = "fish-audio";
    cfg.services.tts.providers["fish-audio"].referenceId = "fish-ref-123";

    _resetTtsProviderOverridesForTests();
    const fallbackTexts: string[] = [];
    const elevenlabs: TtsProvider = {
      id: "elevenlabs",
      capabilities: {
        supportsStreaming: false,
        supportedFormats: ["mp3", "wav", "opus"],
      },
      async synthesize(request) {
        fallbackTexts.push(request.text);
        return {
          audio: Buffer.from("fallback-audio"),
          contentType: "audio/pcm",
        };
      },
    };
    _setTtsProviderForTests(elevenlabs);

    const fishTexts: string[] = [];
    const fishAudioFailing: TtsProvider = {
      id: "fish-audio",
      capabilities: {
        supportsStreaming: true,
        supportedFormats: ["mp3", "wav", "opus"],
      },
      async synthesize() {
        throw new Error("fish-audio synth failure");
      },
      async synthesizeStream(request, onChunk) {
        fishTexts.push(request.text);
        if (opts?.fishEmitsChunkBeforeFailing) {
          onChunk(Buffer.from("partial-fish-audio"));
          // Let the queued emit flush so the play URL reaches the
          // transport before the failure lands (mirrors a real
          // mid-stream stall).
          await new Promise((r) => setTimeout(r, 0));
        }
        throw new Error("fish-audio stream failure");
      },
    };
    _setTtsProviderForTests(fishAudioFailing);

    return { fishTexts, fallbackTexts };
  }

  test("PCM transport: a failed segment and the rest of the turn synthesize via a playable fallback provider", async () => {
    const { fishTexts, fallbackTexts } = registerPcmFallbackProviders();
    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn(["First part is done. ", "Second part is done."]),
    );
    const { relay, controller } = setupController(undefined, {
      requiresPcmAudio: true,
    });

    await controller.handleCallerUtterance("Hi");

    // The primary provider is tried once; the failed segment and all
    // subsequent segments retry through the fallback provider, so the
    // caller hears the whole turn instead of partial speech then silence.
    expect(fishTexts).toEqual(["First part is done."]);
    expect(fallbackTexts).toEqual([
      "First part is done.",
      "Second part is done.",
    ]);
    expect(relay.sentPlayUrls.length).toBe(2);
    // No text routes through native tokens on a PCM transport.
    expect(relay.sentTokens.filter((t) => t.token.length > 0)).toEqual([]);
    const lastToken = relay.sentTokens[relay.sentTokens.length - 1];
    expect(lastToken).toEqual({ token: "", last: true });

    controller.destroy();
  });

  test("PCM transport: a mid-stream failure after audio reached the caller is not re-spoken, but later segments use the fallback", async () => {
    const { fishTexts, fallbackTexts } = registerPcmFallbackProviders({
      fishEmitsChunkBeforeFailing: true,
    });
    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn(["First part is done. ", "Second part is done."]),
    );
    const { relay, controller } = setupController(undefined, {
      requiresPcmAudio: true,
    });

    await controller.handleCallerUtterance("Hi");

    // The failed segment's play URL already went out — the caller heard
    // its truncated audio, so a fallback re-synthesis would speak the
    // whole segment a second time. Only later segments route through
    // the fallback provider.
    expect(fishTexts).toEqual(["First part is done."]);
    expect(fallbackTexts).toEqual(["Second part is done."]);
    expect(relay.sentPlayUrls.length).toBe(2);
    expect(relay.sentTokens.filter((t) => t.token.length > 0)).toEqual([]);
    const lastToken = relay.sentTokens[relay.sentTokens.length - 1];
    expect(lastToken).toEqual({ token: "", last: true });

    controller.destroy();
  });

  test("PCM transport: when no playable fallback exists, failed segments are skipped and end-of-turn still fires", async () => {
    // Only fish-audio's key resolves, so the fallback scan finds nothing.
    mockResolvableProviderKeys = (service) =>
      service === "fish-audio" ? "test-key" : null;
    const { fishTexts, fallbackTexts } = registerPcmFallbackProviders();
    mockStartVoiceTurn.mockImplementation(
      createMockVoiceTurn(["First part is done. ", "Second part is done."]),
    );
    const { relay, controller } = setupController(undefined, {
      requiresPcmAudio: true,
    });

    await controller.handleCallerUtterance("Hi");

    expect(fishTexts).toEqual(["First part is done."]);
    expect(fallbackTexts).toEqual([]);
    expect(relay.sentPlayUrls.length).toBe(0);
    // Native tokens are never used on a PCM transport, and the turn
    // still closes with the end-of-turn signal.
    expect(relay.sentTokens.filter((t) => t.token.length > 0)).toEqual([]);
    const lastToken = relay.sentTokens[relay.sentTokens.length - 1];
    expect(lastToken).toEqual({ token: "", last: true });

    controller.destroy();
  });

  // ── TTS provider abstraction: interruption behavior ─────────────────

  test("handleInterrupt: cancels synthesis abort controller for native provider path", async () => {
    // Using the default native provider (ElevenLabs) — no synthesis abort
    // controller should be active, but interrupt should still work cleanly.
    mockStartVoiceTurn.mockImplementation(
      async (opts: {
        signal?: AbortSignal;
        onTextDelta: (t: string) => void;
        onComplete: () => void;
      }) => {
        return new Promise((resolve) => {
          // Emit a token right away so the assistant is actively speaking
          // before the interrupt arrives.
          opts.onTextDelta("This should be interrupted");

          opts.signal?.addEventListener(
            "abort",
            () => {
              opts.onComplete();
              resolve({ turnId: "run-1", abort: () => {} });
            },
            { once: true },
          );
        });
      },
    );

    const { relay, controller } = setupController();
    const turnPromise = controller.handleCallerUtterance("Start speaking");
    await new Promise((r) => setTimeout(r, 5));
    controller.handleInterrupt();
    await turnPromise;

    // Should have sent an end-of-turn marker
    const endTurnMarkers = relay.sentTokens.filter(
      (t) => t.token === "" && t.last === true,
    );
    expect(endTurnMarkers.length).toBeGreaterThan(0);
    expect(controller.getState()).toBe("idle");

    controller.destroy();
  });

  // ── Shared TTS provider resolution ──────────────────────────────────

  describe("resolveCallTtsProvider (shared helper)", () => {
    test("returns native path with elevenlabs (non-streaming provider)", async () => {
      // Default config has provider: "elevenlabs" which is registered as
      // non-streaming in registerTestTtsProviders()
      const result = await resolveCallTtsProvider();
      expect(result.provider).not.toBeNull();
      expect(result.provider!.id).toBe("elevenlabs");
      expect(result.useSynthesizedPath).toBe(false);
      expect(result.audioFormat).toBe("mp3");
    });

    test("returns fallback when the configured provider is not in the catalog", async () => {
      // The schema enum rejects unknown providers, so this state can only be
      // produced by mutating the loader's cached config directly.
      const cfg = loadConfig();
      (cfg.services.tts as { provider: string }).provider =
        "not-a-real-provider";

      const result = await resolveCallTtsProvider();
      expect(result.provider).toBeNull();
      expect(result.useSynthesizedPath).toBe(false);
      expect(result.audioFormat).toBe("mp3");
    });

    test("degrades fish-audio synthesized path when referenceId is missing", async () => {
      const cfg = loadConfig();
      cfg.services.tts.provider = "fish-audio";
      cfg.services.tts.providers["fish-audio"].referenceId = "";

      const result = await resolveCallTtsProvider();
      expect(result.provider).toBeNull();
      expect(result.useSynthesizedPath).toBe(false);
      expect(result.audioFormat).toBe("mp3");
    });

    test("call controller LLM path uses shared resolution (native provider sends text tokens)", async () => {
      // With the default elevenlabs provider (non-streaming), the call
      // controller should send text tokens directly to the relay (native path).
      mockStartVoiceTurn.mockImplementation(
        createMockVoiceTurn(["Hello", " caller"]),
      );
      const { relay, controller } = setupController();

      await controller.handleCallerUtterance("Hi");

      // Native path: text tokens should be sent, no play URLs
      const nonEmptyTokens = relay.sentTokens.filter((t) => t.token.length > 0);
      expect(nonEmptyTokens.length).toBeGreaterThan(0);
      expect(relay.sentPlayUrls.length).toBe(0);

      controller.destroy();
    });

    test("returns synthesized path with deepgram provider", async () => {
      const cfg = loadConfig();
      cfg.services.tts.provider = "deepgram";

      const result = await resolveCallTtsProvider();
      expect(result.provider).not.toBeNull();
      expect(result.provider!.id).toBe("deepgram");
      expect(result.useSynthesizedPath).toBe(true);
      expect(result.audioFormat).toBe("mp3");
    });

    test("Deepgram does not apply fish-audio referenceId gate", async () => {
      // Deepgram has no referenceId requirement. Verify the fish-audio
      // config gate does not apply to deepgram resolution.
      const cfg = loadConfig();
      cfg.services.tts.provider = "deepgram";
      // fish-audio referenceId left empty — should not affect deepgram.
      cfg.services.tts.providers["fish-audio"].referenceId = "";

      const result = await resolveCallTtsProvider();
      expect(result.provider).not.toBeNull();
      expect(result.provider!.id).toBe("deepgram");
      expect(result.useSynthesizedPath).toBe(true);
    });
  });

  // ── handleBargeIn ───────────────────────────────────────────────────

  describe("handleBargeIn", () => {
    test("handleBargeIn returns false and does not abort when controller is idle", () => {
      const { relay, controller } = setupController();

      // Controller starts idle after construction
      expect(controller.getState()).toBe("idle");
      const onAccepted = mock(() => {});
      const result = controller.handleBargeIn(onAccepted);

      expect(result).toBe(false);
      expect(onAccepted).not.toHaveBeenCalled();
      // No end-of-turn token should have been sent (no interruption)
      const endTokens = relay.sentTokens.filter(
        (t) => t.last === true && t.token === "",
      );
      expect(endTokens.length).toBe(0);

      controller.destroy();
    });

    test("handleBargeIn returns false and does not abort while still processing (no output yet)", async () => {
      // Simulate a turn stuck waiting for the processing lock: no tokens
      // emitted, no completion. The controller must stay in `processing` and
      // NOT flip to `speaking`, so barge-in can't abort a silent turn.
      mockStartVoiceTurn.mockImplementation(
        async (opts: {
          onTextDelta: (t: string) => void;
          onComplete: () => void;
          signal?: AbortSignal;
        }) => {
          // Never emit tokens or complete — remain in the pre-speech phase.
          return { turnId: "run-slow", abort: () => opts.onComplete() };
        },
      );

      const { relay, controller } = setupController();
      const turnPromise = controller.handleCallerUtterance("Hello");

      // Wait for microtasks to settle
      for (let i = 0; i < 5; i++) {
        await Promise.resolve();
      }

      // No outbound audio/tokens yet → still processing.
      expect(controller.getState()).toBe("processing");

      const onAccepted = mock(() => {});
      const bargeResult = controller.handleBargeIn(onAccepted);
      expect(bargeResult).toBe(false);
      expect(onAccepted).not.toHaveBeenCalled();
      // Still processing (not aborted), and no interrupt/end-of-turn token sent.
      expect(controller.getState()).toBe("processing");
      const endTokens = relay.sentTokens.filter(
        (t) => t.last === true && t.token === "",
      );
      expect(endTokens.length).toBe(0);

      // Cleanup: abort the pending turn
      controller.destroy();
      await turnPromise.catch(() => {});
    });

    test("stays in processing until first token, then flips to speaking and barge-in is accepted", async () => {
      // Gate the first token so we can observe the pre-speech processing phase
      // (e.g. the lock-wait / generation window) before any audio is emitted.
      let emitFirstToken!: () => void;
      const firstTokenGate = new Promise<void>((r) => {
        emitFirstToken = r;
      });
      let releaseTurn!: () => void;
      const completeGate = new Promise<void>((r) => {
        releaseTurn = r;
      });

      mockStartVoiceTurn.mockImplementation(
        async (opts: {
          onTextDelta: (t: string) => void;
          onComplete: () => void;
          signal?: AbortSignal;
        }) => {
          await firstTokenGate;
          if (opts.signal?.aborted) {
            const err = new Error("aborted");
            err.name = "AbortError";
            throw err;
          }
          opts.onTextDelta("Hello");
          // Hold the turn open so state remains `speaking` until we barge in.
          opts.signal?.addEventListener("abort", () => releaseTurn());
          await completeGate;
          opts.onComplete();
          return { turnId: "run-gate", abort: () => releaseTurn() };
        },
      );

      const { controller } = setupController();
      const turnPromise = controller.handleCallerUtterance("Hi");
      for (let i = 0; i < 5; i++) {
        await Promise.resolve();
      }

      // Before any token: processing, barge-in ignored (turn not aborted).
      expect(controller.getState()).toBe("processing");
      expect(controller.handleBargeIn()).toBe(false);
      expect(controller.getState()).toBe("processing");

      // Release the first token → controller flips to speaking.
      emitFirstToken();
      for (let i = 0; i < 5; i++) {
        await Promise.resolve();
      }
      expect(controller.getState()).toBe("speaking");

      // Now barge-in is accepted and interrupts the turn.
      expect(controller.handleBargeIn()).toBe(true);
      expect(controller.getState()).toBe("idle");

      controller.destroy();
      await turnPromise.catch(() => {});
    });

    test("buffering transport (media-stream): streamed tokens do not flip to speaking; barge-in is rejected and the turn still delivers", async () => {
      // Simulates the media-stream transport: sendTextToken(.., false)
      // only buffers; audio starts later. The controller must stay in
      // `processing` until the transport's audio-start signal fires, so
      // VAD speech-start during generation cannot abort a silent turn.
      let releaseTurn!: () => void;
      const completeGate = new Promise<void>((r) => {
        releaseTurn = r;
      });

      mockStartVoiceTurn.mockImplementation(
        async (opts: {
          onTextDelta: (t: string) => void;
          onComplete: () => void;
          signal?: AbortSignal;
        }) => {
          opts.onTextDelta("Hello");
          opts.onTextDelta(" caller");
          opts.signal?.addEventListener("abort", () => releaseTurn());
          await completeGate;
          opts.onComplete();
          return { turnId: "run-buffered", abort: () => releaseTurn() };
        },
      );

      const { relay, controller } = setupController();
      let audioStartCallback: (() => void) | null = null;
      relay.setAudioStartCallback = (cb) => {
        audioStartCallback = cb;
      };

      const turnPromise = controller.handleCallerUtterance("Hi");
      for (let i = 0; i < 10; i++) {
        await Promise.resolve();
      }

      // Tokens were emitted (buffered by the transport) but no audio has
      // started — the controller must still be processing.
      expect(
        relay.sentTokens.filter((t) => !t.last && t.token.length > 0).length,
      ).toBeGreaterThan(0);
      expect(controller.getState()).toBe("processing");
      expect(audioStartCallback).not.toBeNull();

      // VAD speech-start mid-generation → barge-in rejected, turn intact.
      expect(controller.handleBargeIn()).toBe(false);
      expect(controller.getState()).toBe("processing");

      // The turn completes and delivers its end-of-turn signal.
      releaseTurn();
      await turnPromise;
      const endTokens = relay.sentTokens.filter(
        (t) => t.last === true && t.token === "",
      );
      expect(endTokens.length).toBe(1);

      controller.destroy();
    });

    test("buffering transport: audio-start signal flips to speaking and barge-in is accepted", async () => {
      let releaseTurn!: () => void;
      const completeGate = new Promise<void>((r) => {
        releaseTurn = r;
      });

      mockStartVoiceTurn.mockImplementation(
        async (opts: {
          onTextDelta: (t: string) => void;
          onComplete: () => void;
          signal?: AbortSignal;
        }) => {
          opts.onTextDelta("Hello");
          opts.signal?.addEventListener("abort", () => releaseTurn());
          await completeGate;
          opts.onComplete();
          return { turnId: "run-buffered-2", abort: () => releaseTurn() };
        },
      );

      const { relay, controller } = setupController();
      let audioStartCallback: (() => void) | null = null;
      let discardedPendingText = 0;
      relay.setAudioStartCallback = (cb) => {
        audioStartCallback = cb;
      };
      relay.discardPendingText = () => {
        discardedPendingText++;
      };

      const turnPromise = controller.handleCallerUtterance("Hi");
      for (let i = 0; i < 10; i++) {
        await Promise.resolve();
      }
      expect(controller.getState()).toBe("processing");

      // Transport reports real outbound audio started → speaking.
      audioStartCallback!();
      expect(controller.getState()).toBe("speaking");

      // Barge-in now aborts the turn, discards the transport's buffered
      // text, and returns the controller to idle.
      expect(controller.handleBargeIn()).toBe(true);
      expect(controller.getState()).toBe("idle");
      expect(discardedPendingText).toBeGreaterThan(0);

      controller.destroy();
      await turnPromise.catch(() => {});
    });

    test("buffering transport: a caller utterance during processing cancels the transport's pending speech", async () => {
      let releaseTurn!: () => void;
      const completeGate = new Promise<void>((r) => {
        releaseTurn = r;
      });
      let turnCalls = 0;
      mockStartVoiceTurn.mockImplementation(
        async (opts: {
          onTextDelta: (t: string) => void;
          onComplete: () => void;
          signal?: AbortSignal;
        }) => {
          turnCalls++;
          if (turnCalls === 1) {
            opts.onTextDelta("Queued sentence one. Queued sentence two.");
            opts.signal?.addEventListener("abort", () => releaseTurn());
            await completeGate;
            opts.onComplete();
            return { turnId: "run-cancel-1", abort: () => releaseTurn() };
          }
          opts.onTextDelta("Second turn reply.");
          opts.onComplete();
          return { turnId: "run-cancel-2", abort: () => {} };
        },
      );

      const { relay, controller } = setupController();
      let cancelledPendingSpeech = 0;
      // Buffering transport: audio never starts, so the first turn stays
      // in `processing` with its sentences already queued for synthesis.
      relay.setAudioStartCallback = () => {};
      relay.cancelPendingSpeech = () => {
        cancelledPendingSpeech++;
      };

      const turn1 = controller.handleCallerUtterance("Hi");
      for (let i = 0; i < 10; i++) {
        await Promise.resolve();
      }
      expect(controller.getState()).toBe("processing");
      expect(cancelledPendingSpeech).toBe(0);

      // The caller speaks again before any audio played — the aborted
      // turn's queued speech must be cancelled so it cannot play over
      // the new turn.
      await controller.handleCallerUtterance("Actually, wait");
      expect(cancelledPendingSpeech).toBeGreaterThan(0);

      await turn1.catch(() => {});
      controller.destroy();
    });

    test("buffering transport: stale audio-start signal from a superseded run does not flip state", async () => {
      let releaseTurn!: () => void;
      const completeGate = new Promise<void>((r) => {
        releaseTurn = r;
      });

      mockStartVoiceTurn.mockImplementation(
        async (opts: {
          onTextDelta: (t: string) => void;
          onComplete: () => void;
          signal?: AbortSignal;
        }) => {
          opts.onTextDelta("Hello");
          opts.signal?.addEventListener("abort", () => releaseTurn());
          await completeGate;
          opts.onComplete();
          return { turnId: "run-buffered-3", abort: () => releaseTurn() };
        },
      );

      const { relay, controller } = setupController();
      let audioStartCallback: (() => void) | null = null;
      relay.setAudioStartCallback = (cb) => {
        audioStartCallback = cb;
      };

      const turnPromise = controller.handleCallerUtterance("Hi");
      for (let i = 0; i < 10; i++) {
        await Promise.resolve();
      }
      const staleCallback = audioStartCallback!;

      // Supersede the run (hard interrupt), then fire the stale signal.
      controller.handleInterrupt();
      expect(controller.getState()).toBe("idle");
      staleCallback();
      expect(controller.getState()).toBe("idle");

      controller.destroy();
      await turnPromise.catch(() => {});
    });

    test("handleBargeIn returns true and interrupts when controller is speaking", async () => {
      // Create a turn that holds the speaking state long enough to test barge-in
      let resolveComplete: () => void;
      const completePromise = new Promise<void>((r) => {
        resolveComplete = r;
      });

      mockStartVoiceTurn.mockImplementation(
        async (opts: {
          onTextDelta: (t: string) => void;
          onComplete: () => void;
          signal?: AbortSignal;
        }) => {
          opts.onTextDelta("Hello");
          opts.onTextDelta(" there");
          // Don't complete yet — wait for external signal
          opts.signal?.addEventListener("abort", () => {
            resolveComplete!();
          });
          await completePromise;
          opts.onComplete();
          return { turnId: "run-barge", abort: () => resolveComplete!() };
        },
      );

      const { relay, controller } = setupController();
      const turnPromise = controller.handleCallerUtterance("Hi");

      // Let microtasks settle so onTextDelta runs
      for (let i = 0; i < 10; i++) {
        await Promise.resolve();
      }

      expect(controller.getState()).toBe("speaking");

      // onAccepted must fire after the speaking gate but BEFORE the
      // end-of-turn token from handleInterrupt, so a transport's queue
      // flush cannot wipe that mark.
      const endTokensAtAccept: number[] = [];
      const onAccepted = mock(() => {
        endTokensAtAccept.push(
          relay.sentTokens.filter((t) => t.last === true && t.token === "")
            .length,
        );
      });
      const result = controller.handleBargeIn(onAccepted);
      expect(result).toBe(true);
      expect(onAccepted).toHaveBeenCalledTimes(1);
      expect(endTokensAtAccept).toEqual([0]);
      const endTokens = relay.sentTokens.filter(
        (t) => t.last === true && t.token === "",
      );
      expect(endTokens.length).toBe(1);

      // After barge-in, controller should be idle
      expect(controller.getState()).toBe("idle");

      controller.destroy();
      await turnPromise.catch(() => {});
    });
  });
});
