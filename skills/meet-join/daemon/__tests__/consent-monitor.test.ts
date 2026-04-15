/**
 * Unit tests for {@link MeetConsentMonitor}.
 *
 * These tests inject a fake dispatcher (recording subscribers by meeting),
 * a scripted LLM client, a stub session manager, and manual timer hooks so
 * each scenario is deterministic and cache-free. Real LLM providers are
 * never constructed.
 */

import { describe, expect, mock, test } from "bun:test";

import type { MeetBotEvent } from "@vellumai/meet-contracts";

import {
  LLM_CHECK_DEBOUNCE_MS,
  LLM_TICK_INTERVAL_MS,
  MeetConsentMonitor,
  type MeetSessionLeaver,
  type ObjectionDecision,
} from "../consent-monitor.js";
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
  intervalMs: number | null;
  fired: number;
  cleared: boolean;
}

function makeTimerControl(): TimerControl {
  let storedCb: (() => void) | undefined;
  const state: TimerControl = {
    intervalMs: null,
    fired: 0,
    cleared: false,
    setIntervalFn(cb, ms) {
      state.intervalMs = ms;
      storedCb = cb;
      return { id: "fake-timer" };
    },
    clearIntervalFn(_handle) {
      state.cleared = true;
      storedCb = undefined;
    },
    fire() {
      if (!storedCb) return;
      state.fired += 1;
      storedCb();
    },
  };
  return state;
}

function transcriptChunk(
  meetingId: string,
  timestamp: string,
  text: string,
  options: {
    isFinal?: boolean;
    speakerLabel?: string;
    speakerId?: string;
  } = {},
): MeetBotEvent {
  return {
    type: "transcript.chunk",
    meetingId,
    timestamp,
    isFinal: options.isFinal ?? true,
    text,
    speakerLabel: options.speakerLabel,
    speakerId: options.speakerId,
  };
}

function inboundChat(
  meetingId: string,
  timestamp: string,
  text: string,
  fromName = "Alice",
  fromId = "a",
): MeetBotEvent {
  return {
    type: "chat.inbound",
    meetingId,
    timestamp,
    fromId,
    fromName,
    text,
  };
}

function participantChange(
  meetingId: string,
  timestamp: string,
  joined: Array<{ id: string; name: string; isSelf?: boolean }>,
  left: Array<{ id: string; name: string; isSelf?: boolean }> = [],
): MeetBotEvent {
  return {
    type: "participant.change",
    meetingId,
    timestamp,
    joined,
    left,
  };
}

async function flushPromises(): Promise<void> {
  for (let i = 0; i < 3; i++) await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MeetConsentMonitor keyword fast-path → LLM confirm", () => {
  test("chat keyword hit + LLM confirm triggers leave with objection reason", async () => {
    const dispatcher = makeFakeDispatcher();
    const session = makeFakeSessionManager();
    const timer = makeTimerControl();
    const llm = mock(
      async (_prompt: string): Promise<ObjectionDecision> => ({
        objected: true,
        reason: "participant asked the bot to leave",
      }),
    );

    const monitor = new MeetConsentMonitor({
      meetingId: "m1",
      assistantId: "self",
      sessionManager: session,
      config: {
        autoLeaveOnObjection: true,
        objectionKeywords: ["please leave", "stop recording"],
      },
      llmAsk: llm,
      subscribe: dispatcher.subscribe,
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
      now: () => 0,
    });
    monitor.start();

    dispatcher.dispatch(
      "m1",
      inboundChat("m1", "2024-01-01T00:00:00.000Z", "Hey, please leave?"),
    );

    await flushPromises();

    expect(llm).toHaveBeenCalledTimes(1);
    expect(session.leave).toHaveBeenCalledTimes(1);
    const [id, reason] = session.leave.mock.calls[0] as unknown as [
      string,
      string,
    ];
    expect(id).toBe("m1");
    expect(reason).toBe("objection: participant asked the bot to leave");
    expect(monitor._isDecided()).toBe(true);

    monitor.stop();
    expect(timer.cleared).toBe(true);
    expect(dispatcher.subscriberCount("m1")).toBe(0);
  });

  test("keyword hit but LLM says objected=false does NOT trigger leave", async () => {
    const dispatcher = makeFakeDispatcher();
    const session = makeFakeSessionManager();
    const timer = makeTimerControl();
    const llm = mock(
      async (_prompt: string): Promise<ObjectionDecision> => ({
        objected: false,
        reason: "participant was quoting documentation",
      }),
    );

    const monitor = new MeetConsentMonitor({
      meetingId: "m1",
      assistantId: "self",
      sessionManager: session,
      config: {
        autoLeaveOnObjection: true,
        objectionKeywords: ["please leave"],
      },
      llmAsk: llm,
      subscribe: dispatcher.subscribe,
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
      now: () => 0,
    });
    monitor.start();

    dispatcher.dispatch(
      "m1",
      transcriptChunk(
        "m1",
        "2024-01-01T00:00:00.000Z",
        "I'm reading from the docs, 'please leave on error'.",
      ),
    );

    await flushPromises();

    expect(llm).toHaveBeenCalledTimes(1);
    expect(session.leave).toHaveBeenCalledTimes(0);
    expect(monitor._isDecided()).toBe(false);

    monitor.stop();
  });

  test("autoLeaveOnObjection=false records decision but does not leave", async () => {
    const dispatcher = makeFakeDispatcher();
    const session = makeFakeSessionManager();
    const timer = makeTimerControl();
    const llm = mock(
      async (_prompt: string): Promise<ObjectionDecision> => ({
        objected: true,
        reason: "explicit opt-out",
      }),
    );

    const monitor = new MeetConsentMonitor({
      meetingId: "m1",
      assistantId: "self",
      sessionManager: session,
      config: {
        autoLeaveOnObjection: false,
        objectionKeywords: ["no bots"],
      },
      llmAsk: llm,
      subscribe: dispatcher.subscribe,
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
      now: () => 0,
    });
    monitor.start();

    dispatcher.dispatch(
      "m1",
      inboundChat("m1", "2024-01-01T00:00:00.000Z", "no bots please"),
    );

    await flushPromises();

    expect(llm).toHaveBeenCalledTimes(1);
    expect(session.leave).toHaveBeenCalledTimes(0);
    // Decision was recorded — no further LLM calls should happen.
    expect(monitor._isDecided()).toBe(true);

    dispatcher.dispatch(
      "m1",
      inboundChat("m1", "2024-01-01T00:00:10.000Z", "no bots please"),
    );
    await flushPromises();
    expect(llm).toHaveBeenCalledTimes(1);

    monitor.stop();
  });
});

