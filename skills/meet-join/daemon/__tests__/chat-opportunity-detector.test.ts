/**
 * Unit tests for {@link MeetChatOpportunityDetector}.
 *
 * These tests inject a fake dispatcher (recording subscribers by meeting),
 * a scripted Tier 2 LLM callable, and a controllable clock so every
 * scenario is deterministic. Real provider abstractions are never
 * constructed.
 */

import { describe, expect, mock, test } from "bun:test";

import type { MeetBotEvent } from "../../contracts/index.js";

import {
  type ChatOpportunityDecision,
  type ChatOpportunityEvent,
  MeetChatOpportunityDetector,
  type ProactiveChatConfig,
  type TimerHandle,
  type VoiceModeConfig,
} from "../chat-opportunity-detector.js";
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

function makeClock(initial: number): {
  now: () => number;
  advance: (ms: number) => void;
  set: (value: number) => void;
} {
  let t = initial;
  return {
    now: () => t,
    advance(ms) {
      t += ms;
    },
    set(value) {
      t = value;
    },
  };
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
  joined: { id: string; name: string; isSelf?: boolean }[],
  left: { id: string; name: string }[] = [],
): MeetBotEvent {
  return {
    type: "participant.change",
    meetingId,
    timestamp,
    joined,
    left,
  };
}

function defaultConfig(
  overrides: Partial<ProactiveChatConfig> = {},
): ProactiveChatConfig {
  return {
    enabled: true,
    detectorKeywords: [
      "\\b(can|could|would|will)\\s+you\\b",
      "\\bcan\\s+(anyone|someone)\\b",
      "\\bdoes\\s+(anyone|someone)\\s+know\\b",
      "\\banyone\\s+(have|know)\\b",
    ],
    tier2DebounceMs: 5_000,
    escalationCooldownSec: 30,
    tier2MaxTranscriptSec: 30,
    ...overrides,
  };
}

function defaultVoiceConfig(
  overrides: Partial<VoiceModeConfig> = {},
): VoiceModeConfig {
  return {
    enabled: true,
    eouDebounceMs: 800,
    ...overrides,
  };
}

/**
 * Manual timer driver for voice-mode EOU tests. Tests register
 * scheduled callbacks via `setTimer` and can fire them deterministically
 * with `fireAll()` or cancel via `clearTimer`.
 */
function makeManualTimers(): {
  setTimer: (cb: () => void, ms: number) => TimerHandle;
  clearTimer: (handle: TimerHandle) => void;
  fireAll: () => void;
  pendingCount: () => number;
} {
  interface Entry {
    id: number;
    cb: () => void;
    ms: number;
    cancelled: boolean;
  }
  const pending = new Map<number, Entry>();
  let nextId = 1;
  return {
    setTimer(cb, ms) {
      const id = nextId++;
      pending.set(id, { id, cb, ms, cancelled: false });
      return id;
    },
    clearTimer(handle) {
      const entry = pending.get(handle as number);
      if (entry) entry.cancelled = true;
      pending.delete(handle as number);
    },
    fireAll() {
      for (const entry of Array.from(pending.values())) {
        pending.delete(entry.id);
        if (!entry.cancelled) entry.cb();
      }
    },
    pendingCount() {
      return pending.size;
    },
  };
}

