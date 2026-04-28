/**
 * Unit tests for {@link MeetBargeInWatcher}.
 *
 * These tests inject a fake meeting-event dispatcher, a fake assistant-
 * event-hub subscriber, manual timer hooks, and a stub session manager so
 * each scenario is deterministic. Real provider/dispatcher singletons are
 * never touched.
 *
 * Coverage:
 *   - Bot-self identification from `participant.change` with `isSelf: true`.
 *   - Cancel fires only after the debounce window has elapsed AND the bot
 *     is still speaking AND a non-bot speaker took the floor.
 *   - Brief (< 250ms) non-bot speaker events do not trigger cancel — the
 *     pending cancel is cleared when the bot regains the floor or when
 *     speaking ends.
 *   - Bot-attributed events (speaker.change to the bot, transcript.chunk
 *     attributed to the bot, low-confidence chunks) never schedule a cancel.
 *   - High-confidence interim transcript chunks attributed to a non-bot
 *     speaker DO schedule a cancel.
 *   - Watcher does nothing while the bot is not speaking.
 *   - `stop()` clears the pending cancel and unsubscribes.
 */

import type {
  AssistantEvent,
  AssistantEventCallback,
  ServerMessage,
  Subscription as AssistantEventSubscription,
} from "@vellumai/skill-host-contracts";
import { buildAssistantEvent } from "@vellumai/skill-host-contracts";
import { describe, expect, mock, test } from "bun:test";

import type { MeetBotEvent } from "../../contracts/index.js";

import {
  BARGE_IN_DEBOUNCE_MS,
  type BargeInCanceller,
  MeetBargeInWatcher,
} from "../barge-in-watcher.js";
import type {
  MeetEventSubscriber,
  MeetEventUnsubscribe,
} from "../event-publisher.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeFakeDispatcher(): {
  subscribe: (
    meetingId: string,
    cb: MeetEventSubscriber,
  ) => MeetEventUnsubscribe;
  dispatch: (meetingId: string, event: MeetBotEvent) => void;
  subscriberCount: (meetingId: string) => number;
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
    subscriberCount(meetingId) {
      return subs.get(meetingId)?.size ?? 0;
    },
  };
}

function makeFakeAssistantEventHub(): {
  subscribe: (cb: AssistantEventCallback) => AssistantEventSubscription;
  publish: (message: ServerMessage) => void;
  subscriberCount: () => number;
} {
  const subs = new Set<AssistantEventCallback>();
  return {
    subscribe(cb) {
      subs.add(cb);
      let active = true;
      return {
        dispose: () => {
          if (!active) return;
          active = false;
          subs.delete(cb);
        },
        get active() {
          return active;
        },
      };
    },
    publish(message) {
      const event: AssistantEvent = buildAssistantEvent(message);
      for (const cb of Array.from(subs)) {
        void cb(event);
      }
    },
    subscriberCount: () => subs.size,
  };
}

function makeFakeSession(): BargeInCanceller & {
  cancelSpeak: ReturnType<typeof mock>;
} {
  return {
    cancelSpeak: mock(async (_id: string) => {}),
  };
}

interface TimerControl {
  setTimeoutFn: (cb: () => void, ms: number) => unknown;
  clearTimeoutFn: (handle: unknown) => void;
  fire: (handle: unknown) => void;
  fireAll: () => void;
  /** Map of pending handle → callback. */
  pending: Map<symbol, { cb: () => void; ms: number }>;
}

function makeTimerControl(): TimerControl {
  const pending = new Map<symbol, { cb: () => void; ms: number }>();
  return {
    pending,
    setTimeoutFn(cb, ms) {
      const handle = Symbol("barge-in-test-timer");
      pending.set(handle, { cb, ms });
      return handle;
    },
    clearTimeoutFn(handle) {
      pending.delete(handle as symbol);
    },
    fire(handle) {
      const entry = pending.get(handle as symbol);
      if (!entry) return;
      pending.delete(handle as symbol);
      entry.cb();
    },
    fireAll() {
      const handles = Array.from(pending.keys());
      for (const handle of handles) {
        const entry = pending.get(handle);
        if (!entry) continue;
        pending.delete(handle);
        entry.cb();
      }
    },
  };
}

const MEETING_ID = "m-barge-in";
const BOT_PARTICIPANT_ID = "bot-self-id";
const HUMAN_SPEAKER_ID = "human-alice";

