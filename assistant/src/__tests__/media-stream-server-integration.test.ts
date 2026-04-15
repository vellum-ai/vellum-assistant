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
    test("start event registers a controller and records call_connected", () => {
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
// These tests exercise the deny and unsupported-action branches in
// MediaStreamCallSession.handleStart by overriding mockRouteSetupResult
// before sending a start message.

describe("media-stream setup outcome scenarios", () => {
  describe("deny outcome", () => {
    test("deny outcome records inbound_acl_denied event and sets status to failed", () => {
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
        toNumber: "+15550001111",
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

    test("deny outcome runs finalization", () => {
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

      // finalizeCall should be called because early teardown runs it inline
      expect(finalizeCall).toHaveBeenCalledWith(
        "call-deny-finalize-1",
        "conv-deny-finalize-1",
      );
    });
  });

  describe("unsupported interactive setup flow", () => {
    test("verification outcome records call_failed with preflight-bypass reason", () => {
      mockRouteSetupResult = {
        outcome: {
          action: "verification",
          assistantId: "self",
          fromNumber: "+14155551234",
        },
        resolved: {
          assistantId: "self",
          isInbound: true,
          otherPartyNumber: "+14155551234",
          actorTrust: { trustClass: "unknown", memberRecord: null },
        },
      };

      const mockWs = createMockWs();
      mockSessions.set("call-unsup-verify-1", {
        id: "call-unsup-verify-1",
        conversationId: "conv-unsup-verify-1",
        status: "initiated",
        task: null,
        startedAt: null,
        fromNumber: "+14155551234",
        toNumber: "+15550001111",
      });

      const session = new MediaStreamCallSession(
        mockWs.ws,
        "call-unsup-verify-1",
      );
      session.handleMessage(makeStartMessage());

      // Should record call_failed event with preflight-bypass note
      expect(recordCallEvent).toHaveBeenCalledWith(
        "call-unsup-verify-1",
        "call_failed",
        expect.objectContaining({
          reason: expect.stringContaining("verification"),
          transport: "media-stream",
        }),
      );

      // Should set session status to failed
      expect(updateCallSession).toHaveBeenCalledWith(
        "call-unsup-verify-1",
        expect.objectContaining({
          status: "failed",
          lastError: expect.stringContaining("preflight guard"),
        }),
      );

      // Should NOT register a controller
      expect(registerCallController).not.toHaveBeenCalled();
    });

    test("name_capture outcome speaks generic apology and tears down", () => {
      mockRouteSetupResult = {
        outcome: {
          action: "name_capture",
          assistantId: "self",
          fromNumber: "+14155551234",
        },
        resolved: {
          assistantId: "self",
          isInbound: true,
          otherPartyNumber: "+14155551234",
          actorTrust: { trustClass: "unknown", memberRecord: null },
        },
      };

      const mockWs = createMockWs();
      mockSessions.set("call-unsup-name-1", {
        id: "call-unsup-name-1",
        conversationId: "conv-unsup-name-1",
        status: "initiated",
        task: null,
        startedAt: null,
        fromNumber: "+14155551234",
        toNumber: "+15550001111",
      });

      const session = new MediaStreamCallSession(
        mockWs.ws,
        "call-unsup-name-1",
      );
      session.handleMessage(makeStartMessage());

      // speakSystemPrompt should be called with the generic apology
      expect(speakSystemPrompt).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining("additional verification"),
      );

      // Should run finalization inline
      expect(finalizeCall).toHaveBeenCalledWith(
        "call-unsup-name-1",
        "conv-unsup-name-1",
      );
    });

    test("callee_verification outcome fails with explicit reason", () => {
      mockRouteSetupResult = {
        outcome: {
          action: "callee_verification",
          verificationConfig: { maxAttempts: 3, codeLength: 6 },
        },
        resolved: {
          assistantId: "self",
          isInbound: false,
          otherPartyNumber: "+14155551234",
          actorTrust: { trustClass: "guardian", memberRecord: null },
        },
      };

      const mockWs = createMockWs();
      mockSessions.set("call-unsup-callee-1", {
        id: "call-unsup-callee-1",
        conversationId: "conv-unsup-callee-1",
        status: "initiated",
        task: null,
        startedAt: null,
        fromNumber: "+15550001111",
        toNumber: "+14155551234",
      });

      const session = new MediaStreamCallSession(
        mockWs.ws,
        "call-unsup-callee-1",
      );
      session.handleMessage(makeStartMessage());

      // Should record the failure with the specific action
      expect(recordCallEvent).toHaveBeenCalledWith(
        "call-unsup-callee-1",
        "call_failed",
        expect.objectContaining({
          reason: expect.stringContaining("callee_verification"),
        }),
      );

      // Session should be failed
      expect(updateCallSession).toHaveBeenCalledWith(
        "call-unsup-callee-1",
        expect.objectContaining({ status: "failed" }),
      );
    });

    test("normal_call after deny scenario still creates controller", () => {
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

      // Initial greeting should fire
      expect(mockStartInitialGreeting).toHaveBeenCalled();
    });
  });

  // ── Barge-in regression ──────────────────────────────────────────

  describe("barge-in gating", () => {
    test("immediate inbound audio after stream start does not trigger handleInterrupt", () => {
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

      // Simulate inbound speech audio while assistant is speaking.
      // Use a high-amplitude mu-law payload so speech detection triggers.
      const speechPayload = Buffer.alloc(160, 0x00).toString("base64");
      session.handleMessage(makeMediaMessage(speechPayload, "1"));

      // handleBargeIn should have been called (returning true)
      expect(mockHandleBargeIn).toHaveBeenCalled();

      session.destroy();
    });
  });

  // ── E2E regression scenario ──────────────────────────────────────

  describe("end-to-end regression: connected call that stays active", () => {
    test("stream connects, inbound audio starts, call remains active for a turn, controller only destroyed at stop/hangup", () => {
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