async function flushPromises(): Promise<void> {
  for (let i = 0; i < 3; i++) await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MeetChatOpportunityDetector — Tier 1 fast filter", () => {
  test("transcript Tier 1 miss does not invoke Tier 2 and does not fire callback", async () => {
    const dispatcher = makeFakeDispatcher();
    const clock = makeClock(1_000);
    const llm = mock(
      async (_prompt: string): Promise<ChatOpportunityDecision> => ({
        shouldRespond: true,
        reason: "should not be called",
      }),
    );
    const onOpportunity = mock((_event: ChatOpportunityEvent) => {});

    const detector = new MeetChatOpportunityDetector({
      meetingId: "m1",
      assistantDisplayName: "Aria",
      config: defaultConfig(),
      voiceConfig: defaultVoiceConfig(),
      callDetectorLLM: llm,
      onOpportunity,
      subscribe: dispatcher.subscribe,
      now: clock.now,
    });
    detector.start();

    dispatcher.dispatch(
      "m1",
      transcriptChunk(
        "m1",
        "2024-01-01T00:00:00.000Z",
        "The weather is nice today.",
      ),
    );

    await flushPromises();

    expect(llm).toHaveBeenCalledTimes(0);
    expect(onOpportunity).toHaveBeenCalledTimes(0);
    expect(detector.getStats().tier1Hits).toBe(0);

    detector.dispose();
    expect(dispatcher.subscriberCount("m1")).toBe(0);
  });

  test("inbound chat always invokes Tier 2 regardless of Tier 1 content", async () => {
    const dispatcher = makeFakeDispatcher();
    const clock = makeClock(1_000);
    const llm = mock(
      async (_prompt: string): Promise<ChatOpportunityDecision> => ({
        shouldRespond: true,
        reason: "user addressed the assistant without a keyword",
      }),
    );
    const onOpportunity = mock((_event: ChatOpportunityEvent) => {});

    const detector = new MeetChatOpportunityDetector({
      meetingId: "m1",
      assistantDisplayName: "Aria",
      config: defaultConfig(),
      voiceConfig: defaultVoiceConfig(),
      callDetectorLLM: llm,
      onOpportunity,
      subscribe: dispatcher.subscribe,
      now: clock.now,
    });
    detector.start();

    // Plain "hello team" does NOT match any Tier 1 regex (no assistant
    // name, no `can you`, no `does anyone`). Before the chat-bypass
    // change this test would have asserted zero Tier 2 calls; post-
    // change the detector sends every inbound chat straight to Tier 2.
    dispatcher.dispatch(
      "m1",
      inboundChat("m1", "2024-01-01T00:00:00.000Z", "hello team"),
    );

    await flushPromises();

    expect(llm).toHaveBeenCalledTimes(1);
    expect(onOpportunity).toHaveBeenCalledTimes(1);
    const [{ reason }] = onOpportunity.mock.calls[0] as unknown as [
      ChatOpportunityEvent,
    ];
    expect(reason).toBe("user addressed the assistant without a keyword");

    const stats = detector.getStats();
    expect(stats.tier1Hits).toBe(1);
    expect(stats.tier2Calls).toBe(1);
    expect(stats.tier2PositiveCount).toBe(1);
    expect(stats.escalationsFired).toBe(1);

    // The Tier 2 prompt should carry the synthetic bypass reason so
    // operators grepping `tier1:*` in logs still see the trigger.
    const [prompt] = llm.mock.calls[0] as unknown as [string];
    expect(prompt).toContain("tier1:chat-always-on");

    detector.dispose();
  });

  test("Tier 1 hit + Tier 2 false does not fire callback", async () => {
    const dispatcher = makeFakeDispatcher();
    const clock = makeClock(1_000);
    const llm = mock(
      async (_prompt: string): Promise<ChatOpportunityDecision> => ({
        shouldRespond: false,
        reason: "user was talking to another human",
      }),
    );
    const onOpportunity = mock((_event: ChatOpportunityEvent) => {});

    const detector = new MeetChatOpportunityDetector({
      meetingId: "m1",
      assistantDisplayName: "Aria",
      config: defaultConfig(),
      voiceConfig: defaultVoiceConfig(),
      callDetectorLLM: llm,
      onOpportunity,
      subscribe: dispatcher.subscribe,
      now: clock.now,
    });
    detector.start();

    dispatcher.dispatch(
      "m1",
      transcriptChunk(
        "m1",
        "2024-01-01T00:00:00.000Z",
        "Hey Alice, can you send the deck?",
      ),
    );

    await flushPromises();

    expect(llm).toHaveBeenCalledTimes(1);
    expect(onOpportunity).toHaveBeenCalledTimes(0);

    const stats = detector.getStats();
    expect(stats.tier1Hits).toBe(1);
    expect(stats.tier2Calls).toBe(1);
    expect(stats.tier2PositiveCount).toBe(0);
    expect(stats.escalationsFired).toBe(0);

    detector.dispose();
  });

  test("Tier 1 hit + Tier 2 true fires callback with decision reason", async () => {
    const dispatcher = makeFakeDispatcher();
    const clock = makeClock(1_000);
    const llm = mock(
      async (_prompt: string): Promise<ChatOpportunityDecision> => ({
        shouldRespond: true,
        reason: "team is asking for a spec link the assistant can provide",
      }),
    );
    const onOpportunity = mock((_event: ChatOpportunityEvent) => {});

    const detector = new MeetChatOpportunityDetector({
      meetingId: "m1",
      assistantDisplayName: "Aria",
      config: defaultConfig(),
      voiceConfig: defaultVoiceConfig(),
      callDetectorLLM: llm,
      onOpportunity,
      subscribe: dispatcher.subscribe,
      now: clock.now,
    });
    detector.start();

    dispatcher.dispatch(
      "m1",
      inboundChat(
        "m1",
        "2024-01-01T00:00:00.000Z",
        "Does anyone know where the design doc lives?",
      ),
    );

    await flushPromises();

    expect(llm).toHaveBeenCalledTimes(1);
    expect(onOpportunity).toHaveBeenCalledTimes(1);
    const [{ reason }] = onOpportunity.mock.calls[0] as unknown as [
      ChatOpportunityEvent,
    ];
    expect(reason).toBe(
      "team is asking for a spec link the assistant can provide",
    );

    const stats = detector.getStats();
    expect(stats.tier1Hits).toBe(1);
    expect(stats.tier2Calls).toBe(1);
    expect(stats.tier2PositiveCount).toBe(1);
    expect(stats.escalationsFired).toBe(1);
    expect(stats.escalationsSuppressed).toBe(0);

    detector.dispose();
  });

  test("direct assistant name mention triggers Tier 1", async () => {
    const dispatcher = makeFakeDispatcher();
    const clock = makeClock(1_000);
    const llm = mock(
      async (_prompt: string): Promise<ChatOpportunityDecision> => ({
        shouldRespond: true,
        reason: "assistant was directly addressed",
      }),
    );
    const onOpportunity = mock((_event: ChatOpportunityEvent) => {});

    const detector = new MeetChatOpportunityDetector({
      meetingId: "m1",
      assistantDisplayName: "Aria",
      config: defaultConfig(),
      voiceConfig: defaultVoiceConfig(),
      callDetectorLLM: llm,
      onOpportunity,
      subscribe: dispatcher.subscribe,
      now: clock.now,
    });
    detector.start();

    dispatcher.dispatch(
      "m1",
      transcriptChunk(
        "m1",
        "2024-01-01T00:00:00.000Z",
        "I was chatting with Aria earlier.",
      ),
    );

    await flushPromises();

    expect(detector.getStats().tier1Hits).toBe(1);
    expect(llm).toHaveBeenCalledTimes(1);
    detector.dispose();
  });
});