function participantChangeWithSelf(): MeetBotEvent {
  return {
    type: "participant.change",
    meetingId: MEETING_ID,
    timestamp: "2024-01-01T00:00:00.000Z",
    joined: [{ id: BOT_PARTICIPANT_ID, name: "Aria", isSelf: true }],
    left: [],
  };
}

function speakerChange(speakerId: string, speakerName = "Alice"): MeetBotEvent {
  return {
    type: "speaker.change",
    meetingId: MEETING_ID,
    timestamp: "2024-01-01T00:00:01.000Z",
    speakerId,
    speakerName,
  };
}

function interimTranscript(
  options: {
    confidence?: number;
    speakerId?: string;
    text?: string;
  } = {},
): MeetBotEvent {
  return {
    type: "transcript.chunk",
    meetingId: MEETING_ID,
    timestamp: "2024-01-01T00:00:01.500Z",
    isFinal: false,
    text: options.text ?? "interrupting…",
    confidence: options.confidence ?? 0.9,
    speakerId: options.speakerId,
  };
}

function speakingStarted(streamId = "stream-1"): ServerMessage {
  return {
    type: "meet.speaking_started",
    meetingId: MEETING_ID,
    streamId,
  };
}

function speakingEnded(
  streamId = "stream-1",
  reason: "completed" | "cancelled" | "error" = "completed",
): ServerMessage {
  return {
    type: "meet.speaking_ended",
    meetingId: MEETING_ID,
    streamId,
    reason,
  };
}

async function flushPromises(): Promise<void> {
  for (let i = 0; i < 3; i++) await Promise.resolve();
}

interface Harness {
  watcher: MeetBargeInWatcher;
  dispatcher: ReturnType<typeof makeFakeDispatcher>;
  hub: ReturnType<typeof makeFakeAssistantEventHub>;
  timer: TimerControl;
  session: BargeInCanceller & { cancelSpeak: ReturnType<typeof mock> };
}

function makeHarness(): Harness {
  const dispatcher = makeFakeDispatcher();
  const hub = makeFakeAssistantEventHub();
  const timer = makeTimerControl();
  const session = makeFakeSession();
  const watcher = new MeetBargeInWatcher({
    meetingId: MEETING_ID,
    sessionManager: session,
    subscribe: dispatcher.subscribe,
    subscribeAssistantEvents: hub.subscribe,
    setTimeoutFn: timer.setTimeoutFn,
    clearTimeoutFn: timer.clearTimeoutFn,
  });
  watcher.start();
  return { watcher, dispatcher, hub, timer, session };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MeetBargeInWatcher — bot-self identification", () => {
  test("captures botSpeakerId from the first participant.change with isSelf", () => {
    const { watcher, dispatcher } = makeHarness();
    expect(watcher._getBotSpeakerId()).toBeNull();
    dispatcher.dispatch(MEETING_ID, participantChangeWithSelf());
    expect(watcher._getBotSpeakerId()).toBe(BOT_PARTICIPANT_ID);
    watcher.stop();
  });

  test("ignores subsequent isSelf joiners — first wins", () => {
    const { watcher, dispatcher } = makeHarness();
    dispatcher.dispatch(MEETING_ID, participantChangeWithSelf());
    expect(watcher._getBotSpeakerId()).toBe(BOT_PARTICIPANT_ID);
    dispatcher.dispatch(MEETING_ID, {
      type: "participant.change",
      meetingId: MEETING_ID,
      timestamp: "2024-01-01T00:00:05.000Z",
      joined: [{ id: "different-self", name: "Other", isSelf: true }],
      left: [],
    });
    expect(watcher._getBotSpeakerId()).toBe(BOT_PARTICIPANT_ID);
    watcher.stop();
  });
});