describe("MeetConsentMonitor dedupe", () => {
  test("repeated identical chunks within 5s → LLM called only once", async () => {
    const dispatcher = makeFakeDispatcher();
    const session = makeFakeSessionManager();
    const timer = makeTimerControl();
    let t = 0;
    const now = () => t;
    const llm = mock(
      async (_prompt: string): Promise<ObjectionDecision> => ({
        objected: false,
        reason: "",
      }),
    );

    const monitor = new MeetConsentMonitor({
      meetingId: "m1",
      assistantId: "self",
      sessionManager: session,
      config: {
        autoLeaveOnObjection: true,
        objectionKeywords: ["please leave"],
      },
      llmAsk: llm,
      subscribe: dispatcher.subscribe,
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
      now,
    });
    monitor.start();

    // Three identical chunks within the dedupe window.
    for (let i = 0; i < 3; i++) {
      t = i * 100; // 0ms, 100ms, 200ms
      dispatcher.dispatch(
        "m1",
        transcriptChunk(
          "m1",
          new Date(t).toISOString(),
          "please leave the meeting",
        ),
      );
      await flushPromises();
    }

    // Only the first chunk should have reached the keyword path → one LLM.
    expect(llm).toHaveBeenCalledTimes(1);
    // One transcript entry recorded (the others were deduped).
    expect(monitor._bufferedTranscriptCount()).toBe(1);

    // Past both the dedupe and debounce windows, the same text re-enters
    // the keyword path. We use `LLM_CHECK_DEBOUNCE_MS + 1` — since
    // `LLM_CHECK_DEBOUNCE_MS` is defined to exceed the dedupe window,
    // neither guard short-circuits the second call.
    t = LLM_CHECK_DEBOUNCE_MS + 1;
    dispatcher.dispatch(
      "m1",
      transcriptChunk(
        "m1",
        new Date(t).toISOString(),
        "please leave the meeting",
      ),
    );
    await flushPromises();
    expect(llm).toHaveBeenCalledTimes(2);

    monitor.stop();
  });
});

