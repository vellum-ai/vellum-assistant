import { describe, expect, test } from "bun:test";

import {
  getLiveVoiceMetricsAggregateFields,
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
        // Manual mode: no utterance_end mark, so the round trip falls back
        // to ptt_release → first TTS audio.
        roundTripMs: 195,
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

  test("derives roundTripMs from utterance_end to first TTS audio and aggregates it", () => {
    const clock = makeClock(0);
    const collector = new LiveVoiceMetricsCollector({
      sessionId: "session-round-trip",
      clock: clock.now,
    });

    collector.startTurn("turn-vad");
    clock.advance(10);
    collector.markUtteranceEnd();
    clock.advance(40);
    // utterance_end takes precedence over a later ptt_release mark.
    collector.markPushToTalkRelease();
    clock.advance(50);
    collector.markFinalTranscript();
    clock.advance(25);
    collector.markFirstAssistantDelta();
    clock.advance(75);
    collector.markFirstTtsAudio();
    const turn = collector.completeTurn();

    expect(turn.durations.roundTripMs).toBe(190);

    const snapshot = collector.getSnapshot();
    expect(getLiveVoiceMetricsAggregateFields(snapshot, "turn-vad")).toEqual({
      sttMs: 50,
      llmFirstDeltaMs: 25,
      ttsFirstAudioMs: 75,
      roundTripMs: 190,
      totalMs: 200,
    });
    expect(snapshot.summary.durations.roundTripMs).toEqual({
      count: 1,
      p50Ms: 190,
      p95Ms: 190,
    });
  });

  test("roundTripMs is null when the end-of-speech or first TTS mark is missing", () => {
    const clock = makeClock(0);
    const collector = new LiveVoiceMetricsCollector({
      sessionId: "session-round-trip-null",
      clock: clock.now,
    });

    // First TTS audio without an end-of-speech mark.
    collector.startTurn("turn-no-speech-end");
    clock.advance(30);
    collector.markFirstTtsAudio();
    expect(collector.completeTurn().durations.roundTripMs).toBeNull();

    // End-of-speech mark without first TTS audio.
    collector.startTurn("turn-no-tts");
    clock.advance(20);
    collector.markUtteranceEnd();
    expect(collector.completeTurn().durations.roundTripMs).toBeNull();

    expect(
      getLiveVoiceMetricsAggregateFields(collector.getSnapshot()).roundTripMs,
    ).toBeNull();
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
        roundTripMs: null,
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

  test("startTurn seeds stashed marks and backdates the turn start", () => {
    const clock = makeClock(1_000);
    const collector = new LiveVoiceMetricsCollector({
      sessionId: "session-5",
      clock: clock.now,
    });

    clock.advance(500);
    const turn = collector.startTurn("turn-seeded", {
      firstAudioAtMs: 1_100,
      speechStartAtMs: 1_150,
      utteranceEndAtMs: 1_300,
      finalTranscriptAtMs: 1_400,
    });

    expect(turn.timestamps.startedAtMs).toBe(1_100);
    expect(turn.timestamps.firstAudioAtMs).toBe(1_100);
    expect(turn.timestamps.speechStartAtMs).toBe(1_150);
    expect(turn.timestamps.utteranceEndAtMs).toBe(1_300);
    expect(turn.timestamps.finalTranscriptAtMs).toBe(1_400);
    expect(turn.durations.utteranceEndToFinalTranscriptMs).toBe(100);

    // A live mark never overwrites a seeded mark (first timestamp wins).
    clock.advance(100);
    collector.markFinalTranscript("turn-seeded");
    expect(
      collector.getSnapshot().activeTurn?.timestamps.finalTranscriptAtMs,
    ).toBe(1_400);

    clock.advance(100);
    const completed = collector.completeTurn("turn-seeded");
    expect(completed.durations.totalTurnDurationMs).toBe(600);
  });

  test("seed marks ahead of the turn start are clamped to it", () => {
    const clock = makeClock(2_000);
    const collector = new LiveVoiceMetricsCollector({
      sessionId: "session-6",
      clock: clock.now,
    });

    const turn = collector.startTurn("turn-clamped", {
      utteranceEndAtMs: 5_000,
    });

    expect(turn.timestamps.startedAtMs).toBe(2_000);
    expect(turn.timestamps.utteranceEndAtMs).toBe(2_000);
  });

  test("markBargeIn records a first-wins timestamp on the active turn", () => {
    const clock = makeClock(3_000);
    const collector = new LiveVoiceMetricsCollector({
      sessionId: "session-7",
      clock: clock.now,
    });

    collector.startTurn("turn-barge");
    clock.advance(40);
    const frame = collector.markBargeIn("turn-barge");

    expect(frame.event).toBe("barge_in");
    expect(frame.turnId).toBe("turn-barge");
    expect(frame.metrics.activeTurn?.timestamps.bargeInAtMs).toBe(3_040);

    clock.advance(25);
    collector.markBargeIn("turn-barge");
    expect(collector.getSnapshot().activeTurn?.timestamps.bargeInAtMs).toBe(
      3_040,
    );

    const cancelled = collector.cancelTurn("barge_in", "turn-barge");
    expect(cancelled.timestamps.bargeInAtMs).toBe(3_040);
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