describe("MeetChatOpportunityDetector — debounce + cooldown", () => {
  test("two Tier 1 hits within debounce window produce only one Tier 2 call", async () => {
    const dispatcher = makeFakeDispatcher();
    const clock = makeClock(1_000);
    const llm = mock(
      async (_prompt: string): Promise<ChatOpportunityDecision> => ({
        shouldRespond: false,
        reason: "not applicable",
      }),
    );
    const onOpportunity = mock((_event: ChatOpportunityEvent) => {});

    const detector = new MeetChatOpportunityDetector({
      meetingId: "m1",
      assistantDisplayName: "Aria",
      config: defaultConfig({ tier2DebounceMs: 5_000 }),
      voiceConfig: defaultVoiceConfig(),
      callDetectorLLM: llm,
      onOpportunity,
      subscribe: dispatcher.subscribe,
      now: clock.now,
    });
    detector.start();

    dispatcher.dispatch(
      "m1",
      transcriptChunk(
        "m1",
        "2024-01-01T00:00:00.000Z",
        "Can you send the deck?",
      ),
    );
    await flushPromises();

    clock.advance(1_000);
    dispatcher.dispatch(
      "m1",
      transcriptChunk(
        "m1",
        "2024-01-01T00:00:01.000Z",
        "Could you share the link?",
      ),
    );
    await flushPromises();

    expect(llm).toHaveBeenCalledTimes(1);
    const stats = detector.getStats();
    expect(stats.tier1Hits).toBe(2);
    expect(stats.tier2Calls).toBe(1);

    // Advance past the debounce window and confirm a new hit actually calls.
    clock.advance(5_000);
    dispatcher.dispatch(
      "m1",
      transcriptChunk(
        "m1",
        "2024-01-01T00:00:07.000Z",
        "Can you paste the link?",
      ),
    );
    await flushPromises();

    expect(llm).toHaveBeenCalledTimes(2);
    detector.dispose();
  });

  test("two Tier 2 positives within cooldown window fire callback only once", async () => {
    const dispatcher = makeFakeDispatcher();
    const clock = makeClock(1_000);
    const llm = mock(
      async (_prompt: string): Promise<ChatOpportunityDecision> => ({
        shouldRespond: true,
        reason: "assistant should respond",
      }),
    );
    const onOpportunity = mock((_event: ChatOpportunityEvent) => {});

    const detector = new MeetChatOpportunityDetector({
      meetingId: "m1",
      assistantDisplayName: "Aria",
      // Use a short debounce so the second hit actually reaches Tier 2,
      // letting us exercise the escalation cooldown rather than the
      // debounce guard above it.
      config: defaultConfig({
        tier2DebounceMs: 100,
        escalationCooldownSec: 30,
      }),
      voiceConfig: defaultVoiceConfig(),
      callDetectorLLM: llm,
      onOpportunity,
      subscribe: dispatcher.subscribe,
      now: clock.now,
    });
    detector.start();

    dispatcher.dispatch(
      "m1",
      inboundChat(
        "m1",
        "2024-01-01T00:00:00.000Z",
        "Does anyone know the release date?",
      ),
    );
    await flushPromises();

    clock.advance(500);
    dispatcher.dispatch(
      "m1",
      inboundChat(
        "m1",
        "2024-01-01T00:00:00.500Z",
        "Can anyone confirm the release date?",
      ),
    );
    await flushPromises();

    expect(llm).toHaveBeenCalledTimes(2);
    expect(onOpportunity).toHaveBeenCalledTimes(1);

    const stats = detector.getStats();
    expect(stats.tier2PositiveCount).toBe(2);
    expect(stats.escalationsFired).toBe(1);
    expect(stats.escalationsSuppressed).toBe(1);

    // Advance past cooldown → next positive should fire again.
    clock.advance(30_000);
    dispatcher.dispatch(
      "m1",
      inboundChat(
        "m1",
        "2024-01-01T00:00:30.500Z",
        "Can anyone confirm timing?",
      ),
    );
    await flushPromises();

    expect(onOpportunity).toHaveBeenCalledTimes(2);
    detector.dispose();
  });
});