describe("MeetConsentMonitor timer tick", () => {
  test("tick with buffered content calls LLM with the rolling buffer", async () => {
    const dispatcher = makeFakeDispatcher();
    const session = makeFakeSessionManager();
    const timer = makeTimerControl();
    const llm = mock(
      async (_prompt: string): Promise<ObjectionDecision> => ({
        objected: false,
        reason: "",
      }),
    );

    const monitor = new MeetConsentMonitor({
      meetingId: "m1",
      assistantId: "self",
      sessionManager: session,
      config: {
        autoLeaveOnObjection: true,
        // Phrase that's NOT in the keyword list — only the timer tick path
        // gets a shot at escalating this.
        objectionKeywords: ["please leave"],
      },
      llmAsk: llm,
      subscribe: dispatcher.subscribe,
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
      now: () => 0,
    });
    monitor.start();

    // Timer interval was installed at the expected cadence.
    expect(timer.intervalMs).toBe(LLM_TICK_INTERVAL_MS);

    dispatcher.dispatch(
      "m1",
      transcriptChunk(
        "m1",
        "2024-01-01T00:00:00.000Z",
        "I'm not sure I want this recorded, can we turn it off?",
        { speakerLabel: "Alice" },
      ),
    );

    // No keyword match → no LLM yet.
    await flushPromises();
    expect(llm).toHaveBeenCalledTimes(0);

    // Simulate the 20s timer firing — now the LLM runs against the buffer.
    timer.fire();
    await flushPromises();
    expect(llm).toHaveBeenCalledTimes(1);

    // The prompt contains the speaker-tagged transcript line.
    const prompt = llm.mock.calls[0]![0] as string;
    expect(prompt).toContain("Alice: I'm not sure I want this recorded");

    monitor.stop();
  });

  test("tick with empty buffers does NOT call LLM", async () => {
    const dispatcher = makeFakeDispatcher();
    const session = makeFakeSessionManager();
    const timer = makeTimerControl();
    const llm = mock(
      async (_prompt: string): Promise<ObjectionDecision> => ({
        objected: false,
        reason: "",
      }),
    );

    const monitor = new MeetConsentMonitor({
      meetingId: "m1",
      assistantId: "self",
      sessionManager: session,
      config: {
        autoLeaveOnObjection: true,
        objectionKeywords: ["please leave"],
      },
      llmAsk: llm,
      subscribe: dispatcher.subscribe,
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
      now: () => 0,
    });
    monitor.start();

    timer.fire();
    await flushPromises();
    expect(llm).toHaveBeenCalledTimes(0);

    monitor.stop();
  });
});

