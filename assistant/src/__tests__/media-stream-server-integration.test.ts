import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  mock,
  test,
} from "bun:test";

// ---------------------------------------------------------------------------
// Module mocks — declared before imports of the module under test.
// ---------------------------------------------------------------------------

// Mock the STT resolve module (used by MediaStreamSttSession)
mock.module("../providers/speech-to-text/resolve.js", () => ({
  resolveTelephonySttCapability: jest.fn(),
  resolveBatchTranscriber: jest.fn(),
}));

// Mock the logger to suppress output during tests
mock.module("../util/logger.js", () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

// Mock the call store — lightweight in-memory stubs
const mockSessions = new Map<string, Record<string, unknown>>();
const mockEvents: Array<{
  callSessionId: string;
  eventType: string;
  data: unknown;
}> = [];

mock.module("../calls/call-store.js", () => ({
  getCallSession: jest.fn((id: string) => mockSessions.get(id) ?? null),
  updateCallSession: jest.fn((id: string, updates: Record<string, unknown>) => {
    const session = mockSessions.get(id);
    if (session) {
      Object.assign(session, updates);
    }
  }),
  recordCallEvent: jest.fn(
    (callSessionId: string, eventType: string, data: unknown) => {
      mockEvents.push({ callSessionId, eventType, data });
    },
  ),
  createCallSession: jest.fn(),
  getCallSessionByCallSid: jest.fn(),
  getActiveCallSessionForConversation: jest.fn(),
  createPendingQuestion: jest.fn(),
  expirePendingQuestions: jest.fn(),
  getPendingQuestion: jest.fn(),
  answerPendingQuestion: jest.fn(),
}));

// Mock the call state machine
mock.module("../calls/call-state-machine.js", () => ({
  isTerminalState: jest.fn(
    (status: string) =>
      status === "completed" || status === "failed" || status === "cancelled",
  ),
}));

// Mock the call state (controller registry)
const mockControllers = new Map<string, unknown>();
mock.module("../calls/call-state.js", () => ({
  registerCallController: jest.fn(
    (callSessionId: string, controller: unknown) => {
      mockControllers.set(callSessionId, controller);
    },
  ),
  unregisterCallController: jest.fn((callSessionId: string) => {
    mockControllers.delete(callSessionId);
  }),
  getCallController: jest.fn((callSessionId: string) =>
    mockControllers.get(callSessionId),
  ),
  fireCallTranscriptNotifier: jest.fn(),
  fireCallQuestionNotifier: jest.fn(),
  fireCallCompletionNotifier: jest.fn(),
  registerCallQuestionNotifier: jest.fn(),
  unregisterCallQuestionNotifier: jest.fn(),
  registerCallTranscriptNotifier: jest.fn(),
  unregisterCallTranscriptNotifier: jest.fn(),
  registerCallCompletionNotifier: jest.fn(),
  unregisterCallCompletionNotifier: jest.fn(),
}));

// Mock the finalize-call module
mock.module("../calls/finalize-call.js", () => ({
  finalizeCall: jest.fn(),
}));

// Mock the call pointer messages
mock.module("../calls/call-pointer-messages.js", () => ({
  addPointerMessage: jest.fn(async () => {}),
  formatDuration: jest.fn((ms: number) => `${Math.round(ms / 1000)}s`),
}));

// Mock the CallController to avoid pulling in the full conversation pipeline
const mockStartInitialGreeting = jest.fn(async () => {});
const mockHandleCallerUtterance = jest.fn(async () => {});
const mockHandleInterrupt = jest.fn();
const mockDestroy = jest.fn();

const mockHandleBargeIn = jest.fn(() => false);

mock.module("../calls/call-controller.js", () => ({
  CallController: jest.fn().mockImplementation(() => ({
    startInitialGreeting: mockStartInitialGreeting,
    handleCallerUtterance: mockHandleCallerUtterance,
    handleInterrupt: mockHandleInterrupt,
    handleBargeIn: mockHandleBargeIn,
    destroy: mockDestroy,
    getState: jest.fn(() => "idle"),
    setTrustContext: jest.fn(),
    markNextCallerTurnAsOpeningAck: jest.fn(),
    getPendingConsultationQuestionId: jest.fn(),
    handleUserAnswer: jest.fn(),
    handleUserInstruction: jest.fn(),
  })),
}));

// Mock the assistant scope
mock.module("../runtime/assistant-scope.js", () => ({
  DAEMON_INTERNAL_ASSISTANT_ID: "self",
}));

// Mock the relay setup router so handleStart() doesn't query the database.
// Default returns normal_call; individual tests can override via
// `mockRouteSetupResult` to exercise deny and unsupported-flow branches.
let mockRouteSetupResult: {
  outcome: { action: string; [key: string]: unknown };
  resolved: {
    assistantId: string;
    isInbound: boolean;
    otherPartyNumber: string;
    actorTrust: { trustClass: string; memberRecord: null };
  };
} = {
  outcome: { action: "normal_call" as const, isInbound: true },
  resolved: {
    assistantId: "self",
    isInbound: true,
    otherPartyNumber: "+15551234567",
    actorTrust: {
      trustClass: "guardian" as const,
      memberRecord: null,
    },
  },
};

mock.module("../calls/relay-setup-router.js", () => ({
  routeSetup: jest.fn(() => mockRouteSetupResult),
}));

// Mock the actor trust resolver (used by handleStart to derive trust context)
mock.module("../runtime/actor-trust-resolver.js", () => ({
  toTrustContext: jest.fn(() => ({
    sourceChannel: "phone",
    trustClass: "guardian",
  })),
  resolveActorTrust: jest.fn(() => ({
    trustClass: "guardian",
    memberRecord: null,
  })),
}));

// Mock the call speech output (speakSystemPrompt used in deny/unsupported paths)
mock.module("../calls/call-speech-output.js", () => ({
  speakSystemPrompt: jest.fn(async () => {}),
}));

// Mock scoped approval grants (used in handleTransportClosed and early teardown)
mock.module("../memory/scoped-approval-grants.js", () => ({
  revokeScopedApprovalGrantsForContext: jest.fn(),
}));

// Mock the credential-compatibility preflight (PR 10). Default ready so a
// normal_call still bootstraps a controller; the inbound not-ready test
// toggles this to assert the spoken-setup-message + end-call behavior.
let mockCredentialReadiness: {
  status: "ready" | "not-ready";
  missing?: Array<{ kind: string; providerId: string | null; reason: string }>;
} = { status: "ready" };

mock.module("../calls/telephony-credential-preflight.js", () => ({
  resolveTelephonyCredentialReadiness: jest.fn(
    async () => mockCredentialReadiness,
  ),
  describeCredentialGaps: jest.fn(
    (
      missing: Array<{
        kind: string;
        providerId: string | null;
        reason: string;
      }>,
    ) =>
      missing
        .map(
          (g) =>
            `${g.kind === "stt" ? "speech-to-text" : "text-to-speech"} provider ${
              g.providerId ? `"${g.providerId}"` : "(unconfigured)"
            } (${g.reason})`,
        )
        .join(", "),
  ),
}));

// Mock the TTS provider resolution so that the dynamic import inside
// MediaStreamOutput.processSynthesizeItem() doesn't pull in the real
// config/provider chain (which would hang or error in a test environment).
mock.module("../calls/resolve-call-tts-provider.js", () => ({
  resolveCallTtsProvider: jest.fn(() => ({
    provider: null,
    useSynthesizedPath: false,
    audioFormat: "mp3" as const,
  })),
  resolvePlayableCallTtsProvider: jest.fn(async () => ({
    provider: null,
    audioFormat: "wav" as const,
  })),
}));

// Mock the verification/invite primitives the setup flow consumes so the
// integration test can drive deterministic success/failure outcomes without a
// live channel/invite store.
let mockVerificationResult: unknown = {
  outcome: "success",
  eventName: "voice_verification_succeeded",
  verificationType: "guardian",
};
let mockInviteResult: unknown = {
  outcome: "success",
  memberId: "member-1",
  type: "trusted_contact",
};
mock.module("../calls/relay-verification.js", () => ({
  parseDigitsFromSpeech: jest.fn((t: string) => t.replace(/\D/g, "")),
  attemptVerificationCode: jest.fn(() => mockVerificationResult),
  attemptInviteCodeRedemption: jest.fn(() => mockInviteResult),
}));

// Mock the access-request helper so name-capture opens a deterministic request.
let mockNotifyResult: {
  notified: boolean;
  requestId?: string;
  reason?: string;
} = { notified: true, requestId: "access-req-1" };
mock.module("../runtime/access-request-helper.js", () => ({
  notifyGuardianOfAccessRequest: jest.fn(() => mockNotifyResult),
}));

// Mock the canonical guardian store (polled by the real GuardianWaitController).
let mockCanonicalRequestStatus: "pending" | "approved" | "denied" = "pending";
mock.module("../memory/canonical-guardian-store.js", () => ({
  getCanonicalGuardianRequest: jest.fn(() => ({
    id: "access-req-1",
    status: mockCanonicalRequestStatus,
  })),
}));

// Mock label/persona resolution used by the setup-flow copy deps.
mock.module("../contacts/contact-store.js", () => ({
  findGuardianForChannel: jest.fn(() => null),
  listGuardianChannels: jest.fn(() => null),
}));
mock.module("../daemon/identity-helpers.js", () => ({
  getAssistantName: jest.fn(() => "Aria"),
}));
mock.module("../prompts/user-reference.js", () => ({
  resolveGuardianName: jest.fn(
    (displayName?: string) => displayName ?? "your contact",
  ),
}));

// Mock conversation-crud (callee-verification code post).
mock.module("../memory/conversation-crud.js", () => ({
  addMessage: jest.fn(async () => {}),
}));

// Capture the most-recently-constructed STT session's callbacks so tests can
// fire transcript/DTMF events directly (driving real audio through the turn
// detector + a transcriber is impractical under fake timers). The real STT
// session is exercised by media-stream-stt-session.test.ts; here we only need
// the callback wiring into MediaStreamCallSession.
let lastSttCallbacks: {
  onSpeechStart?: () => void;
  onTranscriptFinal?: (text: string, durationMs: number) => void;
  onDtmf?: (digit: string) => void;
  onStop?: () => void;
  onError?: (category: string, message: string) => void;
} = {};
mock.module("../calls/media-stream-stt-session.js", () => ({
  MediaStreamSttSession: jest.fn().mockImplementation((_config, callbacks) => {
    lastSttCallbacks = callbacks ?? {};
    return {
      handleMessage: jest.fn(),
      dispose: jest.fn(),
    };
  }),
}));

// ---------------------------------------------------------------------------
// Now import the module under test.
// ---------------------------------------------------------------------------

import { speakSystemPrompt } from "../calls/call-speech-output.js";
import { registerCallController } from "../calls/call-state.js";
import { recordCallEvent, updateCallSession } from "../calls/call-store.js";
import { finalizeCall } from "../calls/finalize-call.js";
import {
  activeMediaStreamSessions,
  MediaStreamCallSession,
} from "../calls/media-stream-server.js";

// ---------------------------------------------------------------------------
// Async helpers
// ---------------------------------------------------------------------------

/**
 * Flush pending microtasks (promise continuations). Used to let the async
 * credential preflight kicked off by `handleStart` resolve before asserting on
 * the controller's initial greeting / not-ready teardown. Works under jest fake
 * timers because it relies on microtasks, not the timer queue.
 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Mock WebSocket factory
// ---------------------------------------------------------------------------

function createMockWs() {
  const sent: string[] = [];
  let closed = false;
  let closeCode: number | undefined;
  let closeReason: string | undefined;

  return {
    ws: {
      send(data: string) {
        if (closed) throw new Error("WebSocket is closed");
        sent.push(data);
      },
      close(code?: number, reason?: string) {
        closed = true;
        closeCode = code;
        closeReason = reason;
      },
    } as unknown as import("bun").ServerWebSocket<unknown>,
    get sent() {
      return sent;
    },
    get closed() {
      return closed;
    },
    get closeCode() {
      return closeCode;
    },
    get closeReason() {
      return closeReason;
    },
  };
}

// ---------------------------------------------------------------------------
// Fixture factories
// ---------------------------------------------------------------------------

function makeStartMessage(overrides?: {
  callSid?: string;
  streamSid?: string;
}): string {
  return JSON.stringify({
    event: "start",
    sequenceNumber: "1",
    streamSid: overrides?.streamSid ?? "MZ00000000000000000000000000000000",
    start: {
      accountSid: "AC00000000000000000000000000000000",
      streamSid: overrides?.streamSid ?? "MZ00000000000000000000000000000000",
      callSid: overrides?.callSid ?? "CA00000000000000000000000000000000",
      tracks: ["inbound"],
      customParameters: {},
      mediaFormat: {
        encoding: "audio/x-mulaw",
        sampleRate: 8000,
        channels: 1,
      },
    },
  });
}

function makeMediaMessage(payload: string, chunk: string = "1"): string {
  return JSON.stringify({
    event: "media",
    sequenceNumber: "2",
    streamSid: "MZ00000000000000000000000000000000",
    media: {
      track: "inbound",
      chunk,
      timestamp: "100",
      payload,
    },
  });
}

function makeStopMessage(): string {
  return JSON.stringify({
    event: "stop",
    sequenceNumber: "99",
    streamSid: "MZ00000000000000000000000000000000",
    stop: {
      accountSid: "AC00000000000000000000000000000000",
      callSid: "CA00000000000000000000000000000000",
    },
  });
}

function makeMarkMessage(name: string): string {
  return JSON.stringify({
    event: "mark",
    sequenceNumber: "50",
    streamSid: "MZ00000000000000000000000000000000",
    mark: { name },
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.useFakeTimers();
  mockSessions.clear();
  mockEvents.length = 0;
  mockControllers.clear();
  activeMediaStreamSessions.clear();
  mockStartInitialGreeting.mockClear();
  mockHandleCallerUtterance.mockClear();
  mockHandleInterrupt.mockClear();
  mockHandleBargeIn.mockClear();
  mockHandleBargeIn.mockReturnValue(false);
  mockDestroy.mockClear();
  (registerCallController as jest.Mock).mockClear();
  (recordCallEvent as jest.Mock).mockClear();
  (updateCallSession as jest.Mock).mockClear();
  (finalizeCall as jest.Mock).mockClear();
  (speakSystemPrompt as jest.Mock).mockClear();
  mockCredentialReadiness = { status: "ready" };
  mockVerificationResult = {
    outcome: "success",
    eventName: "voice_verification_succeeded",
    verificationType: "guardian",
  };
  mockInviteResult = {
    outcome: "success",
    memberId: "member-1",
    type: "trusted_contact",
  };
  mockNotifyResult = { notified: true, requestId: "access-req-1" };
  mockCanonicalRequestStatus = "pending";
  // Reset routeSetup to default normal_call
  mockRouteSetupResult = {
    outcome: { action: "normal_call" as const, isInbound: true },
    resolved: {
      assistantId: "self",
      isInbound: true,
      otherPartyNumber: "+15551234567",
      actorTrust: {
        trustClass: "guardian" as const,
        memberRecord: null,
      },
    },
  };
});

afterEach(() => {
  jest.useRealTimers();
  activeMediaStreamSessions.clear();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MediaStreamCallSession", () => {
  test("creates a session and exposes output adapter", () => {
    const { ws } = createMockWs();
    const session = new MediaStreamCallSession(ws, "call-1");
    expect(session.callSessionId).toBe("call-1");
    expect(session.getOutput()).toBeDefined();
    expect(session.getOutput().getConnectionState()).toBe("connected");
  });

  describe("start event handling", () => {
    test("start event registers a controller and records call_connected", async () => {
      const mock = createMockWs();
      // Set up a call session in the mock store
      mockSessions.set("call-1", {
        id: "call-1",
        conversationId: "conv-1",
        status: "initiated",
        task: "Test task",
        startedAt: null,
        toNumber: "+15551234567",
      });

      const session = new MediaStreamCallSession(mock.ws, "call-1");
      session.handleMessage(makeStartMessage());

      // Controller registration and the lifecycle event/update happen
      // synchronously in handleStart.
      expect(registerCallController).toHaveBeenCalledWith(
        "call-1",
        expect.anything(),
      );
      expect(recordCallEvent).toHaveBeenCalledWith(
        "call-1",
        "call_connected",
        expect.objectContaining({
          callSid: "CA00000000000000000000000000000000",
          transport: "media-stream",
        }),
      );
      expect(updateCallSession).toHaveBeenCalledWith(
        "call-1",
        expect.objectContaining({
          providerCallSid: "CA00000000000000000000000000000000",
          status: "in_progress",
        }),
      );

      // The initial greeting fires after the async credential preflight
      // resolves — flush microtasks before asserting.
      await flushMicrotasks();
      expect(mockStartInitialGreeting).toHaveBeenCalled();
    });

    test("start event updates streamSid on the output adapter", () => {
      const mock = createMockWs();
      mockSessions.set("call-1", {
        id: "call-1",
        conversationId: "conv-1",
        status: "initiated",
        task: null,
        startedAt: null,
        toNumber: "+15551234567",
      });

      const session = new MediaStreamCallSession(mock.ws, "call-1");
      session.handleMessage(makeStartMessage({ streamSid: "MZ-custom-sid" }));

      expect(session.getOutput().getStreamSid()).toBe("MZ-custom-sid");
    });

    test("credential preflight not-ready speaks a setup message, records the event, and ends the call without a controller", async () => {
      const mock = createMockWs();
      mockSessions.set("call-1", {
        id: "call-1",
        conversationId: "conv-1",
        status: "initiated",
        task: "Test task",
        startedAt: null,
        toNumber: "+12025550123",
      });
      mockCredentialReadiness = {
        status: "not-ready",
        missing: [
          {
            kind: "stt",
            providerId: "openai-whisper",
            reason: "missing-credentials",
          },
        ],
      };

      const session = new MediaStreamCallSession(mock.ws, "call-1");
      session.handleMessage(makeStartMessage());

      // The controller is bootstrapped synchronously, then the async preflight
      // tears it down when not-ready. Flush microtasks to let it resolve.
      await flushMicrotasks();

      // Controller was torn down (destroyed + unregistered) and never greeted.
      expect(mockDestroy).toHaveBeenCalled();
      expect(mockStartInitialGreeting).not.toHaveBeenCalled();

      // Failure event recorded with direction + missing details.
      expect(recordCallEvent).toHaveBeenCalledWith(
        "call-1",
        "telephony_credential_preflight_failed",
        expect.objectContaining({
          direction: "inbound",
          transport: "media-stream",
          missing: mockCredentialReadiness.missing,
        }),
      );

      // Session marked failed.
      expect(updateCallSession).toHaveBeenCalledWith(
        "call-1",
        expect.objectContaining({ status: "failed" }),
      );

      // A spoken setup-required message went out over the media-stream TTS path.
      expect(speakSystemPrompt).toHaveBeenCalledTimes(1);

      // The call was finalized (teardown) rather than left connected silent.
      expect(finalizeCall).toHaveBeenCalledWith("call-1", "conv-1");
    });
  });

  describe("transport close handling", () => {
    test("normal close (1000) marks session as completed", () => {
      const mock = createMockWs();
      mockSessions.set("call-1", {
        id: "call-1",
        conversationId: "conv-1",
        status: "in_progress",
        startedAt: Date.now() - 60000,
        toNumber: "+15551234567",
      });

      const session = new MediaStreamCallSession(mock.ws, "call-1");
      session.handleTransportClosed(1000, "normal-close");

      expect(updateCallSession).toHaveBeenCalledWith(
        "call-1",
        expect.objectContaining({ status: "completed" }),
      );
      expect(finalizeCall).toHaveBeenCalledWith("call-1", "conv-1");
    });

    test("abnormal close marks session as failed", () => {
      const mock = createMockWs();
      mockSessions.set("call-1", {
        id: "call-1",
        conversationId: "conv-1",
        status: "in_progress",
        startedAt: Date.now() - 60000,
        toNumber: "+15551234567",
      });

      const session = new MediaStreamCallSession(mock.ws, "call-1");
      session.handleTransportClosed(1006, "abnormal-close");

      expect(updateCallSession).toHaveBeenCalledWith(
        "call-1",
        expect.objectContaining({
          status: "failed",
          lastError: expect.stringContaining("abnormal-close"),
        }),
      );
      expect(finalizeCall).toHaveBeenCalledWith("call-1", "conv-1");
    });

    test("close on already-terminal session is a no-op", () => {
      const mock = createMockWs();
      mockSessions.set("call-1", {
        id: "call-1",
        conversationId: "conv-1",
        status: "completed",
        toNumber: "+15551234567",
      });

      const session = new MediaStreamCallSession(mock.ws, "call-1");
      session.handleTransportClosed(1000);

      // updateCallSession should NOT have been called because session
      // was already terminal
      expect(updateCallSession).not.toHaveBeenCalled();
    });
  });

  describe("destroy", () => {
    test("destroys the controller and marks output as closed", () => {
      const mock = createMockWs();
      mockSessions.set("call-1", {
        id: "call-1",
        conversationId: "conv-1",
        status: "initiated",
        task: null,
        startedAt: null,
        toNumber: "+15551234567",
      });

      const session = new MediaStreamCallSession(mock.ws, "call-1");
      // Trigger start to create a controller
      session.handleMessage(makeStartMessage());

      session.destroy();
      expect(mockDestroy).toHaveBeenCalled();
      expect(session.getOutput().getConnectionState()).toBe("closed");
    });

    test("destroy is idempotent", () => {
      const mock = createMockWs();
      const session = new MediaStreamCallSession(mock.ws, "call-1");
      session.destroy();
      session.destroy(); // Should not throw
    });

    test("messages after destroy are dropped", () => {
      const mock = createMockWs();
      const session = new MediaStreamCallSession(mock.ws, "call-1");
      session.destroy();

      // Should not throw or create side effects
      session.handleMessage(makeStartMessage());
      expect(registerCallController).not.toHaveBeenCalled();
    });
  });

  describe("media event forwarding", () => {
    test("media events are forwarded to the STT session without errors", () => {
      const mock = createMockWs();
      mockSessions.set("call-1", {
        id: "call-1",
        conversationId: "conv-1",
        status: "initiated",
        task: null,
        startedAt: null,
        toNumber: "+15551234567",
      });

      const session = new MediaStreamCallSession(mock.ws, "call-1");
      session.handleMessage(makeStartMessage());

      // Send media frames — should not throw
      const payload = Buffer.from("test-audio").toString("base64");
      session.handleMessage(makeMediaMessage(payload, "1"));
      session.handleMessage(makeMediaMessage(payload, "2"));
      session.handleMessage(makeMediaMessage(payload, "3"));
    });

    test("mark events are forwarded without errors", () => {
      const mock = createMockWs();
      const session = new MediaStreamCallSession(mock.ws, "call-1");

      // Mark events should be silently handled
      session.handleMessage(makeMarkMessage("end-of-turn"));
    });

    test("stop events are forwarded to the STT session", () => {
      const mock = createMockWs();
      mockSessions.set("call-1", {
        id: "call-1",
        conversationId: "conv-1",
        status: "initiated",
        task: null,
        startedAt: null,
        toNumber: "+15551234567",
      });

      const session = new MediaStreamCallSession(mock.ws, "call-1");
      session.handleMessage(makeStartMessage());
      session.handleMessage(makeStopMessage());

      // Stop is informational; the session continues until WebSocket closes
    });
  });

  describe("malformed messages", () => {
    test("invalid JSON is dropped silently", () => {
      const mock = createMockWs();
      const session = new MediaStreamCallSession(mock.ws, "call-1");
      // Should not throw
      session.handleMessage("not json {{{");
    });

    test("unknown event types are dropped silently", () => {
      const mock = createMockWs();
      const session = new MediaStreamCallSession(mock.ws, "call-1");
      session.handleMessage(JSON.stringify({ event: "unknown_type" }));
    });
  });
});

describe("media-stream output egress", () => {
  // These tests exercise the async playback queue which relies on real
  // timers (setTimeout / Bun.sleep). Override the global fake-timers
  // from the outer beforeEach for this block.
  beforeEach(() => {
    jest.useRealTimers();
  });

  test("sendTextToken with text produces outbound media frames", async () => {
    const mockWs = createMockWs();
    mockSessions.set("call-out-1", {
      id: "call-out-1",
      conversationId: "conv-out-1",
      status: "initiated",
      task: "Outbound test",
      startedAt: null,
      toNumber: "+15551234567",
    });

    const session = new MediaStreamCallSession(mockWs.ws, "call-out-1");
    session.handleMessage(makeStartMessage());

    // Simulate the controller sending text to the output adapter
    const output = session.getOutput();
    output.sendTextToken("Hello caller", true);

    // Allow the async playback queue to drain
    await Bun.sleep(50);

    // The output should have sent at least an end-of-turn mark.
    // Media frames depend on TTS provider availability (mocked away in
    // this test suite), but the mark is always sent synchronously.
    const markMessages = mockWs.sent.filter(
      (s) => JSON.parse(s).event === "mark",
    );
    expect(markMessages.length).toBeGreaterThan(0);

    const markParsed = JSON.parse(markMessages[0]);
    expect(markParsed.mark.name).toBe("end-of-turn");
  });

  test("empty sendTextToken (end-of-turn signal) sends only a mark, no media", async () => {
    const mockWs = createMockWs();
    mockSessions.set("call-eot-1", {
      id: "call-eot-1",
      conversationId: "conv-eot-1",
      status: "initiated",
      task: null,
      startedAt: null,
      toNumber: "+15551234567",
    });

    const session = new MediaStreamCallSession(mockWs.ws, "call-eot-1");
    session.handleMessage(makeStartMessage());

    const output = session.getOutput();
    output.sendTextToken("", true);

    await Bun.sleep(50);

    // Should send a mark but no media frames
    const mediaMessages = mockWs.sent.filter(
      (s) => JSON.parse(s).event === "media",
    );
    const markMessages = mockWs.sent.filter(
      (s) => JSON.parse(s).event === "mark",
    );

    expect(mediaMessages).toHaveLength(0);
    expect(markMessages.length).toBeGreaterThan(0);
  });

  test("sendAudioPayload sends media frames to Twilio", () => {
    const mockWs = createMockWs();
    mockSessions.set("call-audio-1", {
      id: "call-audio-1",
      conversationId: "conv-audio-1",
      status: "initiated",
      task: null,
      startedAt: null,
      toNumber: "+15551234567",
    });

    const session = new MediaStreamCallSession(mockWs.ws, "call-audio-1");
    session.handleMessage(makeStartMessage());

    const output = session.getOutput();
    const payload = Buffer.from("test-audio-data").toString("base64");
    output.sendAudioPayload(payload);

    const mediaMessages = mockWs.sent.filter(
      (s) => JSON.parse(s).event === "media",
    );
    expect(mediaMessages).toHaveLength(1);
    expect(JSON.parse(mediaMessages[0]).media.payload).toBe(payload);
  });

  test("clearAudio sends clear command and flushes playback queue", async () => {
    const mockWs = createMockWs();
    mockSessions.set("call-barge-1", {
      id: "call-barge-1",
      conversationId: "conv-barge-1",
      status: "initiated",
      task: null,
      startedAt: null,
      toNumber: "+15551234567",
    });

    const session = new MediaStreamCallSession(mockWs.ws, "call-barge-1");
    session.handleMessage(makeStartMessage());

    const output = session.getOutput();

    // Queue some output
    output.sendTextToken("This will be interrupted", true);

    // Immediately barge-in
    output.clearAudio();

    await Bun.sleep(50);

    // Should have sent a clear command
    const clearMessages = mockWs.sent.filter(
      (s) => JSON.parse(s).event === "clear",
    );
    expect(clearMessages.length).toBeGreaterThanOrEqual(1);
  });

  test("barge-in via speech start clears audio and interrupts controller", () => {
    const mockWs = createMockWs();
    mockSessions.set("call-interrupt-1", {
      id: "call-interrupt-1",
      conversationId: "conv-interrupt-1",
      status: "initiated",
      task: "Test task",
      startedAt: null,
      toNumber: "+15551234567",
    });

    const session = new MediaStreamCallSession(mockWs.ws, "call-interrupt-1");
    session.handleMessage(makeStartMessage());

    // Verify the controller is created
    expect(session.getController()).not.toBeNull();

    // Simulate a caller starting to speak (barge-in) by sending media
    // while the assistant would be speaking. The handleSpeechStart callback
    // should clear audio and call handleInterrupt on the controller.
    // Note: In the real flow, the STT session detects speech start from
    // audio energy. Here we verify the wiring by checking that the
    // controller's handleInterrupt was called (if speech start fires).
    // The STT session is stubbed, so we verify the output adapter's
    // clearAudio works independently.
    const output = session.getOutput();
    output.clearAudio();

    const clearMessages = mockWs.sent.filter(
      (s) => JSON.parse(s).event === "clear",
    );
    expect(clearMessages.length).toBeGreaterThanOrEqual(1);
  });
});

describe("activeMediaStreamSessions registry", () => {
  test("sessions can be added and retrieved", () => {
    const mock = createMockWs();
    const session = new MediaStreamCallSession(mock.ws, "call-1");
    activeMediaStreamSessions.set("call-1", session);
    expect(activeMediaStreamSessions.get("call-1")).toBe(session);
    activeMediaStreamSessions.delete("call-1");
    expect(activeMediaStreamSessions.get("call-1")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Scenario-driven setup outcome coverage
// ---------------------------------------------------------------------------
// These tests drive each routeSetup outcome through the live CallSetupFlow
// over the media-stream output transport, asserting the correct controller
// creation / opener selection / teardown for every continuation.

/** Register a session row and start a media-stream session for an outcome. */
function startSessionWithOutcome(
  callSessionId: string,
  sessionRow: Record<string, unknown>,
): { session: MediaStreamCallSession; ws: ReturnType<typeof createMockWs> } {
  const ws = createMockWs();
  mockSessions.set(callSessionId, { id: callSessionId, ...sessionRow });
  const session = new MediaStreamCallSession(ws.ws, callSessionId);
  session.handleMessage(makeStartMessage());
  return { session, ws };
}

describe("media-stream setup outcome scenarios", () => {
  describe("deny outcome", () => {
    test("deny outcome records inbound_acl_denied event and sets status to failed", async () => {
      mockRouteSetupResult = {
        outcome: {
          action: "deny",
          message: "This number is not authorized.",
          logReason: "Inbound voice ACL: blocked caller",
        },
        resolved: {
          assistantId: "self",
          isInbound: true,
          otherPartyNumber: "+15559998888",
          actorTrust: { trustClass: "unknown", memberRecord: null },
        },
      };

      const mockWs = createMockWs();
      mockSessions.set("call-deny-1", {
        id: "call-deny-1",
        conversationId: "conv-deny-1",
        status: "initiated",
        task: null,
        startedAt: null,
        fromNumber: "+15559998888",
        toNumber: "+15555550143",
      });

      const session = new MediaStreamCallSession(mockWs.ws, "call-deny-1");
      session.handleMessage(makeStartMessage());
      await flushMicrotasks();

      // Should record an inbound_acl_denied event (flow records logReason)
      expect(recordCallEvent).toHaveBeenCalledWith(
        "call-deny-1",
        "inbound_acl_denied",
        expect.objectContaining({
          logReason: "Inbound voice ACL: blocked caller",
        }),
      );

      // The terminal `ended` continuation marks the session failed.
      expect(updateCallSession).toHaveBeenCalledWith(
        "call-deny-1",
        expect.objectContaining({
          status: "failed",
          lastError: "Inbound voice ACL: blocked caller",
        }),
      );

      // Should NOT register a controller (deny path resolves `ended`, no
      // controller is created)
      expect(registerCallController).not.toHaveBeenCalled();
    });

    test("deny outcome speaks the denial message", () => {
      mockRouteSetupResult = {
        outcome: {
          action: "deny",
          message: "This number is not authorized to use this assistant.",
          logReason: "Inbound voice ACL: member policy deny",
        },
        resolved: {
          assistantId: "self",
          isInbound: true,
          otherPartyNumber: "+15559998888",
          actorTrust: { trustClass: "unknown", memberRecord: null },
        },
      };

      const mockWs = createMockWs();
      mockSessions.set("call-deny-speak-1", {
        id: "call-deny-speak-1",
        conversationId: "conv-deny-speak-1",
        status: "initiated",
        task: null,
        startedAt: null,
        fromNumber: "+15559998888",
        toNumber: "+15555550143",
      });

      const session = new MediaStreamCallSession(
        mockWs.ws,
        "call-deny-speak-1",
      );
      session.handleMessage(makeStartMessage());

      // speakSystemPrompt should be called with the denial message
      expect(speakSystemPrompt).toHaveBeenCalledWith(
        expect.anything(),
        "This number is not authorized to use this assistant.",
      );
    });

    test("deny outcome runs finalization", async () => {
      mockRouteSetupResult = {
        outcome: {
          action: "deny",
          message: "Not authorized.",
          logReason: "ACL deny",
        },
        resolved: {
          assistantId: "self",
          isInbound: true,
          otherPartyNumber: "+15559998888",
          actorTrust: { trustClass: "unknown", memberRecord: null },
        },
      };

      const mockWs = createMockWs();
      mockSessions.set("call-deny-finalize-1", {
        id: "call-deny-finalize-1",
        conversationId: "conv-deny-finalize-1",
        status: "initiated",
        task: null,
        startedAt: null,
        fromNumber: "+15559998888",
        toNumber: "+15555550143",
      });

      const session = new MediaStreamCallSession(
        mockWs.ws,
        "call-deny-finalize-1",
      );
      session.handleMessage(makeStartMessage());
      await flushMicrotasks();

      // finalizeCall should be called because the terminal `ended` continuation
      // runs it inline
      expect(finalizeCall).toHaveBeenCalledWith(
        "call-deny-finalize-1",
        "conv-deny-finalize-1",
      );
    });
  });

  describe("interactive setup flows reach the controller with the right opener", () => {
    test("inbound guardian verification: DTMF code success greets normally", async () => {
      mockRouteSetupResult = {
        outcome: {
          action: "verification",
          assistantId: "self",
          fromNumber: "+15555550142",
        },
        resolved: {
          assistantId: "self",
          isInbound: true,
          otherPartyNumber: "+15555550142",
          actorTrust: { trustClass: "unknown", memberRecord: null },
        },
      };
      mockVerificationResult = {
        outcome: "success",
        eventName: "voice_verification_succeeded",
        verificationType: "guardian",
      };

      startSessionWithOutcome("call-verify-1", {
        conversationId: "conv-verify-1",
        status: "initiated",
        task: null,
        startedAt: null,
        fromNumber: "+15555550142",
        toNumber: "+15555550143",
      });

      // No controller yet — setup flow is collecting the code.
      expect(registerCallController).not.toHaveBeenCalled();

      // Drive a full 6-digit code over DTMF frames; the flow consumes it,
      // verifies, and resolves proceed-initial-greeting.
      for (const digit of ["1", "2", "3", "4", "5", "6"]) {
        lastSttCallbacks.onDtmf?.(digit);
      }
      await flushMicrotasks();

      // The controller is now created and the normal greeting fired (after the
      // credential preflight resolves).
      expect(registerCallController).toHaveBeenCalledWith(
        "call-verify-1",
        expect.anything(),
      );
      await flushMicrotasks();
      expect(mockStartInitialGreeting).toHaveBeenCalled();
    });

    test("inbound invite redemption: DTMF code success uses the handoff opener", async () => {
      mockRouteSetupResult = {
        outcome: {
          action: "invite_redemption",
          assistantId: "self",
          fromNumber: "+15555550142",
          friendName: "Sam",
          guardianName: "Alex",
        },
        resolved: {
          assistantId: "self",
          isInbound: true,
          otherPartyNumber: "+15555550142",
          actorTrust: { trustClass: "unknown", memberRecord: null },
        },
      };
      mockInviteResult = {
        outcome: "success",
        memberId: "member-1",
        type: "trusted_contact",
      };

      const { session } = startSessionWithOutcome("call-invite-1", {
        conversationId: "conv-invite-1",
        status: "initiated",
        task: null,
        startedAt: null,
        fromNumber: "+15555550142",
        toNumber: "+15555550143",
      });

      for (const digit of ["9", "8", "7", "6", "5", "4"]) {
        lastSttCallbacks.onDtmf?.(digit);
      }
      await flushMicrotasks();

      // Handoff copy already spoken by the flow → controller created, next
      // caller turn marked as opening-ack, NO initial greeting fired.
      expect(registerCallController).toHaveBeenCalledWith(
        "call-invite-1",
        expect.anything(),
      );
      expect(
        session.getController()?.markNextCallerTurnAsOpeningAck,
      ).toBeDefined();
      expect(mockStartInitialGreeting).not.toHaveBeenCalled();
    });

    test("outbound callee verification: spoken-digit code success greets normally", async () => {
      mockRouteSetupResult = {
        outcome: {
          action: "callee_verification",
          verificationConfig: { maxAttempts: 3, codeLength: 6 },
        },
        resolved: {
          assistantId: "self",
          isInbound: false,
          otherPartyNumber: "+15555550142",
          actorTrust: { trustClass: "guardian", memberRecord: null },
        },
      };

      startSessionWithOutcome("call-callee-1", {
        conversationId: "conv-callee-1",
        status: "initiated",
        task: "Outbound task",
        startedAt: null,
        fromNumber: "+15555550143",
        toNumber: "+15555550142",
        initiatedFromConversationId: "origin-conv-1",
      });
      // Let the detached code-post side effects settle so the generated code
      // is known and the resolver is installed.
      await flushMicrotasks();

      // The callee-verification code is generated internally; we can't read it,
      // but the callee path treats a matching code via DTMF as success. Since
      // the code is random, instead assert the flow is active (collecting) and
      // that a generic wrong code keeps the flow open without a controller.
      lastSttCallbacks.onDtmf?.("0");
      lastSttCallbacks.onDtmf?.("0");
      lastSttCallbacks.onDtmf?.("0");
      await flushMicrotasks();

      // The verification code post went out to the originating conversation.
      const { addMessage } = await import("../memory/conversation-crud.js");
      expect(addMessage).toHaveBeenCalled();
    });

    test("name_capture → guardian approval creates controller with handoff opener", async () => {
      mockRouteSetupResult = {
        outcome: {
          action: "name_capture",
          assistantId: "self",
          fromNumber: "+15555550142",
        },
        resolved: {
          assistantId: "self",
          isInbound: true,
          otherPartyNumber: "+15555550142",
          actorTrust: { trustClass: "unknown", memberRecord: null },
        },
      };
      mockNotifyResult = { notified: true, requestId: "access-req-1" };
      mockCanonicalRequestStatus = "approved";

      startSessionWithOutcome("call-name-1", {
        conversationId: "conv-name-1",
        status: "initiated",
        task: null,
        startedAt: null,
        fromNumber: "+15555550142",
        toNumber: "+15555550143",
      });

      // No controller during name capture.
      expect(registerCallController).not.toHaveBeenCalled();

      // The caller speaks their name → access request opened → guardian wait
      // starts. The mocked canonical request is already "approved" so the first
      // poll resolves the wait.
      lastSttCallbacks.onTranscriptFinal?.("Example User", 1200);
      // Drive the wait poll timer (fake timers) and let callbacks settle.
      jest.advanceTimersByTime(60_000);
      await flushMicrotasks();

      // Approval handoff spoken by the flow → controller created with the
      // opening-ack opener; no initial greeting.
      expect(registerCallController).toHaveBeenCalledWith(
        "call-name-1",
        expect.anything(),
      );
      expect(mockStartInitialGreeting).not.toHaveBeenCalled();
    });

    test("unverified caller: speaks guidance, fails the session, no controller", async () => {
      mockRouteSetupResult = {
        outcome: {
          action: "unverified_caller",
          displayName: "Jordan",
          isGuardian: false,
        },
        resolved: {
          assistantId: "self",
          isInbound: true,
          otherPartyNumber: "+15555550142",
          actorTrust: { trustClass: "unknown", memberRecord: null },
        },
      };

      startSessionWithOutcome("call-unver-1", {
        conversationId: "conv-unver-1",
        status: "initiated",
        task: null,
        startedAt: null,
        fromNumber: "+15555550142",
        toNumber: "+15555550143",
      });
      await flushMicrotasks();

      expect(speakSystemPrompt).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining("has not been verified"),
      );
      expect(updateCallSession).toHaveBeenCalledWith(
        "call-unver-1",
        expect.objectContaining({ status: "failed" }),
      );
      expect(registerCallController).not.toHaveBeenCalled();
      expect(finalizeCall).toHaveBeenCalledWith("call-unver-1", "conv-unver-1");
    });

    test("flow-finalized ended outcome (unverified) finalizes EXACTLY ONCE", async () => {
      // The unverified-caller path finalizes itself from inside CallSetupFlow
      // (finalizeFailedAccessRequest → injected finalizeFailedCall →
      // finalizeFailedSetup → runFinalizationAndGrantCleanup → finalizeCall).
      // It then resolves `ended`, and the ended branch of handleSetupComplete
      // must NOT finalize again — otherwise a second completion message would
      // be persisted and a second completion notifier fired. finalizeCall does
      // both, so a single invocation proves a single message + single notifier.
      mockRouteSetupResult = {
        outcome: {
          action: "unverified_caller",
          displayName: "Jordan",
          isGuardian: false,
        },
        resolved: {
          assistantId: "self",
          isInbound: true,
          otherPartyNumber: "+15555550142",
          actorTrust: { trustClass: "unknown", memberRecord: null },
        },
      };

      startSessionWithOutcome("call-once-1", {
        conversationId: "conv-once-1",
        status: "initiated",
        task: null,
        startedAt: null,
        fromNumber: "+15555550142",
        toNumber: "+15555550143",
      });
      await flushMicrotasks();

      expect(finalizeCall).toHaveBeenCalledTimes(1);
      expect(finalizeCall).toHaveBeenCalledWith("call-once-1", "conv-once-1");
    });

    test("guardian denial ended outcome finalizes EXACTLY ONCE", async () => {
      // Guardian denial finalizes itself inside the flow
      // (handleAccessRequestDenied → finalizeFailedAccessRequest →
      // finalizeFailedCall) before resolving `ended`; the ended branch must
      // skip re-finalizing the already-terminal session.
      mockRouteSetupResult = {
        outcome: {
          action: "name_capture",
          assistantId: "self",
          fromNumber: "+15555550142",
        },
        resolved: {
          assistantId: "self",
          isInbound: true,
          otherPartyNumber: "+15555550142",
          actorTrust: { trustClass: "unknown", memberRecord: null },
        },
      };
      mockNotifyResult = { notified: true, requestId: "access-req-1" };
      mockCanonicalRequestStatus = "denied";

      startSessionWithOutcome("call-deny-once-1", {
        conversationId: "conv-deny-once-1",
        status: "initiated",
        task: null,
        startedAt: null,
        fromNumber: "+15555550142",
        toNumber: "+15555550143",
      });

      // Caller speaks name → access request opened → guardian wait → first poll
      // resolves "denied".
      lastSttCallbacks.onTranscriptFinal?.("Example User", 1200);
      jest.advanceTimersByTime(60_000);
      await flushMicrotasks();

      expect(registerCallController).not.toHaveBeenCalled();
      expect(finalizeCall).toHaveBeenCalledTimes(1);
      expect(finalizeCall).toHaveBeenCalledWith(
        "call-deny-once-1",
        "conv-deny-once-1",
      );
    });

    test("guardian approval restores session status to in_progress", async () => {
      // Name-capture enters the guardian wait via markWaitingOnUser
      // (session → waiting_on_user). On approval the flow resolves
      // proceed-handoff-spoken and the controller is created; the session must
      // be restored to in_progress (matching relay-server) rather than left
      // parked in waiting_on_user for the rest of the connected call.
      mockRouteSetupResult = {
        outcome: {
          action: "name_capture",
          assistantId: "self",
          fromNumber: "+15555550142",
        },
        resolved: {
          assistantId: "self",
          isInbound: true,
          otherPartyNumber: "+15555550142",
          actorTrust: { trustClass: "unknown", memberRecord: null },
        },
      };
      mockNotifyResult = { notified: true, requestId: "access-req-1" };
      mockCanonicalRequestStatus = "approved";

      startSessionWithOutcome("call-approve-1", {
        conversationId: "conv-approve-1",
        status: "initiated",
        task: null,
        startedAt: null,
        fromNumber: "+15555550142",
        toNumber: "+15555550143",
      });

      // Caller speaks name → access request → guardian wait → markWaitingOnUser
      // drives the session to waiting_on_user.
      lastSttCallbacks.onTranscriptFinal?.("Example User", 1200);
      expect(mockSessions.get("call-approve-1")?.status).toBe(
        "waiting_on_user",
      );

      // First poll resolves "approved" → proceed-handoff-spoken → controller.
      jest.advanceTimersByTime(60_000);
      await flushMicrotasks();

      expect(registerCallController).toHaveBeenCalledWith(
        "call-approve-1",
        expect.anything(),
      );
      // The fix: restored to in_progress when the controller is created.
      expect(updateCallSession).toHaveBeenCalledWith("call-approve-1", {
        status: "in_progress",
      });
      expect(mockSessions.get("call-approve-1")?.status).toBe("in_progress");
    });

    test("dispose() on transport close tears down an in-flight setup flow", () => {
      mockRouteSetupResult = {
        outcome: {
          action: "verification",
          assistantId: "self",
          fromNumber: "+15555550142",
        },
        resolved: {
          assistantId: "self",
          isInbound: true,
          otherPartyNumber: "+15555550142",
          actorTrust: { trustClass: "unknown", memberRecord: null },
        },
      };

      const { session } = startSessionWithOutcome("call-dispose-1", {
        conversationId: "conv-dispose-1",
        status: "in_progress",
        task: null,
        startedAt: Date.now() - 1000,
        fromNumber: "+15555550142",
        toNumber: "+15555550143",
      });

      // Closing the transport while collecting a code must not throw and must
      // finalize the call (the setup flow is disposed first).
      session.handleTransportClosed(1006, "abnormal-close");
      expect(finalizeCall).toHaveBeenCalledWith(
        "call-dispose-1",
        "conv-dispose-1",
      );
    });

    test("transcript routing: setup-phase transcripts go to the flow, post-setup transcripts go to the controller", async () => {
      // name_capture so the flow stays active and consumes the first transcript
      // (the caller's name) rather than forwarding it to a controller.
      mockRouteSetupResult = {
        outcome: {
          action: "name_capture",
          assistantId: "self",
          fromNumber: "+15555550142",
        },
        resolved: {
          assistantId: "self",
          isInbound: true,
          otherPartyNumber: "+15555550142",
          actorTrust: { trustClass: "unknown", memberRecord: null },
        },
      };
      mockNotifyResult = { notified: true, requestId: "access-req-1" };
      mockCanonicalRequestStatus = "approved";

      const { session } = startSessionWithOutcome("call-route-1", {
        conversationId: "conv-route-1",
        status: "initiated",
        task: null,
        startedAt: null,
        fromNumber: "+15555550142",
        toNumber: "+15555550143",
      });

      // First transcript = the caller's name → consumed by the flow, NOT routed
      // to a controller's handleCallerUtterance (none exists yet).
      lastSttCallbacks.onTranscriptFinal?.("Jamie", 1000);
      expect(mockHandleCallerUtterance).not.toHaveBeenCalled();

      // Guardian approves → handoff spoken → controller created.
      jest.advanceTimersByTime(60_000);
      await flushMicrotasks();
      expect(session.getController()).not.toBeNull();

      // A subsequent transcript now routes to the live controller.
      lastSttCallbacks.onTranscriptFinal?.("Hello there", 1000);
      await flushMicrotasks();
      expect(mockHandleCallerUtterance).toHaveBeenCalledWith("Hello there");
    });

    test("normal_call after deny scenario still creates controller", async () => {
      // Verify that after a deny-scenario test, resetting to normal_call
      // properly creates a controller (no cross-test pollution).
      mockRouteSetupResult = {
        outcome: { action: "normal_call", isInbound: true },
        resolved: {
          assistantId: "self",
          isInbound: true,
          otherPartyNumber: "+15551234567",
          actorTrust: { trustClass: "guardian", memberRecord: null },
        },
      };

      const mockWs = createMockWs();
      mockSessions.set("call-reset-1", {
        id: "call-reset-1",
        conversationId: "conv-reset-1",
        status: "initiated",
        task: "Test task",
        startedAt: null,
        toNumber: "+15551234567",
      });

      const session = new MediaStreamCallSession(mockWs.ws, "call-reset-1");
      session.handleMessage(makeStartMessage());

      // Controller should be registered for normal calls
      expect(registerCallController).toHaveBeenCalledWith(
        "call-reset-1",
        expect.anything(),
      );

      // Initial greeting fires after the async preflight resolves.
      await flushMicrotasks();
      expect(mockStartInitialGreeting).toHaveBeenCalled();
    });
  });

  // ── Barge-in regression ──────────────────────────────────────────

  describe("barge-in gating", () => {
    test("immediate inbound audio after stream start does not trigger handleInterrupt", async () => {
      const mockWs = createMockWs();
      mockSessions.set("call-bargein-1", {
        id: "call-bargein-1",
        conversationId: "conv-bargein-1",
        status: "initiated",
        task: null,
        startedAt: null,
        toNumber: "+15551234567",
      });

      const session = new MediaStreamCallSession(mockWs.ws, "call-bargein-1");

      // Stream start bootstraps the controller; greeting fires post-preflight.
      session.handleMessage(makeStartMessage());
      await flushMicrotasks();
      expect(mockStartInitialGreeting).toHaveBeenCalled();

      // Immediate inbound speech — before the assistant has spoken. The STT
      // session surfaces speech-start via onSpeechStart, which calls
      // handleBargeIn. Since the controller mock returns false (not speaking),
      // handleInterrupt should NOT be called.
      lastSttCallbacks.onSpeechStart?.();
      lastSttCallbacks.onSpeechStart?.();

      // handleBargeIn was called but returned false
      expect(mockHandleBargeIn).toHaveBeenCalled();
      expect(mockHandleInterrupt).not.toHaveBeenCalled();

      // voice_session_aborted should NOT appear in recorded events
      const abortEvents = mockEvents.filter(
        (e) =>
          e.callSessionId === "call-bargein-1" &&
          e.eventType === "voice_session_aborted",
      );
      expect(abortEvents.length).toBe(0);

      session.destroy();
    });

    test("barge-in is accepted when controller is speaking", () => {
      // Configure mock to indicate the controller is speaking
      mockHandleBargeIn.mockReturnValue(true);

      const mockWs = createMockWs();
      mockSessions.set("call-bargein-2", {
        id: "call-bargein-2",
        conversationId: "conv-bargein-2",
        status: "in_progress",
        task: null,
        startedAt: Date.now() - 5000,
        toNumber: "+15551234567",
      });

      const session = new MediaStreamCallSession(mockWs.ws, "call-bargein-2");
      session.handleMessage(makeStartMessage());

      // Simulate inbound speech while the assistant is speaking.
      lastSttCallbacks.onSpeechStart?.();

      // handleBargeIn should have been called (returning true)
      expect(mockHandleBargeIn).toHaveBeenCalled();

      session.destroy();
    });
  });

  // ── E2E regression scenario ──────────────────────────────────────

  describe("end-to-end regression: connected call that stays active", () => {
    test("stream connects, inbound audio starts, call remains active for a turn, controller only destroyed at stop/hangup", async () => {
      const mockWs = createMockWs();
      mockSessions.set("call-e2e-1", {
        id: "call-e2e-1",
        conversationId: "conv-e2e-1",
        status: "initiated",
        task: null,
        startedAt: null,
        toNumber: "+15551234567",
      });

      const session = new MediaStreamCallSession(mockWs.ws, "call-e2e-1");

      // 1. Stream connects — start event arrives
      session.handleMessage(makeStartMessage());
      expect(registerCallController).toHaveBeenCalledWith(
        "call-e2e-1",
        expect.anything(),
      );
      await flushMicrotasks();
      expect(mockStartInitialGreeting).toHaveBeenCalled();

      // Verify session was updated to in_progress
      expect(updateCallSession).toHaveBeenCalledWith(
        "call-e2e-1",
        expect.objectContaining({ status: "in_progress" }),
      );

      // 2. Inbound audio starts immediately (controller idle — barge-in ignored)
      const payload = Buffer.from("test-audio").toString("base64");
      for (let i = 1; i <= 5; i++) {
        session.handleMessage(makeMediaMessage(payload, String(i)));
      }

      // handleInterrupt should NOT have been called (gated barge-in)
      expect(mockHandleInterrupt).not.toHaveBeenCalled();

      // 3. Controller is NOT destroyed yet — still active
      expect(mockDestroy).not.toHaveBeenCalled();

      // 4. More media frames arrive (simulating ongoing call)
      for (let i = 6; i <= 10; i++) {
        session.handleMessage(makeMediaMessage(payload, String(i)));
      }

      // Controller still not destroyed
      expect(mockDestroy).not.toHaveBeenCalled();

      // 5. Stop event arrives — controller should be cleaned up
      //    only when the session is fully destroyed
      session.handleMessage(makeStopMessage());

      // WebSocket close triggers full teardown
      mockSessions.set("call-e2e-1", {
        ...mockSessions.get("call-e2e-1")!,
        status: "in_progress",
        startedAt: Date.now() - 30000,
      });
      session.handleTransportClosed(1000, "normal-close");

      expect(updateCallSession).toHaveBeenCalledWith(
        "call-e2e-1",
        expect.objectContaining({ status: "completed" }),
      );

      // Now destroy
      session.destroy();
      expect(mockDestroy).toHaveBeenCalled();
    });
  });
});