describe("MeetBargeInWatcher — speaking lifecycle", () => {
  test("does not arm cancel until meet.speaking_started", () => {
    const { watcher, dispatcher, timer, session } = makeHarness();
    dispatcher.dispatch(MEETING_ID, participantChangeWithSelf());

    // Bot is not yet speaking — a non-bot speaker change must not schedule
    // a cancel.
    dispatcher.dispatch(MEETING_ID, speakerChange(HUMAN_SPEAKER_ID));
    expect(timer.pending.size).toBe(0);
    expect(watcher._hasPendingCancel()).toBe(false);
    expect(session.cancelSpeak).toHaveBeenCalledTimes(0);

    watcher.stop();
  });

  test("flips isBotSpeaking on speaking_started/ended events", async () => {
    const { watcher, hub } = makeHarness();
    expect(watcher._isBotSpeaking()).toBe(false);

    hub.publish(speakingStarted());
    await flushPromises();
    expect(watcher._isBotSpeaking()).toBe(true);

    hub.publish(speakingEnded());
    await flushPromises();
    expect(watcher._isBotSpeaking()).toBe(false);

    watcher.stop();
  });

  test("ignores meet.speaking_* events for a different meetingId", async () => {
    const { watcher, hub } = makeHarness();
    hub.publish({
      type: "meet.speaking_started",
      meetingId: "different-meeting",
      streamId: "x",
    });
    await flushPromises();
    expect(watcher._isBotSpeaking()).toBe(false);
    watcher.stop();
  });
});

describe("MeetBargeInWatcher — speaker.change cancel path", () => {
  test("non-bot speaker.change while bot is speaking schedules a cancel that fires after the debounce", async () => {
    const { watcher, dispatcher, hub, timer, session } = makeHarness();
    dispatcher.dispatch(MEETING_ID, participantChangeWithSelf());
    hub.publish(speakingStarted());
    await flushPromises();

    dispatcher.dispatch(MEETING_ID, speakerChange(HUMAN_SPEAKER_ID));
    // Cancel is queued but not yet fired.
    expect(watcher._hasPendingCancel()).toBe(true);
    expect(timer.pending.size).toBe(1);
    const [{ ms }] = Array.from(timer.pending.values());
    expect(ms).toBe(BARGE_IN_DEBOUNCE_MS);
    expect(session.cancelSpeak).toHaveBeenCalledTimes(0);

    // Fire the timer — cancel runs.
    timer.fireAll();
    await flushPromises();

    expect(session.cancelSpeak).toHaveBeenCalledTimes(1);
    const [calledMeetingId] = session.cancelSpeak.mock.calls[0] as unknown as [
      string,
    ];
    expect(calledMeetingId).toBe(MEETING_ID);
    expect(watcher._hasPendingCancel()).toBe(false);

    watcher.stop();
  });

  test("brief non-bot speaker (returns to bot within debounce) does NOT cancel", async () => {
    const { watcher, dispatcher, hub, timer, session } = makeHarness();
    dispatcher.dispatch(MEETING_ID, participantChangeWithSelf());
    hub.publish(speakingStarted());
    await flushPromises();

    // Brief blip from a human speaker.
    dispatcher.dispatch(MEETING_ID, speakerChange(HUMAN_SPEAKER_ID));
    expect(watcher._hasPendingCancel()).toBe(true);

    // Floor returns to the bot before the debounce expires.
    dispatcher.dispatch(MEETING_ID, speakerChange(BOT_PARTICIPANT_ID, "Aria"));
    expect(watcher._hasPendingCancel()).toBe(false);
    expect(timer.pending.size).toBe(0);

    // Even firing any leftover timers should not produce a cancel.
    timer.fireAll();
    await flushPromises();
    expect(session.cancelSpeak).toHaveBeenCalledTimes(0);

    watcher.stop();
  });

  test("speaker.change to the bot while bot is speaking is a no-op", async () => {
    const { watcher, dispatcher, hub, timer, session } = makeHarness();
    dispatcher.dispatch(MEETING_ID, participantChangeWithSelf());
    hub.publish(speakingStarted());
    await flushPromises();

    dispatcher.dispatch(MEETING_ID, speakerChange(BOT_PARTICIPANT_ID, "Aria"));
    expect(timer.pending.size).toBe(0);
    expect(watcher._hasPendingCancel()).toBe(false);
    expect(session.cancelSpeak).toHaveBeenCalledTimes(0);

    watcher.stop();
  });

  test("speaking_ended within debounce window cancels the pending cancel", async () => {
    const { watcher, dispatcher, hub, timer, session } = makeHarness();
    dispatcher.dispatch(MEETING_ID, participantChangeWithSelf());
    hub.publish(speakingStarted());
    await flushPromises();

    dispatcher.dispatch(MEETING_ID, speakerChange(HUMAN_SPEAKER_ID));
    expect(watcher._hasPendingCancel()).toBe(true);

    // Stream finishes naturally before the debounce expires.
    hub.publish(speakingEnded());
    await flushPromises();
    expect(watcher._hasPendingCancel()).toBe(false);
    expect(timer.pending.size).toBe(0);

    timer.fireAll();
    await flushPromises();
    expect(session.cancelSpeak).toHaveBeenCalledTimes(0);

    watcher.stop();
  });

  test("scheduling is idempotent — repeated triggers within the debounce window do not stack timers", async () => {
    const { watcher, dispatcher, hub, timer } = makeHarness();
    dispatcher.dispatch(MEETING_ID, participantChangeWithSelf());
    hub.publish(speakingStarted());
    await flushPromises();

    dispatcher.dispatch(MEETING_ID, speakerChange(HUMAN_SPEAKER_ID));
    dispatcher.dispatch(MEETING_ID, speakerChange("another-human"));
    dispatcher.dispatch(MEETING_ID, speakerChange("third-human"));
    expect(timer.pending.size).toBe(1);
    expect(watcher._hasPendingCancel()).toBe(true);

    watcher.stop();
  });
});