describe("MeetConsentMonitor content-watermark tick skip", () => {
  test("silent meeting after one early chunk: only the first tick fires LLM", async () => {
    const dispatcher = makeFakeDispatcher();
    const session = makeFakeSessionManager();
    const timer = makeTimerControl();
    let t = 0;
    const llm = mock(
      async (_prompt: string): Promise<ObjectionDecision> => ({
        objected: false,
        reason: "",
      }),
    );

    const monitor = new MeetConsentMonitor({
      meetingId: "m1",
      assistantId: "self",
      sessionManager: session,
      config: {
        autoLeaveOnObjection: true,
        // Phrase that won't keyword-match — only the tick can escalate.
        objectionKeywords: ["please leave"],
      },
      llmAsk: llm,
      subscribe: dispatcher.subscribe,
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
      now: () => t,
    });
    monitor.start();

    // Content arrives once before any timer fires.
    t = 1_000;
    dispatcher.dispatch(
      "m1",
      transcriptChunk(
        "m1",
        "2024-01-01T00:00:01.000Z",
        "morning everyone, lets get started",
        { speakerLabel: "Alice", speakerId: "alice" },
      ),
    );
    await flushPromises();
    expect(llm).toHaveBeenCalledTimes(0);

    // Tick #1: content advanced since the (null) watermark → fires.
    t = 20_000;
    timer.fire();
    await flushPromises();
    expect(llm).toHaveBeenCalledTimes(1);

    // Tick #2: silent stretch — content watermark unchanged → skipped.
    t = 40_000;
    timer.fire();
    await flushPromises();
    expect(llm).toHaveBeenCalledTimes(1);

    // Tick #3: still silent — still skipped.
    t = 60_000;
    timer.fire();
    await flushPromises();
    expect(llm).toHaveBeenCalledTimes(1);

    monitor.stop();
  });

  test("active meeting with new content every tick: every tick fires LLM", async () => {
    const dispatcher = makeFakeDispatcher();
    const session = makeFakeSessionManager();
    const timer = makeTimerControl();
    let t = 0;
    const llm = mock(
      async (_prompt: string): Promise<ObjectionDecision> => ({
        objected: false,
        reason: "",
      }),
    );

    const monitor = new MeetConsentMonitor({
      meetingId: "m1",
      assistantId: "self",
      sessionManager: session,
      config: {
        autoLeaveOnObjection: true,
        // No keyword match — exercise only the tick path.
        objectionKeywords: ["please leave"],
      },
      llmAsk: llm,
      subscribe: dispatcher.subscribe,
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
      now: () => t,
    });
    monitor.start();

    // Three ticks, each preceded by a fresh transcript chunk ~10s in.
    for (let tickIndex = 1; tickIndex <= 3; tickIndex++) {
      t = (tickIndex - 1) * 20_000 + 10_000;
      dispatcher.dispatch(
        "m1",
        transcriptChunk(
          "m1",
          new Date(t).toISOString(),
          `something interesting ${tickIndex}`,
          { speakerLabel: "Alice", speakerId: "alice" },
        ),
      );
      await flushPromises();

      t = tickIndex * 20_000;
      timer.fire();
      await flushPromises();

      expect(llm).toHaveBeenCalledTimes(tickIndex);
    }

    monitor.stop();
  });

  test("participant join: next tick fires LLM even if joiner has not spoken", async () => {
    const dispatcher = makeFakeDispatcher();
    const session = makeFakeSessionManager();
    const timer = makeTimerControl();
    let t = 0;
    const llm = mock(
      async (_prompt: string): Promise<ObjectionDecision> => ({
        objected: false,
        reason: "",
      }),
    );

    const monitor = new MeetConsentMonitor({
      meetingId: "m1",
      assistantId: "self",
      sessionManager: session,
      config: {
        autoLeaveOnObjection: true,
        objectionKeywords: ["please leave"],
      },
      llmAsk: llm,
      subscribe: dispatcher.subscribe,
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
      now: () => t,
    });
    monitor.start();

    // Seed prior content + tick so the watermark catches up.
    t = 1_000;
    dispatcher.dispatch(
      "m1",
      transcriptChunk("m1", "2024-01-01T00:00:01.000Z", "kicking things off", {
        speakerLabel: "Alice",
        speakerId: "alice",
      }),
    );
    await flushPromises();

    t = 20_000;
    timer.fire();
    await flushPromises();
    expect(llm).toHaveBeenCalledTimes(1);

    // Next tick with no new content would normally be skipped …
    t = 40_000;
    timer.fire();
    await flushPromises();
    expect(llm).toHaveBeenCalledTimes(1);

    // … but a participant joining advances the watermark even though
    // they haven't said anything yet.
    t = 50_000;
    dispatcher.dispatch(
      "m1",
      participantChange("m1", "2024-01-01T00:00:50.000Z", [
        { id: "bob", name: "Bob" },
      ]),
    );
    await flushPromises();

    t = 60_000;
    timer.fire();
    await flushPromises();
    expect(llm).toHaveBeenCalledTimes(2);

    monitor.stop();
  });

  test("regression: keyword-fired LLM call advances watermark so next tick on same content is a no-op", async () => {
    const dispatcher = makeFakeDispatcher();
    const session = makeFakeSessionManager();
    const timer = makeTimerControl();
    let t = 0;
    const llm = mock(
      async (_prompt: string): Promise<ObjectionDecision> => ({
        objected: false,
        reason: "",
      }),
    );

    const monitor = new MeetConsentMonitor({
      meetingId: "m1",
      assistantId: "self",
      sessionManager: session,
      config: {
        autoLeaveOnObjection: true,
        objectionKeywords: ["please leave"],
      },
      llmAsk: llm,
      subscribe: dispatcher.subscribe,
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
      now: () => t,
    });
    monitor.start();

    // First keyword hit: fires LLM (1) and advances the content watermark.
    t = 1_000;
    dispatcher.dispatch(
      "m1",
      inboundChat(
        "m1",
        "2024-01-01T00:00:01.000Z",
        "actually please leave the call",
      ),
    );
    await flushPromises();
    expect(llm).toHaveBeenCalledTimes(1);

    // Tick after the keyword path runs: keyword call already advanced the
    // watermark to the same lastContentTimestamp, so the tick sees no new
    // content and skips. This avoids the redundant keyword+tick double-fire
    // on identical content.
    t = 20_000;
    timer.fire();
    await flushPromises();
    expect(llm).toHaveBeenCalledTimes(1);

    // Still no new content. Next tick is also skipped.
    t = 40_000;
    timer.fire();
    await flushPromises();
    expect(llm).toHaveBeenCalledTimes(1);

    // A second keyword hit (different text so dedupe doesn't swallow it)
    // ALWAYS fires the LLM regardless of the watermark — keyword path only
    // consults the debounce, not the watermark. The 44s gap is past 8s
    // debounce so this call fires.
    t = 45_000;
    dispatcher.dispatch(
      "m1",
      inboundChat(
        "m1",
        "2024-01-01T00:00:45.000Z",
        "really, please leave now",
        "Bob",
        "b",
      ),
    );
    await flushPromises();
    expect(llm).toHaveBeenCalledTimes(2);

    monitor.stop();
  });
});

