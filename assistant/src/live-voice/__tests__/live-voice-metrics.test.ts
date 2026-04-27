import { describe, expect, test } from "bun:test";

import {
  LiveVoiceMetricsCollector,
  type LiveVoiceMetricsFrame,
} from "../live-voice-metrics.js";

function makeClock(startMs = 0): {
  now: () => number;
  advance: (durationMs: number) => number;
} {
  let currentMs = startMs;
  return {
    now: () => currentMs,
    advance: (durationMs: number) => {
      currentMs += durationMs;
      return currentMs;
    },
  };
}

describe("LiveVoiceMetricsCollector", () => {
  test("tracks session readiness and full turn latency phases", () => {
    const clock = makeClock(1_000);
    const frames: LiveVoiceMetricsFrame[] = [];
    const collector = new LiveVoiceMetricsCollector({
      sessionId: "session-1",
      conversationId: "conversation-1",
      clock: clock.now,
      emit: (frame) => frames.push(frame),
    });

    clock.advance(75);
    collector.markReady();

    collector.startTurn("turn-1");
    collector.markFirstAudio();
    clock.advance(120);
    collector.markFirstPartial();
    clock.advance(80);
    collector.markPushToTalkRelease();
    clock.advance(90);
    collector.markFinalTranscript();
    clock.advance(45);
    collector.markFirstAssistantDelta();
    clock.advance(60);
    collector.markFirstTtsAudio();
    clock.advance(200);
    const completedTurn = collector.completeTurn();

    expect(collector.getSnapshot().session).toEqual({
      sessionId: "session-1",
      conversationId: "conversation-1",
      startedAtMs: 1_000,
      readyAtMs: 1_075,
      startToReadyMs: 75,
    });
    expect(completedTurn).toMatchObject({
      turnId: "turn-1",
      status: "completed",
      cancellationReason: null,
      durations: {
        firstAudioToFirstPartialMs: 120,
        pttReleaseToFinalTranscriptMs: 90,
        finalTranscriptToFirstAssistantDeltaMs: 45,
        firstAssistantDeltaToFirstTtsAudioMs: 60,
        totalTurnDurationMs: 595,
      },
    });

    const lastFrame = frames.at(-1);
    expect(lastFrame).toMatchObject({
      type: "metrics",
      event: "turn_completed",
      sessionId: "session-1",
      conversationId: "conversation-1",
      turnId: "turn-1",
      metrics: {
        summary: {
          retainedTurnCount: 1,
          completedTurnCount: 1,
          cancelledTurnCount: 0,
          durations: {
            totalTurnDurationMs: {
              count: 1,
              p50Ms: 595,
              p95Ms: 595,
            },
          },
        },
      },
    });
  });

  test("keeps missing phases nullable when a turn is cancelled", () => {
    const clock = makeClock(5_000);
    const frames: LiveVoiceMetricsFrame[] = [];
    const collector = new LiveVoiceMetricsCollector({
      sessionId: "session-2",
      clock: clock.now,
      emit: (frame) => frames.push(frame),
    });

    collector.startTurn("turn-cancelled");
    clock.advance(20);
    collector.markFirstAudio();
    clock.advance(30);
    const cancelledTurn = collector.cancelTurn("interrupt");

    expect(cancelledTurn).toMatchObject({
      turnId: "turn-cancelled",
      status: "cancelled",
      cancellationReason: "interrupt",
      durations: {
        firstAudioToFirstPartialMs: null,
        pttReleaseToFinalTranscriptMs: null,
        finalTranscriptToFirstAssistantDeltaMs: null,
        firstAssistantDeltaToFirstTtsAudioMs: null,
        totalTurnDurationMs: 50,
      },
    });

    const snapshot = collector.getSnapshot();
    expect(snapshot.activeTurn).toBeNull();
    expect(snapshot.summary.cancelledTurnCount).toBe(1);
    expect(snapshot.summary.durations.firstAudioToFirstPartialMs).toEqual({
      count: 0,
      p50Ms: null,
      p95Ms: null,
    });
    expect(frames.at(-1)?.event).toBe("turn_cancelled");
  });

  test("normalizes a regressing injected clock so durations are monotonic", () => {
    const times = [1_000, 900, 800, 700, 1_200, 1_100, 1_350];
    const collector = new LiveVoiceMetricsCollector({
      sessionId: "session-3",
      clock: () => times.shift() ?? 1_350,
    });

    collector.markReady();
    collector.startTurn("turn-monotonic");
    collector.markFirstAudio();
    collector.markFirstPartial();
    collector.markPushToTalkRelease();
    const turn = collector.completeTurn();

    expect(collector.getSnapshot().session.startToReadyMs).toBe(0);
    expect(turn.timestamps.startedAtMs).toBe(1_000);
    expect(turn.timestamps.firstAudioAtMs).toBe(1_000);
    expect(turn.timestamps.firstPartialAtMs).toBe(1_200);
    expect(turn.timestamps.pttReleaseAtMs).toBe(1_200);
    expect(turn.durations.firstAudioToFirstPartialMs).toBe(200);
    expect(turn.durations.pttReleaseToFinalTranscriptMs).toBeNull();
    expect(turn.durations.totalTurnDurationMs).toBe(350);
  });

  test("records only the first timestamp for first-phase metrics", () => {
    const clock = makeClock(10_000);
    const collector = new LiveVoiceMetricsCollector({
      sessionId: "session-4",
      clock: clock.now,
    });

    collector.startTurn("turn-idempotent");
    collector.markFirstAudio();
    clock.advance(250);
    collector.markFirstAudio();
    clock.advance(50);
    const partialFrame = collector.markFirstPartial();

    expect(partialFrame.metrics.activeTurn?.timestamps.firstAudioAtMs).toBe(
      10_000,
    );
    expect(
      partialFrame.metrics.activeTurn?.durations.firstAudioToFirstPartialMs,
    ).toBe(300);
  });
});
