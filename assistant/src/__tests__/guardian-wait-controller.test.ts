/**
 * Tests for GuardianWaitController — the transport-agnostic access-request
 * wait orchestrator.
 *
 * Covers:
 * - start(): hold message, waiting_on_user session status, timer arming
 * - approval / denial / timeout resolution via injected callbacks
 * - heartbeat sequencing (initial window vs jittered steady) and reset-on-reply
 * - wait-utterance classes incl. cooldown throttling and callback opt-in bypass
 * - callback handoff exactly-once semantics (timeout vs disconnect races)
 * - dispose() idempotence and timer cleanup
 *
 * All timer-driven behavior runs under fake timers — no real delays.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  mock,
  test,
} from "bun:test";

// ── Module mocks (must come before source imports) ───────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realLogger = require("../util/logger.js");
mock.module("../util/logger.js", () => ({
  ...realLogger,
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Config loader — drives the intervals relay-access-wait reads directly.
const mockConfig = {
  calls: {
    userConsultTimeoutSeconds: 120 as number,
    ttsPlaybackDelayMs: 0,
    accessRequestPollIntervalMs: 50 as number,
    guardianWaitUpdateInitialIntervalMs: 100,
    guardianWaitUpdateInitialWindowMs: 300,
    guardianWaitUpdateSteadyMinIntervalMs: 150,
    guardianWaitUpdateSteadyMaxIntervalMs: 200,
  },
};
mock.module("../config/loader.js", () => ({
  getConfig: () => mockConfig,
  loadConfig: () => mockConfig,
}));

// Canonical guardian request store — in-memory map driven by tests.
const canonicalRequests = new Map<string, CanonicalGuardianRequest>();
mock.module("../contacts/canonical-guardian-store.js", () => ({
  getCanonicalGuardianRequest: (id: string) =>
    canonicalRequests.get(id) ?? null,
}));

// Callback handoff helper dependencies — cut the real notification graph.
mock.module("../contacts/contact-store.js", () => ({
  findContactChannel: () => null,
}));
mock.module("../runtime/member-verdict-cache.js", () => ({
  getCachedMemberAcl: () => null,
}));

let emitSignalCalls: Array<Record<string, unknown>> = [];
mock.module("../notifications/emit-signal.js", () => ({
  emitNotificationSignal: (params: Record<string, unknown>) => {
    emitSignalCalls.push(params);
    return Promise.resolve();
  },
}));

// call-store — relay-access-wait's heartbeat helper records events here.
let storeEvents: Array<{
  eventType: string;
  payload?: Record<string, unknown>;
}> = [];
mock.module("../calls/call-store.js", () => ({
  recordCallEvent: (
    _callSessionId: string,
    eventType: string,
    payload?: Record<string, unknown>,
  ) => {
    storeEvents.push({ eventType, payload });
  },
}));

// ── Source imports (after mocks) ─────────────────────────────────────

import {
  GuardianWaitController,
  type GuardianWaitControllerDeps,
  type GuardianWaitResolutionContext,
  IN_WAIT_REPLY_COOLDOWN_MS,
} from "../calls/guardian-wait-controller.js";
import type { CanonicalGuardianRequest } from "../contacts/canonical-guardian-store.js";

// ── Fixtures ─────────────────────────────────────────────────────────

const CALL_SESSION_ID = "call-session-1";
const REQUEST_ID = "req-1";
const START_PARAMS = {
  requestId: REQUEST_ID,
  assistantId: "self",
  fromNumber: "+15555550100",
  callerName: "Bob",
};

// Controller clock. Starts large so the first in-wait reply is outside the
// cooldown window (lastInWaitReplyAt initializes to 0, matching the relay).
let nowValue = 1_000_000;

function seedRequest(status: CanonicalGuardianRequest["status"]): void {
  canonicalRequests.set(REQUEST_ID, {
    id: REQUEST_ID,
    status,
  } as CanonicalGuardianRequest);
}

function createController(overrides?: Partial<GuardianWaitControllerDeps>) {
  const spoken: string[] = [];
  const sessionUpdates: Array<Record<string, unknown>> = [];
  const events: Array<{
    eventType: string;
    payload?: Record<string, unknown>;
  }> = [];
  const approvals: GuardianWaitResolutionContext[] = [];
  const denials: GuardianWaitResolutionContext[] = [];
  const timeouts: GuardianWaitResolutionContext[] = [];

  const deps: GuardianWaitControllerDeps = {
    speakSystemPrompt: async (text) => {
      spoken.push(text);
    },
    updateCallSession: (_id, updates) => {
      sessionUpdates.push(updates as Record<string, unknown>);
    },
    recordCallEvent: (_callSessionId, eventType, payload) => {
      events.push({ eventType, payload });
    },
    resolveGuardianLabel: () => "Alice",
    onApproved: (ctx) => {
      approvals.push(ctx);
    },
    onDenied: (ctx) => {
      denials.push(ctx);
    },
    onTimeout: (ctx) => {
      timeouts.push(ctx);
    },
    now: () => nowValue,
    firstHeartbeatDelayMs: 0,
    ...overrides,
  };

  const controller = new GuardianWaitController(CALL_SESSION_ID, deps);
  return {
    controller,
    spoken,
    sessionUpdates,
    events,
    approvals,
    denials,
    timeouts,
  };
}

/** Make an in-wait callback offer, then opt in. Bypasses no timers. */
function optIntoCallback(controller: GuardianWaitController): void {
  nowValue += IN_WAIT_REPLY_COOLDOWN_MS + 1;
  controller.handleTranscript("hurry up, this is taking too long");
  nowValue += 1;
  controller.handleTranscript("yes, please call me back");
}