describe("MeetChatOpportunityDetector — enabled=false", () => {
  test("disabled detector performs no Tier 1, Tier 2, or callback work", async () => {
    const dispatcher = makeFakeDispatcher();
    const clock = makeClock(1_000);
    const llm = mock(
      async (_prompt: string): Promise<ChatOpportunityDecision> => ({
        shouldRespond: true,
        reason: "should not be called",
      }),
    );
    const onOpportunity = mock((_event: ChatOpportunityEvent) => {});

    const detector = new MeetChatOpportunityDetector({
      meetingId: "m1",
      assistantDisplayName: "Aria",
      config: defaultConfig({ enabled: false }),
      voiceConfig: defaultVoiceConfig(),
      callDetectorLLM: llm,
      onOpportunity,
      subscribe: dispatcher.subscribe,
      now: clock.now,
    });
    detector.start();

    dispatcher.dispatch(
      "m1",
      transcriptChunk(
        "m1",
        "2024-01-01T00:00:00.000Z",
        "Hey Aria, can you send the deck?",
      ),
    );
    dispatcher.dispatch(
      "m1",
      inboundChat(
        "m1",
        "2024-01-01T00:00:01.000Z",
        "Does anyone know the link?",
      ),
    );

    await flushPromises();

    expect(llm).toHaveBeenCalledTimes(0);
    expect(onOpportunity).toHaveBeenCalledTimes(0);

    const stats = detector.getStats();
    expect(stats.tier1Hits).toBe(0);
    expect(stats.tier2Calls).toBe(0);
    expect(stats.escalationsFired).toBe(0);

    detector.dispose();
  });
});