describe("MeetBargeInWatcher — transcript.chunk cancel path", () => {
  test("interim non-bot chunk above confidence threshold schedules a cancel", async () => {
    const { watcher, dispatcher, hub, timer, session } = makeHarness();
    dispatcher.dispatch(MEETING_ID, participantChangeWithSelf());
    hub.publish(speakingStarted());
    await flushPromises();

    dispatcher.dispatch(
      MEETING_ID,
      interimTranscript({ confidence: 0.85, speakerId: HUMAN_SPEAKER_ID }),
    );
    expect(watcher._hasPendingCancel()).toBe(true);

    timer.fireAll();
    await flushPromises();
    expect(session.cancelSpeak).toHaveBeenCalledTimes(1);

    watcher.stop();
  });

  test("interim chunk attributed to the bot does NOT schedule a cancel", async () => {
    const { watcher, dispatcher, hub, timer, session } = makeHarness();
    dispatcher.dispatch(MEETING_ID, participantChangeWithSelf());
    hub.publish(speakingStarted());
    await flushPromises();

    dispatcher.dispatch(
      MEETING_ID,
      interimTranscript({ confidence: 0.95, speakerId: BOT_PARTICIPANT_ID }),
    );
    expect(timer.pending.size).toBe(0);
    expect(watcher._hasPendingCancel()).toBe(false);
    expect(session.cancelSpeak).toHaveBeenCalledTimes(0);

    watcher.stop();
  });

  test("low-confidence interim chunk does NOT schedule a cancel", async () => {
    const { watcher, dispatcher, hub, timer, session } = makeHarness();
    dispatcher.dispatch(MEETING_ID, participantChangeWithSelf());
    hub.publish(speakingStarted());
    await flushPromises();

    dispatcher.dispatch(
      MEETING_ID,
      interimTranscript({ confidence: 0.3, speakerId: HUMAN_SPEAKER_ID }),
    );
    expect(timer.pending.size).toBe(0);
    expect(session.cancelSpeak).toHaveBeenCalledTimes(0);

    watcher.stop();
  });

  test("final transcript chunks (isFinal:true) are ignored — only interim chunks count", async () => {
    const { watcher, dispatcher, hub, timer, session } = makeHarness();
    dispatcher.dispatch(MEETING_ID, participantChangeWithSelf());
    hub.publish(speakingStarted());
    await flushPromises();

    dispatcher.dispatch(MEETING_ID, {
      type: "transcript.chunk",
      meetingId: MEETING_ID,
      timestamp: "2024-01-01T00:00:01.500Z",
      isFinal: true,
      text: "I am interrupting",
      confidence: 0.95,
      speakerId: HUMAN_SPEAKER_ID,
    });
    expect(timer.pending.size).toBe(0);
    expect(session.cancelSpeak).toHaveBeenCalledTimes(0);

    watcher.stop();
  });

  test("interim chunk without confidence is ignored — threshold cannot be evaluated", async () => {
    const { watcher, dispatcher, hub, timer, session } = makeHarness();
    dispatcher.dispatch(MEETING_ID, participantChangeWithSelf());
    hub.publish(speakingStarted());
    await flushPromises();

    const noConfidenceChunk: MeetBotEvent = {
      type: "transcript.chunk",
      meetingId: MEETING_ID,
      timestamp: "2024-01-01T00:00:02.500Z",
      isFinal: false,
      text: "background noise",
      speakerId: HUMAN_SPEAKER_ID,
    };
    dispatcher.dispatch(MEETING_ID, noConfidenceChunk);

    expect(timer.pending.size).toBe(0);
    expect(watcher._hasPendingCancel()).toBe(false);
    expect(session.cancelSpeak).toHaveBeenCalledTimes(0);

    watcher.stop();
  });
});