beforeEach(() => {
  jest.useFakeTimers();
  nowValue = 1_000_000;
  canonicalRequests.clear();
  emitSignalCalls = [];
  storeEvents = [];
  mockConfig.calls.userConsultTimeoutSeconds = 120;
  mockConfig.calls.accessRequestPollIntervalMs = 50;
});

afterEach(() => {
  jest.useRealTimers();
});

// ── Tests ────────────────────────────────────────────────────────────

describe("GuardianWaitController", () => {
  describe("start", () => {
    test("speaks the hold message, marks the session waiting, and enters the wait state", () => {
      const { controller, spoken, sessionUpdates } = createController();

      expect(controller.getState()).toBe("idle");
      controller.start(START_PARAMS);

      expect(controller.getState()).toBe("awaiting_guardian_decision");
      expect(controller.getResolution()).toBeNull();
      expect(spoken).toEqual([
        "Thank you. I've let Alice know. Please hold while I check if I have permission to speak with you.",
      ]);
      expect(sessionUpdates).toEqual([{ status: "waiting_on_user" }]);

      controller.dispose();
    });

    test("may only be called once", () => {
      const { controller } = createController();
      controller.start(START_PARAMS);
      expect(() => controller.start(START_PARAMS)).toThrow(
        "may only be called once",
      );
      controller.dispose();
    });
  });

  describe("resolution", () => {
    test("approval: poll observes approved and fires onApproved once", () => {
      seedRequest("pending");
      const { controller, approvals, denials, timeouts } = createController();
      controller.start(START_PARAMS);

      jest.advanceTimersByTime(50);
      expect(approvals).toHaveLength(0);

      seedRequest("approved");
      jest.advanceTimersByTime(50);

      expect(approvals).toHaveLength(1);
      expect(approvals[0]).toEqual({
        requestId: REQUEST_ID,
        assistantId: "self",
        fromNumber: "+15555550100",
        callerName: "Bob",
        callbackOptIn: false,
      });
      expect(denials).toHaveLength(0);
      expect(timeouts).toHaveLength(0);
      expect(controller.getState()).toBe("resolved");
      expect(controller.getResolution()).toBe("approved");

      // Poll is cleared — no duplicate resolution on further ticks.
      jest.advanceTimersByTime(1000);
      expect(approvals).toHaveLength(1);
    });

    test("denial: poll observes denied and fires onDenied once", () => {
      seedRequest("pending");
      const { controller, approvals, denials, timeouts } = createController();
      controller.start(START_PARAMS);

      seedRequest("denied");
      jest.advanceTimersByTime(50);

      expect(denials).toHaveLength(1);
      expect(approvals).toHaveLength(0);
      expect(timeouts).toHaveLength(0);
      expect(controller.getResolution()).toBe("denied");

      jest.advanceTimersByTime(1000);
      expect(denials).toHaveLength(1);
    });

    test("pending/expired statuses keep polling; timeout fires onTimeout", () => {
      seedRequest("pending");
      const { controller, timeouts } = createController({
        consultTimeoutMs: 2000,
      });
      controller.start(START_PARAMS);

      jest.advanceTimersByTime(1999);
      expect(timeouts).toHaveLength(0);

      jest.advanceTimersByTime(1);
      expect(timeouts).toHaveLength(1);
      expect(timeouts[0].callbackOptIn).toBe(false);
      expect(controller.getState()).toBe("resolved");
      expect(controller.getResolution()).toBe("timeout");

      // Timeout without opt-in emits no callback handoff.
      expect(emitSignalCalls).toHaveLength(0);
    });

    test("heartbeats and speech stop after resolution", () => {
      seedRequest("pending");
      const { controller, spoken } = createController();
      controller.start(START_PARAMS);

      seedRequest("approved");
      jest.advanceTimersByTime(50);
      const spokenAtResolution = spoken.length;

      jest.advanceTimersByTime(10_000);
      expect(spoken).toHaveLength(spokenAtResolution);
    });
  });

  describe("heartbeats", () => {
    test("fires at the initial interval inside the initial window", () => {
      seedRequest("pending");
      nowValue = Date.now();
      const { controller, spoken } = createController();
      controller.start(START_PARAMS);

      // Margins are generous because bun's fake clock bases timer due
      // times on real registration timestamps (a few ms of drift).
      jest.advanceTimersByTime(80);
      expect(spoken).toHaveLength(1); // hold message only

      jest.advanceTimersByTime(40);
      expect(spoken).toHaveLength(2);
      expect(spoken[1]).toBe(
        "Still waiting to hear back from Alice. Thank you for your patience.",
      );
      expect(
        storeEvents.filter(
          (e) => e.eventType === "voice_guardian_wait_heartbeat_sent",
        ),
      ).toHaveLength(1);

      controller.dispose();
    });

    test("uses the jittered steady interval past the initial window and advances the sequence", () => {
      seedRequest("pending");
      // Stamp the wait start 10s in the past so elapsed exceeds the 300ms
      // initial window and the steady interval range [150, 200) applies.
      nowValue = Date.now() - 10_000;
      const { controller, spoken } = createController();
      controller.start(START_PARAMS);

      jest.advanceTimersByTime(140);
      expect(spoken).toHaveLength(1);

      jest.advanceTimersByTime(120);
      expect(spoken).toHaveLength(2);

      // The next heartbeat is rescheduled and uses the next message in the
      // rotation.
      jest.advanceTimersByTime(210);
      expect(spoken).toHaveLength(3);
      expect(spoken[2]).not.toBe(spoken[1]);

      controller.dispose();
    });

    test("a caller reply resets the heartbeat timer", () => {
      seedRequest("pending");
      nowValue = Date.now();
      const { controller, spoken } = createController();
      controller.start(START_PARAMS);

      jest.advanceTimersByTime(60);
      controller.handleTranscript("any update?");
      expect(spoken).toHaveLength(2);
      expect(spoken[1]).toContain("still here");

      // The pre-reply timer (40ms remaining) was cleared; a fresh full
      // interval applies from the reply.
      jest.advanceTimersByTime(80);
      expect(spoken).toHaveLength(2);
      jest.advanceTimersByTime(40);
      expect(spoken).toHaveLength(3);
      expect(spoken[2]).toBe(
        "Still waiting to hear back from Alice. Thank you for your patience.",
      );

      controller.dispose();
    });
  });

  describe("wait utterances", () => {
    test("classifies every utterance and ignores empty ones without speaking", () => {
      const { controller, spoken, events } = createController();
      controller.start(START_PARAMS);

      controller.handleTranscript("   ");
      expect(events).toEqual([
        {
          eventType: "voice_guardian_wait_prompt_classified",
          payload: { classification: "empty", transcript: "   " },
        },
      ]);
      expect(spoken).toHaveLength(1); // hold message only

      controller.dispose();
    });

    test("patience check gets immediate reassurance", () => {
      const { controller, spoken } = createController();
      controller.start(START_PARAMS);

      controller.handleTranscript("are you still there?");
      expect(spoken[1]).toBe(
        "Yes, I'm still here. Still waiting to hear back from Alice.",
      );

      controller.dispose();
    });

    test("neutral utterance gets an acknowledgment", () => {
      const { controller, spoken } = createController();
      controller.start(START_PARAMS);

      controller.handleTranscript("I was calling about the garden fence");
      expect(spoken[1]).toBe(
        "Thanks for that. I'm still waiting on Alice. I'll let you know as soon as I hear back.",
      );

      controller.dispose();
    });

    test("impatience triggers the callback offer once, then plain reassurance", () => {
      const { controller, spoken, events } = createController();
      controller.start(START_PARAMS);

      controller.handleTranscript("hurry up");
      expect(spoken[1]).toContain("call you back");
      expect(
        events.filter(
          (e) => e.eventType === "voice_guardian_wait_callback_offer_sent",
        ),
      ).toHaveLength(1);

      nowValue += IN_WAIT_REPLY_COOLDOWN_MS + 1;
      controller.handleTranscript("come on, hurry up");
      expect(spoken[2]).toBe(
        "I hear you, I'm sorry for the wait. Still trying to reach Alice.",
      );
      expect(
        events.filter(
          (e) => e.eventType === "voice_guardian_wait_callback_offer_sent",
        ),
      ).toHaveLength(1);

      controller.dispose();
    });

    test("cooldown suppresses rapid-fire non-callback replies", () => {
      const { controller, spoken } = createController();
      controller.start(START_PARAMS);

      controller.handleTranscript("hello?");
      expect(spoken).toHaveLength(2);

      nowValue += IN_WAIT_REPLY_COOLDOWN_MS - 1;
      controller.handleTranscript("hello again?");
      expect(spoken).toHaveLength(2);

      nowValue += 1;
      controller.handleTranscript("still there?");
      expect(spoken).toHaveLength(3);

      controller.dispose();
    });

    test("callback opt-in and decline bypass the cooldown", () => {
      const { controller, spoken, events } = createController();
      controller.start(START_PARAMS);

      controller.handleTranscript("hurry up"); // offer made
      nowValue += 1; // well inside cooldown
      controller.handleTranscript("yes, please call me back");
      expect(spoken[2]).toContain("you'd like a callback");
      expect(
        events.some(
          (e) => e.eventType === "voice_guardian_wait_callback_opt_in_set",
        ),
      ).toBe(true);

      nowValue += 1; // still inside cooldown
      controller.handleTranscript("actually no, I'll hold");
      expect(spoken[3]).toBe(
        "No problem, I'll keep holding. Still waiting on Alice.",
      );
      expect(
        events.some(
          (e) => e.eventType === "voice_guardian_wait_callback_opt_in_declined",
        ),
      ).toBe(true);

      controller.dispose();
    });

    test("transcripts are ignored before start and after resolution/dispose", () => {
      const { controller, events, spoken } = createController();

      controller.handleTranscript("hello?");
      expect(events).toHaveLength(0);

      controller.start(START_PARAMS);
      controller.dispose();
      controller.handleTranscript("hello?");
      expect(events).toHaveLength(0);
      expect(spoken).toHaveLength(1);
    });
  });

  describe("callback handoff exactly-once", () => {
    test("timeout after opt-in emits the handoff once, before onTimeout", () => {
      seedRequest("pending");
      const { controller, timeouts } = createController({
        consultTimeoutMs: 2000,
      });
      controller.start(START_PARAMS);
      optIntoCallback(controller);

      jest.advanceTimersByTime(2000);
      expect(emitSignalCalls).toHaveLength(1);
      expect(emitSignalCalls[0].dedupeKey).toBe(
        `access-request-callback-handoff:${REQUEST_ID}`,
      );
      expect(timeouts).toHaveLength(1);
      expect(timeouts[0].callbackOptIn).toBe(true);
    });

    test("disconnect racing timeout does not emit a second handoff", () => {
      seedRequest("pending");
      const { controller, timeouts } = createController({
        consultTimeoutMs: 2000,
      });
      controller.start(START_PARAMS);
      optIntoCallback(controller);

      jest.advanceTimersByTime(2000);
      expect(emitSignalCalls).toHaveLength(1);

      // Transport closes right after the timeout resolved the wait.
      controller.dispose("transport_closed");
      expect(emitSignalCalls).toHaveLength(1);
      expect(timeouts).toHaveLength(1);
    });

    test("disconnect mid-wait with opt-in emits the handoff; a later timeout cannot fire", () => {
      seedRequest("pending");
      const { controller, timeouts } = createController({
        consultTimeoutMs: 2000,
      });
      controller.start(START_PARAMS);
      optIntoCallback(controller);

      controller.dispose("transport_closed");
      expect(emitSignalCalls).toHaveLength(1);
      expect(emitSignalCalls[0].contextPayload).toMatchObject({
        reason: "transport_closed",
        callbackOptIn: true,
        callerName: "Bob",
      });

      jest.advanceTimersByTime(10_000);
      expect(emitSignalCalls).toHaveLength(1);
      expect(timeouts).toHaveLength(0);
    });

    test("disconnect mid-wait without opt-in emits nothing", () => {
      seedRequest("pending");
      const { controller } = createController();
      controller.start(START_PARAMS);

      controller.dispose("transport_closed");
      expect(emitSignalCalls).toHaveLength(0);
    });

    test("plain teardown never emits the handoff", () => {
      seedRequest("pending");
      const { controller } = createController();
      controller.start(START_PARAMS);
      optIntoCallback(controller);

      controller.dispose();
      expect(emitSignalCalls).toHaveLength(0);
    });
  });

  describe("dispose", () => {
    test("clears every timer — nothing fires afterwards", () => {
      seedRequest("pending");
      const { controller, spoken, approvals, denials, timeouts } =
        createController({ consultTimeoutMs: 2000 });
      controller.start(START_PARAMS);

      controller.dispose();
      expect(controller.getState()).toBe("disposed");

      seedRequest("approved");
      jest.advanceTimersByTime(60_000);
      expect(spoken).toHaveLength(1); // hold message only
      expect(approvals).toHaveLength(0);
      expect(denials).toHaveLength(0);
      expect(timeouts).toHaveLength(0);
      expect(
        storeEvents.filter(
          (e) => e.eventType === "voice_guardian_wait_heartbeat_sent",
        ),
      ).toHaveLength(0);
    });

    test("is idempotent and preserves a reached resolution", () => {
      seedRequest("approved");
      const { controller, approvals } = createController();
      controller.start(START_PARAMS);
      jest.advanceTimersByTime(50);
      expect(approvals).toHaveLength(1);

      controller.dispose();
      controller.dispose("transport_closed");
      expect(controller.getState()).toBe("resolved");
      expect(controller.getResolution()).toBe("approved");
      expect(emitSignalCalls).toHaveLength(0);
    });
  });
});
