/**
 * Opt-in live smoke harness for {@link MeetConsentMonitor}'s LLM
 * judgement path. Unlike `consent-monitor.test.ts`, this suite drives the
 * REAL `defaultLLMAsk` — backed by `getConfiguredProvider` under the
 * `meetConsentMonitor` call site — against a small fixture set of
 * transcript/chat excerpts so Sidd can calibrate the model's rationale by
 * eye.
 *
 * **Gating.** The entire suite is gated on `MEET_CONSENT_MONITOR_LIVE=1`.
 * CI and every other test run must leave the env flag unset; the suite
 * then skips cleanly without ever constructing a provider or hitting the
 * network. Sidd invokes it manually:
 *
 *     MEET_CONSENT_MONITOR_LIVE=1 bun test daemon/__tests__/consent-monitor-live.test.ts
 *
 * The harness logs each fixture's prompt, the LLM verdict, and the
 * returned rationale to stdout so the output is eyeballable.
 *
 * Production code is intentionally NOT modified by this PR — the harness
 * exercises the existing `defaultLLMAsk` export path by constructing a
 * monitor with no `llmAsk` override, dispatching fixture events through a
 * fake dispatcher, and inspecting the `MeetSessionLeaver` stub for
 * leave-calls.
 */

import { describe, expect, mock, test } from "bun:test";

import type { MeetBotEvent } from "../../contracts/index.js";

import {
  MeetConsentMonitor,
  type MeetSessionLeaver,
} from "../consent-monitor.js";
import type {
  MeetEventSubscriber,
  MeetEventUnsubscribe,
} from "../event-publisher.js";

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

const LIVE = process.env.MEET_CONSENT_MONITOR_LIVE === "1";

// Bun's `describe.skipIf(cond)` returns a no-op `describe` when `cond` is
// truthy. We want to skip when LIVE is false, so pass `!LIVE`.
const maybeDescribe = LIVE ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface LiveFixture {
  name: string;
  /**
   * One or more events to dispatch through the fake event dispatcher before
   * the timer tick fires. Each event advances the monitor's rolling buffers.
   */
  events: MeetBotEvent[];
  /**
   * Expected verdict from the live LLM. `"either"` means the sample is
   * ambiguous by design — the assertion just checks that the monitor
   * returned a decision (leave-fired or not) without throwing.
   */
  expected: "objected" | "not-objected" | "either";
}

const FIXTURES: LiveFixture[] = [
  {
    name: "clear objection: participant asks the bot to leave in chat",
    events: [
      {
        type: "chat.inbound",
        meetingId: "live-1",
        timestamp: "2024-01-01T00:00:00.000Z",
        fromId: "alice",
        fromName: "Alice",
        text: "can the AI note-taker please leave? we want this conversation off the record",
      },
    ],
    expected: "objected",
  },
  {
    name: "clear non-objection: participant greets the group",
    events: [
      {
        type: "transcript.chunk",
        meetingId: "live-2",
        timestamp: "2024-01-01T00:00:00.000Z",
        isFinal: true,
        speakerId: "alice",
        speakerLabel: "Alice",
        text: "morning everyone, let's get started on the roadmap review",
      },
    ],
    expected: "not-objected",
  },
  {
    name: "ambiguous: participant wants to 'keep this private' without naming the bot",
    events: [
      {
        type: "transcript.chunk",
        meetingId: "live-3",
        timestamp: "2024-01-01T00:00:00.000Z",
        isFinal: true,
        speakerId: "bob",
        speakerLabel: "Bob",
        text: "maybe we should keep this part private",
      },
    ],
    expected: "either",
  },
  {
    name: "off-topic bot mention: participant says their own bot is on vacation",
    events: [
      {
        type: "transcript.chunk",
        meetingId: "live-4",
        timestamp: "2024-01-01T00:00:00.000Z",
        isFinal: true,
        speakerId: "carol",
        speakerLabel: "Carol",
        text: "oh by the way, my scheduling bot is on vacation this week so please email me directly",
      },
    ],
    expected: "not-objected",
  },
];

// ---------------------------------------------------------------------------
// Fake dispatcher (same shape as consent-monitor.test.ts)
// ---------------------------------------------------------------------------

function makeFakeDispatcher(): {
  subscribe: (
    meetingId: string,
    cb: MeetEventSubscriber,
  ) => MeetEventUnsubscribe;
  dispatch: (meetingId: string, event: MeetBotEvent) => void;
} {
  const subs = new Map<string, Set<MeetEventSubscriber>>();
  return {
    subscribe(meetingId, cb) {
      let set = subs.get(meetingId);
      if (!set) {
        set = new Set();
        subs.set(meetingId, set);
      }
      set.add(cb);
      return () => {
        const existing = subs.get(meetingId);
        if (!existing) return;
        existing.delete(cb);
        if (existing.size === 0) subs.delete(meetingId);
      };
    },
    dispatch(meetingId, event) {
      const set = subs.get(meetingId);
      if (!set) return;
      for (const cb of Array.from(set)) cb(event);
    },
  };
}

