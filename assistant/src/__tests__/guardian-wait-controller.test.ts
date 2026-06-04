import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Logger mock (must come before any source imports) ────────────────

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// ── call-store mock ───────────────────────────────────────────────────
// recordCallEvent persists to the call DB; stub it and capture events so the
// controller (and the real relay-access-wait helpers it reuses) can run
// without a live store.

const recordedEvents: Array<{ type: string; payload?: unknown }> = [];
mock.module("../calls/call-store.js", () => ({
  recordCallEvent: (_id: string, type: string, payload?: unknown) => {
    recordedEvents.push({ type, payload });
  },
}));

// ── notification / contact / canonical-store mocks ───────────────────
// Transitive deps of the REAL emitAccessRequestCallbackHandoff helper (which
// the controller reuses). Stub them so the timeout handoff path runs without
// emitting a real signal or hitting the DB, while letting us assert it fired.

const emittedSignals: Array<{ sourceEventName: string; dedupeKey?: string }> =
  [];
mock.module("../notifications/emit-signal.js", () => ({
  emitNotificationSignal: (params: {
    sourceEventName: string;
    dedupeKey?: string;
  }) => {
    emittedSignals.push({
      sourceEventName: params.sourceEventName,
      dedupeKey: params.dedupeKey,
    });
    return Promise.resolve();
  },
}));

mock.module("../contacts/contact-store.js", () => ({
  findContactChannel: () => null,
}));

mock.module("../memory/canonical-guardian-store.js", () => ({
  getCanonicalGuardianRequest: () => null,
}));

import type { SetupFlowTransport } from "../calls/call-setup-flow-types.js";
import {
  GuardianWaitController,
  type GuardianWaitControllerDeps,
} from "../calls/guardian-wait-controller.js";

// ── Test doubles ─────────────────────────────────────────────────────

function makeTransport(): SetupFlowTransport {
  // The controller speaks through the injected `speakSystemPrompt`, never the
  // transport directly, so these are inert — present only to satisfy the shape.
  return {
    sendTextToken() {},
    endSession() {},
    getConnectionState: () => "connected",
  };
}

/**
 * Manual fake-timer harness. One-shot and repeating timers are tracked
 * separately so tests can fire/inspect them deterministically — no real
 * delays, and `dispose()` cleanup can be asserted by checking nothing is left.
 */