describe("MeetBargeInWatcher — bot speaking to itself", () => {
  test("bot speaks with no other speaker activity — no cancel ever fires", async () => {
    const { watcher, dispatcher, hub, timer, session } = makeHarness();
    dispatcher.dispatch(MEETING_ID, participantChangeWithSelf());
    hub.publish(speakingStarted());
    await flushPromises();

    // No speaker.change, no transcript.chunk — long bot utterance.
    expect(timer.pending.size).toBe(0);
    expect(session.cancelSpeak).toHaveBeenCalledTimes(0);

    hub.publish(speakingEnded());
    await flushPromises();
    expect(timer.pending.size).toBe(0);
    expect(session.cancelSpeak).toHaveBeenCalledTimes(0);

    watcher.stop();
  });
});

describe("MeetBargeInWatcher — fire-time guard", () => {
  test("debounced cancel does not call cancelSpeak when bot stopped speaking between schedule and fire", async () => {
    // Defense-in-depth: even though `meet.speaking_ended` already clears
    // the pending cancel today, the timer's own callback re-checks
    // `isBotSpeaking` at fire time. We exercise that guard by capturing
    // the queued callback, manually flipping the flag without touching
    // the watcher's clear path, and firing the captured callback.
    const { watcher, dispatcher, hub, timer, session } = makeHarness();
    dispatcher.dispatch(MEETING_ID, participantChangeWithSelf());
    hub.publish(speakingStarted());
    await flushPromises();

    dispatcher.dispatch(MEETING_ID, speakerChange(HUMAN_SPEAKER_ID));
    expect(timer.pending.size).toBe(1);
    const [{ cb }] = Array.from(timer.pending.values());

    // Flip `isBotSpeaking` to false via the production path, but capture
    // the queued cb BEFORE calling that path so the cb's closure is the
    // one we'll invoke directly. The production path will also call
    // clearPendingCancel which removes the timer from `timer.pending`,
    // but the closure we captured above is still valid.
    hub.publish(speakingEnded());
    await flushPromises();

    // Manually invoke the captured callback to simulate a regression in
    // which the clear path didn't run before the timer fired.
    cb();
    await flushPromises();

    expect(session.cancelSpeak).toHaveBeenCalledTimes(0);
    watcher.stop();
  });
});

describe("MeetBargeInWatcher — start/stop idempotency", () => {
  test("double start does not double-subscribe", () => {
    const { watcher, dispatcher, hub } = makeHarness();
    expect(dispatcher.subscriberCount(MEETING_ID)).toBe(1);
    expect(hub.subscriberCount()).toBe(1);
    watcher.start();
    expect(dispatcher.subscriberCount(MEETING_ID)).toBe(1);
    expect(hub.subscriberCount()).toBe(1);
    watcher.stop();
  });

  test("stop unsubscribes from both the dispatcher and the hub", () => {
    const { watcher, dispatcher, hub } = makeHarness();
    expect(dispatcher.subscriberCount(MEETING_ID)).toBe(1);
    expect(hub.subscriberCount()).toBe(1);
    watcher.stop();
    expect(dispatcher.subscriberCount(MEETING_ID)).toBe(0);
    expect(hub.subscriberCount()).toBe(0);
  });

  test("stop clears any pending cancel", async () => {
    const { watcher, dispatcher, hub, timer, session } = makeHarness();
    dispatcher.dispatch(MEETING_ID, participantChangeWithSelf());
    hub.publish(speakingStarted());
    await flushPromises();
    dispatcher.dispatch(MEETING_ID, speakerChange(HUMAN_SPEAKER_ID));
    expect(watcher._hasPendingCancel()).toBe(true);

    watcher.stop();
    expect(watcher._hasPendingCancel()).toBe(false);
    expect(timer.pending.size).toBe(0);

    timer.fireAll();
    await flushPromises();
    expect(session.cancelSpeak).toHaveBeenCalledTimes(0);
  });

  test("double stop is safe", () => {
    const { watcher } = makeHarness();
    watcher.stop();
    expect(() => watcher.stop()).not.toThrow();
  });
});