function makeFakeSessionManager(): MeetSessionLeaver & {
  leave: ReturnType<typeof mock>;
} {
  return {
    leave: mock(async (_id: string, _reason: string) => {}),
  };
}

interface TimerControl {
  setIntervalFn: (cb: () => void, ms: number) => unknown;
  clearIntervalFn: (handle: unknown) => void;
  fire: () => void;
}

function makeTimerControl(): TimerControl {
  let storedCb: (() => void) | undefined;
  return {
    setIntervalFn(cb, _ms) {
      storedCb = cb;
      return { id: "fake-timer" };
    },
    clearIntervalFn(_handle) {
      storedCb = undefined;
    },
    fire() {
      if (storedCb) storedCb();
    },
  };
}

/**
 * Waits for all microtasks to drain, plus one macrotask to give the real
 * provider call a chance to complete. The real LLM call can take
 * hundreds of milliseconds to a few seconds — we use a generous
 * single `setTimeout(0)` round since the monitor's own timeout
 * ({@link ../consent-monitor.ts | CONSENT_LLM_TIMEOUT_MS}) will bound
 * the wait. The test `await`s on `session.leave`/in-flight detection
 * via polling in {@link waitForDecision} below.
 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

/**
 * Polls the monitor's `_isDecided()` and the session manager's leave-call
 * count until either the monitor decides or the budget runs out. Keeps
 * the budget comfortably above the consent monitor's own 5s LLM timeout
 * so a slow provider still has room to return.
 */
async function waitForDecision(
  monitor: MeetConsentMonitor,
  session: { leave: ReturnType<typeof mock> },
  budgetMs = 15_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < budgetMs) {
    if (monitor._isDecided() || session.leave.mock.calls.length > 0) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// ---------------------------------------------------------------------------
// Live suite
// ---------------------------------------------------------------------------

maybeDescribe("consent-monitor live LLM judgement", () => {
  for (const fixture of FIXTURES) {
    test(
      fixture.name,
      async () => {
        const dispatcher = makeFakeDispatcher();
        const session = makeFakeSessionManager();
        const timer = makeTimerControl();

        const monitor = new MeetConsentMonitor({
          meetingId: `live-${fixture.name}`,
          assistantId: "self",
          sessionManager: session,
          config: {
            autoLeaveOnObjection: true,
            // Empty keyword list forces every fixture through the
            // timer-tick path so we exercise the LLM on ambiguous phrasing
            // even when no keyword matches. The fake timer's `fire()`
            // simulates the 20s tick deterministically.
            objectionKeywords: [],
          },
          // Intentionally NO `llmAsk` override → uses the real
          // `defaultLLMAsk` which routes through `getConfiguredProvider`.
          subscribe: dispatcher.subscribe,
          setIntervalFn: timer.setIntervalFn,
          clearIntervalFn: timer.clearIntervalFn,
        });
        monitor.start();

        const meetingId = fixture.events[0]!.meetingId;
        for (const event of fixture.events) {
          dispatcher.dispatch(meetingId, event);
        }
        await flushMicrotasks();

        // Trigger the LLM via the safety-net timer.
        timer.fire();
        await waitForDecision(monitor, session);

        const decided = monitor._isDecided();
        const leaveCalls = session.leave.mock.calls as unknown as Array<
          [string, string]
        >;
        const leaveReason = leaveCalls[0]?.[1] ?? null;

        // eslint-disable-next-line no-console
        console.log(
          `[consent-monitor-live] fixture="${fixture.name}"\n` +
            `    expected=${fixture.expected}\n` +
            `    decided=${decided}\n` +
            `    leaveCalls=${leaveCalls.length}\n` +
            `    leaveReason=${leaveReason === null ? "(none)" : JSON.stringify(leaveReason)}`,
        );

        if (fixture.expected === "objected") {
          expect(decided).toBe(true);
          expect(leaveCalls.length).toBe(1);
        } else if (fixture.expected === "not-objected") {
          expect(decided).toBe(false);
          expect(leaveCalls.length).toBe(0);
        } else {
          // `"either"` — just assert the monitor reached a terminal state
          // without throwing. The calibration signal is the logged
          // rationale above, not a hard assertion.
          expect(typeof decided).toBe("boolean");
        }

        monitor.stop();
      },
      // Per-test budget: 5s LLM timeout + 15s poll budget + padding.
      30_000,
    );
  }
});