describe("MeetConsentMonitor prompt content", () => {
  test("includes last 5 chat messages and speaker-tagged transcript", async () => {
    const dispatcher = makeFakeDispatcher();
    const session = makeFakeSessionManager();
    const timer = makeTimerControl();
    const llm = mock(
      async (_prompt: string): Promise<ObjectionDecision> => ({
        objected: false,
        reason: "",
      }),
    );

    const monitor = new MeetConsentMonitor({
      meetingId: "m1",
      assistantId: "self",
      sessionManager: session,
      config: {
        autoLeaveOnObjection: true,
        objectionKeywords: ["KEYWORD"],
      },
      llmAsk: llm,
      subscribe: dispatcher.subscribe,
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
      now: () => 0,
    });
    monitor.start();

    // Seed more than 5 chat messages — buffer should retain only the last 5.
    for (let i = 0; i < 7; i++) {
      dispatcher.dispatch(
        "m1",
        inboundChat(
          "m1",
          new Date(i * 1000).toISOString(),
          `chat-${i}`,
          `User${i}`,
          `u${i}`,
        ),
      );
    }
    // Seed transcript.
    dispatcher.dispatch(
      "m1",
      transcriptChunk("m1", "2024-01-01T00:00:10.000Z", "hello there", {
        speakerLabel: "Alice",
      }),
    );
    // Trip the keyword path to force an LLM run on content we can inspect.
    dispatcher.dispatch(
      "m1",
      transcriptChunk("m1", "2024-01-01T00:00:11.000Z", "KEYWORD is set", {
        speakerLabel: "Alice",
      }),
    );
    await flushPromises();

    expect(llm).toHaveBeenCalledTimes(1);
    const prompt = llm.mock.calls[0]![0] as string;

    // Earliest 2 chats dropped; last 5 retained.
    expect(prompt).not.toContain("chat-0");
    expect(prompt).not.toContain("chat-1");
    expect(prompt).toContain("User2: chat-2");
    expect(prompt).toContain("User6: chat-6");

    // Transcript is speaker-tagged.
    expect(prompt).toContain("Alice: hello there");
    expect(prompt).toContain("Alice: KEYWORD is set");

    // Prompt declares the strict-JSON contract.
    expect(prompt).toContain("strictly JSON");

    monitor.stop();
  });
});

describe("MeetConsentMonitor resilience", () => {
  test("LLM errors do not throw through event dispatch, and do not burn the debounce window", async () => {
    const dispatcher = makeFakeDispatcher();
    const session = makeFakeSessionManager();
    const timer = makeTimerControl();
    let t = 0;
    let failNextCall = true;
    const llm = mock(async (_prompt: string): Promise<ObjectionDecision> => {
      if (failNextCall) {
        failNextCall = false;
        throw new Error("llm exploded");
      }
      return { objected: false, reason: "" };
    });

    const monitor = new MeetConsentMonitor({
      meetingId: "m1",
      assistantId: "self",
      sessionManager: session,
      config: {
        autoLeaveOnObjection: true,
        objectionKeywords: ["please leave"],
      },
      llmAsk: llm,
      subscribe: dispatcher.subscribe,
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
      now: () => t,
    });
    monitor.start();

    // First keyword hit — LLM throws, should not reject or crash the test.
    t = 0;
    dispatcher.dispatch(
      "m1",
      inboundChat("m1", "2024-01-01T00:00:00.000Z", "please leave now"),
    );
    await flushPromises();

    expect(llm).toHaveBeenCalledTimes(1);
    expect(session.leave).toHaveBeenCalledTimes(0);
    // Monitor remains active and can try again on the next trigger.
    expect(monitor._isDecided()).toBe(false);

    // Next keyword hit arrives well within the 8s debounce window. Because
    // the LLM failed, `lastLlmCheckAt` was restored — so this trigger must
    // fire a new LLM call immediately, not be silently suppressed by the
    // debounce.
    t = 500;
    dispatcher.dispatch(
      "m1",
      inboundChat(
        "m1",
        "2024-01-01T00:00:00.500Z",
        "please leave already",
        "Bob",
        "b",
      ),
    );
    await flushPromises();
    expect(llm).toHaveBeenCalledTimes(2);

    monitor.stop();
  });

  test("start() is idempotent; stop() is idempotent", () => {
    const dispatcher = makeFakeDispatcher();
    const session = makeFakeSessionManager();
    const timer = makeTimerControl();
    const monitor = new MeetConsentMonitor({
      meetingId: "m1",
      assistantId: "self",
      sessionManager: session,
      config: {
        autoLeaveOnObjection: true,
        objectionKeywords: [],
      },
      llmAsk: async () => ({ objected: false, reason: "" }),
      subscribe: dispatcher.subscribe,
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
      now: () => 0,
    });
    monitor.start();
    monitor.start();
    expect(dispatcher.subscriberCount("m1")).toBe(1);

    monitor.stop();
    monitor.stop();
    expect(dispatcher.subscriberCount("m1")).toBe(0);
  });

  test("interim transcript chunks are ignored", async () => {
    const dispatcher = makeFakeDispatcher();
    const session = makeFakeSessionManager();
    const timer = makeTimerControl();
    const llm = mock(
      async (_prompt: string): Promise<ObjectionDecision> => ({
        objected: true,
        reason: "r",
      }),
    );

    const monitor = new MeetConsentMonitor({
      meetingId: "m1",
      assistantId: "self",
      sessionManager: session,
      config: {
        autoLeaveOnObjection: true,
        objectionKeywords: ["please leave"],
      },
      llmAsk: llm,
      subscribe: dispatcher.subscribe,
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
      now: () => 0,
    });
    monitor.start();

    dispatcher.dispatch(
      "m1",
      transcriptChunk("m1", "2024-01-01T00:00:00.000Z", "please leave now", {
        isFinal: false,
      }),
    );
    await flushPromises();

    // Interim finals don't reach the LLM.
    expect(llm).toHaveBeenCalledTimes(0);

    monitor.stop();
  });

  test("overlapping keyword hits collapse to a single in-flight LLM call", async () => {
    const dispatcher = makeFakeDispatcher();
    const session = makeFakeSessionManager();
    const timer = makeTimerControl();
    let resolveFirst: (v: ObjectionDecision) => void = () => {};
    const firstPromise = new Promise<ObjectionDecision>((resolve) => {
      resolveFirst = resolve;
    });
    let callCount = 0;
    const llm = mock(async (_prompt: string): Promise<ObjectionDecision> => {
      callCount += 1;
      if (callCount === 1) return firstPromise;
      return { objected: false, reason: "" };
    });

    const monitor = new MeetConsentMonitor({
      meetingId: "m1",
      assistantId: "self",
      sessionManager: session,
      config: {
        autoLeaveOnObjection: true,
        objectionKeywords: ["please leave"],
      },
      llmAsk: llm,
      subscribe: dispatcher.subscribe,
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
      now: () => 0,
    });
    monitor.start();

    // Two distinct keyword-hit events while the first LLM call is pending.
    dispatcher.dispatch(
      "m1",
      inboundChat("m1", "2024-01-01T00:00:00.000Z", "please leave first"),
    );
    dispatcher.dispatch(
      "m1",
      inboundChat("m1", "2024-01-01T00:00:01.000Z", "please leave second"),
    );
    await flushPromises();

    // Only the first call was issued; the second collapsed because one was
    // already in flight.
    expect(llm).toHaveBeenCalledTimes(1);

    resolveFirst({ objected: false, reason: "" });
    await flushPromises();

    monitor.stop();
  });
});