describe("MeetChatOpportunityDetector — custom keywords", () => {
  test("custom detectorKeywords accepted and used for Tier 1", async () => {
    const dispatcher = makeFakeDispatcher();
    const clock = makeClock(1_000);
    const llm = mock(
      async (_prompt: string): Promise<ChatOpportunityDecision> => ({
        shouldRespond: true,
        reason: "custom trigger fired",
      }),
    );
    const onOpportunity = mock((_event: ChatOpportunityEvent) => {});

    const detector = new MeetChatOpportunityDetector({
      meetingId: "m1",
      assistantDisplayName: "Aria",
      config: defaultConfig({
        // Only this custom pattern — none of the defaults are present.
        detectorKeywords: ["\\bblue\\s+monkey\\b"],
      }),
      voiceConfig: defaultVoiceConfig(),
      callDetectorLLM: llm,
      onOpportunity,
      subscribe: dispatcher.subscribe,
      now: clock.now,
    });
    detector.start();

    // A phrase that would match the DEFAULT keywords must NOT fire here,
    // because we replaced them entirely.
    dispatcher.dispatch(
      "m1",
      transcriptChunk(
        "m1",
        "2024-01-01T00:00:00.000Z",
        "Can you send the deck?",
      ),
    );
    await flushPromises();
    // Still matches the assistant-name pattern if name is "Aria"?
    // This phrase doesn't mention Aria, so Tier 1 should not hit.
    expect(detector.getStats().tier1Hits).toBe(0);
    expect(llm).toHaveBeenCalledTimes(0);

    // The custom pattern should match. Use a transcript chunk here
    // (not an inbound chat) because inbound chat bypasses Tier 1
    // entirely — we want this test to exercise Tier 1 regex matching.
    dispatcher.dispatch(
      "m1",
      transcriptChunk(
        "m1",
        "2024-01-01T00:00:01.000Z",
        "my favorite is the blue monkey at the zoo",
      ),
    );
    await flushPromises();

    expect(detector.getStats().tier1Hits).toBe(1);
    expect(llm).toHaveBeenCalledTimes(1);
    expect(onOpportunity).toHaveBeenCalledTimes(1);

    detector.dispose();
  });
});

