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

// Mock the STT resolve module (used by MediaStreamSttSession).
// resolveStreamingTranscriber yields no transcriber, so sessions settle on
// the batch path regardless of the calls.voice.telephonyStreaming default.
mock.module("../providers/speech-to-text/resolve.js", () => ({
  resolveTelephonySttCapability: jest.fn(),
  resolveBatchTranscriber: jest.fn(),
  resolveStreamingTranscriber: jest.fn(async () => null),
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
  postPointerMessageSafe: jest.fn(),
  formatDuration: jest.fn((ms: number) => `${Math.round(ms / 1000)}s`),
}));

// Mock the CallController to avoid pulling in the full conversation pipeline
const mockStartInitialGreeting = jest.fn(async () => {});
const mockStartPostVerificationGreeting = jest.fn(async () => {});
const mockMarkNextCallerTurnAsOpeningAck = jest.fn();
const mockHandleCallerUtterance = jest.fn(async () => {});
const mockHandleInterrupt = jest.fn();
const mockDestroy = jest.fn();

// Mirrors CallController.handleBargeIn: invokes onAccepted only when the
// barge-in passes the speaking gate.
const mockHandleBargeIn = jest.fn((_onAccepted?: () => void) => false);

mock.module("../calls/call-controller.js", () => ({
  CallController: jest.fn().mockImplementation(() => ({
    startInitialGreeting: mockStartInitialGreeting,
    startPostVerificationGreeting: mockStartPostVerificationGreeting,
    markNextCallerTurnAsOpeningAck: mockMarkNextCallerTurnAsOpeningAck,
    handleCallerUtterance: mockHandleCallerUtterance,
    handleInterrupt: mockHandleInterrupt,
    handleBargeIn: mockHandleBargeIn,
    destroy: mockDestroy,
    getState: jest.fn(() => "idle"),
    setTrustContext: jest.fn(),
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

// When set, routeSetup rejects instead — exercising the setup-failure
// teardown (e.g. the outbound unusable-verdict abort).
let mockRouteSetupError: Error | null = null;

mock.module("../calls/call-setup-router.js", () => ({
  routeSetup: jest.fn(() => {
    if (mockRouteSetupError) {
      throw mockRouteSetupError;
    }
    return mockRouteSetupResult;
  }),
}));

// Mock the inbound trust reader. handleStart awaits the combined
// verdict + admission-policy read (one gateway round-trip) and threads both
// into routeSetup so the media-stream transport enforces the gateway ACL and
// the admission floor. Tests override mockInboundVerdict /
// mockAdmissionPolicy, or set mockTrustReadUnavailable to exercise the
// fail-closed deny ({ ok: false } when the gateway is unreachable).
// Returning a resolved promise introduces a microtask hop, so tests await
// session.whenSetupSettled() after sending the start frame.
//
// The default verdict carries the guardian label the gateway stamps for the
// phone channel; setup-flow copy reads it via the primed displayName.
const defaultInboundVerdict = () => ({
  trustClass: "unknown",
  canonicalSenderId: null,
  guardianDisplayName: "Alex",
});
let mockAdmissionPolicy: unknown = null;
let mockTrustReadUnavailable = false;
// Optional gate: when set, the trust read awaits this promise before
// resolving, letting a test dispose the session mid-read (simulating a WS
// close while the gateway IPC read is pending) or deliver frames during the
// setup-routing window.
let mockTrustReadGate: Promise<void> | null = null;
// The verdict gate lets a test hold mid-setup trust RE-resolution open (the
// setup flow's default resolver reads the verdict) so it can deliver
// transcripts during the deferral window.
let mockInboundVerdict: unknown = defaultInboundVerdict();
let mockVerdictGate: Promise<void> | null = null;
const mockGetInboundTrustVerdict = jest.fn(
  async (_args?: Record<string, unknown>) => {
    if (mockVerdictGate) {
      await mockVerdictGate;
    }
    return mockInboundVerdict;
  },
);
const mockReadPhoneCallerTrust = jest.fn(
  async (otherPartyNumber: string | undefined) => {
    if (mockTrustReadGate) {
      await mockTrustReadGate;
    }
    if (mockTrustReadUnavailable) {
      return { ok: false as const };
    }
    const verdict = await mockGetInboundTrustVerdict({
      channelType: "phone",
      actorExternalId: otherPartyNumber || undefined,
    });
    return {
      ok: true as const,
      verdict,
      admissionPolicy: mockAdmissionPolicy,
    };
  },
);
mock.module("../calls/inbound-trust-reader.js", () => ({
  readPhoneCallerTrust: mockReadPhoneCallerTrust,
  getPhoneCallerVerdict: (otherPartyNumber: string | undefined) =>
    mockGetInboundTrustVerdict({
      channelType: "phone",
      actorExternalId: otherPartyNumber || undefined,
    }),
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
mock.module("../approvals/scoped-approval-grants.js", () => ({
  revokeScopedApprovalGrantsForContext: jest.fn(),
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
}));

// ── Setup-flow dependency mocks ─────────────────────────────────────────
// MediaStreamCallSession drives every routeSetup outcome through a real
// CallSetupFlow (and, for name capture, a real GuardianWaitController).
// Mock the side-effectful modules those pull in: config-backed timing
// constants, guardian labels, verification/invite services, the guardian
// notifier, canonical-request polling, and wait heartbeats.

// Config-backed call constants — small real-timer-friendly values.
let mockTtsPlaybackDelayMs = 5;
let mockAccessRequestPollIntervalMs = 5;
let mockUserConsultationTimeoutMs = 500;
mock.module("../calls/call-constants.js", () => ({
  isDeniedNumber: jest.fn(() => false),
  getMaxCallDurationMs: jest.fn(() => 3_600_000),
  getUserConsultationTimeoutMs: jest.fn(() => mockUserConsultationTimeoutMs),
  getTtsPlaybackDelayMs: jest.fn(() => mockTtsPlaybackDelayMs),
  getAccessRequestPollIntervalMs: jest.fn(
    () => mockAccessRequestPollIntervalMs,
  ),
  getGuardianWaitUpdateInitialIntervalMs: jest.fn(() => 10_000),
  getGuardianWaitUpdateInitialWindowMs: jest.fn(() => 60_000),
  getGuardianWaitUpdateSteadyMinIntervalMs: jest.fn(() => 20_000),
  getGuardianWaitUpdateSteadyMaxIntervalMs: jest.fn(() => 40_000),
  getSilenceTimeoutMs: jest.fn(() => 30_000),
  getEndCallListenWindowMs: jest.fn(() => 15_000),
}));

// Guardian delivery reader (IPC-backed). The setup path no longer reads it —
// the guardian label comes off the verdict — so tests assert these stay
// uncalled during handleStart; the mock also keeps transitive importers off
// the real IPC.
const mockGetGuardianDelivery = jest.fn(async () => [
  { channelType: "phone", status: "active", displayName: "Alex" },
]);
const mockGetGuardianDeliveryFresh = jest.fn(async () => []);
mock.module("../contacts/guardian-delivery-reader.js", () => ({
  getGuardianDelivery: mockGetGuardianDelivery,
  getGuardianDeliveryFresh: mockGetGuardianDeliveryFresh,
  peekCachedGuardianDelivery: jest.fn(() => null),
  voiceGuardianDisplayName: jest.fn(() => "Alex"),
  guardianForChannel: jest.fn(),
  anyGuardian: jest.fn(),
  invalidateGuardianDeliveryCache: jest.fn(),
}));

// Guardian/assistant display labels (filesystem-backed).
mock.module("../prompts/user-reference.js", () => ({
  DEFAULT_USER_REFERENCE: "my human",
  resolveGuardianName: jest.fn(
    (primed?: string | null) => primed ?? "my human",
  ),
}));
mock.module("../daemon/identity-helpers.js", () => ({
  getAssistantName: jest.fn(() => "Aria"),
  resolveUserName: jest.fn(() => null),
}));

// Conversation persistence (used by callee verification code posting).
const mockAddMessage = jest.fn(async () => ({}));
mock.module("../persistence/conversation-crud.js", () => ({
  addMessage: mockAddMessage,
}));

// Verification / invite services (gateway + verification-store backed).
type MockVerificationResult =
  | {
      outcome: "success";
      verificationType: "guardian" | "trusted_contact";
      eventName: string;
      ttsMessage?: string;
    }
  | {
      outcome: "failure";
      eventName: string;
      ttsMessage: string;
      attempts: number;
    }
  | {
      outcome: "retry";
      ttsMessage: string;
      attempt: number;
      maxAttempts: number;
    };
let mockVerificationResult: MockVerificationResult = {
  outcome: "success",
  verificationType: "guardian",
  eventName: "voice_verification_succeeded",
};
const mockAttemptVerificationCode = jest.fn(async () => mockVerificationResult);
type MockInviteResult =
  | { outcome: "success"; memberId: string; inviteId: string; type: string }
  | { outcome: "failure"; ttsMessage: string };
let mockInviteResult: MockInviteResult = {
  outcome: "success",
  memberId: "member-1",
  inviteId: "invite-1",
  type: "trusted_contact",
};
const mockAttemptInviteCodeRedemption = jest.fn(async () => mockInviteResult);
mock.module("../calls/call-verification.js", () => ({
  attemptVerificationCode: mockAttemptVerificationCode,
  attemptInviteCodeRedemption: mockAttemptInviteCodeRedemption,
  parseDigitsFromSpeech: jest.fn((text: string) => text.replace(/\D+/g, "")),
}));

// Guardian access-request notifier (name-capture sub-flow).
type MockNotifyResult =
  | { notified: true; created: boolean; requestId: string }
  | { notified: false; reason: string };
let mockNotifyResult: MockNotifyResult = {
  notified: true,
  created: true,
  requestId: "req-1",
};
const mockNotifyGuardianOfAccessRequest = jest.fn(async () => mockNotifyResult);
mock.module("../runtime/access-request-helper.js", () => ({
  notifyGuardianOfAccessRequest: mockNotifyGuardianOfAccessRequest,
}));

// Gateway guardian-request client polled by the guardian wait controller.
let mockCanonicalRequest: { status: string } | null = null;
const mockGetCanonicalGuardianRequest = jest.fn(
  async () => mockCanonicalRequest,
);
mock.module("../channels/gateway-guardian-requests.js", () => ({
  getGuardianRequestOrNull: mockGetCanonicalGuardianRequest,
}));

// Wait-state helpers: no heartbeats in tests; capture callback handoffs.
const mockEmitCallbackHandoff = jest.fn(
  (args: { callbackHandoffNotified: boolean }) => ({
    callbackHandoffNotified: args.callbackHandoffNotified,
    notified: false,
  }),
);
mock.module("../calls/access-request-wait.js", () => ({
  classifyWaitUtterance: jest.fn(() => "neutral"),
  scheduleNextHeartbeat: jest.fn(() => null),
  emitAccessRequestCallbackHandoff: mockEmitCallbackHandoff,
}));

// ---------------------------------------------------------------------------
// Now import the module under test.
// ---------------------------------------------------------------------------

import { revokeScopedApprovalGrantsForContext } from "../approvals/scoped-approval-grants.js";
import { CallController } from "../calls/call-controller.js";
import { postPointerMessageSafe } from "../calls/call-pointer-messages.js";
import { routeSetup } from "../calls/call-setup-router.js";
import { speakSystemPrompt } from "../calls/call-speech-output.js";
import {
  fireCallTranscriptNotifier,
  registerCallController,
} from "../calls/call-state.js";
import { recordCallEvent, updateCallSession } from "../calls/call-store.js";
import { finalizeCall } from "../calls/finalize-call.js";
import {
  activeMediaStreamSessions,
  MediaStreamCallSession,
} from "../calls/media-stream-server.js";

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
        if (closed) {
          throw new Error("WebSocket is closed");
        }
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

function makeDtmfMessage(digit: string): string {
  return JSON.stringify({
    event: "dtmf",
    sequenceNumber: "60",
    streamSid: "MZ00000000000000000000000000000000",
    dtmf: { digit },
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
  mockStartPostVerificationGreeting.mockClear();
  mockMarkNextCallerTurnAsOpeningAck.mockClear();
  mockHandleCallerUtterance.mockClear();
  mockHandleInterrupt.mockClear();
  mockHandleBargeIn.mockClear();
  mockHandleBargeIn.mockReturnValue(false);
  mockDestroy.mockClear();
  (CallController as unknown as jest.Mock).mockClear();
  (registerCallController as jest.Mock).mockClear();
  (fireCallTranscriptNotifier as jest.Mock).mockClear();
  (recordCallEvent as jest.Mock).mockClear();
  (updateCallSession as jest.Mock).mockClear();
  (finalizeCall as jest.Mock).mockClear();
  (revokeScopedApprovalGrantsForContext as jest.Mock).mockClear();
  (speakSystemPrompt as jest.Mock).mockClear();
  (postPointerMessageSafe as jest.Mock).mockClear();
  (routeSetup as jest.Mock).mockClear();
  mockRouteSetupError = null;
  mockReadPhoneCallerTrust.mockClear();
  mockAdmissionPolicy = null;
  mockTrustReadUnavailable = false;
  mockTrustReadGate = null;
  mockGetInboundTrustVerdict.mockClear();
  mockInboundVerdict = defaultInboundVerdict();
  mockVerdictGate = null;
  mockGetGuardianDelivery.mockClear();
  mockGetGuardianDeliveryFresh.mockClear();
  mockAddMessage.mockClear();
  mockAttemptVerificationCode.mockClear();
  mockVerificationResult = {
    outcome: "success",
    verificationType: "guardian",
    eventName: "voice_verification_succeeded",
  };
  mockAttemptInviteCodeRedemption.mockClear();
  mockInviteResult = {
    outcome: "success",
    memberId: "member-1",
    inviteId: "invite-1",
    type: "trusted_contact",
  };
  mockNotifyGuardianOfAccessRequest.mockClear();
  mockNotifyResult = { notified: true, created: true, requestId: "req-1" };
  mockGetCanonicalGuardianRequest.mockClear();
  mockCanonicalRequest = null;
  mockEmitCallbackHandoff.mockClear();
  mockTtsPlaybackDelayMs = 5;
  mockAccessRequestPollIntervalMs = 5;
  mockUserConsultationTimeoutMs = 500;
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
      await session.whenSetupSettled();

      // Controller should have been registered
      expect(registerCallController).toHaveBeenCalledWith(
        "call-1",
        expect.anything(),
      );

      // call_connected event should have been recorded
      expect(recordCallEvent).toHaveBeenCalledWith(
        "call-1",
        "call_connected",
        expect.objectContaining({
          callSid: "CA00000000000000000000000000000000",
          transport: "media-stream",
        }),
      );

      // Call session should have been updated
      expect(updateCallSession).toHaveBeenCalledWith(
        "call-1",
        expect.objectContaining({
          providerCallSid: "CA00000000000000000000000000000000",
          status: "in_progress",
        }),
      );

      // Initial greeting should have been fired
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
  });

  describe("transport close handling", () => {
    test("normal close (1000) marks session as completed and writes the completed pointer", () => {
      const mock = createMockWs();
      mockSessions.set("call-1", {
        id: "call-1",
        conversationId: "conv-1",
        status: "in_progress",
        startedAt: Date.now() - 60000,
        toNumber: "+15551234567",
        initiatedFromConversationId: "conv-origin",
      });

      const session = new MediaStreamCallSession(mock.ws, "call-1");
      session.handleTransportClosed(1000, "normal-close");

      expect(updateCallSession).toHaveBeenCalledWith(
        "call-1",
        expect.objectContaining({ status: "completed" }),
      );
      expect(finalizeCall).toHaveBeenCalledWith("call-1", "conv-1");
      expect(postPointerMessageSafe).toHaveBeenCalledWith(
        "conv-origin",
        "completed",
        "+15551234567",
        expect.objectContaining({ duration: expect.any(String) }),
      );
    });

    test("abnormal close marks session as failed and writes the failed pointer", () => {
      const mock = createMockWs();
      mockSessions.set("call-1", {
        id: "call-1",
        conversationId: "conv-1",
        status: "in_progress",
        startedAt: Date.now() - 60000,
        toNumber: "+15551234567",
        initiatedFromConversationId: "conv-origin",
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
      expect(postPointerMessageSafe).toHaveBeenCalledWith(
        "conv-origin",
        "failed",
        "+15551234567",
        expect.objectContaining({ reason: expect.any(String) }),
      );
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
    test("destroys the controller and marks output as closed", async () => {
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
      await session.whenSetupSettled();

      session.destroy();
      expect(mockDestroy).toHaveBeenCalled();
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

  test("barge-in via speech start clears audio and interrupts controller", async () => {
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
    await session.whenSetupSettled();

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
// These tests exercise the deny and unsupported-action branches in
// MediaStreamCallSession.handleStart by overriding mockRouteSetupResult
// before sending a start message.

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
        toNumber: "+15550001111",
      });

      const session = new MediaStreamCallSession(mockWs.ws, "call-deny-1");
      session.handleMessage(makeStartMessage());
      await session.whenSetupSettled();

      // Should record an inbound_acl_denied event
      expect(recordCallEvent).toHaveBeenCalledWith(
        "call-deny-1",
        "inbound_acl_denied",
        expect.objectContaining({
          from: "+15559998888",
        }),
      );

      // Should update session to failed
      expect(updateCallSession).toHaveBeenCalledWith(
        "call-deny-1",
        expect.objectContaining({
          status: "failed",
          lastError: "Inbound voice ACL: blocked caller",
        }),
      );

      // Should NOT register a controller (deny path skips it)
      expect(registerCallController).not.toHaveBeenCalled();
    });

    test("deny outcome speaks the denial message", async () => {
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
        toNumber: "+15550001111",
      });

      const session = new MediaStreamCallSession(
        mockWs.ws,
        "call-deny-speak-1",
      );
      session.handleMessage(makeStartMessage());
      await session.whenSetupSettled();

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
        toNumber: "+15550001111",
      });

      const session = new MediaStreamCallSession(
        mockWs.ws,
        "call-deny-finalize-1",
      );
      session.handleMessage(makeStartMessage());
      await session.whenSetupSettled();

      // finalizeCall should be called because early teardown runs it inline
      expect(finalizeCall).toHaveBeenCalledWith(
        "call-deny-finalize-1",
        "conv-deny-finalize-1",
      );
    });
  });

  describe("normal_call reset after deny", () => {
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
      await session.whenSetupSettled();

      // Controller should be registered for normal calls
      expect(registerCallController).toHaveBeenCalledWith(
        "call-reset-1",
        expect.anything(),
      );

      // Initial greeting should fire
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

      // Stream start bootstraps the controller
      session.handleMessage(makeStartMessage());
      await session.whenSetupSettled();
      expect(mockStartInitialGreeting).toHaveBeenCalled();

      // Immediate inbound audio (speech-like payloads) — before the
      // assistant has spoken. The speech detector classifies these as
      // speech, so onSpeechStart fires and calls handleBargeIn. Since
      // the controller mock returns false (not speaking), handleInterrupt
      // should NOT be called.
      const speechPayload = Buffer.alloc(160, 0x00).toString("base64");
      session.handleMessage(makeMediaMessage(speechPayload, "1"));
      session.handleMessage(makeMediaMessage(speechPayload, "2"));
      session.handleMessage(makeMediaMessage(speechPayload, "3"));

      // handleBargeIn was called but returned false
      expect(mockHandleBargeIn).toHaveBeenCalled();
      expect(mockHandleInterrupt).not.toHaveBeenCalled();

      // An ignored barge-in flushes only Twilio's buffered audio (to
      // stop a completed turn's tail talking over the caller). The
      // internal playback queue is untouched, so the queued greeting
      // still plays — handleInterrupt must not have run.
      const clearCommands = mockWs.sent.filter(
        (s) => JSON.parse(s).event === "clear",
      );
      expect(clearCommands.length).toBeGreaterThan(0);

      // voice_session_aborted should NOT appear in recorded events
      const abortEvents = mockEvents.filter(
        (e) =>
          e.callSessionId === "call-bargein-1" &&
          e.eventType === "voice_session_aborted",
      );
      expect(abortEvents.length).toBe(0);

      session.destroy();
    });

    test("barge-in is accepted when controller is speaking", async () => {
      // Configure mock to indicate the controller is speaking; like the
      // real controller, it fires onAccepted before interrupting.
      mockHandleBargeIn.mockImplementation((onAccepted?: () => void) => {
        onAccepted?.();
        return true;
      });

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
      await session.whenSetupSettled();

      // Simulate inbound speech audio while assistant is speaking.
      // Use a high-amplitude mu-law payload so speech detection triggers.
      const speechPayload = Buffer.alloc(160, 0x00).toString("base64");
      session.handleMessage(makeMediaMessage(speechPayload, "1"));

      // handleBargeIn should have been called (returning true), and the
      // accepted barge-in flushes outbound audio via the onAccepted hook.
      expect(mockHandleBargeIn).toHaveBeenCalled();
      const clearCommands = mockWs.sent.filter(
        (s) => JSON.parse(s).event === "clear",
      );
      expect(clearCommands.length).toBe(1);

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
      await session.whenSetupSettled();
      expect(registerCallController).toHaveBeenCalledWith(
        "call-e2e-1",
        expect.anything(),
      );
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

  // ── Admission floor enforcement on the media-stream transport ────────
  // The phone channel is no longer exempt from per-channel admission, so the
  // trust floor must be enforced on this transport too — not just the
  // gateway's no_one kill switch. handleStart resolves the phone admission
  // policy (riding the caller-trust verdict read — one gateway round-trip)
  // and threads it into routeSetup; a floor-denied caller (e.g. guardian_only
  // vs a trusted_contact) produces a `deny` outcome here, which speaks a
  // denial + tears down and never starts a normal call.

  describe("admission floor enforcement", () => {
    test("resolves the phone admission policy on the single trust read and threads it into routeSetup", async () => {
      mockAdmissionPolicy = "guardian_only";

      const mockWs = createMockWs();
      mockSessions.set("call-floor-thread-1", {
        id: "call-floor-thread-1",
        conversationId: "conv-floor-thread-1",
        status: "initiated",
        task: null,
        startedAt: null,
        fromNumber: "+14155550000",
        toNumber: "+15550001111",
      });

      const session = new MediaStreamCallSession(
        mockWs.ws,
        "call-floor-thread-1",
      );
      session.handleMessage(makeStartMessage());
      await session.whenSetupSettled();

      // Exactly one gateway read on the setup path: the combined verdict +
      // admission-policy IPC. No separate guardian display-name prime or
      // delivery cache warm.
      expect(mockReadPhoneCallerTrust).toHaveBeenCalledTimes(1);
      expect(mockReadPhoneCallerTrust).toHaveBeenCalledWith("+14155550000");
      expect(mockGetGuardianDelivery).not.toHaveBeenCalled();
      expect(mockGetGuardianDeliveryFresh).not.toHaveBeenCalled();
      expect(routeSetup).toHaveBeenCalledWith(
        expect.objectContaining({
          callSessionId: "call-floor-thread-1",
          admissionPolicy: "guardian_only",
        }),
      );
    });

    test("guardian_only floor denies a trusted-contact caller — speaks denial, tears down, no controller", async () => {
      mockAdmissionPolicy = "guardian_only";
      // With the floor wired, the real router would return `deny` for a
      // below-floor (trusted_contact) caller; the mock reflects that outcome.
      mockRouteSetupResult = {
        outcome: {
          action: "deny",
          message:
            "This number is not authorized to reach the assistant right now.",
          logReason: "Inbound voice admission floor: guardian_only",
        },
        resolved: {
          assistantId: "self",
          isInbound: true,
          otherPartyNumber: "+14155550000",
          actorTrust: { trustClass: "trusted_contact", memberRecord: null },
        },
      };

      const mockWs = createMockWs();
      mockSessions.set("call-floor-deny-1", {
        id: "call-floor-deny-1",
        conversationId: "conv-floor-deny-1",
        status: "initiated",
        task: null,
        startedAt: null,
        fromNumber: "+14155550000",
        toNumber: "+15550001111",
      });

      const session = new MediaStreamCallSession(
        mockWs.ws,
        "call-floor-deny-1",
      );
      session.handleMessage(makeStartMessage());
      await session.whenSetupSettled();

      // Policy was passed into routeSetup.
      expect(routeSetup).toHaveBeenCalledWith(
        expect.objectContaining({ admissionPolicy: "guardian_only" }),
      );

      // Denial spoken, session failed, no controller, finalization ran.
      expect(speakSystemPrompt).toHaveBeenCalledWith(
        expect.anything(),
        "This number is not authorized to reach the assistant right now.",
      );
      expect(updateCallSession).toHaveBeenCalledWith(
        "call-floor-deny-1",
        expect.objectContaining({
          status: "failed",
          lastError: "Inbound voice admission floor: guardian_only",
        }),
      );
      expect(registerCallController).not.toHaveBeenCalled();
      expect(mockStartInitialGreeting).not.toHaveBeenCalled();
      expect(finalizeCall).toHaveBeenCalledWith(
        "call-floor-deny-1",
        "conv-floor-deny-1",
      );
    });

    test("null policy (no enforcement) leaves behavior unchanged — normal call proceeds", async () => {
      mockAdmissionPolicy = null;
      // routeSetup default is normal_call.

      const mockWs = createMockWs();
      mockSessions.set("call-floor-null-1", {
        id: "call-floor-null-1",
        conversationId: "conv-floor-null-1",
        status: "initiated",
        task: null,
        startedAt: null,
        fromNumber: "+14155550000",
        toNumber: "+15550001111",
      });

      const session = new MediaStreamCallSession(
        mockWs.ws,
        "call-floor-null-1",
      );
      session.handleMessage(makeStartMessage());
      await session.whenSetupSettled();

      // Null policy is still threaded through (router skips the floor).
      expect(routeSetup).toHaveBeenCalledWith(
        expect.objectContaining({ admissionPolicy: null }),
      );

      // Normal call proceeds: controller registered + greeting fired.
      expect(registerCallController).toHaveBeenCalledWith(
        "call-floor-null-1",
        expect.anything(),
      );
      expect(mockStartInitialGreeting).toHaveBeenCalled();
    });

    test("unreachable gateway fails closed — inbound setup denied without routing", async () => {
      mockTrustReadUnavailable = true;

      const mockWs = createMockWs();
      mockSessions.set("call-floor-unavail-1", {
        id: "call-floor-unavail-1",
        conversationId: "conv-floor-unavail-1",
        status: "initiated",
        task: null,
        startedAt: null,
        fromNumber: "+15555550142",
        toNumber: "+15555550143",
      });

      const session = new MediaStreamCallSession(
        mockWs.ws,
        "call-floor-unavail-1",
      );
      session.handleMessage(makeStartMessage());
      await session.whenSetupSettled();

      // Fail closed promptly: no routing.
      expect(routeSetup).not.toHaveBeenCalled();

      // Standard deny teardown: unavailable copy spoken, session failed,
      // no controller, finalization ran.
      expect(speakSystemPrompt).toHaveBeenCalledWith(
        expect.anything(),
        "The assistant is unable to take this call right now. Please try again later.",
      );
      expect(updateCallSession).toHaveBeenCalledWith(
        "call-floor-unavail-1",
        expect.objectContaining({
          status: "failed",
          lastError: "Inbound voice admission floor: gateway unreachable",
        }),
      );
      expect(registerCallController).not.toHaveBeenCalled();
      expect(mockStartInitialGreeting).not.toHaveBeenCalled();
      expect(finalizeCall).toHaveBeenCalledWith(
        "call-floor-unavail-1",
        "conv-floor-unavail-1",
      );
    });

    test("unreachable gateway does not affect an outbound call (admission not consulted)", async () => {
      mockTrustReadUnavailable = true;
      mockRouteSetupResult = {
        outcome: { action: "normal_call", isInbound: false },
        resolved: {
          assistantId: "self",
          isInbound: false,
          otherPartyNumber: "+15555550144",
          actorTrust: { trustClass: "guardian", memberRecord: null },
        },
      };

      const mockWs = createMockWs();
      mockSessions.set("call-outbound-unavail-1", {
        id: "call-outbound-unavail-1",
        conversationId: "conv-outbound-unavail-1",
        initiatedFromConversationId: "conv-outbound-unavail-1",
        status: "initiated",
        task: null,
        startedAt: null,
        fromNumber: "+15555550143",
        toNumber: "+15555550144",
      });

      const session = new MediaStreamCallSession(
        mockWs.ws,
        "call-outbound-unavail-1",
      );
      session.handleMessage(makeStartMessage());
      await session.whenSetupSettled();

      // Outbound routes normally; the failed read degrades to a null policy
      // and a null verdict (the router ignores admission on outbound and owns
      // the missing-verdict abort posture).
      expect(routeSetup).toHaveBeenCalledWith(
        expect.objectContaining({ admissionPolicy: null, verdict: null }),
      );
      expect(registerCallController).toHaveBeenCalledWith(
        "call-outbound-unavail-1",
        expect.anything(),
      );
      expect(mockStartInitialGreeting).toHaveBeenCalled();
    });

    test("a floor-denied caller's transcript is dropped during setup routing", async () => {
      mockAdmissionPolicy = "guardian_only";
      mockRouteSetupResult = {
        outcome: {
          action: "deny",
          message:
            "This number is not authorized to reach the assistant right now.",
          logReason: "Inbound voice admission floor: guardian_only",
        },
        resolved: {
          assistantId: "self",
          isInbound: true,
          otherPartyNumber: "+14155550000",
          actorTrust: { trustClass: "trusted_contact", memberRecord: null },
        },
      };

      const mockWs = createMockWs();
      mockSessions.set("call-floor-drop-1", {
        id: "call-floor-drop-1",
        conversationId: "conv-floor-drop-1",
        status: "initiated",
        task: null,
        startedAt: null,
        fromNumber: "+14155550000",
        toNumber: "+15550001111",
      });

      const session = new MediaStreamCallSession(
        mockWs.ws,
        "call-floor-drop-1",
      );
      session.handleMessage(makeStartMessage());
      await session.whenSetupSettled();

      // No controller exists for a denied caller, so even if a transcript
      // arrived it could never reach handleCallerUtterance / be persisted.
      expect(registerCallController).not.toHaveBeenCalled();
      expect(mockHandleCallerUtterance).not.toHaveBeenCalled();
      // No caller_spoke event recorded for the denied caller.
      const callerSpoke = mockEvents.filter(
        (e) =>
          e.callSessionId === "call-floor-drop-1" &&
          e.eventType === "caller_spoke",
      );
      expect(callerSpoke.length).toBe(0);
    });

    test("a DTMF digit received during setup routing is dropped", async () => {
      // Gate the trust read so setupRouting is still true when the DTMF
      // frame arrives (simulating a digit during the gateway IPC read).
      let releaseGate!: () => void;
      mockTrustReadGate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });

      const mockWs = createMockWs();
      mockSessions.set("call-dtmf-drop-1", {
        id: "call-dtmf-drop-1",
        conversationId: "conv-dtmf-drop-1",
        status: "initiated",
        task: null,
        startedAt: null,
        fromNumber: "+14155550000",
        toNumber: "+15550001111",
      });

      const session = new MediaStreamCallSession(mockWs.ws, "call-dtmf-drop-1");
      session.handleMessage(makeStartMessage());

      // DTMF arrives while the trust read is still pending.
      session.handleMessage(makeDtmfMessage("5"));

      releaseGate();
      await session.whenSetupSettled();

      // The digit was dropped during setup: no caller_spoke event, no
      // controller interaction.
      const callerSpoke = mockEvents.filter(
        (e) =>
          e.callSessionId === "call-dtmf-drop-1" &&
          e.eventType === "caller_spoke",
      );
      expect(callerSpoke.length).toBe(0);
      expect(mockHandleCallerUtterance).not.toHaveBeenCalled();
    });

    test("session disposed during the trust read aborts setup — no controller, no greeting", async () => {
      // Gate the trust read so the session can be disposed (as the WS
      // close handler does) while handleStart is awaiting it.
      let releaseGate!: () => void;
      mockTrustReadGate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });

      const mockWs = createMockWs();
      mockSessions.set("call-disposed-1", {
        id: "call-disposed-1",
        conversationId: "conv-disposed-1",
        status: "initiated",
        task: null,
        startedAt: null,
        fromNumber: "+14155550000",
        toNumber: "+15550001111",
      });

      const session = new MediaStreamCallSession(mockWs.ws, "call-disposed-1");
      session.handleMessage(makeStartMessage());

      // Twilio closes the WebSocket mid-read: the server disposes the session.
      session.destroy();

      // Now let the trust read resolve and setup routing resume.
      releaseGate();
      await session.whenSetupSettled();

      // Setup must have aborted: routeSetup never ran, no controller, no greeting.
      expect(routeSetup).not.toHaveBeenCalled();
      expect(registerCallController).not.toHaveBeenCalled();
      expect(mockStartInitialGreeting).not.toHaveBeenCalled();
      expect(speakSystemPrompt).not.toHaveBeenCalled();
    });
  });

  // ── Gateway trust verdict ──────────────────────────────────────────
  // handleStart awaits readPhoneCallerTrust for the inbound caller and
  // threads the verdict into routeSetup, so the media-stream transport
  // enforces the gateway ACL. routeSetup itself decides verdict-vs-local;
  // these tests assert the verdict is fetched and passed.

  describe("gateway trust verdict", () => {
    test("fetches the inbound caller's verdict and threads it into routeSetup", async () => {
      mockInboundVerdict = {
        channelType: "phone",
        actorExternalId: "+14155550000",
        contactId: "contact-1",
        channelId: "channel-1",
        status: "verified",
        policy: "allow",
        resolutionFailed: false,
      };

      const mockWs = createMockWs();
      mockSessions.set("call-verdict-thread-1", {
        id: "call-verdict-thread-1",
        conversationId: "conv-verdict-thread-1",
        status: "initiated",
        task: null,
        startedAt: null,
        fromNumber: "+14155550000",
        toNumber: "+15550001111",
      });

      const session = new MediaStreamCallSession(
        mockWs.ws,
        "call-verdict-thread-1",
      );
      session.handleMessage(makeStartMessage());
      await session.whenSetupSettled();

      // Verdict fetched for the inbound caller (from number) on the phone channel.
      expect(mockGetInboundTrustVerdict).toHaveBeenCalledWith({
        channelType: "phone",
        actorExternalId: "+14155550000",
      });
      // Verdict threaded into routeSetup.
      expect(routeSetup).toHaveBeenCalledWith(
        expect.objectContaining({ verdict: mockInboundVerdict }),
      );
    });

    test("a blocked/denied member verdict is enforced (deny) on the media-stream transport", async () => {
      // The real router returns `deny` for a member verdict whose ACL is
      // blocked/revoked/deny; the mock reflects that outcome here.
      mockInboundVerdict = {
        channelType: "phone",
        actorExternalId: "+14155550000",
        contactId: "contact-1",
        channelId: "channel-1",
        status: "blocked",
        policy: "deny",
        resolutionFailed: false,
      };
      mockRouteSetupResult = {
        outcome: {
          action: "deny",
          message:
            "This number is not authorized to reach the assistant right now.",
          logReason: "Inbound voice ACL: member blocked",
        },
        resolved: {
          assistantId: "self",
          isInbound: true,
          otherPartyNumber: "+14155550000",
          actorTrust: { trustClass: "unknown", memberRecord: null },
        },
      };

      const mockWs = createMockWs();
      mockSessions.set("call-verdict-deny-1", {
        id: "call-verdict-deny-1",
        conversationId: "conv-verdict-deny-1",
        status: "initiated",
        task: null,
        startedAt: null,
        fromNumber: "+14155550000",
        toNumber: "+15550001111",
      });

      const session = new MediaStreamCallSession(
        mockWs.ws,
        "call-verdict-deny-1",
      );
      session.handleMessage(makeStartMessage());
      await session.whenSetupSettled();

      // Verdict was passed into routeSetup, which denied the caller.
      expect(routeSetup).toHaveBeenCalledWith(
        expect.objectContaining({ verdict: mockInboundVerdict }),
      );
      expect(speakSystemPrompt).toHaveBeenCalledWith(
        expect.anything(),
        "This number is not authorized to reach the assistant right now.",
      );
      expect(updateCallSession).toHaveBeenCalledWith(
        "call-verdict-deny-1",
        expect.objectContaining({ status: "failed" }),
      );
      expect(registerCallController).not.toHaveBeenCalled();
      expect(mockStartInitialGreeting).not.toHaveBeenCalled();
    });
  });

  // ── Setup routing failure teardown ─────────────────────────────────
  // routeSetup throws on an outbound unusable verdict (and on gateway
  // pending-session/invite read failures). The rejection must end the
  // call — never a live silent line with no flow or controller.

  describe("setup routing failure teardown", () => {
    test("outbound unusable-verdict abort marks the session failed and ends the call", async () => {
      mockRouteSetupError = new Error(
        "Voice setup: caller trust verdict unavailable (missing) — aborting outbound setup",
      );

      const mockWs = createMockWs();
      mockSessions.set("call-setup-fail-1", {
        id: "call-setup-fail-1",
        conversationId: "conv-setup-fail-1",
        initiatedFromConversationId: "conv-origin-fail-1",
        status: "initiated",
        task: null,
        startedAt: null,
        fromNumber: "+15555550143",
        toNumber: "+15555550144",
      });

      const session = new MediaStreamCallSession(
        mockWs.ws,
        "call-setup-fail-1",
      );
      session.handleMessage(makeStartMessage());
      await session.whenSetupSettled();

      // Session marked failed with the abort detail, failure event recorded.
      expect(updateCallSession).toHaveBeenCalledWith(
        "call-setup-fail-1",
        expect.objectContaining({
          status: "failed",
          lastError: expect.stringContaining("trust verdict unavailable"),
        }),
      );
      expect(recordCallEvent).toHaveBeenCalledWith(
        "call-setup-fail-1",
        "call_failed",
        expect.objectContaining({ reason: "setup_routing_failed" }),
      );

      // Initiating conversation is told the call failed.
      expect(postPointerMessageSafe).toHaveBeenCalledWith(
        "conv-origin-fail-1",
        "failed",
        "+15555550144",
        expect.objectContaining({ reason: "call setup failed" }),
      );

      // Stream ended, session finalized — no controller, no setup flow.
      expect(mockWs.closed).toBe(true);
      expect(finalizeCall).toHaveBeenCalledWith(
        "call-setup-fail-1",
        "conv-setup-fail-1",
      );
      expect(registerCallController).not.toHaveBeenCalled();
      expect(session.getController()).toBeNull();
      expect(session.getSetupFlow()).toBeNull();

      // Subsequent transcripts have nowhere to go and are dropped, not
      // silently consumed by a half-alive session.
      expect(mockHandleCallerUtterance).not.toHaveBeenCalled();
    });

    test("inbound setup-read failure also tears down (no pointer message)", async () => {
      mockRouteSetupError = new Error("gateway pending-session read failed");

      const mockWs = createMockWs();
      mockSessions.set("call-setup-fail-2", {
        id: "call-setup-fail-2",
        conversationId: "conv-setup-fail-2",
        status: "initiated",
        task: null,
        startedAt: null,
        fromNumber: "+15555550145",
        toNumber: "+15555550146",
      });

      const session = new MediaStreamCallSession(
        mockWs.ws,
        "call-setup-fail-2",
      );
      session.handleMessage(makeStartMessage());
      await session.whenSetupSettled();

      expect(updateCallSession).toHaveBeenCalledWith(
        "call-setup-fail-2",
        expect.objectContaining({ status: "failed" }),
      );
      expect(mockWs.closed).toBe(true);
      expect(finalizeCall).toHaveBeenCalledWith(
        "call-setup-fail-2",
        "conv-setup-fail-2",
      );
      expect(postPointerMessageSafe).not.toHaveBeenCalled();
      expect(registerCallController).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Setup-flow integration scenarios
// ---------------------------------------------------------------------------
// Drive every interactive routeSetup outcome end to end through the real
// CallSetupFlow (and, for name capture, the real GuardianWaitController)
// over a fake WebSocket. These use real timers with small mocked timing
// constants so terminal hangups and guardian-wait polling actually fire.

describe("setup flows over the media-stream transport", () => {
  beforeEach(() => {
    jest.useRealTimers();
  });

  const FROM = "+14155550100";
  const TO = "+15550001111";

  const sleep = (ms = 15) => Bun.sleep(ms);

  function setupCall(opts: {
    callId: string;
    outcome: { action: string; [key: string]: unknown };
    resolved?: Partial<(typeof mockRouteSetupResult)["resolved"]>;
    session?: Record<string, unknown>;
  }) {
    mockRouteSetupResult = {
      outcome: opts.outcome,
      resolved: {
        assistantId: "self",
        isInbound: true,
        otherPartyNumber: FROM,
        actorTrust: { trustClass: "unknown", memberRecord: null },
        ...opts.resolved,
      },
    };
    mockSessions.set(opts.callId, {
      id: opts.callId,
      conversationId: `conv-${opts.callId}`,
      status: "initiated",
      task: null,
      startedAt: null,
      fromNumber: FROM,
      toNumber: TO,
      ...opts.session,
    });
    const mockWs = createMockWs();
    const session = new MediaStreamCallSession(mockWs.ws, opts.callId);
    session.handleMessage(makeStartMessage());
    return { session, mockWs };
  }

  /**
   * Deliver a final caller transcript, mirroring the STT session's
   * onTranscriptFinal callback wiring (driving real audio through the
   * batch transcriber is out of scope for these tests).
   */
  function deliverTranscript(
    session: MediaStreamCallSession,
    text: string,
  ): void {
    (
      session as unknown as {
        handleTranscriptFinal(text: string, durationMs: number): void;
      }
    ).handleTranscriptFinal(text, 500);
  }

  function enterDigits(session: MediaStreamCallSession, digits: string): void {
    for (const digit of digits) {
      session.handleMessage(makeDtmfMessage(digit));
    }
  }

  function callerSpokeEvents(callId: string) {
    return mockEvents.filter(
      (e) => e.callSessionId === callId && e.eventType === "caller_spoke",
    );
  }

  describe("inbound verification", () => {
    test("success routes DTMF to the flow, then proceeds to the initial greeting", async () => {
      const { session } = setupCall({
        callId: "call-verif-ok",
        outcome: {
          action: "verification",
          assistantId: "self",
          fromNumber: FROM,
        },
      });
      await session.whenSetupSettled();

      // The flow prompts for the code; no controller exists during setup.
      expect(speakSystemPrompt).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining("six-digit verification code"),
      );
      expect(session.getSetupFlow()?.getState()).toBe("collecting_code");
      expect(session.getController()).toBeNull();
      expect(registerCallController).not.toHaveBeenCalled();

      enterDigits(session, "123456");
      await sleep();

      expect(mockAttemptVerificationCode).toHaveBeenCalledWith(
        expect.objectContaining({ enteredCode: "123456", isOutbound: false }),
      );
      // The server records per-digit caller_spoke events for the flow.
      expect(callerSpokeEvents("call-verif-ok")).toHaveLength(6);

      // Flow completed: controller created + initial greeting fired.
      expect(registerCallController).toHaveBeenCalledWith(
        "call-verif-ok",
        expect.anything(),
      );
      expect(
        (CallController as unknown as jest.Mock).mock.calls[0]?.[3],
      ).toMatchObject({ assistantId: "self" });
      expect(mockStartInitialGreeting).toHaveBeenCalled();
      expect(session.getSetupFlow()).toBeNull();
      expect(session.getController()).not.toBeNull();
      expect(finalizeCall).not.toHaveBeenCalled();

      // Post-setup transcripts route to the controller.
      deliverTranscript(session, "hello there");
      await sleep(5);
      expect(mockHandleCallerUtterance).toHaveBeenCalledWith("hello there");

      session.destroy();
    });

    test("failure fails the session, finalizes exactly once, and hangs up", async () => {
      mockVerificationResult = {
        outcome: "failure",
        eventName: "voice_verification_failed",
        ttsMessage: "Verification failed. Goodbye.",
        attempts: 3,
      };
      const { session, mockWs } = setupCall({
        callId: "call-verif-fail",
        outcome: {
          action: "verification",
          assistantId: "self",
          fromNumber: FROM,
        },
      });
      await session.whenSetupSettled();

      enterDigits(session, "000000");
      await sleep();

      expect(speakSystemPrompt).toHaveBeenCalledWith(
        expect.anything(),
        "Verification failed. Goodbye.",
      );
      expect(updateCallSession).toHaveBeenCalledWith(
        "call-verif-fail",
        expect.objectContaining({ status: "failed" }),
      );
      expect(finalizeCall).toHaveBeenCalledTimes(1);
      expect(finalizeCall).toHaveBeenCalledWith(
        "call-verif-fail",
        "conv-call-verif-fail",
      );
      expect(registerCallController).not.toHaveBeenCalled();

      // The flow schedules its own delayed endSession.
      await sleep(30);
      expect(mockWs.closed).toBe(true);

      // Transport close after flow-side finalization must not double-finalize.
      session.handleTransportClosed(1000, "session-ended");
      expect(finalizeCall).toHaveBeenCalledTimes(1);

      session.destroy();
    });
  });

  describe("outbound verification", () => {
    test("success posts the pointer and fires the post-verification greeting", async () => {
      const { session } = setupCall({
        callId: "call-outverif",
        outcome: {
          action: "outbound_verification",
          assistantId: "self",
          sessionId: "verif-sess-1",
          toNumber: TO,
        },
        resolved: {
          isInbound: false,
          otherPartyNumber: TO,
          actorTrust: { trustClass: "guardian", memberRecord: null },
        },
        session: { initiatedFromConversationId: "conv-origin-1" },
      });
      await session.whenSetupSettled();
      expect(registerCallController).not.toHaveBeenCalled();

      enterDigits(session, "654321");
      await sleep();

      expect(mockAttemptVerificationCode).toHaveBeenCalledWith(
        expect.objectContaining({ enteredCode: "654321", isOutbound: true }),
      );
      expect(postPointerMessageSafe).toHaveBeenCalledWith(
        "conv-origin-1",
        "verification_succeeded",
        TO,
        expect.objectContaining({ channel: "phone" }),
      );
      expect(mockStartPostVerificationGreeting).toHaveBeenCalled();
      expect(mockStartInitialGreeting).not.toHaveBeenCalled();
      expect(registerCallController).toHaveBeenCalledWith(
        "call-outverif",
        expect.anything(),
      );

      session.destroy();
    });
  });

  describe("callee verification", () => {
    test("posts the code to the origin conversation, retries a wrong code, greets on a match", async () => {
      const { session } = setupCall({
        callId: "call-callee",
        outcome: {
          action: "callee_verification",
          verificationConfig: { maxAttempts: 3, codeLength: 4 },
        },
        resolved: {
          isInbound: false,
          otherPartyNumber: TO,
          actorTrust: { trustClass: "guardian", memberRecord: null },
        },
        session: { initiatedFromConversationId: "conv-origin-2" },
      });
      await session.whenSetupSettled();

      // The generated code is posted to the initiating conversation.
      expect(mockAddMessage).toHaveBeenCalledTimes(1);
      const [postedConvId, , postedContent] = mockAddMessage.mock
        .calls[0] as unknown as [string, string, string];
      expect(postedConvId).toBe("conv-origin-2");
      const code = /: (\d{4})/.exec(postedContent)?.[1];
      expect(code).toBeDefined();

      // A wrong code re-prompts without ending the call.
      const wrongCode = code === "0000" ? "1111" : "0000";
      enterDigits(session, wrongCode);
      await sleep();
      expect(speakSystemPrompt).toHaveBeenCalledWith(
        expect.anything(),
        "That code was incorrect. Please try again.",
      );
      expect(registerCallController).not.toHaveBeenCalled();

      // The right code proceeds to the initial greeting.
      enterDigits(session, code!);
      await sleep();
      expect(registerCallController).toHaveBeenCalledWith(
        "call-callee",
        expect.anything(),
      );
      expect(mockStartInitialGreeting).toHaveBeenCalled();
      expect(finalizeCall).not.toHaveBeenCalled();

      session.destroy();
    });
  });

  describe("invite redemption", () => {
    test("success speaks the handoff, marks the opening ack, and replays deferred transcripts", async () => {
      const { session } = setupCall({
        callId: "call-invite",
        outcome: {
          action: "invite_redemption",
          assistantId: "self",
          fromNumber: FROM,
          inviteeName: "Casey Example",
        },
      });
      await session.whenSetupSettled();

      expect(speakSystemPrompt).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining("Welcome Casey."),
      );

      // Hold mid-setup trust re-resolution open so a transcript arrives
      // during the deferral window.
      let releaseVerdict!: () => void;
      mockVerdictGate = new Promise<void>((resolve) => {
        releaseVerdict = resolve;
      });

      enterDigits(session, "111222");
      await sleep();
      expect(mockAttemptInviteCodeRedemption).toHaveBeenCalledWith(
        expect.objectContaining({ enteredCode: "111222" }),
      );

      // Caller speaks while the trust upgrade is in flight — deferred, but
      // the transcript notifier still fires for UI subscribers.
      deliverTranscript(session, "hi can you help me book a flight");
      expect(fireCallTranscriptNotifier).toHaveBeenCalledWith(
        "conv-call-invite",
        "call-invite",
        "caller",
        "hi can you help me book a flight",
      );
      expect(mockHandleCallerUtterance).not.toHaveBeenCalled();

      releaseVerdict();
      await sleep();

      expect(speakSystemPrompt).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining("verified that you are Casey"),
      );
      expect(mockMarkNextCallerTurnAsOpeningAck).toHaveBeenCalled();
      expect(mockStartInitialGreeting).not.toHaveBeenCalled();
      expect(registerCallController).toHaveBeenCalledWith(
        "call-invite",
        expect.anything(),
      );
      // The deferred transcript replays into the controller after the opener.
      expect(mockHandleCallerUtterance).toHaveBeenCalledWith(
        "hi can you help me book a flight",
      );

      session.destroy();
    });

    test("failure speaks the failure copy and finalizes exactly once", async () => {
      mockInviteResult = {
        outcome: "failure",
        ttsMessage: "That code is not valid. Goodbye.",
      };
      const { session, mockWs } = setupCall({
        callId: "call-invite-fail",
        outcome: {
          action: "invite_redemption",
          assistantId: "self",
          fromNumber: FROM,
          inviteeName: null,
        },
      });
      await session.whenSetupSettled();

      enterDigits(session, "999999");
      await sleep();

      expect(speakSystemPrompt).toHaveBeenCalledWith(
        expect.anything(),
        "That code is not valid. Goodbye.",
      );
      expect(updateCallSession).toHaveBeenCalledWith(
        "call-invite-fail",
        expect.objectContaining({ status: "failed" }),
      );
      expect(finalizeCall).toHaveBeenCalledTimes(1);
      expect(registerCallController).not.toHaveBeenCalled();

      await sleep(30);
      expect(mockWs.closed).toBe(true);
      session.handleTransportClosed(1000, "session-ended");
      expect(finalizeCall).toHaveBeenCalledTimes(1);

      session.destroy();
    });
  });

  describe("name capture and guardian wait", () => {
    function nameCaptureOutcome() {
      return {
        action: "name_capture",
        assistantId: "self",
        fromNumber: FROM,
      };
    }

    test("waits for the guardian with NO controller, then approval hands off", async () => {
      const { session } = setupCall({
        callId: "call-name-ok",
        outcome: nameCaptureOutcome(),
      });
      await session.whenSetupSettled();

      expect(speakSystemPrompt).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining("Can I get your name?"),
      );
      expect(session.getSetupFlow()?.getState()).toBe("capturing_name");

      mockCanonicalRequest = { status: "pending" };
      deliverTranscript(session, "Casey Example");
      await sleep();

      expect(mockNotifyGuardianOfAccessRequest).toHaveBeenCalledWith(
        expect.objectContaining({ actorDisplayName: "Casey Example" }),
      );
      // The transcript notifier fires for caller turns during setup.
      expect(fireCallTranscriptNotifier).toHaveBeenCalledWith(
        "conv-call-name-ok",
        "call-name-ok",
        "caller",
        "Casey Example",
      );
      expect(updateCallSession).toHaveBeenCalledWith("call-name-ok", {
        status: "waiting_on_user",
      });
      // No controller exists during the wait — no silence nudges can fire.
      expect(session.getSetupFlow()?.getState()).toBe(
        "awaiting_guardian_decision",
      );
      expect(session.getController()).toBeNull();
      expect(CallController as unknown as jest.Mock).not.toHaveBeenCalled();
      expect(registerCallController).not.toHaveBeenCalled();

      // The guardian approves; the wait poll picks it up.
      mockCanonicalRequest = { status: "approved" };
      await sleep(40);

      expect(speakSystemPrompt).toHaveBeenCalledWith(
        expect.anything(),
        "Great! Alex said I can speak with you. How can I help?",
      );
      expect(mockMarkNextCallerTurnAsOpeningAck).toHaveBeenCalled();
      expect(registerCallController).toHaveBeenCalledWith(
        "call-name-ok",
        expect.anything(),
      );
      expect(session.getSetupFlow()).toBeNull();
      expect(finalizeCall).not.toHaveBeenCalled();

      session.destroy();
    });

    test("guardian denial speaks the goodbye copy and finalizes exactly once", async () => {
      const { session, mockWs } = setupCall({
        callId: "call-name-deny",
        outcome: nameCaptureOutcome(),
      });
      await session.whenSetupSettled();

      mockCanonicalRequest = { status: "pending" };
      deliverTranscript(session, "Casey Example");
      await sleep();

      mockCanonicalRequest = { status: "denied" };
      await sleep(40);

      expect(speakSystemPrompt).toHaveBeenCalledWith(
        expect.anything(),
        "Sorry, Alex says I'm not allowed to speak with you. Goodbye.",
      );
      expect(updateCallSession).toHaveBeenCalledWith(
        "call-name-deny",
        expect.objectContaining({ status: "failed" }),
      );
      expect(finalizeCall).toHaveBeenCalledTimes(1);
      expect(registerCallController).not.toHaveBeenCalled();

      await sleep(30);
      expect(mockWs.closed).toBe(true);
      session.handleTransportClosed(1000, "session-ended");
      expect(finalizeCall).toHaveBeenCalledTimes(1);

      session.destroy();
    });

    test("guardian-wait timeout speaks the timeout copy and finalizes exactly once", async () => {
      mockUserConsultationTimeoutMs = 40;
      const { session } = setupCall({
        callId: "call-name-timeout",
        outcome: nameCaptureOutcome(),
      });
      await session.whenSetupSettled();

      mockCanonicalRequest = { status: "pending" };
      deliverTranscript(session, "Casey Example");
      await sleep();

      await sleep(80);

      expect(mockEmitCallbackHandoff).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "timeout" }),
      );
      expect(speakSystemPrompt).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining("Sorry, I can't get ahold of Alex right now."),
      );
      expect(updateCallSession).toHaveBeenCalledWith(
        "call-name-timeout",
        expect.objectContaining({ status: "failed" }),
      );
      expect(finalizeCall).toHaveBeenCalledTimes(1);
      expect(registerCallController).not.toHaveBeenCalled();

      session.destroy();
    });

    test("disconnect mid-wait disposes the flow, emits the callback handoff, and finalizes once", async () => {
      const { session } = setupCall({
        callId: "call-name-drop",
        outcome: nameCaptureOutcome(),
      });
      await session.whenSetupSettled();

      mockCanonicalRequest = { status: "pending" };
      deliverTranscript(session, "Casey Example");
      await sleep();
      expect(session.getSetupFlow()?.getState()).toBe(
        "awaiting_guardian_decision",
      );

      session.handleTransportClosed(1006, "network dropped");

      expect(mockEmitCallbackHandoff).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "transport_closed" }),
      );
      expect(updateCallSession).toHaveBeenCalledWith(
        "call-name-drop",
        expect.objectContaining({ status: "failed" }),
      );
      expect(finalizeCall).toHaveBeenCalledTimes(1);
      expect(session.getSetupFlow()).toBeNull();

      // A late approval must not resurrect the torn-down call.
      mockCanonicalRequest = { status: "approved" };
      await sleep(40);
      expect(registerCallController).not.toHaveBeenCalled();
      expect(finalizeCall).toHaveBeenCalledTimes(1);

      session.destroy();
    });
  });

  describe("unverified caller", () => {
    test("hears the verification guidance and the call ends without a controller", async () => {
      const { session, mockWs } = setupCall({
        callId: "call-unverified",
        outcome: {
          action: "unverified_caller",
          assistantId: "self",
          fromNumber: FROM,
          displayName: "Sam Example",
          isGuardian: false,
        },
      });
      await session.whenSetupSettled();

      expect(speakSystemPrompt).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining("registered as Sam Example's phone"),
      );
      expect(
        mockEvents.some(
          (e) =>
            e.callSessionId === "call-unverified" &&
            e.eventType === "inbound_acl_unverified_caller",
        ),
      ).toBe(true);
      expect(updateCallSession).toHaveBeenCalledWith(
        "call-unverified",
        expect.objectContaining({ status: "failed" }),
      );
      expect(finalizeCall).toHaveBeenCalledTimes(1);
      expect(registerCallController).not.toHaveBeenCalled();

      await sleep(30);
      expect(mockWs.closed).toBe(true);

      session.destroy();
    });
  });

  describe("hangup during terminal setup speech", () => {
    /** Gate the next speakSystemPrompt call on a manually released promise. */
    function gateNextSpeech(): () => void {
      let release!: () => void;
      (speakSystemPrompt as jest.Mock).mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      return () => release();
    }

    test("hangup during the deny goodbye finalizes exactly once and revokes grants", async () => {
      const releaseSpeech = gateNextSpeech();
      const { session } = setupCall({
        callId: "call-deny-hangup",
        outcome: {
          action: "deny",
          message: "Not authorized.",
          logReason: "ACL deny",
        },
      });
      await sleep();

      // The deny path sets terminal status before its goodbye finishes.
      expect(updateCallSession).toHaveBeenCalledWith(
        "call-deny-hangup",
        expect.objectContaining({ status: "failed" }),
      );
      expect(finalizeCall).not.toHaveBeenCalled();

      // Caller hangs up while the goodbye is still speaking.
      session.handleTransportClosed(1006, "caller hung up");

      expect(finalizeCall).toHaveBeenCalledTimes(1);
      expect(finalizeCall).toHaveBeenCalledWith(
        "call-deny-hangup",
        "conv-call-deny-hangup",
      );
      expect(revokeScopedApprovalGrantsForContext).toHaveBeenCalledWith({
        callSessionId: "call-deny-hangup",
      });
      expect(revokeScopedApprovalGrantsForContext).toHaveBeenCalledWith({
        conversationId: "conv-call-deny-hangup",
      });
      expect(session.getSetupFlow()).toBeNull();

      // The speech promise settling later must not double-finalize.
      releaseSpeech();
      await session.whenSetupSettled();
      await sleep();
      expect(finalizeCall).toHaveBeenCalledTimes(1);
      expect(registerCallController).not.toHaveBeenCalled();

      session.destroy();
    });

    test("hangup during the guardian-denial goodbye finalizes exactly once and revokes grants", async () => {
      const { session } = setupCall({
        callId: "call-guard-deny-hangup",
        outcome: {
          action: "name_capture",
          assistantId: "self",
          fromNumber: FROM,
        },
      });
      await session.whenSetupSettled();

      mockCanonicalRequest = { status: "pending" };
      deliverTranscript(session, "Casey Example");
      await sleep();

      const releaseSpeech = gateNextSpeech();
      mockCanonicalRequest = { status: "denied" };
      await sleep(40);

      expect(updateCallSession).toHaveBeenCalledWith(
        "call-guard-deny-hangup",
        expect.objectContaining({ status: "failed" }),
      );
      expect(finalizeCall).not.toHaveBeenCalled();

      // Caller hangs up while the denial goodbye is still speaking.
      session.handleTransportClosed(1006, "caller hung up");

      expect(finalizeCall).toHaveBeenCalledTimes(1);
      expect(finalizeCall).toHaveBeenCalledWith(
        "call-guard-deny-hangup",
        "conv-call-guard-deny-hangup",
      );
      expect(revokeScopedApprovalGrantsForContext).toHaveBeenCalledWith({
        callSessionId: "call-guard-deny-hangup",
      });
      expect(session.getSetupFlow()).toBeNull();

      releaseSpeech();
      await sleep();
      expect(finalizeCall).toHaveBeenCalledTimes(1);
      expect(registerCallController).not.toHaveBeenCalled();

      session.destroy();
    });

    test("deny completion without a hangup finalizes exactly once; a later close does not re-finalize", async () => {
      const { session, mockWs } = setupCall({
        callId: "call-deny-normal",
        outcome: {
          action: "deny",
          message: "Not authorized.",
          logReason: "ACL deny",
        },
      });
      await session.whenSetupSettled();

      expect(finalizeCall).toHaveBeenCalledTimes(1);
      expect(finalizeCall).toHaveBeenCalledWith(
        "call-deny-normal",
        "conv-call-deny-normal",
      );

      // The flow schedules its own delayed endSession.
      await sleep(30);
      expect(mockWs.closed).toBe(true);

      session.handleTransportClosed(1000, "session-ended");
      expect(finalizeCall).toHaveBeenCalledTimes(1);

      session.destroy();
    });
  });
});
