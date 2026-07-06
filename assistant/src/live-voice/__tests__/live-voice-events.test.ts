/**
 * Per-turn archive and metrics behavior of the duplex LiveVoiceSession:
 * user/assistant audio archiving with `archived` frames (including the
 * warning fallback), turn metrics frames with aggregate latency fields,
 * and the stale-turn guard that keeps an aborted turn's audio from being
 * archived under the next turn's id.
 */

import { describe, expect, mock, test } from "bun:test";

import type {
  LiveVoiceSessionArchiveAudioInput,
  LiveVoiceSessionAudioArchiver,
} from "../live-voice-session.js";
import {
  audioFrame,
  createSessionHarness,
  frameTypes,
  makeArchiveResult,
  type SessionHarness,
  startRespondingTurn,
  waitFor,
} from "./live-voice-session-harness.js";

function makeClock(): () => number {
  let now = 1_000;
  return () => {
    now += 10;
    return now;
  };
}

function createArchivingHarness(
  archiveAudio: LiveVoiceSessionAudioArchiver,
): SessionHarness {
  return createSessionHarness({
    emitMetrics: true,
    sessionOptions: {
      archiveAudio,
      metricsClock: makeClock(),
    },
  });
}

describe("LiveVoiceSession archive and metrics events", () => {
  test("archives user and assistant audio and emits completion and session metrics", async () => {
    const archiveAudio = mock(
      async (input: LiveVoiceSessionArchiveAudioInput) =>
        makeArchiveResult(input),
    );
    const harness = createArchivingHarness(archiveAudio);
    const { session, frames, transport } = harness;

    await startRespondingTurn(harness, "hello");
    await transport.emitTtsAudio("assistant audio bytes");
    await transport.emitTtsDone();
    await waitFor(() =>
      frames.some(
        (frame) => frame.type === "metrics" && frame.event === "turn_completed",
      ),
    );
    await session.close("client_end");

    expect(frameTypes(frames)).toEqual([
      "ready",
      "stt_final",
      "thinking",
      "tts_audio",
      "tts_done",
      "archived",
      "archived",
      "metrics",
      "metrics",
    ]);
    expect(archiveAudio).toHaveBeenCalledTimes(2);
    expect(archiveAudio.mock.calls.map((call) => call[0].role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(archiveAudio.mock.calls[0]?.[0]).toMatchObject({
      sessionId: "session-123",
      turnId: "live-turn-1",
      role: "user",
      mimeType: "audio/pcm",
      sampleRate: 24_000,
    });
    expect(archiveAudio.mock.calls[1]?.[0]).toMatchObject({
      sessionId: "session-123",
      turnId: "live-turn-1",
      role: "assistant",
      mimeType: "audio/pcm",
      sampleRate: 24_000,
    });
    expect(
      Buffer.from(
        archiveAudio.mock.calls[0]![0].audio.dataBase64,
        "base64",
      ).toString(),
    ).toBe("user audio");
    expect(
      Buffer.from(
        archiveAudio.mock.calls[1]![0].audio.dataBase64,
        "base64",
      ).toString(),
    ).toBe("assistant audio bytes");

    const archivedFrames = frames.filter((frame) => frame.type === "archived");
    expect(archivedFrames.map((frame) => frame.attachmentIds)).toEqual([
      ["user-attachment-123"],
      ["assistant-attachment-123"],
    ]);

    const completedMetrics = frames.find(
      (frame) => frame.type === "metrics" && frame.event === "turn_completed",
    );
    expect(completedMetrics).toMatchObject({
      type: "metrics",
      sessionId: "session-123",
      conversationId: "conversation-123",
      turnId: "live-turn-1",
      sttMs: null,
      llmFirstDeltaMs: null,
      ttsFirstAudioMs: null,
      totalMs: expect.any(Number),
      metrics: {
        summary: {
          completedTurnCount: 1,
          cancelledTurnCount: 0,
        },
      },
    });
    expect(frames.at(-1)).toMatchObject({
      type: "metrics",
      event: "session_ended",
      sessionId: "session-123",
    });
  });

  test("records per-turn latency aggregates from the marker sequence", async () => {
    const archiveAudio = mock(
      async (input: LiveVoiceSessionArchiveAudioInput) =>
        makeArchiveResult(input),
    );
    const harness = createArchivingHarness(archiveAudio);
    const { session, frames, ingest, transport, controllerTransport } = harness;

    await session.start();
    await session.handleClientFrame(audioFrame("user audio"));
    ingest.callbacks.onPartial?.("hel");
    await session.handleClientFrame({ type: "ptt_release" });
    ingest.callbacks.onTranscriptFinal?.("hello");
    await waitFor(() => frames.some((frame) => frame.type === "thinking"));
    controllerTransport().sendTextToken("Hi there.", true);
    await transport.emitTtsAudio("assistant audio");
    await transport.emitTtsDone();
    await waitFor(() =>
      frames.some(
        (frame) => frame.type === "metrics" && frame.event === "turn_completed",
      ),
    );

    // The deterministic clock advances 10ms per marker, so every stage
    // duration resolves to a concrete (non-null) value.
    expect(
      frames.find(
        (frame) => frame.type === "metrics" && frame.event === "turn_completed",
      ),
    ).toMatchObject({
      turnId: "live-turn-1",
      sttMs: 10,
      llmFirstDeltaMs: 10,
      ttsFirstAudioMs: 10,
      totalMs: expect.any(Number),
    });
  });

  test("uses the TTS chunk content type for socket frames and archive metadata", async () => {
    const archiveAudio = mock(
      async (input: LiveVoiceSessionArchiveAudioInput) =>
        makeArchiveResult(input),
    );
    const harness = createArchivingHarness(archiveAudio);
    const { frames, transport } = harness;

    await startRespondingTurn(harness, "hello");
    await transport.emitTtsAudio("assistant wav bytes", "audio/wav");
    await transport.emitTtsDone();
    await waitFor(() =>
      frames.some(
        (frame) => frame.type === "archived" && frame.role === "assistant",
      ),
    );

    expect(frames.find((frame) => frame.type === "tts_audio")).toMatchObject({
      type: "tts_audio",
      mimeType: "audio/wav",
    });
    expect(
      archiveAudio.mock.calls.find((call) => call[0].role === "assistant")?.[0],
    ).toMatchObject({
      role: "assistant",
      mimeType: "audio/wav",
    });
  });

  test("barge-in archives the aborted turn's audio under its own id", async () => {
    const archiveAudio = mock(
      async (input: LiveVoiceSessionArchiveAudioInput) =>
        makeArchiveResult(input),
    );
    const harness = createArchivingHarness(archiveAudio);
    const { session, frames, ingest, transport, controller } = harness;

    await startRespondingTurn(harness, "first utterance");
    await transport.emitTtsAudio("aborted assistant audio");
    controller.state = "speaking";
    ingest.callbacks.onSpeechStart?.();
    await waitFor(() =>
      frames.some(
        (frame) => frame.type === "metrics" && frame.event === "turn_cancelled",
      ),
    );

    // Aborted turn: user + assistant audio archived under live-turn-1.
    expect(archiveAudio.mock.calls.map((call) => call[0].turnId)).toEqual([
      "live-turn-1",
      "live-turn-1",
    ]);
    expect(frames.some((frame) => frame.type === "tts_done")).toBe(false);

    // Next turn completes normally and archives only its own audio.
    await session.handleClientFrame(audioFrame("second user audio"));
    ingest.callbacks.onTranscriptFinal?.("second utterance");
    await waitFor(
      () => frames.filter((frame) => frame.type === "thinking").length === 2,
    );
    await transport.emitTtsAudio("second assistant audio");
    await transport.emitTtsDone();
    await waitFor(() =>
      frames.some(
        (frame) => frame.type === "metrics" && frame.event === "turn_completed",
      ),
    );

    const secondTurnCalls = archiveAudio.mock.calls.filter(
      (call) => call[0].turnId === "live-turn-2",
    );
    expect(secondTurnCalls.map((call) => call[0].role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(
      Buffer.from(secondTurnCalls[1]![0].audio.dataBase64, "base64").toString(),
    ).toBe("second assistant audio");

    const cancelledMetrics = frames.find(
      (frame) => frame.type === "metrics" && frame.event === "turn_cancelled",
    );
    expect(cancelledMetrics).toMatchObject({
      turnId: "live-turn-1",
      metrics: {
        summary: { cancelledTurnCount: 1 },
      },
    });
  });

  test("emits warning archive frames when the archiver fails, without erroring the turn", async () => {
    const archiveAudio = mock(async () => {
      throw new Error("archive store unavailable");
    });
    const harness = createArchivingHarness(archiveAudio);
    const { frames, transport } = harness;

    await startRespondingTurn(harness, "hello");
    await transport.emitTtsAudio("assistant audio");
    await transport.emitTtsDone();
    await waitFor(() =>
      frames.some(
        (frame) => frame.type === "metrics" && frame.event === "turn_completed",
      ),
    );

    const archivedFrames = frames.filter((frame) => frame.type === "archived");
    expect(archivedFrames).toHaveLength(2);
    for (const frame of archivedFrames) {
      expect(frame).toMatchObject({
        warning: {
          code: "archive_failed",
          message: expect.stringContaining("archive store unavailable"),
        },
      });
      expect(frame.attachmentIds).toBeUndefined();
    }
    expect(frames.filter((frame) => frame.type === "error")).toEqual([]);
  });

  test("persisted message ids reported during the turn are linked into the archives", async () => {
    const archiveAudio = mock(
      async (input: LiveVoiceSessionArchiveAudioInput) =>
        makeArchiveResult(input),
    );
    const harness = createArchivingHarness(archiveAudio);
    const { frames, transport, controller } = harness;

    await startRespondingTurn(harness, "hello");
    // The voice bridge reports the persisted user message right after
    // dispatch and the assistant message at generation complete — both
    // while the turn is still responding.
    controller.options?.onPersistedUserMessageId("msg-user-1");
    controller.options?.onPersistedAssistantMessageId("msg-assistant-1");
    await transport.emitTtsAudio("assistant audio");
    await transport.emitTtsDone();
    await waitFor(() =>
      frames.some(
        (frame) => frame.type === "metrics" && frame.event === "turn_completed",
      ),
    );

    expect(
      archiveAudio.mock.calls.map((call) => [call[0].role, call[0].messageId]),
    ).toEqual([
      ["user", "msg-user-1"],
      ["assistant", "msg-assistant-1"],
    ]);
  });

  test("archives with null message ids when none arrived before finalize (unlinked fallback)", async () => {
    const archiveAudio = mock(
      async (input: LiveVoiceSessionArchiveAudioInput) =>
        makeArchiveResult(input),
    );
    const harness = createArchivingHarness(archiveAudio);
    const { frames, transport } = harness;

    await startRespondingTurn(harness, "hello");
    await transport.emitTtsAudio("assistant audio");
    await transport.emitTtsDone();
    await waitFor(() =>
      frames.some(
        (frame) => frame.type === "metrics" && frame.event === "turn_completed",
      ),
    );

    expect(
      archiveAudio.mock.calls.map((call) => call[0].messageId ?? null),
    ).toEqual([null, null]);
  });

  test("message ids arriving after the turn finalized are dropped, not misattributed", async () => {
    const archiveAudio = mock(
      async (input: LiveVoiceSessionArchiveAudioInput) =>
        makeArchiveResult(input),
    );
    const harness = createArchivingHarness(archiveAudio);
    const { session, frames, ingest, transport, controller } = harness;

    await startRespondingTurn(harness, "first utterance");
    controller.options?.onPersistedUserMessageId("msg-user-1");
    // Barge-in finalizes the turn before the assistant message persists.
    controller.state = "speaking";
    ingest.callbacks.onSpeechStart?.();
    await waitFor(() =>
      frames.some(
        (frame) => frame.type === "metrics" && frame.event === "turn_cancelled",
      ),
    );
    // Late id for the aborted generation: no responding turn — dropped.
    controller.options?.onPersistedAssistantMessageId("msg-assistant-stale");

    await session.handleClientFrame(audioFrame("second user audio"));
    ingest.callbacks.onTranscriptFinal?.("second utterance");
    await waitFor(
      () => frames.filter((frame) => frame.type === "thinking").length === 2,
    );
    controller.options?.onPersistedUserMessageId("msg-user-2");
    controller.options?.onPersistedAssistantMessageId("msg-assistant-2");
    await transport.emitTtsAudio("second assistant audio");
    await transport.emitTtsDone();
    await waitFor(() =>
      frames.some(
        (frame) => frame.type === "metrics" && frame.event === "turn_completed",
      ),
    );

    expect(
      archiveAudio.mock.calls.map((call) => [
        call[0].turnId,
        call[0].role,
        call[0].messageId ?? null,
      ]),
    ).toEqual([
      ["live-turn-1", "user", "msg-user-1"],
      ["live-turn-2", "user", "msg-user-2"],
      ["live-turn-2", "assistant", "msg-assistant-2"],
    ]);
  });

  test("session close cancels the open turn and archives its user audio", async () => {
    const archiveAudio = mock(
      async (input: LiveVoiceSessionArchiveAudioInput) =>
        makeArchiveResult(input),
    );
    const harness = createArchivingHarness(archiveAudio);
    const { session, frames } = harness;

    await session.start();
    await session.handleClientFrame(audioFrame("unfinished user audio"));
    await session.close("websocket_close");

    expect(archiveAudio).toHaveBeenCalledTimes(1);
    expect(archiveAudio.mock.calls[0]?.[0]).toMatchObject({
      role: "user",
      turnId: "live-turn-1",
    });
    const metricsEvents = frames
      .filter((frame) => frame.type === "metrics")
      .map((frame) => (frame.type === "metrics" ? frame.event : ""));
    expect(metricsEvents).toEqual(["turn_cancelled", "session_ended"]);
  });
});