describe("MeetChatOpportunityDetector — 1:1 voice mode", () => {
  test("bypasses Tier 1 and Tier 2 when participantCount === 2", async () => {
    const dispatcher = makeFakeDispatcher();
    const clock = makeClock(1_000);
    const timers = makeManualTimers();
    const llm = mock(
      async (_prompt: string): Promise<ChatOpportunityDecision> => ({
        shouldRespond: true,
        reason: "LLM should never be consulted in 1:1 voice mode",
      }),
    );
    const onOpportunity = mock((_event: ChatOpportunityEvent) => {});

    const detector = new MeetChatOpportunityDetector({
      meetingId: "m1",
      assistantDisplayName: "Aria",
      config: defaultConfig(),
      voiceConfig: defaultVoiceConfig(),
      callDetectorLLM: llm,
      onOpportunity,
      subscribe: dispatcher.subscribe,
      now: clock.now,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    detector.start();

    // Seed a 1:1 meeting: bot + one human.
    dispatcher.dispatch(
      "m1",
      participantChange("m1", "2024-01-01T00:00:00.000Z", [
        { id: "bot", name: "Aria", isSelf: true },
        { id: "alice", name: "Alice" },
      ]),
    );

    // Transcript without any Tier 1 keyword or assistant-name mention.
    dispatcher.dispatch(
      "m1",
      transcriptChunk(
        "m1",
        "2024-01-01T00:00:01.000Z",
        "so what's on our agenda this week",
      ),
    );
    await flushPromises();

    // EOU timer is scheduled but hasn't fired yet.
    expect(llm).toHaveBeenCalledTimes(0);
    expect(onOpportunity).toHaveBeenCalledTimes(0);
    expect(timers.pendingCount()).toBe(1);

    // Fire the EOU timer — wake should land without consulting the LLM.
    timers.fireAll();

    expect(llm).toHaveBeenCalledTimes(0);
    expect(onOpportunity).toHaveBeenCalledTimes(1);
    const [event] = onOpportunity.mock.calls[0] as unknown as [
      ChatOpportunityEvent,
    ];
    expect(event.kind).toBe("voice");
    expect(event.reason).toContain("voice-turn:");
    expect(event.reason).toContain("so what's on our agenda this week");

    const stats = detector.getStats();
    expect(stats.tier1Hits).toBe(0);
    expect(stats.tier2Calls).toBe(0);
    expect(stats.voiceWakesFired).toBe(1);
    expect(stats.escalationsFired).toBe(1);

    detector.dispose();
  });

  test("EOU debounce collapses rapid final chunks into a single wake", async () => {
    const dispatcher = makeFakeDispatcher();
    const clock = makeClock(1_000);
    const timers = makeManualTimers();
    const llm = mock(
      async (_prompt: string): Promise<ChatOpportunityDecision> => ({
        shouldRespond: true,
        reason: "should not be called",
      }),
    );
    const onOpportunity = mock((_event: ChatOpportunityEvent) => {});

    const detector = new MeetChatOpportunityDetector({
      meetingId: "m1",
      assistantDisplayName: "Aria",
      config: defaultConfig(),
      voiceConfig: defaultVoiceConfig(),
      callDetectorLLM: llm,
      onOpportunity,
      subscribe: dispatcher.subscribe,
      now: clock.now,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    detector.start();

    dispatcher.dispatch(
      "m1",
      participantChange("m1", "2024-01-01T00:00:00.000Z", [
        { id: "bot", name: "Aria", isSelf: true },
        { id: "alice", name: "Alice" },
      ]),
    );

    // Two quick final chunks before EOU fires. The second reschedules
    // the timer — there is always exactly one pending timer per meeting.
    dispatcher.dispatch(
      "m1",
      transcriptChunk("m1", "2024-01-01T00:00:01.000Z", "wait which one"),
    );
    dispatcher.dispatch(
      "m1",
      transcriptChunk("m1", "2024-01-01T00:00:01.500Z", "the redesign deck"),
    );
    expect(timers.pendingCount()).toBe(1);

    timers.fireAll();

    expect(onOpportunity).toHaveBeenCalledTimes(1);
    // The wake carries the most recent utterance, not the first one.
    const [event] = onOpportunity.mock.calls[0] as unknown as [
      ChatOpportunityEvent,
    ];
    expect(event.reason).toContain("the redesign deck");

    detector.dispose();
  });

  test("voice wake respects escalation cooldown", async () => {
    const dispatcher = makeFakeDispatcher();
    const clock = makeClock(1_000);
    const timers = makeManualTimers();
    const llm = mock(
      async (_prompt: string): Promise<ChatOpportunityDecision> => ({
        shouldRespond: true,
        reason: "should not be called",
      }),
    );
    const onOpportunity = mock((_event: ChatOpportunityEvent) => {});

    const detector = new MeetChatOpportunityDetector({
      meetingId: "m1",
      assistantDisplayName: "Aria",
      // Short escalation cooldown for the test; voice mode itself has no
      // separate throttle, so the cooldown is the one gate we can trip.
      config: defaultConfig({ escalationCooldownSec: 30 }),
      voiceConfig: defaultVoiceConfig(),
      callDetectorLLM: llm,
      onOpportunity,
      subscribe: dispatcher.subscribe,
      now: clock.now,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    detector.start();

    dispatcher.dispatch(
      "m1",
      participantChange("m1", "2024-01-01T00:00:00.000Z", [
        { id: "bot", name: "Aria", isSelf: true },
        { id: "alice", name: "Alice" },
      ]),
    );

    // First utterance + EOU fires.
    dispatcher.dispatch(
      "m1",
      transcriptChunk("m1", "2024-01-01T00:00:01.000Z", "how's it going"),
    );
    timers.fireAll();
    expect(onOpportunity).toHaveBeenCalledTimes(1);

    // Second utterance 10s later — still inside the 30s cooldown.
    clock.advance(10_000);
    dispatcher.dispatch(
      "m1",
      transcriptChunk("m1", "2024-01-01T00:00:11.000Z", "anyway"),
    );
    timers.fireAll();

    expect(onOpportunity).toHaveBeenCalledTimes(1); // still 1 — suppressed
    expect(detector.getStats().escalationsSuppressed).toBe(1);

    // Third utterance past the cooldown — fires again.
    clock.advance(30_000);
    dispatcher.dispatch(
      "m1",
      transcriptChunk("m1", "2024-01-01T00:00:41.000Z", "ok back to it"),
    );
    timers.fireAll();

    expect(onOpportunity).toHaveBeenCalledTimes(2);

    detector.dispose();
  });

  test("falls back to Tier 1 + Tier 2 when a third participant joins", async () => {
    const dispatcher = makeFakeDispatcher();
    const clock = makeClock(1_000);
    const timers = makeManualTimers();
    const llm = mock(
      async (_prompt: string): Promise<ChatOpportunityDecision> => ({
        shouldRespond: false,
        reason: "not addressed to assistant",
      }),
    );
    const onOpportunity = mock((_event: ChatOpportunityEvent) => {});

    const detector = new MeetChatOpportunityDetector({
      meetingId: "m1",
      assistantDisplayName: "Aria",
      config: defaultConfig(),
      voiceConfig: defaultVoiceConfig(),
      callDetectorLLM: llm,
      onOpportunity,
      subscribe: dispatcher.subscribe,
      now: clock.now,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    detector.start();

    // 1:1 → voice mode.
    dispatcher.dispatch(
      "m1",
      participantChange("m1", "2024-01-01T00:00:00.000Z", [
        { id: "bot", name: "Aria", isSelf: true },
        { id: "alice", name: "Alice" },
      ]),
    );

    // Third participant joins — should flip to group mode and cancel any
    // pending voice EOU timer.
    dispatcher.dispatch(
      "m1",
      transcriptChunk("m1", "2024-01-01T00:00:01.000Z", "quick thought"),
    );
    expect(timers.pendingCount()).toBe(1);

    dispatcher.dispatch(
      "m1",
      participantChange("m1", "2024-01-01T00:00:02.000Z", [
        { id: "bob", name: "Bob" },
      ]),
    );
    expect(timers.pendingCount()).toBe(0); // voice timer cancelled

    // A non-matching transcript in group mode must not call Tier 2.
    dispatcher.dispatch(
      "m1",
      transcriptChunk(
        "m1",
        "2024-01-01T00:00:03.000Z",
        "and also another thing",
      ),
    );
    await flushPromises();

    expect(llm).toHaveBeenCalledTimes(0);
    expect(onOpportunity).toHaveBeenCalledTimes(0);

    detector.dispose();
  });

  test("voice mode disabled falls back to Tier 1 + Tier 2 even in 1:1", async () => {
    const dispatcher = makeFakeDispatcher();
    const clock = makeClock(1_000);
    const timers = makeManualTimers();
    const llm = mock(
      async (_prompt: string): Promise<ChatOpportunityDecision> => ({
        shouldRespond: true,
        reason: "tier 2 is the path here",
      }),
    );
    const onOpportunity = mock((_event: ChatOpportunityEvent) => {});

    const detector = new MeetChatOpportunityDetector({
      meetingId: "m1",
      assistantDisplayName: "Aria",
      config: defaultConfig(),
      voiceConfig: defaultVoiceConfig({ enabled: false }),
      callDetectorLLM: llm,
      onOpportunity,
      subscribe: dispatcher.subscribe,
      now: clock.now,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    detector.start();

    dispatcher.dispatch(
      "m1",
      participantChange("m1", "2024-01-01T00:00:00.000Z", [
        { id: "bot", name: "Aria", isSelf: true },
        { id: "alice", name: "Alice" },
      ]),
    );

    // Matching Tier 1 transcript — must take the Tier 2 path because
    // voice mode is disabled, not the EOU-debounced voice path.
    dispatcher.dispatch(
      "m1",
      transcriptChunk(
        "m1",
        "2024-01-01T00:00:01.000Z",
        "can you share the doc?",
      ),
    );
    await flushPromises();

    // No voice timer scheduled.
    expect(timers.pendingCount()).toBe(0);
    expect(llm).toHaveBeenCalledTimes(1);
    expect(onOpportunity).toHaveBeenCalledTimes(1);
    const [event] = onOpportunity.mock.calls[0] as unknown as [
      ChatOpportunityEvent,
    ];
    expect(event.kind).toBe("chat");

    detector.dispose();
  });
});