function makeClock() {
  const now = 1_000_000;
  let nextId = 1;
  const oneShots = new Map<number, { fn: () => void; delayMs: number }>();
  const intervals = new Map<number, { fn: () => void; intervalMs: number }>();

  return {
    now: () => now,
    setTimer(fn: () => void, delayMs: number) {
      const id = nextId++;
      oneShots.set(id, { fn, delayMs });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer(handle: ReturnType<typeof setTimeout>) {
      oneShots.delete(handle as unknown as number);
    },
    setPollTimer(fn: () => void, intervalMs: number) {
      const id = nextId++;
      intervals.set(id, { fn, intervalMs });
      return id as unknown as ReturnType<typeof setInterval>;
    },
    clearPollTimer(handle: ReturnType<typeof setInterval>) {
      intervals.delete(handle as unknown as number);
    },
    /** Fire all currently-pending one-shot timers (FIFO). */
    fireOneShots() {
      const pending = [...oneShots.values()];
      oneShots.clear();
      for (const t of pending) t.fn();
    },
    /** Fire only pending one-shots whose delay is at most `maxDelayMs`. */
    fireOneShotsUpTo(maxDelayMs: number) {
      for (const [id, t] of [...oneShots.entries()]) {
        if (t.delayMs <= maxDelayMs) {
          oneShots.delete(id);
          t.fn();
        }
      }
    },
    /** Fire one tick of every active interval. */
    tickPolls() {
      for (const t of [...intervals.values()]) t.fn();
    },
    pendingOneShots: () => oneShots.size,
    pendingIntervals: () => intervals.size,
  };
}

interface Harness {
  clock: ReturnType<typeof makeClock>;
  transport: SetupFlowTransport;
  deps: GuardianWaitControllerDeps;
  spokenPrompts: string[];
  approved: Array<{ assistantId: string; fromNumber: string }>;
  denied: Array<{ guardianLabel: string }>;
  timedOut: Array<{ guardianLabel: string; callbackOptIn: boolean }>;
  /** Count of markWaitingOnUser() invocations. */
  waitingOnUserMarks: { count: number };
  /** Current canonical request status returned by the injected lookup. */
  setRequestStatus: (status: string | null) => void;
}

function makeHarness(): Harness {
  const clock = makeClock();
  const transport = makeTransport();
  const spokenPrompts: string[] = [];
  const approved: Harness["approved"] = [];
  const denied: Harness["denied"] = [];
  const timedOut: Harness["timedOut"] = [];
  const waitingOnUserMarks = { count: 0 };
  let requestStatus: string | null = "pending";

  const deps: GuardianWaitControllerDeps = {
    speakSystemPrompt: async (_transport, text) => {
      spokenPrompts.push(text);
    },
    resolveGuardianLabel: () => "Alex",
    markWaitingOnUser: () => {
      waitingOnUserMarks.count++;
    },
    onApproved: (p) =>
      approved.push({ assistantId: p.assistantId, fromNumber: p.fromNumber }),
    onDenied: (p) => denied.push({ guardianLabel: p.guardianLabel }),
    onTimeout: (p) =>
      timedOut.push({
        guardianLabel: p.guardianLabel,
        callbackOptIn: p.callbackOptIn,
      }),
    now: () => clock.now(),
    setTimer: (fn, ms) => clock.setTimer(fn, ms),
    clearTimer: (h) => clock.clearTimer(h),
    setPollTimer: (fn, ms) => clock.setPollTimer(fn, ms),
    clearPollTimer: (h) => clock.clearPollTimer(h),
    getCanonicalGuardianRequest: () =>
      requestStatus ? ({ status: requestStatus } as never) : null,
    // Deterministic heartbeat scheduler driven by the fake clock. Mirrors the
    // shared helper's contract (re-schedules itself) without real setTimeout.
    scheduleHeartbeat: (params) => {
      if (!params.isWaitActive()) return null;
      return clock.setTimer(() => {
        if (!params.isWaitActive()) return;
        const seq = params.consumeSequence();
        params.sendTextToken(`heartbeat-${seq}`, true);
        params.scheduleNext();
      }, 100);
    },
    timeoutMs: 30_000,
    pollIntervalMs: 1_000,
    initialHeartbeatDelayMs: 500,
    inWaitReplyCooldownMs: 3_000,
  };

  return {
    clock,
    transport,
    deps,
    spokenPrompts,
    approved,
    denied,
    timedOut,
    waitingOnUserMarks,
    setRequestStatus: (s) => {
      requestStatus = s;
    },
  };
}

const START = {
  accessRequestId: "req_1",
  assistantId: "asst_1",
  fromNumber: "+15550100",
  callerName: "Sam",
};

describe("GuardianWaitController", () => {
  let h: Harness;
  let controller: GuardianWaitController;

  beforeEach(() => {
    recordedEvents.length = 0;
    emittedSignals.length = 0;
    h = makeHarness();
    controller = new GuardianWaitController("call_1", h.transport, h.deps);
  });

  test("starts idle, transitions to awaiting on start, speaks the hold message", () => {
    expect(controller.getState()).toBe("idle");

    controller.start(START);

    expect(controller.getState()).toBe("awaiting_guardian_decision");
    expect(h.spokenPrompts[0]).toContain("Please hold");
    expect(h.spokenPrompts[0]).toContain("Alex");
    // poll + timeout + initial heartbeat-delay timers are pending.
    expect(h.clock.pendingIntervals()).toBe(1);
    expect(h.clock.pendingOneShots()).toBe(2);
  });

  test("persists waiting_on_user when the wait starts", () => {
    expect(h.waitingOnUserMarks.count).toBe(0);

    controller.start(START);

    // Mirrors relay-server.ts: status is persisted to waiting_on_user exactly
    // once, at wait start, so recovery/UI observe the call is blocked on the user.
    expect(h.waitingOnUserMarks.count).toBe(1);
  });

  test("approval → onApproved with caller identity", () => {
    controller.start(START);
    h.setRequestStatus("approved");

    h.clock.tickPolls();

    expect(h.approved).toEqual([
      { assistantId: "asst_1", fromNumber: "+15550100" },
    ]);
    expect(controller.getState()).toBe("resolved");
    expect(
      recordedEvents.some((e) => e.type === "inbound_acl_access_approved"),
    ).toBe(true);
    // All timers cleared on resolution.
    expect(h.clock.pendingIntervals()).toBe(0);
    expect(h.clock.pendingOneShots()).toBe(0);
  });

  test("denial → onDenied", () => {
    controller.start(START);
    h.setRequestStatus("denied");

    h.clock.tickPolls();

    expect(h.denied).toEqual([{ guardianLabel: "Alex" }]);
    expect(controller.getState()).toBe("resolved");
    expect(
      recordedEvents.some((e) => e.type === "inbound_acl_access_denied"),
    ).toBe(true);
    expect(h.clock.pendingIntervals()).toBe(0);
    expect(h.clock.pendingOneShots()).toBe(0);
  });

  test("heartbeats fire in sequence while waiting", () => {
    controller.start(START);

    // Fire only short-delay one-shots (initial 500ms delay + 100ms heartbeats),
    // never the 30s timeout. Each call drains the currently-pending heartbeat.
    h.clock.fireOneShotsUpTo(500); // initial delay → schedules first heartbeat
    h.clock.fireOneShotsUpTo(500); // heartbeat-0 → schedules next
    h.clock.fireOneShotsUpTo(500); // heartbeat-1 → schedules next

    const heartbeats = h.spokenPrompts.filter((p) =>
      p.startsWith("heartbeat-"),
    );
    expect(heartbeats).toEqual(["heartbeat-0", "heartbeat-1"]);
  });

  test("timeout → callback handoff + onTimeout + timeout event", () => {
    controller.start(START);
    // An offer must be made before "yes" is read as a callback opt-in.
    controller.handleTranscript("this is taking too long"); // → callback offer
    controller.handleTranscript("yes, call me back"); // → opt-in
    expect(controller.getState()).toBe("awaiting_guardian_decision");

    // Fire pending one-shots until the timeout handler runs. The timeout timer
    // is among the pending one-shots; firing them invokes it.
    h.clock.fireOneShots();

    expect(h.timedOut).toEqual([
      { guardianLabel: "Alex", callbackOptIn: true },
    ]);
    expect(controller.getState()).toBe("resolved");
    expect(
      recordedEvents.some((e) => e.type === "inbound_acl_access_timeout"),
    ).toBe(true);
    // The reused emitAccessRequestCallbackHandoff helper emitted a signal.
    expect(emittedSignals).toHaveLength(1);
    expect(emittedSignals[0]!.sourceEventName).toBe(
      "ingress.access_request.callback_handoff",
    );
    expect(h.clock.pendingIntervals()).toBe(0);
    expect(h.clock.pendingOneShots()).toBe(0);
  });

  test("wait-state utterances are classified and answered", () => {
    controller.start(START);
    const before = h.spokenPrompts.length;

    // Patience check → reassurance.
    controller.handleTranscript("hello? are you still there?");
    const patienceReply = h.spokenPrompts[before];
    expect(patienceReply).toContain("still here");

    expect(
      recordedEvents.some(
        (e) => e.type === "voice_guardian_wait_prompt_classified",
      ),
    ).toBe(true);
  });

  test("impatience offers a callback, opt-in records the flag", () => {
    controller.start(START);

    controller.handleTranscript("this is taking too long");
    expect(h.spokenPrompts.some((p) => p.includes("call you back"))).toBe(true);
    expect(
      recordedEvents.some(
        (e) => e.type === "voice_guardian_wait_callback_offer_sent",
      ),
    ).toBe(true);

    // Now that an offer was made, "yes, call me back" is a callback opt-in.
    controller.handleTranscript("yes, call me back");
    expect(
      recordedEvents.some(
        (e) => e.type === "voice_guardian_wait_callback_opt_in_set",
      ),
    ).toBe(true);
  });

  test("handleTranscript is a no-op once resolved", () => {
    controller.start(START);
    controller.dispose();
    const before = h.spokenPrompts.length;

    controller.handleTranscript("hello?");

    expect(h.spokenPrompts.length).toBe(before);
  });

  test("dispose() clears every pending timer", () => {
    controller.start(START);
    // After start: poll interval + (timeout + initial heartbeat-delay) one-shots.
    expect(h.clock.pendingIntervals()).toBe(1);
    expect(h.clock.pendingOneShots()).toBe(2);

    controller.dispose();

    expect(controller.getState()).toBe("resolved");
    expect(h.clock.pendingIntervals()).toBe(0);
    expect(h.clock.pendingOneShots()).toBe(0);
  });
});