describe("MeetConsentMonitor LLM check debounce", () => {
  test("three fast-check hits in rapid succession collapse to a single LLM call", async () => {
    // Models the worst-case fast-keyword spam scenario: a participant
    // (or several) saying "please leave" three times in a few seconds. The
    // debounce should reduce those three keyword hits to one LLM call.
    const dispatcher = makeFakeDispatcher();
    const session = makeFakeSessionManager();
    const timer = makeTimerControl();
    let t = 0;
    const llm = mock(
      async (_prompt: string): Promise<ObjectionDecision> => ({
        objected: false,
        reason: "",
      }),
    );

    const monitor = new MeetConsentMonitor({
      meetingId: "m1",
      assistantId: "self",
      sessionManager: session,
      config: {
        autoLeaveOnObjection: true,
        objectionKeywords: ["please leave"],
      },
      llmAsk: llm,
      subscribe: dispatcher.subscribe,
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
      now: () => t,
    });
    monitor.start();

    // First keyword hit at t=0 — fires LLM.
    t = 0;
    dispatcher.dispatch(
      "m1",
      inboundChat("m1", "2024-01-01T00:00:00.000Z", "please leave first"),
    );
    await flushPromises();
    expect(llm).toHaveBeenCalledTimes(1);

    // Second keyword hit at t=3s — within 8s debounce window, skipped.
    t = 3_000;
    dispatcher.dispatch(
      "m1",
      inboundChat(
        "m1",
        "2024-01-01T00:00:03.000Z",
        "please leave second",
        "Bob",
        "b",
      ),
    );
    await flushPromises();
    expect(llm).toHaveBeenCalledTimes(1);

    // Third keyword hit at t=9s — past 8s debounce window, fires LLM.
    t = 9_000;
    dispatcher.dispatch(
      "m1",
      inboundChat(
        "m1",
        "2024-01-01T00:00:09.000Z",
        "please leave third",
        "Carol",
        "c",
      ),
    );
    await flushPromises();
    expect(llm).toHaveBeenCalledTimes(2);

    monitor.stop();
  });

  test("three distinct objections within 3 seconds → exactly one LLM call", async () => {
    // Plan PR 3 acceptance criterion, verbatim: "A fixture where a
    // participant says 'please leave' three times in three seconds
    // produces exactly one LLM call." Uses three DIFFERENT phrases so the
    // 5s dedupe ledger doesn't swallow the later two — this must exercise
    // the debounce path, not the dedupe path.
    const dispatcher = makeFakeDispatcher();
    const session = makeFakeSessionManager();
    const timer = makeTimerControl();
    let t = 0;
    const llm = mock(
      async (_prompt: string): Promise<ObjectionDecision> => ({
        objected: false,
        reason: "",
      }),
    );

    const monitor = new MeetConsentMonitor({
      meetingId: "m1",
      assistantId: "self",
      sessionManager: session,
      config: {
        autoLeaveOnObjection: true,
        objectionKeywords: ["please leave", "stop recording", "no bots"],
      },
      llmAsk: llm,
      subscribe: dispatcher.subscribe,
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
      now: () => t,
    });
    monitor.start();

    // Hit #1 at t=0: fires LLM.
    t = 0;
    dispatcher.dispatch(
      "m1",
      inboundChat("m1", "2024-01-01T00:00:00.000Z", "please leave"),
    );
    await flushPromises();
    expect(llm).toHaveBeenCalledTimes(1);

    // Hit #2 at t=1s: within 8s debounce, skipped.
    t = 1_000;
    dispatcher.dispatch(
      "m1",
      inboundChat(
        "m1",
        "2024-01-01T00:00:01.000Z",
        "stop recording",
        "Bob",
        "b",
      ),
    );
    await flushPromises();
    expect(llm).toHaveBeenCalledTimes(1);

    // Hit #3 at t=2s: still within 8s debounce, skipped.
    t = 2_000;
    dispatcher.dispatch(
      "m1",
      inboundChat("m1", "2024-01-01T00:00:02.000Z", "no bots", "Carol", "c"),
    );
    await flushPromises();
    expect(llm).toHaveBeenCalledTimes(1);

    monitor.stop();
  });

  test("timer tick + fast-check hit within 100ms collapse to a single LLM call", async () => {
    // Either trigger can win the debounce race depending on event order;
    // whichever lands first locks out the other for the debounce window.
    const dispatcher = makeFakeDispatcher();
    const session = makeFakeSessionManager();
    const timer = makeTimerControl();
    let t = 0;
    const llm = mock(
      async (_prompt: string): Promise<ObjectionDecision> => ({
        objected: false,
        reason: "",
      }),
    );

    const monitor = new MeetConsentMonitor({
      meetingId: "m1",
      assistantId: "self",
      sessionManager: session,
      config: {
        autoLeaveOnObjection: true,
        objectionKeywords: ["please leave"],
      },
      llmAsk: llm,
      subscribe: dispatcher.subscribe,
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
      now: () => t,
    });
    monitor.start();

    // Seed a non-keyword chunk so the tick has buffer content to work with
    // (otherwise the empty-buffer guard would short-circuit the tick).
    t = 19_900;
    dispatcher.dispatch(
      "m1",
      transcriptChunk(
        "m1",
        "2024-01-01T00:00:19.900Z",
        "we're discussing the roadmap",
        { speakerLabel: "Alice", speakerId: "alice" },
      ),
    );
    await flushPromises();
    expect(llm).toHaveBeenCalledTimes(0);

    // Tick fires first at t=20s (LLM call #1).
    t = 20_000;
    timer.fire();
    await flushPromises();
    expect(llm).toHaveBeenCalledTimes(1);

    // 50ms later a keyword-matching chat arrives — within 8s debounce, skipped.
    t = 20_050;
    dispatcher.dispatch(
      "m1",
      inboundChat(
        "m1",
        "2024-01-01T00:00:20.050Z",
        "please leave the meeting",
        "Bob",
        "b",
      ),
    );
    await flushPromises();
    expect(llm).toHaveBeenCalledTimes(1);

    monitor.stop();
  });

  test("regression: after objection-decided + leave, additional fast-checks produce no LLM activity", async () => {
    // The "already decided to leave" guard short-circuits before the
    // debounce, so a second keyword hit after leave was triggered must
    // not produce any additional LLM call regardless of how much time
    // has elapsed.
    const dispatcher = makeFakeDispatcher();
    const session = makeFakeSessionManager();
    const timer = makeTimerControl();
    let t = 0;
    const llm = mock(
      async (_prompt: string): Promise<ObjectionDecision> => ({
        objected: true,
        reason: "explicit ask to leave",
      }),
    );

    const monitor = new MeetConsentMonitor({
      meetingId: "m1",
      assistantId: "self",
      sessionManager: session,
      config: {
        autoLeaveOnObjection: true,
        objectionKeywords: ["please leave"],
      },
      llmAsk: llm,
      subscribe: dispatcher.subscribe,
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
      now: () => t,
    });
    monitor.start();

    // First keyword hit at t=0 — fires LLM, decision is objected=true,
    // session.leave invoked.
    t = 0;
    dispatcher.dispatch(
      "m1",
      inboundChat("m1", "2024-01-01T00:00:00.000Z", "please leave now"),
    );
    await flushPromises();
    expect(llm).toHaveBeenCalledTimes(1);
    expect(session.leave).toHaveBeenCalledTimes(1);
    expect(monitor._isDecided()).toBe(true);

    // Second keyword hit well past the debounce window — must NOT fire
    // an additional LLM call because `decided` short-circuits first.
    t = LLM_CHECK_DEBOUNCE_MS + 5_000;
    dispatcher.dispatch(
      "m1",
      inboundChat(
        "m1",
        "2024-01-01T00:00:13.000Z",
        "please leave again",
        "Bob",
        "b",
      ),
    );
    await flushPromises();
    expect(llm).toHaveBeenCalledTimes(1);
    expect(session.leave).toHaveBeenCalledTimes(1);

    monitor.stop();
  });
});

