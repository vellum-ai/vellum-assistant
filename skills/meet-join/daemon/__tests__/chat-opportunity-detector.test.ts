/**
 * Unit tests for {@link MeetChatOpportunityDetector}.
 *
 * These tests inject a fake dispatcher (recording subscribers by meeting),
 * a scripted Tier 2 LLM callable, and a controllable clock so every
 * scenario is deterministic. Real provider abstractions are never
 * constructed.
 */

import { describe, expect, mock, test } from "bun:test";

import type { MeetBotEvent } from "@vellumai/meet-contracts";

import {
  type ChatOpportunityDecision,
  MeetChatOpportunityDetector,
  type ProactiveChatConfig,
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

async function flushPromises(): Promise<void> {
  for (let i = 0; i < 3; i++) await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MeetChatOpportunityDetector — Tier 1 fast filter", () => {
  test("Tier 1 miss does not invoke Tier 2 and does not fire callback", async () => {
    const dispatcher = makeFakeDispatcher();
    const clock = makeClock(1_000);
    const llm = mock(
      async (_prompt: string): Promise<ChatOpportunityDecision> => ({
        shouldRespond: true,
        reason: "should not be called",
      }),
    );
    const onOpportunity = mock((_reason: string) => {});

    const detector = new MeetChatOpportunityDetector({
      meetingId: "m1",
      assistantDisplayName: "Velissa",
      config: defaultConfig(),
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
    dispatcher.dispatch(
      "m1",
      inboundChat("m1", "2024-01-01T00:00:01.000Z", "hello team"),
    );

    await flushPromises();

    expect(llm).toHaveBeenCalledTimes(0);
    expect(onOpportunity).toHaveBeenCalledTimes(0);
    expect(detector.getStats().tier1Hits).toBe(0);

    detector.dispose();
    expect(dispatcher.subscriberCount("m1")).toBe(0);
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
    const onOpportunity = mock((_reason: string) => {});

    const detector = new MeetChatOpportunityDetector({
      meetingId: "m1",
      assistantDisplayName: "Velissa",
      config: defaultConfig(),
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
    const onOpportunity = mock((_reason: string) => {});

    const detector = new MeetChatOpportunityDetector({
      meetingId: "m1",
      assistantDisplayName: "Velissa",
      config: defaultConfig(),
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
    const [reason] = onOpportunity.mock.calls[0] as unknown as [string];
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
    const onOpportunity = mock((_reason: string) => {});

    const detector = new MeetChatOpportunityDetector({
      meetingId: "m1",
      assistantDisplayName: "Velissa",
      config: defaultConfig(),
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
        "I was chatting with Velissa earlier.",
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
    const onOpportunity = mock((_reason: string) => {});

    const detector = new MeetChatOpportunityDetector({
      meetingId: "m1",
      assistantDisplayName: "Velissa",
      config: defaultConfig({ tier2DebounceMs: 5_000 }),
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
    const onOpportunity = mock((_reason: string) => {});

    const detector = new MeetChatOpportunityDetector({
      meetingId: "m1",
      assistantDisplayName: "Velissa",
      // Use a short debounce so the second hit actually reaches Tier 2,
      // letting us exercise the escalation cooldown rather than the
      // debounce guard above it.
      config: defaultConfig({
        tier2DebounceMs: 100,
        escalationCooldownSec: 30,
      }),
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
    const onOpportunity = mock((_reason: string) => {});

    const detector = new MeetChatOpportunityDetector({
      meetingId: "m1",
      assistantDisplayName: "Velissa",
      config: defaultConfig({ enabled: false }),
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
        "Hey Velissa, can you send the deck?",
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
    const onOpportunity = mock((_reason: string) => {});

    const detector = new MeetChatOpportunityDetector({
      meetingId: "m1",
      assistantDisplayName: "Velissa",
      config: defaultConfig({
        // Only this custom pattern — none of the defaults are present.
        detectorKeywords: ["\\bblue\\s+monkey\\b"],
      }),
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
    // Still matches the assistant-name pattern if name is "Velissa"?
    // This phrase doesn't mention Velissa, so Tier 1 should not hit.
    expect(detector.getStats().tier1Hits).toBe(0);
    expect(llm).toHaveBeenCalledTimes(0);

    // The custom pattern should match.
    dispatcher.dispatch(
      "m1",
      inboundChat(
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