describe("MeetConsentMonitor long-meeting scenario", () => {
  test("10-minute silent meeting with objection at minute 5: objection detected, leave fired, LLM call volume bounded", async () => {
    // Pins plan PR 2 acceptance criteria end-to-end:
    //   - "In a mock meeting with 10 minutes of silence, fewer than 2 LLM
    //     calls fire" — the silent stretch produces exactly 1 LLM call
    //     (the first tick) because the content watermark skips every
    //     subsequent tick.
    //   - "Objection at minute 5 still detected and fires leave within 30
    //     seconds" — a keyword-matching transcript at ~minute 5 fires the
    //     LLM fast-path immediately and invokes session.leave with the
    //     objection reason.
    const dispatcher = makeFakeDispatcher();
    const session = makeFakeSessionManager();
    const timer = makeTimerControl();
    let t = 0;
    // Script the LLM: until the objection arrives, answer "no objection".
    // Once the objection prompt is received, answer "objected: true".
    let sawObjection = false;
    const llm = mock(async (prompt: string): Promise<ObjectionDecision> => {
      if (prompt.includes("please leave")) {
        sawObjection = true;
        return {
          objected: true,
          reason: "participant asked the note-taker to leave",
        };
      }
      return { objected: false, reason: "" };
    });

    const monitor = new MeetConsentMonitor({
      meetingId: "m1",
      assistantId: "self",
      sessionManager: session,
      config: {
        autoLeaveOnObjection: true,
        objectionKeywords: ["please leave"],
      },
      llmAsk: llm,
      subscribe: dispatcher.subscribe,
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
      now: () => t,
    });
    monitor.start();

    // Seed a single non-bot transcript at t=0 so `lastContentTimestamp`
    // is populated — without this the very first tick is skipped by the
    // empty-buffer guard.
    t = 0;
    dispatcher.dispatch(
      "m1",
      transcriptChunk(
        "m1",
        "2024-01-01T00:00:00.000Z",
        "hey folks, kicking things off",
        { speakerLabel: "Alice", speakerId: "alice" },
      ),
    );
    await flushPromises();
    expect(llm).toHaveBeenCalledTimes(0);

    // Fire 30 ticks at 20s intervals = 600s = 10 min. At tick 15 (t=300s,
    // i.e. minute 5) the objection arrives just before the tick fires.
    let leaveCheckpoint: number | null = null;
    const OBJECTION_TICK = 15;
    for (let tickIndex = 1; tickIndex <= 30; tickIndex++) {
      // At minute 5 (just before tick 15), emit the objection.
      if (tickIndex === OBJECTION_TICK) {
        t = tickIndex * 20_000 - 1_000; // t = 299s
        dispatcher.dispatch(
          "m1",
          transcriptChunk(
            "m1",
            new Date(t).toISOString(),
            "please leave, this is private",
            { speakerLabel: "Bob", speakerId: "bob" },
          ),
        );
        await flushPromises();
        leaveCheckpoint = t;
      }

      t = tickIndex * 20_000;
      timer.fire();
      await flushPromises();
    }

    // Silent meeting bound: tick #1 fires LLM once; every subsequent
    // silent tick is skipped by the watermark. Adding the single
    // objection-fired LLM call brings the total to exactly 2.
    expect(llm).toHaveBeenCalledTimes(2);
    expect(sawObjection).toBe(true);

    // Objection detected and acted on.
    expect(session.leave).toHaveBeenCalledTimes(1);
    const [leaveId, leaveReason] = session.leave.mock.calls[0] as unknown as [
      string,
      string,
    ];
    expect(leaveId).toBe("m1");
    expect(leaveReason).toBe(
      "objection: participant asked the note-taker to leave",
    );
    expect(monitor._isDecided()).toBe(true);

    // Leave fired in the same virtual second as the objection —
    // comfortably under the 30s correctness invariant from the plan.
    expect(leaveCheckpoint).not.toBeNull();

    monitor.stop();
  });
});
