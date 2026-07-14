/**
 * Tests for the `useLiveVoice` session controller.
 *
 * The three merged primitives — client, capture, player — are replaced with
 * the shared fakes from `live-voice-fakes.test-helper.ts`, injected through
 * `useLiveVoice`'s factory options, so no WebSocket, microphone, or
 * AudioContext is touched.
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

// The default client factory in use-live-voice statically imports the real
// LiveVoiceChannelClient, which pulls in connection.ts -> the generated SDK.
// Tests inject fake primitives, so we never construct the real client; mock the
// connection module so importing the controller doesn't drag in the SDK client.
mock.module("@/domains/chat/voice/live-voice/connection", () => ({
  resolveLiveVoiceWsUrl: mock(
    async () => "wss://velay.vellum.ai/a/v1/live-voice",
  ),
}));

import type {
  LiveVoiceChannelClient,
  LiveVoiceClientError,
} from "@/domains/chat/voice/live-voice/live-voice-client";
import type { LiveVoiceAudioCapture } from "@/domains/chat/voice/live-voice/pcm-capture";
import type { LiveVoiceAudioPlayer } from "@/domains/chat/voice/live-voice/tts-playback";

import {
  FakeCapture,
  FakeClient,
  FakePlayer,
  pcmChunk,
} from "@/domains/chat/voice/live-voice/live-voice-fakes.test-helper";

// Import the controller + store *after* the connection mock is registered, so
// the real connection.ts (which imports the generated SDK) never enters the
// static import graph.
const { useLiveVoice } = await import(
  "@/domains/chat/voice/live-voice/use-live-voice"
);
const { useLiveVoiceStore } = await import(
  "@/domains/chat/voice/live-voice/live-voice-store"
);

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Drain all pending microtasks (e.g. the wrapped capture-promise chain). */
const flushMicrotasks = () => sleep(0);

function renderController(
  extraOptions: {
    observeAudioState?: boolean;
    reconnectBackoffMs?: number[];
    /**
     * Configure each FakeCapture at creation — before the controller calls
     * `capture.start()`, which happens synchronously at connect time (so
     * mutating the capture after `start()` returns is too late for
     * `deferStart`/`startResult`).
     */
    onCaptureCreated?: (capture: FakeCapture) => void;
  } = {},
) {
  const { onCaptureCreated, ...hookOptions } = extraOptions;
  const client = new FakeClient();
  const player = new FakePlayer();
  let capture!: FakeCapture;
  let renderCount = 0;

  const view = renderHook(() => {
    renderCount++;
    return useLiveVoice({
      createClient: () => client as unknown as LiveVoiceChannelClient,
      createPlayer: () => player as unknown as LiveVoiceAudioPlayer,
      createCapture: (options) => {
        capture = new FakeCapture(options);
        onCaptureCreated?.(capture);
        return capture as unknown as LiveVoiceAudioCapture;
      },
      ...hookOptions,
    });
  });

  return {
    view,
    client,
    player,
    getCapture: () => capture,
    getRenderCount: () => renderCount,
  };
}

/** Start a session and drive it to the listening state (ready + capture). */
async function startListening(
  h: ReturnType<typeof renderController>,
  options?: { handsFree?: boolean },
) {
  await act(async () => {
    await h.view.result.current.start("assistant-1", "conv-1", options);
  });
  // Capture started at connect time; `ready` awaits its (already settled)
  // result — flush that microtask.
  // A current daemon echoes the session's turn-detection mode.
  await act(async () => {
    h.client.emit("ready", {
      type: "ready",
      seq: 1,
      sessionId: "s1",
      conversationId: "conv-1",
      turnDetection: options?.handsFree ? "server_vad" : "manual",
    });
    await Promise.resolve();
  });
}

beforeEach(() => {
  useLiveVoiceStore.getState().reset();
});

afterEach(() => {
  // Unmount any still-mounted controller so its session teardown runs — with
  // continuous listening a session stays live (mic open) until stop()/unmount,
  // so without this the store/session would leak into the next test.
  cleanup();
  useLiveVoiceStore.getState().reset();
});

// ---------------------------------------------------------------------------
// Full turn
// ---------------------------------------------------------------------------

describe("full turn", () => {
  test("drives idle → connecting → listening → thinking → speaking → idle (session ends after the turn)", async () => {
    const h = renderController();

    expect(h.view.result.current.state).toBe("idle");

    await act(async () => {
      await h.view.result.current.start("assistant-1", "conv-1");
    });
    expect(h.view.result.current.state).toBe("connecting");
    expect(h.client.connectArgs).toEqual({
      assistantId: "assistant-1",
      conversationId: "conv-1",
    });

    await act(async () => {
      h.client.emit("ready", {
        type: "ready",
        seq: 1,
        sessionId: "s1",
        conversationId: "conv-1",
      });
      await Promise.resolve();
    });
    expect(h.view.result.current.state).toBe("listening");
    expect(h.getCapture().startCount).toBe(1);

    // Captured audio is forwarded to the client.
    act(() => {
      h.getCapture().pushAmplitude(0.1);
      h.getCapture().pushChunk(pcmChunk(20));
    });
    expect(h.client.sentAudio).toHaveLength(1);

    // Partial then final transcript.
    act(() => {
      h.client.emit("sttPartial", { type: "stt_partial", seq: 2, text: "hel" });
    });
    expect(h.view.result.current.partialTranscript).toBe("hel");

    act(() => {
      h.client.emit("sttFinal", { type: "stt_final", seq: 3, text: "hello" });
    });
    expect(h.view.result.current.finalTranscript).toBe("hello");
    expect(h.view.result.current.partialTranscript).toBe("");
    // Capture still running, so stt_final keeps us listening.
    expect(h.view.result.current.state).toBe("listening");

    act(() => {
      h.client.emit("thinking", { type: "thinking", seq: 4, turnId: "t1" });
    });
    expect(h.view.result.current.state).toBe("thinking");

    act(() => {
      h.client.emit("assistantTextDelta", {
        type: "assistant_text_delta",
        seq: 5,
        text: "hi ",
      });
      h.client.emit("assistantTextDelta", {
        type: "assistant_text_delta",
        seq: 6,
        text: "there",
      });
    });
    expect(h.view.result.current.assistantTranscript).toBe("hi there");

    act(() => {
      h.client.emit("ttsAudio", {
        type: "tts_audio",
        seq: 7,
        mimeType: "audio/pcm",
        sampleRate: 24000,
        dataBase64: "AAAA",
      });
    });
    expect(h.view.result.current.state).toBe("speaking");
    expect(h.player.enqueued).toHaveLength(1);
    // Audio is flowing, so the avatar reads `responding` (JARVIS-1279).
    expect(useLiveVoiceStore.getState().assistantAudioActive).toBe(true);

    // tts_done awaits playback drain, then ends the session (single-utterance):
    // the socket is closed and the mic is shut down, returning to idle.
    await act(async () => {
      h.client.emit("ttsDone", { type: "tts_done", seq: 8, turnId: "t1" });
      h.player.finishPlayback();
      await Promise.resolve();
    });
    expect(h.view.result.current.state).toBe("idle");
    expect(h.client.closed).toBe(true);
    expect(h.getCapture().shutdownCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Assistant-audio activity (mid-turn tool run) — JARVIS-1279
// ---------------------------------------------------------------------------

describe("assistant-audio activity", () => {
  function emitTts(h: ReturnType<typeof renderController>, seq: number) {
    h.client.emit("ttsAudio", {
      type: "tts_audio",
      seq,
      mimeType: "audio/pcm",
      sampleRate: 24000,
      dataBase64: "AAAA",
    });
  }

  test("stays `speaking` but marks audio inactive after the idle window when the player falls silent mid-turn", async () => {
    const h = renderController();
    await startListening(h, { handsFree: true });

    act(() => {
      h.client.emit("thinking", { type: "thinking", seq: 2, turnId: "t1" });
      emitTts(h, 3);
    });
    expect(h.view.result.current.state).toBe("speaking");
    expect(useLiveVoiceStore.getState().assistantAudioActive).toBe(true);

    // The ack audio finishes but the turn stays open — the assistant is now
    // running a tool, so no `tts_done` arrives.
    act(() => {
      h.player.finishPlayback();
    });

    // After the idle grace with a silent player, audio is marked inactive while
    // the phase is still `speaking`, so the avatar can read `thinking`.
    await act(async () => {
      await sleep(650); // > ASSISTANT_AUDIO_IDLE_MS (500ms)
    });
    expect(h.view.result.current.state).toBe("speaking");
    expect(useLiveVoiceStore.getState().assistantAudioActive).toBe(false);

    // More TTS for the same turn re-activates it (back to `responding`).
    act(() => {
      emitTts(h, 4);
    });
    expect(useLiveVoiceStore.getState().assistantAudioActive).toBe(true);
  });

  test("keeps audio active across the idle window while the player is still draining", async () => {
    const h = renderController();
    await startListening(h, { handsFree: true });

    act(() => {
      h.client.emit("thinking", { type: "thinking", seq: 2, turnId: "t1" });
      emitTts(h, 3);
    });
    // FakePlayer.enqueue leaves isPlaying true; never finish playback here.
    expect(h.player.isPlaying).toBe(true);

    // The idle check fires but re-arms because audio is still playing out — the
    // avatar must not blink to `thinking` over audible speech.
    await act(async () => {
      await sleep(650);
    });
    expect(useLiveVoiceStore.getState().assistantAudioActive).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Barge-in
// ---------------------------------------------------------------------------

describe("barge-in", () => {
  test("amplitude over threshold while speaking stops playback, interrupts, and ends the session", async () => {
    const h = renderController();
    await startListening(h);

    act(() => {
      h.client.emit("thinking", { type: "thinking", seq: 2, turnId: "t1" });
      h.client.emit("ttsAudio", {
        type: "tts_audio",
        seq: 3,
        mimeType: "audio/pcm",
        sampleRate: 24000,
        dataBase64: "AAAA",
      });
    });
    expect(h.view.result.current.state).toBe("speaking");
    expect(h.player.isPlaying).toBe(true);

    act(() => {
      h.getCapture().pushAmplitude(0.2); // over BARGE_IN_AMPLITUDE_THRESHOLD
    });

    // Playback is stopped and a single interrupt is sent; the (now terminal)
    // session is then torn down → idle (mic shut down, socket closed).
    expect(h.player.isPlaying).toBe(false);
    expect(h.client.interruptCount).toBe(1);
    expect(h.view.result.current.state).toBe("idle");
    expect(h.client.closed).toBe(true);
    expect(h.getCapture().shutdownCount).toBe(1);
  });

  test("interrupt is sent at most once per response", async () => {
    const h = renderController();
    await startListening(h);

    act(() => {
      h.client.emit("thinking", { type: "thinking", seq: 2, turnId: "t1" });
      h.client.emit("ttsAudio", {
        type: "tts_audio",
        seq: 3,
        mimeType: "audio/pcm",
        sampleRate: 24000,
        dataBase64: "AAAA",
      });
      h.getCapture().pushAmplitude(0.2);
      h.getCapture().pushAmplitude(0.25);
    });

    expect(h.client.interruptCount).toBe(1);
  });

  test("realistic turn: auto-release → speaking → barge-in ends the session", async () => {
    const h = renderController();
    await startListening(h);
    const capture = h.getCapture();

    // Speak, then go silent so push-to-talk auto-releases.
    act(() => {
      capture.pushAmplitude(0.1); // speech
      capture.pushChunk(pcmChunk(200));
      capture.pushAmplitude(0.0); // trailing silence
      capture.pushChunk(pcmChunk(1000));
    });
    expect(h.client.pttReleaseCount).toBe(1);
    expect(h.view.result.current.state).toBe("transcribing");

    // Server thinks, then streams TTS — we move to speaking.
    act(() => {
      h.client.emit("thinking", { type: "thinking", seq: 4, turnId: "t1" });
      h.client.emit("ttsAudio", {
        type: "tts_audio",
        seq: 5,
        mimeType: "audio/pcm",
        sampleRate: 24000,
        dataBase64: "AAAA",
      });
    });
    expect(h.view.result.current.state).toBe("speaking");

    // The mic never stopped, so amplitude still flows while the assistant
    // speaks: a loud reading interrupts (barge-in), which ends the session.
    act(() => {
      capture.pushAmplitude(0.3); // over BARGE_IN_AMPLITUDE_THRESHOLD
    });
    expect(h.client.interruptCount).toBe(1);
    expect(h.player.isPlaying).toBe(false);
    expect(h.view.result.current.state).toBe("idle");
    expect(capture.shutdownCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Automatic push-to-talk release on silence
// ---------------------------------------------------------------------------

describe("automatic ptt_release", () => {
  test("speech followed by a silence window releases push-to-talk", async () => {
    const h = renderController();
    await startListening(h);

    // Speech: a chunk above the speech threshold accrues speech duration.
    act(() => {
      h.getCapture().pushAmplitude(0.1);
      h.getCapture().pushChunk(pcmChunk(200));
    });
    expect(h.client.pttReleaseCount).toBe(0);

    // Silence: a chunk below the speech threshold for >= 1s triggers release.
    act(() => {
      h.getCapture().pushAmplitude(0.0);
      h.getCapture().pushChunk(pcmChunk(1000));
    });

    expect(h.client.pttReleaseCount).toBe(1);
    expect(h.view.result.current.state).toBe("transcribing");
  });

  test("silence without prior speech does not release", async () => {
    const h = renderController();
    await startListening(h);

    act(() => {
      h.getCapture().pushAmplitude(0.0);
      h.getCapture().pushChunk(pcmChunk(2000));
    });

    expect(h.client.pttReleaseCount).toBe(0);
    expect(h.view.result.current.state).toBe("listening");
  });
});

// ---------------------------------------------------------------------------
// Hands-free mode (server turn detection)
// ---------------------------------------------------------------------------

describe("hands-free mode", () => {
  /** Drive one full server-VAD turn: speech → utterance end → response. */
  async function driveTurn(
    h: ReturnType<typeof renderController>,
    seq: number,
    turnId: string,
    text: string,
  ) {
    act(() => {
      h.client.emit("speechStarted", { type: "speech_started", seq });
      h.client.emit("sttPartial", {
        type: "stt_partial",
        seq: seq + 1,
        text: text.slice(0, 3),
      });
      h.client.emit("utteranceEnd", {
        type: "utterance_end",
        seq: seq + 2,
        reason: "silence",
      });
      h.client.emit("sttFinal", { type: "stt_final", seq: seq + 3, text });
      h.client.emit("thinking", { type: "thinking", seq: seq + 4, turnId });
      h.client.emit("ttsAudio", {
        type: "tts_audio",
        seq: seq + 5,
        mimeType: "audio/pcm",
        sampleRate: 24000,
        dataBase64: "AAAA",
      });
    });
    expect(h.view.result.current.state).toBe("speaking");
    await act(async () => {
      h.client.emit("ttsDone", { type: "tts_done", seq: seq + 6, turnId });
      h.player.finishPlayback();
      await Promise.resolve();
    });
  }

  test("connects with server_vad turn detection", async () => {
    const h = renderController();
    await startListening(h, { handsFree: true });

    expect(h.client.connectArgs).toEqual({
      assistantId: "assistant-1",
      conversationId: "conv-1",
      turnDetection: "server_vad",
    });
    expect(h.view.result.current.state).toBe("listening");
  });

  test("runs two full turns on one socket without a second client or ptt_release", async () => {
    const h = renderController();
    await startListening(h, { handsFree: true });

    await driveTurn(h, 2, "t1", "hello");
    // Multi-turn: tts_done drains playback but does NOT tear down.
    expect(h.view.result.current.state).toBe("listening");
    expect(h.client.closed).toBe(false);
    expect(h.getCapture().shutdownCount).toBe(0);

    // Forwarding stayed on for the whole session (full duplex).
    act(() => {
      h.getCapture().pushChunk(pcmChunk(20));
    });
    expect(h.client.sentAudio).toHaveLength(1);

    await driveTurn(h, 10, "t2", "again");
    expect(h.view.result.current.state).toBe("listening");
    expect(h.view.result.current.finalTranscript).toBe("again");

    // Same client and mic for the whole conversation; the server owns turn
    // taking (no client ptt_release), and only stop() ends the session.
    expect(h.client.pttReleaseCount).toBe(0);
    expect(h.getCapture().startCount).toBe(1);
    expect(h.client.closed).toBe(false);

    await act(async () => {
      await h.view.result.current.stop();
    });
    expect(h.view.result.current.state).toBe("idle");
    expect(h.client.ended).toBe(true);
  });

  test("speech_started resets the user transcripts for the new utterance", async () => {
    const h = renderController();
    await startListening(h, { handsFree: true });

    await driveTurn(h, 2, "t1", "hello");
    expect(h.view.result.current.finalTranscript).toBe("hello");

    act(() => {
      h.client.emit("speechStarted", { type: "speech_started", seq: 10 });
    });
    expect(h.view.result.current.finalTranscript).toBe("");
    expect(h.view.result.current.partialTranscript).toBe("");
  });

  test("speech_started while speaking stops the player and returns to listening", async () => {
    const h = renderController();
    await startListening(h, { handsFree: true });

    act(() => {
      h.client.emit("thinking", { type: "thinking", seq: 2, turnId: "t1" });
      h.client.emit("ttsAudio", {
        type: "tts_audio",
        seq: 3,
        mimeType: "audio/pcm",
        sampleRate: 24000,
        dataBase64: "AAAA",
      });
    });
    expect(h.view.result.current.state).toBe("speaking");
    expect(h.player.isPlaying).toBe(true);

    act(() => {
      h.client.emit("speechStarted", { type: "speech_started", seq: 4 });
    });

    // Tail playback is flushed immediately and the session keeps running.
    expect(h.player.isPlaying).toBe(false);
    expect(h.view.result.current.state).toBe("listening");
    expect(h.client.closed).toBe(false);
    expect(h.client.interruptCount).toBe(0);
  });

  test("turn_cancelled stops the player and returns to listening", async () => {
    const h = renderController();
    await startListening(h, { handsFree: true });

    act(() => {
      h.client.emit("thinking", { type: "thinking", seq: 2, turnId: "t1" });
      h.client.emit("ttsAudio", {
        type: "tts_audio",
        seq: 3,
        mimeType: "audio/pcm",
        sampleRate: 24000,
        dataBase64: "AAAA",
      });
    });
    expect(h.player.isPlaying).toBe(true);

    // Barge-in: speech_started precedes turn_cancelled on the wire.
    act(() => {
      h.client.emit("speechStarted", { type: "speech_started", seq: 4 });
      h.client.emit("turnCancelled", {
        type: "turn_cancelled",
        seq: 5,
        turnId: "t1",
      });
    });

    expect(h.player.isPlaying).toBe(false);
    expect(h.view.result.current.state).toBe("listening");
    expect(h.client.closed).toBe(false);

    // The session continues into the next turn on the same socket.
    act(() => {
      h.client.emit("thinking", { type: "thinking", seq: 6, turnId: "t2" });
    });
    expect(h.view.result.current.state).toBe("thinking");
  });

  test("a newer turn's thinking during the playback drain is not clobbered to listening", async () => {
    const h = renderController();
    await startListening(h, { handsFree: true });

    // Turn t1 responds with audio; tts_done arrives while playback is still
    // draining (the fake player holds the drain open until finishPlayback).
    act(() => {
      h.client.emit("thinking", { type: "thinking", seq: 2, turnId: "t1" });
      h.client.emit("ttsAudio", {
        type: "tts_audio",
        seq: 3,
        mimeType: "audio/pcm",
        sampleRate: 24000,
        dataBase64: "AAAA",
      });
    });
    expect(h.view.result.current.state).toBe("speaking");

    await act(async () => {
      h.client.emit("ttsDone", { type: "tts_done", seq: 4, turnId: "t1" });
      await Promise.resolve();
    });
    expect(h.player.isPlaying).toBe(true); // drain still pending

    // Turn t2 starts before t1's tail audio finishes playing.
    act(() => {
      h.client.emit("thinking", { type: "thinking", seq: 5, turnId: "t2" });
    });
    expect(h.view.result.current.state).toBe("thinking");

    await act(async () => {
      h.player.finishPlayback();
      await Promise.resolve();
    });

    // t1's post-drain transition must not hide that t2 is generating.
    expect(h.view.result.current.state).toBe("thinking");
    expect(h.client.closed).toBe(false);
  });

  test("the next utterance's stt_final during the playback drain is not clobbered to listening", async () => {
    const h = renderController();
    await startListening(h, { handsFree: true });

    // Turn t1 responds with audio; tts_done arrives while playback is still
    // draining (the fake player holds the drain open until finishPlayback).
    act(() => {
      h.client.emit("thinking", { type: "thinking", seq: 2, turnId: "t1" });
      h.client.emit("ttsAudio", {
        type: "tts_audio",
        seq: 3,
        mimeType: "audio/pcm",
        sampleRate: 24000,
        dataBase64: "AAAA",
      });
    });
    expect(h.view.result.current.state).toBe("speaking");

    await act(async () => {
      h.client.emit("ttsDone", { type: "tts_done", seq: 4, turnId: "t1" });
      await Promise.resolve();
    });
    expect(h.player.isPlaying).toBe(true); // drain still pending

    // The next utterance finishes transcribing before t1's tail audio drains
    // and before the server's `thinking` frame for t2 arrives. (No
    // speech_started here: it would flush playback and resolve the drain
    // early; batched frames collapse to this same ordering.)
    act(() => {
      h.client.emit("utteranceEnd", {
        type: "utterance_end",
        seq: 5,
        reason: "silence",
      });
      h.client.emit("sttFinal", { type: "stt_final", seq: 6, text: "again" });
    });
    expect(h.view.result.current.state).toBe("thinking");
    expect(h.player.isPlaying).toBe(true); // t1's drain still pending

    await act(async () => {
      h.player.finishPlayback();
      await Promise.resolve();
    });

    // t1's post-drain transition must not hide the in-flight next turn.
    expect(h.view.result.current.state).toBe("thinking");

    // The server's thinking frame for t2 then lands normally.
    act(() => {
      h.client.emit("thinking", { type: "thinking", seq: 7, turnId: "t2" });
    });
    expect(h.view.result.current.state).toBe("thinking");
    expect(h.client.closed).toBe(false);
  });

  test("a turn with no audio still cycles back to listening after tts_done", async () => {
    const h = renderController();
    await startListening(h, { handsFree: true });

    act(() => {
      h.client.emit("thinking", { type: "thinking", seq: 2, turnId: "t1" });
    });
    expect(h.view.result.current.state).toBe("thinking");

    // No tts_audio for this turn: the drain resolves immediately and the same
    // turn's `thinking` cycles back to `listening`.
    await act(async () => {
      h.client.emit("ttsDone", { type: "tts_done", seq: 3, turnId: "t1" });
      await Promise.resolve();
    });
    expect(h.view.result.current.state).toBe("listening");
  });

  test("client-local silence auto-release is inactive", async () => {
    const h = renderController();
    await startListening(h, { handsFree: true });

    // Speech followed by a silence window well past the manual-mode release
    // threshold: the server owns utterance boundaries, so no ptt_release.
    act(() => {
      h.getCapture().pushAmplitude(0.1);
      h.getCapture().pushChunk(pcmChunk(200));
      h.getCapture().pushAmplitude(0.0);
      h.getCapture().pushChunk(pcmChunk(2000));
    });

    expect(h.client.pttReleaseCount).toBe(0);
    expect(h.view.result.current.state).toBe("listening");
    // Audio (speech and silence) keeps streaming to the server VAD.
    expect(h.client.sentAudio).toHaveLength(2);
  });

  test("client-local amplitude barge-in is inactive while the assistant speaks", async () => {
    const h = renderController();
    await startListening(h, { handsFree: true });

    act(() => {
      h.client.emit("thinking", { type: "thinking", seq: 2, turnId: "t1" });
      h.client.emit("ttsAudio", {
        type: "tts_audio",
        seq: 3,
        mimeType: "audio/pcm",
        sampleRate: 24000,
        dataBase64: "AAAA",
      });
    });
    expect(h.view.result.current.state).toBe("speaking");

    act(() => {
      h.getCapture().pushAmplitude(0.3); // over BARGE_IN_AMPLITUDE_THRESHOLD
    });

    // The server detects barge-in from the forwarded audio; the client never
    // interrupts or stops playback on amplitude alone.
    expect(h.client.interruptCount).toBe(0);
    expect(h.player.isPlaying).toBe(true);
    expect(h.view.result.current.state).toBe("speaking");
  });

  // controls.release in hands-free is covered by the dedicated
  // "hands-free session controls" suite below: it sends ptt_release (the
  // daemon honors it as a manual VAD override) while leaving forwarding and
  // local state untouched.
});

// ---------------------------------------------------------------------------
// Version skew: hands-free against an older daemon
// ---------------------------------------------------------------------------

describe("hands-free session controls (send now / stop response / mute)", () => {
  function controls() {
    const c = useLiveVoiceStore.getState().controls;
    expect(c).not.toBeNull();
    return c!;
  }

  /** Drive the session into `speaking` with one thinking + tts frame. */
  function driveToSpeaking(h: ReturnType<typeof renderController>, turnId = "t1") {
    act(() => {
      h.client.emit("thinking", { type: "thinking", seq: 2, turnId });
      h.client.emit("ttsAudio", {
        type: "tts_audio",
        seq: 3,
        mimeType: "audio/pcm",
        sampleRate: 24000,
        dataBase64: "AAAA",
      });
    });
    expect(h.view.result.current.state).toBe("speaking");
  }

  test("release while listening sends ptt_release and leaves forwarding on", async () => {
    const h = renderController();
    await startListening(h, { handsFree: true });

    act(() => controls().release());
    expect(h.client.pttReleaseCount).toBe(1);
    // The state transition is frame-driven — the daemon's utterance_end owns
    // it — and forwarding must stay on (the hands-free listening return never
    // re-enables it, so flipping it off would strand the session).
    expect(h.view.result.current.state).toBe("listening");
    act(() => {
      h.getCapture().pushChunk(pcmChunk(20));
    });
    expect(h.client.sentAudio).toHaveLength(1);

    act(() => {
      h.client.emit("utteranceEnd", {
        type: "utterance_end",
        seq: 2,
        reason: "silence",
      });
    });
    expect(h.view.result.current.state).toBe("transcribing");
  });

  test("release is a no-op outside listening", async () => {
    const h = renderController();
    await startListening(h, { handsFree: true });
    driveToSpeaking(h);

    act(() => controls().release());
    expect(h.client.pttReleaseCount).toBe(0);
  });

  test("stop response while speaking is turn-scoped: playback flushes, session survives", async () => {
    const h = renderController();
    await startListening(h, { handsFree: true });
    driveToSpeaking(h);

    act(() => controls().interrupt());
    expect(h.client.interruptCount).toBe(1);
    expect(h.player.stopCount).toBeGreaterThan(0);
    // NOT torn down: same socket, mic still open and streaming.
    expect(h.view.result.current.state).toBe("listening");
    expect(h.client.closed).toBe(false);
    expect(h.getCapture().shutdownCount).toBe(0);
    act(() => {
      h.getCapture().pushChunk(pcmChunk(20));
    });
    expect(h.client.sentAudio).toHaveLength(1);
  });

  test("straggler tts_audio after a client interrupt is dropped until the next turn", async () => {
    const h = renderController();
    await startListening(h, { handsFree: true });
    driveToSpeaking(h);
    expect(h.player.enqueued).toHaveLength(1);

    act(() => controls().interrupt());
    // A frame already in transit when the interrupt was sent must not
    // resurrect playback.
    act(() => {
      h.client.emit("ttsAudio", {
        type: "tts_audio",
        seq: 4,
        mimeType: "audio/pcm",
        sampleRate: 24000,
        dataBase64: "AAAA",
      });
    });
    expect(h.player.enqueued).toHaveLength(1);
    expect(h.view.result.current.state).toBe("listening");

    // The next turn lifts the guard.
    act(() => {
      h.client.emit("thinking", { type: "thinking", seq: 5, turnId: "t2" });
      h.client.emit("ttsAudio", {
        type: "tts_audio",
        seq: 6,
        mimeType: "audio/pcm",
        sampleRate: 24000,
        dataBase64: "AAAA",
      });
    });
    expect(h.player.enqueued).toHaveLength(2);
    expect(h.view.result.current.state).toBe("speaking");
  });

  test("straggler assistant_text_delta after a client interrupt is dropped until the next turn", async () => {
    const h = renderController();
    await startListening(h, { handsFree: true });
    driveToSpeaking(h);

    act(() => controls().interrupt());
    expect(h.view.result.current.state).toBe("listening");
    // A delta already in transit for the cancelled turn must not append its
    // text or drag the flushed `listening` back to `thinking`.
    act(() => {
      h.client.emit("assistantTextDelta", {
        type: "assistant_text_delta",
        seq: 4,
        text: "cancelled tail",
      });
    });
    expect(h.view.result.current.state).toBe("listening");
    expect(useLiveVoiceStore.getState().assistantTranscript).not.toContain(
      "cancelled tail",
    );

    // The next turn lifts the guard: its deltas apply again.
    act(() => {
      h.client.emit("thinking", { type: "thinking", seq: 5, turnId: "t2" });
      h.client.emit("assistantTextDelta", {
        type: "assistant_text_delta",
        seq: 6,
        text: "next turn",
      });
    });
    expect(useLiveVoiceStore.getState().assistantTranscript).toBe("next turn");
  });

  test("stop response is a no-op while not speaking", async () => {
    const h = renderController();
    await startListening(h, { handsFree: true });

    act(() => controls().interrupt());
    expect(h.client.interruptCount).toBe(0);
    expect(h.view.result.current.state).toBe("listening");
  });

  test("mute streams silence of equal length and pins amplitude to 0; unmute restores", async () => {
    const h = renderController();
    await startListening(h, { handsFree: true });

    act(() => {
      h.getCapture().pushAmplitude(0.5);
    });
    expect(useLiveVoiceStore.getState().inputAmplitude).toBeCloseTo(0.5);

    act(() => controls().setMuted(true));
    expect(useLiveVoiceStore.getState().muted).toBe(true);
    // Muting zeroes the published amplitude immediately and pins later samples.
    expect(useLiveVoiceStore.getState().inputAmplitude).toBe(0);
    act(() => {
      h.getCapture().pushAmplitude(0.7);
    });
    expect(useLiveVoiceStore.getState().inputAmplitude).toBe(0);

    // Chunks keep flowing (VAD/STT keepalive) but as silence, same length.
    const loud = new Int16Array(320).fill(1234).buffer;
    act(() => {
      h.getCapture().pushChunk(loud);
    });
    expect(h.client.sentAudio).toHaveLength(1);
    const sent = new Int16Array(h.client.sentAudio[0]!);
    expect(sent).toHaveLength(320);
    expect(sent.every((sample) => sample === 0)).toBe(true);

    act(() => controls().setMuted(false));
    act(() => {
      h.getCapture().pushChunk(loud);
      h.getCapture().pushAmplitude(0.4);
    });
    expect(new Int16Array(h.client.sentAudio[1]!)[0]).toBe(1234);
    expect(useLiveVoiceStore.getState().inputAmplitude).toBeCloseTo(0.4);
  });

  test("muted survives a retryable reconnect — no hot mic after a blip", async () => {
    const h = renderController({ reconnectBackoffMs: [10] });
    await startListening(h, { handsFree: true });
    act(() => controls().setMuted(true));

    await act(async () => {
      h.client.emit("closed", {
        code: 1013,
        reason: "assistant tunnel disconnected",
      });
    });
    await act(async () => {
      await sleep(40);
    });
    await act(async () => {
      h.client.emit("ready", {
        type: "ready",
        seq: 1,
        sessionId: "s2",
        conversationId: "conv-1",
        turnDetection: "server_vad",
      });
      await Promise.resolve();
    });
    expect(h.view.result.current.state).toBe("listening");
    expect(useLiveVoiceStore.getState().muted).toBe(true);
  });

  test("publishes handsFree to the store, downgraded on the version-skew fallback", async () => {
    const h = renderController();
    // Ready echoes manual — an older daemon ignored turnDetection.
    await act(async () => {
      await h.view.result.current.start("assistant-1", "conv-1", {
        handsFree: true,
      });
    });
    expect(useLiveVoiceStore.getState().handsFree).toBe(true);
    await act(async () => {
      h.client.emit("ready", {
        type: "ready",
        seq: 1,
        sessionId: "s1",
        conversationId: "conv-1",
        turnDetection: "manual",
      });
      await Promise.resolve();
    });
    expect(useLiveVoiceStore.getState().handsFree).toBe(false);
  });
});

describe("hands-free fallback to manual (older daemon)", () => {
  test("ready without turnDetection re-enables auto-release, amplitude barge-in, and single-turn teardown", async () => {
    const h = renderController();
    await act(async () => {
      await h.view.result.current.start("assistant-1", "conv-1", {
        handsFree: true,
      });
    });
    // An older daemon ignores the requested server_vad and never echoes it.
    await act(async () => {
      h.client.emit("ready", {
        type: "ready",
        seq: 1,
        sessionId: "s1",
        conversationId: "conv-1",
      });
      await Promise.resolve();
    });
    expect(h.client.connectArgs).toMatchObject({ turnDetection: "server_vad" });
    expect(h.view.result.current.state).toBe("listening");

    // Client-local silence auto-release fires again (manual behavior).
    act(() => {
      h.getCapture().pushAmplitude(0.1);
      h.getCapture().pushChunk(pcmChunk(200));
      h.getCapture().pushAmplitude(0.0);
      h.getCapture().pushChunk(pcmChunk(1000));
    });
    expect(h.client.pttReleaseCount).toBe(1);
    expect(h.view.result.current.state).toBe("transcribing");

    // Client-local amplitude barge-in fires again and ends the (manual,
    // single-turn) session — no silent hang against the older daemon.
    act(() => {
      h.client.emit("thinking", { type: "thinking", seq: 2, turnId: "t1" });
      h.client.emit("ttsAudio", {
        type: "tts_audio",
        seq: 3,
        mimeType: "audio/pcm",
        sampleRate: 24000,
        dataBase64: "AAAA",
      });
    });
    expect(h.view.result.current.state).toBe("speaking");
    act(() => {
      h.getCapture().pushAmplitude(0.3);
    });
    expect(h.client.interruptCount).toBe(1);
    expect(h.view.result.current.state).toBe("idle");
    expect(h.client.closed).toBe(true);
  });

  test("ready echoing server_vad keeps hands-free behaviors disabled", async () => {
    const h = renderController();
    await startListening(h, { handsFree: true });

    act(() => {
      h.getCapture().pushAmplitude(0.1);
      h.getCapture().pushChunk(pcmChunk(200));
      h.getCapture().pushAmplitude(0.0);
      h.getCapture().pushChunk(pcmChunk(2000));
    });

    expect(h.client.pttReleaseCount).toBe(0);
    expect(h.view.result.current.state).toBe("listening");
  });
});

// ---------------------------------------------------------------------------
// Recoverable errors (hands-free survives; manual stays fatal)
// ---------------------------------------------------------------------------

describe("recoverable errors", () => {
  test("hands-free: a recoverable error returns to listening and the session continues", async () => {
    const h = renderController();
    await startListening(h, { handsFree: true });

    act(() => {
      h.client.emit("utteranceEnd", {
        type: "utterance_end",
        seq: 2,
        reason: "silence",
      });
    });
    expect(h.view.result.current.state).toBe("transcribing");

    act(() => {
      h.client.emit("error", {
        reason: "protocol-error",
        message: "whisper poll failed",
        recoverable: true,
      });
    });

    expect(h.view.result.current.state).toBe("listening");
    expect(h.view.result.current.error).toBe(null);
    expect(h.client.closed).toBe(false);
    expect(h.getCapture().shutdownCount).toBe(0);

    // The conversation keeps going on the same socket.
    act(() => {
      h.client.emit("thinking", { type: "thinking", seq: 3, turnId: "t1" });
    });
    expect(h.view.result.current.state).toBe("thinking");
  });

  test("hands-free: a recoverable error mid-turn leaves the current status alone", async () => {
    const h = renderController();
    await startListening(h, { handsFree: true });

    act(() => {
      h.client.emit("thinking", { type: "thinking", seq: 2, turnId: "t1" });
    });
    act(() => {
      h.client.emit("error", {
        reason: "protocol-error",
        message: "one TTS segment failed",
        recoverable: true,
      });
    });

    expect(h.view.result.current.state).toBe("thinking");
    expect(h.client.closed).toBe(false);
  });

  test("manual mode: a recoverable error is still fatal", async () => {
    const h = renderController();
    await startListening(h);

    act(() => {
      h.client.emit("error", {
        reason: "protocol-error",
        message: "transient blip",
        recoverable: true,
      });
    });

    expect(h.view.result.current.state).toBe("failed");
    expect(h.view.result.current.error).toBe("transient blip");
    expect(h.client.closed).toBe(true);
    expect(h.getCapture().shutdownCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// utterance_discarded (hands-free)
// ---------------------------------------------------------------------------

describe("utterance_discarded", () => {
  test("a noise-only utterance returns to listening instead of sticking in transcribing", async () => {
    const h = renderController();
    await startListening(h, { handsFree: true });

    act(() => {
      h.client.emit("speechStarted", { type: "speech_started", seq: 2 });
      h.client.emit("utteranceEnd", {
        type: "utterance_end",
        seq: 3,
        reason: "silence",
      });
    });
    expect(h.view.result.current.state).toBe("transcribing");

    // A whitespace-only final never starts a server turn; stay transcribing
    // so the discard can safely resolve the utterance.
    act(() => {
      h.client.emit("sttFinal", { type: "stt_final", seq: 4, text: " " });
    });
    expect(h.view.result.current.state).toBe("transcribing");

    act(() => {
      h.client.emit("utteranceDiscarded", {
        type: "utterance_discarded",
        seq: 5,
      });
    });
    expect(h.view.result.current.state).toBe("listening");
    expect(h.client.closed).toBe(false);
  });

  test("does not clobber a newer turn's thinking", async () => {
    const h = renderController();
    await startListening(h, { handsFree: true });

    act(() => {
      h.client.emit("utteranceEnd", {
        type: "utterance_end",
        seq: 2,
        reason: "silence",
      });
    });
    // A newer utterance's turn starts before the stale discard arrives.
    act(() => {
      h.client.emit("thinking", { type: "thinking", seq: 3, turnId: "t2" });
    });
    expect(h.view.result.current.state).toBe("thinking");

    act(() => {
      h.client.emit("utteranceDiscarded", {
        type: "utterance_discarded",
        seq: 4,
      });
    });
    expect(h.view.result.current.state).toBe("thinking");
  });
});

// ---------------------------------------------------------------------------
// Turn latency (server metrics frame + client-heard measurement)
// ---------------------------------------------------------------------------

describe("turn latency", () => {
  /** Aggregate fields every server `metrics` frame carries. */
  const METRICS_FIELDS = {
    sttMs: 420,
    llmFirstDeltaMs: 600,
    ttsFirstAudioMs: 300,
    totalMs: 2100,
  };

  // Silence the per-turn `[live-voice] turn latency` debug line and let tests
  // assert on it.
  let debugSpy: ReturnType<typeof spyOn>;
  beforeEach(() => {
    debugSpy = spyOn(console, "debug").mockImplementation(() => {});
  });
  afterEach(() => {
    debugSpy.mockRestore();
  });

  const latencyLogs = () =>
    debugSpy.mock.calls.filter(
      (call: unknown[]) => call[0] === "[live-voice] turn latency",
    );

  test("hands-free: utterance_end → first tts_audio produces a positive clientHeardLatencyMs", async () => {
    const h = renderController();
    await startListening(h, { handsFree: true });

    act(() => {
      h.client.emit("utteranceEnd", {
        type: "utterance_end",
        seq: 2,
        reason: "silence",
      });
    });
    // Real time elapses between end-of-speech and the response's first audio.
    await act(async () => {
      await sleep(10);
    });
    act(() => {
      h.client.emit("thinking", { type: "thinking", seq: 3, turnId: "t1" });
      h.client.emit("ttsAudio", {
        type: "tts_audio",
        seq: 4,
        mimeType: "audio/pcm",
        sampleRate: 24000,
        dataBase64: "AAAA",
      });
    });

    const latency = useLiveVoiceStore.getState().lastTurnLatency;
    expect(latency).not.toBeNull();
    expect(latency!.clientHeardLatencyMs).toBeGreaterThan(0);
    // No metrics frame yet: only the client half is known.
    expect(latency!.server).toBeNull();

    // A second tts_audio frame of the same response does not re-measure:
    // the store still holds the exact object written on the first frame.
    act(() => {
      h.client.emit("ttsAudio", {
        type: "tts_audio",
        seq: 5,
        mimeType: "audio/pcm",
        sampleRate: 24000,
        dataBase64: "AAAA",
      });
    });
    expect(useLiveVoiceStore.getState().lastTurnLatency).toBe(latency!);
  });

  test("manual: ptt_release → first tts_audio produces a positive clientHeardLatencyMs", async () => {
    const h = renderController();
    await startListening(h);

    act(() => {
      useLiveVoiceStore.getState().controls?.release();
    });
    expect(h.client.pttReleaseCount).toBe(1);
    await act(async () => {
      await sleep(10);
    });
    act(() => {
      h.client.emit("thinking", { type: "thinking", seq: 2, turnId: "t1" });
      h.client.emit("ttsAudio", {
        type: "tts_audio",
        seq: 3,
        mimeType: "audio/pcm",
        sampleRate: 24000,
        dataBase64: "AAAA",
      });
    });

    expect(
      useLiveVoiceStore.getState().lastTurnLatency?.clientHeardLatencyMs,
    ).toBeGreaterThan(0);
  });

  test("a metrics frame pairs the server metrics with the client measurement and logs once", async () => {
    const h = renderController();
    await startListening(h, { handsFree: true });

    act(() => {
      h.client.emit("utteranceEnd", {
        type: "utterance_end",
        seq: 2,
        reason: "silence",
      });
      h.client.emit("sttFinal", { type: "stt_final", seq: 3, text: "hello" });
    });
    await act(async () => {
      await sleep(10);
    });
    act(() => {
      h.client.emit("thinking", { type: "thinking", seq: 4, turnId: "t1" });
      h.client.emit("ttsAudio", {
        type: "tts_audio",
        seq: 5,
        mimeType: "audio/pcm",
        sampleRate: 24000,
        dataBase64: "AAAA",
      });
    });
    await act(async () => {
      h.client.emit("ttsDone", { type: "tts_done", seq: 6, turnId: "t1" });
      h.player.finishPlayback();
      await Promise.resolve();
    });

    act(() => {
      h.client.emit("metrics", {
        type: "metrics",
        seq: 7,
        turnId: "t1",
        ...METRICS_FIELDS,
        roundTripMs: 750,
      });
    });

    const latency = useLiveVoiceStore.getState().lastTurnLatency;
    expect(latency?.server?.turnId).toBe("t1");
    expect(latency?.server?.roundTripMs).toBe(750);
    expect(latency?.clientHeardLatencyMs).toBeGreaterThan(0);

    // Exactly one debug line per completed turn, carrying both halves.
    const logs = latencyLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]![1]).toMatchObject({
      turnId: "t1",
      roundTripMs: 750,
      clientHeardLatencyMs: latency!.clientHeardLatencyMs,
    });
  });

  test("an absent roundTripMs (older daemon) is stored and logged as null", async () => {
    const h = renderController();
    await startListening(h, { handsFree: true });

    // An older daemon's metrics frame predates the field entirely.
    act(() => {
      h.client.emit("metrics", {
        type: "metrics",
        seq: 2,
        turnId: "t1",
        ...METRICS_FIELDS,
      });
    });

    const latency = useLiveVoiceStore.getState().lastTurnLatency;
    expect(latency?.server?.roundTripMs).toBeNull();
    expect(latency?.clientHeardLatencyMs).toBeNull();
    const logs = latencyLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]![1]).toMatchObject({ roundTripMs: null });
  });

  test("turn_cancelled clears the pending stamp so it never pairs across turns", async () => {
    const h = renderController();
    await startListening(h, { handsFree: true });

    // The utterance ends (stamp set)…
    act(() => {
      h.client.emit("utteranceEnd", {
        type: "utterance_end",
        seq: 2,
        reason: "silence",
      });
      h.client.emit("sttFinal", { type: "stt_final", seq: 3, text: "hello" });
      h.client.emit("thinking", { type: "thinking", seq: 4, turnId: "t1" });
    });
    // …but the turn is barged in and cancelled before any audio.
    act(() => {
      h.client.emit("speechStarted", { type: "speech_started", seq: 5 });
      h.client.emit("turnCancelled", {
        type: "turn_cancelled",
        seq: 6,
        turnId: "t1",
      });
    });

    await act(async () => {
      await sleep(10);
    });
    // The next turn's first audio must not pair with the dead stamp.
    act(() => {
      h.client.emit("thinking", { type: "thinking", seq: 7, turnId: "t2" });
      h.client.emit("ttsAudio", {
        type: "tts_audio",
        seq: 8,
        mimeType: "audio/pcm",
        sampleRate: 24000,
        dataBase64: "AAAA",
      });
    });
    expect(useLiveVoiceStore.getState().lastTurnLatency).toBeNull();
  });

  test("utterance_discarded clears the pending stamp", async () => {
    const h = renderController();
    await startListening(h, { handsFree: true });

    // A noise-only utterance is closed (stamp set) and then discarded.
    act(() => {
      h.client.emit("utteranceEnd", {
        type: "utterance_end",
        seq: 2,
        reason: "silence",
      });
      h.client.emit("sttFinal", { type: "stt_final", seq: 3, text: " " });
      h.client.emit("utteranceDiscarded", {
        type: "utterance_discarded",
        seq: 4,
      });
    });

    await act(async () => {
      await sleep(10);
    });
    // A later turn's audio (here without its own utterance_end, so no fresh
    // stamp) must not measure against the discarded utterance's stamp.
    act(() => {
      h.client.emit("thinking", { type: "thinking", seq: 5, turnId: "t1" });
      h.client.emit("ttsAudio", {
        type: "tts_audio",
        seq: 6,
        mimeType: "audio/pcm",
        sampleRate: 24000,
        dataBase64: "AAAA",
      });
    });
    expect(useLiveVoiceStore.getState().lastTurnLatency).toBeNull();
  });

  test("an utterance ending mid-thinking keeps its stamp for its own turn", async () => {
    const h = renderController();
    await startListening(h, { handsFree: true });

    // Utterance A ends and its turn t1 starts thinking.
    act(() => {
      h.client.emit("utteranceEnd", {
        type: "utterance_end",
        seq: 2,
        reason: "silence",
      });
      h.client.emit("thinking", { type: "thinking", seq: 3, turnId: "t1" });
    });
    // Utterance B ends while t1 is still thinking (allowed in hands-free —
    // no turn_cancelled follows a pre-audio overlap).
    act(() => {
      h.client.emit("speechStarted", { type: "speech_started", seq: 4 });
      h.client.emit("utteranceEnd", {
        type: "utterance_end",
        seq: 5,
        reason: "silence",
      });
    });
    await act(async () => {
      await sleep(10);
    });
    // t1's first audio measures against A's bound stamp — it must not
    // consume B's pending one.
    act(() => {
      h.client.emit("ttsAudio", {
        type: "tts_audio",
        seq: 6,
        mimeType: "audio/pcm",
        sampleRate: 24000,
        dataBase64: "AAAA",
      });
    });
    expect(
      useLiveVoiceStore.getState().lastTurnLatency?.clientHeardLatencyMs,
    ).toBeGreaterThan(0);

    // B's own turn still gets a measurement from B's stamp.
    await act(async () => {
      await sleep(10);
    });
    act(() => {
      h.client.emit("thinking", { type: "thinking", seq: 7, turnId: "t2" });
      h.client.emit("ttsAudio", {
        type: "tts_audio",
        seq: 8,
        mimeType: "audio/pcm",
        sampleRate: 24000,
        dataBase64: "AAAA",
      });
    });
    expect(
      useLiveVoiceStore.getState().lastTurnLatency?.clientHeardLatencyMs,
    ).toBeGreaterThan(0);
  });

  test("a cancelled turn leaves the overlapping utterance's pending stamp intact", async () => {
    const h = renderController();
    await startListening(h, { handsFree: true });

    // Utterance A → t1 thinking; utterance B ends mid-thinking; t1 cancelled.
    act(() => {
      h.client.emit("utteranceEnd", {
        type: "utterance_end",
        seq: 2,
        reason: "silence",
      });
      h.client.emit("thinking", { type: "thinking", seq: 3, turnId: "t1" });
      h.client.emit("utteranceEnd", {
        type: "utterance_end",
        seq: 4,
        reason: "silence",
      });
      h.client.emit("turnCancelled", {
        type: "turn_cancelled",
        seq: 5,
        turnId: "t1",
      });
    });
    await act(async () => {
      await sleep(10);
    });
    // B's turn still measures — cancellation only dropped t1's bound stamp.
    act(() => {
      h.client.emit("thinking", { type: "thinking", seq: 6, turnId: "t2" });
      h.client.emit("ttsAudio", {
        type: "tts_audio",
        seq: 7,
        mimeType: "audio/pcm",
        sampleRate: 24000,
        dataBase64: "AAAA",
      });
    });
    expect(
      useLiveVoiceStore.getState().lastTurnLatency?.clientHeardLatencyMs,
    ).toBeGreaterThan(0);
  });

  test("metrics frames for cancelled turns and session end are ignored", async () => {
    const h = renderController();
    await startListening(h, { handsFree: true });

    act(() => {
      h.client.emit("metrics", {
        type: "metrics",
        seq: 2,
        event: "turn_cancelled",
        turnId: "t1",
        ...METRICS_FIELDS,
        roundTripMs: 500,
      });
      h.client.emit("metrics", {
        type: "metrics",
        seq: 3,
        event: "session_ended",
        turnId: "t1",
        ...METRICS_FIELDS,
        roundTripMs: 500,
      });
    });
    expect(useLiveVoiceStore.getState().lastTurnLatency).toBeNull();
    expect(latencyLogs()).toHaveLength(0);

    // A completed-turn frame still lands.
    act(() => {
      h.client.emit("metrics", {
        type: "metrics",
        seq: 4,
        event: "turn_completed",
        turnId: "t2",
        ...METRICS_FIELDS,
        roundTripMs: 640,
      });
    });
    expect(
      useLiveVoiceStore.getState().lastTurnLatency?.server?.roundTripMs,
    ).toBe(640);
    expect(latencyLogs()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Failure paths
// ---------------------------------------------------------------------------

describe("failure", () => {
  test("error frame transitions to failed with the message and tears down", async () => {
    const h = renderController();
    await startListening(h);

    act(() => {
      const err: LiveVoiceClientError = {
        reason: "protocol-error",
        message: "kaboom",
      };
      h.client.emit("error", err);
    });

    expect(h.view.result.current.state).toBe("failed");
    expect(h.view.result.current.error).toBe("kaboom");
    expect(h.client.closed).toBe(true);
    expect(h.getCapture().shutdownCount).toBe(1);
  });

  test("busy frame fails the session", async () => {
    const h = renderController();
    await startListening(h);

    act(() => {
      h.client.emit("busy", {
        type: "busy",
        seq: 2,
        activeSessionId: "other",
      });
    });

    expect(h.view.result.current.state).toBe("failed");
    expect(h.view.result.current.error).toBe(
      "Another live-voice session is active.",
    );
  });

  test("mic denial before ready fails the session and closes the socket", async () => {
    // Capture starts at connect time, so the denial must be configured at
    // creation — it resolves while the server's `ready` is still in flight.
    const h = renderController({
      onCaptureCreated: (capture) => {
        capture.startResult = { ok: false, error: "permission-denied" };
      },
    });
    await act(async () => {
      await h.view.result.current.start("assistant-1");
    });
    // The denial resolved pre-`ready`; the failure surfaces when `ready`
    // processes the capture result (same user-facing error as before).
    expect(h.view.result.current.state).toBe("connecting");
    await act(async () => {
      h.client.emit("ready", {
        type: "ready",
        seq: 1,
        sessionId: "s1",
        conversationId: "conv-1",
      });
      await Promise.resolve();
    });

    expect(h.view.result.current.state).toBe("failed");
    expect(h.view.result.current.error).toBe(
      "Microphone capture could not start.",
    );
    expect(h.client.closed).toBe(true);
    // No audio frame was ever sent on the failed session.
    expect(h.client.sentAudio).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Concurrent mic acquisition (capture overlaps the connect / ready chain)
// ---------------------------------------------------------------------------

describe("concurrent mic acquisition", () => {
  test("capture starts at connect time, before the server sends ready, and no audio is forwarded pre-ready", async () => {
    const h = renderController();
    await act(async () => {
      await h.view.result.current.start("assistant-1", "conv-1", {
        handsFree: true,
      });
    });

    // Mic acquisition already kicked off, concurrent with the connect...
    expect(h.getCapture().startCount).toBe(1);
    expect(h.view.result.current.state).toBe("connecting");

    // ...but forwarding is held: a chunk produced pre-`ready` is never sent.
    act(() => {
      h.getCapture().pushChunk(pcmChunk(20));
    });
    expect(h.client.sentAudio).toHaveLength(0);

    await act(async () => {
      h.client.emit("ready", {
        type: "ready",
        seq: 1,
        sessionId: "s1",
        conversationId: "conv-1",
        turnDetection: "server_vad",
      });
      await Promise.resolve();
    });
    expect(h.view.result.current.state).toBe("listening");
    // `ready` did not start a second acquisition; forwarding is now on.
    expect(h.getCapture().startCount).toBe(1);
    act(() => {
      h.getCapture().pushChunk(pcmChunk(20));
    });
    expect(h.client.sentAudio).toHaveLength(1);
  });

  test("ready arriving before the capture resolves still ends in listening with forwarding on", async () => {
    const h = renderController({
      onCaptureCreated: (capture) => {
        capture.deferStart = true;
      },
    });
    await act(async () => {
      await h.view.result.current.start("assistant-1", "conv-1", {
        handsFree: true,
      });
    });
    expect(h.getCapture().startCount).toBe(1);

    // `ready` lands while getUserMedia is still pending: the session waits in
    // `connecting` and nothing is sent.
    await act(async () => {
      h.client.emit("ready", {
        type: "ready",
        seq: 1,
        sessionId: "s1",
        conversationId: "conv-1",
        turnDetection: "server_vad",
      });
      await flushMicrotasks();
    });
    expect(h.view.result.current.state).toBe("connecting");
    expect(h.client.sentAudio).toHaveLength(0);

    // The mic resolves → the ready handler's await completes → listening.
    await act(async () => {
      h.getCapture().resolveStart();
      await flushMicrotasks();
    });
    expect(h.view.result.current.state).toBe("listening");
    act(() => {
      h.getCapture().pushChunk(pcmChunk(20));
    });
    expect(h.client.sentAudio).toHaveLength(1);
  });

  test("mic denial resolving after ready fails the session and closes the socket", async () => {
    const h = renderController({
      onCaptureCreated: (capture) => {
        capture.deferStart = true;
        capture.startResult = { ok: false, error: "permission-denied" };
      },
    });
    await act(async () => {
      await h.view.result.current.start("assistant-1", "conv-1", {
        handsFree: true,
      });
    });
    await act(async () => {
      h.client.emit("ready", {
        type: "ready",
        seq: 1,
        sessionId: "s1",
        conversationId: "conv-1",
        turnDetection: "server_vad",
      });
      await flushMicrotasks();
    });
    expect(h.view.result.current.state).toBe("connecting");

    await act(async () => {
      h.getCapture().resolveStart();
      await flushMicrotasks();
    });
    expect(h.view.result.current.state).toBe("failed");
    expect(h.view.result.current.error).toBe(
      "Microphone capture could not start.",
    );
    expect(h.client.closed).toBe(true);
    expect(h.client.sentAudio).toHaveLength(0);
  });

  test("teardown during acquisition stops tracks once the capture resolves (leak-free)", async () => {
    const h = renderController({
      onCaptureCreated: (capture) => {
        capture.deferStart = true;
      },
    });
    await act(async () => {
      await h.view.result.current.start("assistant-1", "conv-1", {
        handsFree: true,
      });
    });
    const capture = h.getCapture();
    expect(capture.startCount).toBe(1);

    // Teardown (unmount) while getUserMedia is still pending: shutdown() runs
    // before there are tracks to stop.
    act(() => {
      h.view.unmount();
    });
    expect(capture.shutdownCount).toBe(1);
    expect(capture.stopCount).toBe(0);

    // The acquisition resolves after the session died — the settle hook must
    // release the MediaStream it just opened.
    await act(async () => {
      capture.resolveStart();
      await flushMicrotasks();
    });
    expect(capture.stopCount).toBe(1);
    // Nothing was ever forwarded on the dead session.
    expect(h.client.sentAudio).toHaveLength(0);
  });

  test("a hands-free reconnect attempt starts its fresh capture exactly once (no double-start)", async () => {
    const h = renderController({ reconnectBackoffMs: [20, 40, 60] });
    await startListening(h, { handsFree: true });
    const firstCapture = h.getCapture();
    expect(firstCapture.startCount).toBe(1);

    // Retryable tunnel drop → the dead session's capture is disposed and a
    // reconnect is scheduled.
    await act(async () => {
      h.client.emit("closed", { code: 1013, reason: "tunnel disconnected" });
    });
    expect(firstCapture.shutdownCount).toBe(1);

    // Backoff elapses → the fresh attempt acquires its own mic concurrently
    // with the reconnect, before its `ready`.
    await act(async () => {
      await sleep(40);
    });
    const secondCapture = h.getCapture();
    expect(secondCapture).not.toBe(firstCapture);
    expect(secondCapture.startCount).toBe(1);

    await act(async () => {
      h.client.emit("ready", {
        type: "ready",
        seq: 1,
        sessionId: "s2",
        conversationId: "conv-1",
        turnDetection: "server_vad",
      });
      await Promise.resolve();
    });
    expect(h.view.result.current.state).toBe("listening");
    // `ready` awaited the connect-time acquisition instead of starting again.
    expect(secondCapture.startCount).toBe(1);
    expect(firstCapture.startCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Session context + shared controls
// ---------------------------------------------------------------------------

describe("session context and controls", () => {
  test("start() publishes the session context and controls to the store", async () => {
    const h = renderController();
    await act(async () => {
      await h.view.result.current.start("assistant-1", "conv-1");
    });

    const store = useLiveVoiceStore.getState();
    expect(store.assistantId).toBe("assistant-1");
    expect(store.conversationId).toBe("conv-1");
    expect(store.startedConversationId).toBe("conv-1");
    expect(store.controls).not.toBeNull();
  });

  test("start() without a conversation publishes a null conversationId", async () => {
    const h = renderController();
    await act(async () => {
      await h.view.result.current.start("assistant-1");
    });

    expect(useLiveVoiceStore.getState().assistantId).toBe("assistant-1");
    expect(useLiveVoiceStore.getState().conversationId).toBeNull();
    expect(useLiveVoiceStore.getState().startedConversationId).toBeNull();
  });

  test("ready frame updates a null conversationId with the server-assigned id, keeping the started id", async () => {
    const h = renderController();
    await act(async () => {
      await h.view.result.current.start("assistant-1");
    });
    expect(useLiveVoiceStore.getState().conversationId).toBeNull();

    await act(async () => {
      h.client.emit("ready", {
        type: "ready",
        seq: 1,
        sessionId: "s1",
        conversationId: "conv-server-assigned",
      });
      await Promise.resolve();
    });

    const store = useLiveVoiceStore.getState();
    expect(store.assistantId).toBe("assistant-1");
    expect(store.conversationId).toBe("conv-server-assigned");
    // The started id must survive the republish: draft-session ownership
    // (`isLiveVoiceSessionOwnedBy`) matches the draft composer against it.
    expect(store.startedConversationId).toBeNull();
  });

  test("store controls.release drives the manual ptt release", async () => {
    const h = renderController();
    await startListening(h);

    act(() => {
      useLiveVoiceStore.getState().controls?.release();
    });

    expect(h.client.pttReleaseCount).toBe(1);
    expect(h.view.result.current.state).toBe("transcribing");
  });

  test("store controls.release outside listening is a no-op", async () => {
    const h = renderController();
    await act(async () => {
      await h.view.result.current.start("assistant-1", "conv-1");
    });
    expect(h.view.result.current.state).toBe("connecting");

    act(() => {
      useLiveVoiceStore.getState().controls?.release();
    });

    expect(h.client.pttReleaseCount).toBe(0);
    expect(h.view.result.current.state).toBe("connecting");
  });

  test("store controls.interrupt stops playback while speaking and is a no-op otherwise", async () => {
    const h = renderController();
    await startListening(h);

    // Not speaking yet: interrupt is a guarded no-op.
    act(() => {
      useLiveVoiceStore.getState().controls?.interrupt();
    });
    expect(h.client.interruptCount).toBe(0);
    expect(h.view.result.current.state).toBe("listening");

    act(() => {
      h.client.emit("thinking", { type: "thinking", seq: 2, turnId: "t1" });
      h.client.emit("ttsAudio", {
        type: "tts_audio",
        seq: 3,
        mimeType: "audio/pcm",
        sampleRate: 24000,
        dataBase64: "AAAA",
      });
    });
    expect(h.view.result.current.state).toBe("speaking");

    act(() => {
      useLiveVoiceStore.getState().controls?.interrupt();
    });

    // Same path as barge-in: playback stopped, one interrupt, session ends.
    expect(h.player.isPlaying).toBe(false);
    expect(h.client.interruptCount).toBe(1);
    expect(h.view.result.current.state).toBe("idle");
  });

  test("teardown clears the session context and controls", async () => {
    const h = renderController();
    await startListening(h);
    expect(useLiveVoiceStore.getState().controls).not.toBeNull();

    act(() => {
      h.view.unmount();
    });

    const store = useLiveVoiceStore.getState();
    expect(store.controls).toBeNull();
    expect(store.assistantId).toBeNull();
    expect(store.conversationId).toBeNull();
  });

  test("stop() clears the session context and controls", async () => {
    const h = renderController();
    await startListening(h);

    await act(async () => {
      await h.view.result.current.stop();
    });

    const store = useLiveVoiceStore.getState();
    expect(store.controls).toBeNull();
    expect(store.assistantId).toBeNull();
    expect(store.conversationId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// observeAudioState — high-frequency subscription opt-out
// ---------------------------------------------------------------------------

describe("observeAudioState", () => {
  test("default: amplitude and transcript updates re-render the consumer and surface values", async () => {
    const h = renderController();
    await startListening(h);

    // Amplitude below the speech/barge-in thresholds so no phase transition
    // can account for the re-render — only the amplitude subscription.
    act(() => {
      h.getCapture().pushAmplitude(0.02);
    });
    expect(h.view.result.current.inputAmplitude).toBe(0.02);

    act(() => {
      h.client.emit("sttPartial", { type: "stt_partial", seq: 2, text: "hel" });
    });
    expect(h.view.result.current.partialTranscript).toBe("hel");
  });

  test("false: amplitude ticks do not re-render the consumer; fields pinned at defaults", async () => {
    const h = renderController({ observeAudioState: false });
    await startListening(h);
    expect(h.view.result.current.state).toBe("listening");

    const rendersBefore = h.getRenderCount();
    act(() => {
      // A burst of mic-level samples (all below the speech/barge-in
      // thresholds, so no state transition is involved).
      h.getCapture().pushAmplitude(0.01);
      h.getCapture().pushAmplitude(0.02);
      h.getCapture().pushAmplitude(0.015);
    });

    // The store received the samples (the voice bar polls them via
    // getState())...
    expect(useLiveVoiceStore.getState().inputAmplitude).toBe(0.015);
    // ...but the opted-out consumer did not re-render and returns the
    // pinned default.
    expect(h.getRenderCount()).toBe(rendersBefore);
    expect(h.view.result.current.inputAmplitude).toBe(0);
  });

  test("false: transcript deltas do not re-render; state transitions still do", async () => {
    const h = renderController({ observeAudioState: false });
    await startListening(h);

    const rendersBefore = h.getRenderCount();
    act(() => {
      h.client.emit("sttPartial", { type: "stt_partial", seq: 2, text: "hel" });
      h.client.emit("sttPartial", { type: "stt_partial", seq: 3, text: "hello" });
    });
    // Transcript writes reached the store but not the consumer.
    expect(useLiveVoiceStore.getState().partialTranscript).toBe("hello");
    expect(h.getRenderCount()).toBe(rendersBefore);
    expect(h.view.result.current.partialTranscript).toBe("");

    // Low-frequency session state still flows: releasing push-to-talk moves
    // the returned state to `transcribing` (a re-render).
    act(() => {
      useLiveVoiceStore.getState().controls?.release();
    });
    expect(h.view.result.current.state).toBe("transcribing");
    expect(h.getRenderCount()).toBeGreaterThan(rendersBefore);
  });
});

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

describe("teardown", () => {
  test("stop() ends the session and releases mic, socket, and audio", async () => {
    const h = renderController();
    await startListening(h);
    const capture = h.getCapture();

    await act(async () => {
      await h.view.result.current.stop();
    });

    expect(h.client.ended).toBe(true);
    // dispose() releases the AudioContext (not just stop()); confirm capture is
    // fully shut down too.
    expect(h.player.disposeCount).toBeGreaterThanOrEqual(1);
    expect(capture.shutdownCount).toBe(1);
    expect(h.view.result.current.state).toBe("idle");
  });

  test("unmount releases mic, socket, and audio and resets the store to idle", async () => {
    const h = renderController();
    await startListening(h);
    const capture = h.getCapture();
    // Sanity: a live session leaves the store non-idle before unmount.
    expect(h.view.result.current.state).toBe("listening");

    act(() => {
      h.view.unmount();
    });

    expect(h.client.closed).toBe(true);
    // Unmount must dispose the player so the AudioContext is released.
    expect(h.player.disposeCount).toBeGreaterThanOrEqual(1);
    expect(capture.shutdownCount).toBe(1);
    // Gap 2: teardown must reset the store so a mid-session unmount doesn't
    // strand it in a non-idle phase (which would keep dictation disabled).
    expect(useLiveVoiceStore.getState().state).toBe("idle");
  });

  test("stop() with no active session resets to idle without throwing", async () => {
    const h = renderController();
    await act(async () => {
      await h.view.result.current.stop();
    });
    expect(h.view.result.current.state).toBe("idle");
  });
});

// ---------------------------------------------------------------------------
// stop()/start() races
// ---------------------------------------------------------------------------

describe("stop/start races", () => {
  /**
   * Like `renderController`, but tracks every created primitive so a test can
   * observe a second session, and lets a test hold the first player's
   * `dispose()` open to pause `stop()` mid-teardown.
   */
  function renderRacingController() {
    const clients: FakeClient[] = [];
    const players: FakePlayer[] = [];

    const view = renderHook(() =>
      useLiveVoice({
        createClient: () => {
          const client = new FakeClient();
          clients.push(client);
          return client as unknown as LiveVoiceChannelClient;
        },
        createPlayer: () => {
          const player = new FakePlayer();
          players.push(player);
          return player as unknown as LiveVoiceAudioPlayer;
        },
        createCapture: (options) =>
          new FakeCapture(options) as unknown as LiveVoiceAudioCapture,
      }),
    );

    return { view, clients, players };
  }

  /** Replace `player.dispose` with one that resolves only on command. */
  function holdDisposeOpen(player: FakePlayer): () => void {
    let releaseDispose!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseDispose = resolve;
    });
    player.dispose = async () => {
      player.stop();
      await gate;
    };
    return releaseDispose;
  }

  test("start() during `ending` is a no-op (no second session behind stop()'s teardown)", async () => {
    const h = renderRacingController();
    await act(async () => {
      await h.view.result.current.start("assistant-1", "conv-1");
      h.clients[0]!.emit("ready", {
        type: "ready",
        seq: 1,
        sessionId: "s1",
        conversationId: "conv-1",
      });
      await Promise.resolve();
    });
    expect(h.view.result.current.state).toBe("listening");

    const releaseDispose = holdDisposeOpen(h.players[0]!);
    let stopPromise!: Promise<void>;
    act(() => {
      stopPromise = h.view.result.current.stop();
    });
    expect(useLiveVoiceStore.getState().state).toBe("ending");

    // A starter call in the ending window must not open a new session: the
    // old stop()'s trailing reset would wipe it (hot mic behind idle UI).
    await act(async () => {
      await h.view.result.current.start("assistant-1", "conv-2");
    });
    expect(h.clients).toHaveLength(1);
    expect(useLiveVoiceStore.getState().state).toBe("ending");

    await act(async () => {
      releaseDispose();
      await stopPromise;
    });
    expect(useLiveVoiceStore.getState().state).toBe("idle");
  });

  test("stop()'s late reset does not clobber a session started after a double-stop", async () => {
    const h = renderRacingController();
    await act(async () => {
      await h.view.result.current.start("assistant-1", "conv-1");
      h.clients[0]!.emit("ready", {
        type: "ready",
        seq: 1,
        sessionId: "s1",
        conversationId: "conv-1",
      });
      await Promise.resolve();
    });

    // First stop is paused mid-await; a second stop (no session ref left)
    // resets the store to idle immediately — which unblocks start().
    const releaseDispose = holdDisposeOpen(h.players[0]!);
    let firstStop!: Promise<void>;
    act(() => {
      firstStop = h.view.result.current.stop();
    });
    await act(async () => {
      await h.view.result.current.stop();
    });
    expect(useLiveVoiceStore.getState().state).toBe("idle");

    // A new session starts while the first stop() is still awaiting teardown.
    await act(async () => {
      await h.view.result.current.start("assistant-1", "conv-2");
    });
    expect(h.clients).toHaveLength(2);
    expect(useLiveVoiceStore.getState().state).toBe("connecting");

    // The first stop() finally finishes — its trailing reset must yield to
    // the newer session instead of wiping its store state.
    await act(async () => {
      releaseDispose();
      await firstStop;
    });
    expect(useLiveVoiceStore.getState().state).toBe("connecting");
    expect(useLiveVoiceStore.getState().conversationId).toBe("conv-2");
    expect(useLiveVoiceStore.getState().controls).not.toBeNull();
    expect(h.clients[1]!.closed).toBe(false);

    // The surviving session still works end-to-end: `ready` moves it along.
    await act(async () => {
      h.clients[1]!.emit("ready", {
        type: "ready",
        seq: 1,
        sessionId: "s2",
        conversationId: "conv-2",
      });
      await Promise.resolve();
    });
    expect(useLiveVoiceStore.getState().state).toBe("listening");
  });
});

// ---------------------------------------------------------------------------
// Hands-free reconnect on a retryable tunnel close (JARVIS-1255)
// ---------------------------------------------------------------------------

describe("hands-free reconnect (retryable tunnel close)", () => {
  // The reconnect backoff uses real timers; inject a tiny schedule so specs
  // don't wait real seconds, and sleep just past the first delay (20ms).
  const FAST_BACKOFF = [20, 40, 60];

  test("reconnects to the same conversation on a retryable close (1013) instead of ending", async () => {
    const h = renderController({ reconnectBackoffMs: FAST_BACKOFF });
    await startListening(h, { handsFree: true });
    expect(h.view.result.current.state).toBe("listening");

    // velay drops its tunnel to the assistant mid-session → retryable 1013.
    await act(async () => {
      h.client.emit("closed", {
        code: 1013,
        reason: "assistant tunnel disconnected",
      });
    });
    // Not idle: the surface shows a reconnect, and a stop control stays live so
    // the user can still bail during the gap.
    expect(h.view.result.current.state).toBe("connecting");
    expect(useLiveVoiceStore.getState().controls).not.toBeNull();

    // Backoff elapses → a fresh connect to the SAME conversation.
    await act(async () => {
      await sleep(80);
    });
    expect(h.client.connectArgs).toEqual({
      assistantId: "assistant-1",
      conversationId: "conv-1",
      turnDetection: "server_vad",
    });

    // The reconnected session's `ready` resumes listening (a torn-down session
    // would be idle with no handlers, so `ready` would be a no-op).
    await act(async () => {
      h.client.emit("ready", {
        type: "ready",
        seq: 1,
        sessionId: "s2",
        conversationId: "conv-1",
        turnDetection: "server_vad",
      });
      await Promise.resolve();
    });
    expect(h.view.result.current.state).toBe("listening");
  });

  test("does not reconnect on a non-retryable far-side close", async () => {
    const h = renderController();
    await startListening(h, { handsFree: true });
    await act(async () => {
      h.client.emit("closed", { code: 1000, reason: "normal closure" });
    });
    expect(h.view.result.current.state).toBe("idle");
  });

  test("does not reconnect a locally-initiated close (code null)", async () => {
    const h = renderController();
    await startListening(h, { handsFree: true });
    await act(async () => {
      h.client.emit("closed", { code: null, reason: "client closed" });
    });
    expect(h.view.result.current.state).toBe("idle");
  });

  test("does not reconnect a manual (non-server_vad) session even on 1013", async () => {
    const h = renderController();
    await startListening(h); // manual — `ready` echoes turnDetection "manual"
    await act(async () => {
      h.client.emit("closed", {
        code: 1013,
        reason: "assistant tunnel disconnected",
      });
    });
    expect(h.view.result.current.state).toBe("idle");
  });

  test("stop() during the reconnect gap cancels the pending reconnect", async () => {
    const h = renderController({ reconnectBackoffMs: FAST_BACKOFF });
    await startListening(h, { handsFree: true });
    await act(async () => {
      h.client.emit("closed", { code: 1013, reason: "tunnel disconnected" });
    });
    expect(h.view.result.current.state).toBe("connecting");
    const connectArgsBeforeStop = h.client.connectArgs;

    await act(async () => {
      await h.view.result.current.stop();
    });
    expect(h.view.result.current.state).toBe("idle");

    // The backoff would have elapsed by now — but the timer was cancelled, so
    // no reconnect connect fires.
    await act(async () => {
      await sleep(80);
    });
    expect(h.view.result.current.state).toBe("idle");
    expect(h.client.connectArgs).toBe(connectArgsBeforeStop);
  });

  test("unmounting during the reconnect gap resets the store to idle", async () => {
    const h = renderController({ reconnectBackoffMs: FAST_BACKOFF });
    await startListening(h, { handsFree: true });
    await act(async () => {
      h.client.emit("closed", { code: 1013, reason: "tunnel disconnected" });
    });
    expect(useLiveVoiceStore.getState().state).toBe("connecting");

    // Unmount mid-gap (sessionRef is null, store still shows an active session
    // with live controls) — e.g. navigating away from the chat layout. The
    // controller's unmount cleanup must reset the store, not strand it.
    const connectArgsAtUnmount = h.client.connectArgs;
    await act(async () => {
      h.view.unmount();
    });
    expect(useLiveVoiceStore.getState().state).toBe("idle");
    expect(useLiveVoiceStore.getState().controls).toBeNull();

    // The pending reconnect was cancelled — nothing reconnects after the gap.
    await act(async () => {
      await sleep(80);
    });
    expect(h.client.connectArgs).toBe(connectArgsAtUnmount);
  });

  test("spends the next backoff attempt when a reconnect also closes retryably", async () => {
    const h = renderController({ reconnectBackoffMs: FAST_BACKOFF });
    await startListening(h, { handsFree: true });

    // First tunnel drop → first reconnect scheduled.
    await act(async () => {
      h.client.emit("closed", { code: 1013, reason: "drop 1" });
    });
    expect(h.view.result.current.state).toBe("connecting");
    await act(async () => {
      await sleep(40); // backoff[0]=20 → the reconnect connect runs
    });

    // The reconnect's socket closes retryably again (tunnel still down). The
    // controller must spend the next attempt rather than fail — this is the
    // budget the transport now preserves for pre-`ready` retryable closes.
    await act(async () => {
      h.client.emit("closed", { code: 1013, reason: "drop 2" });
    });
    expect(h.view.result.current.state).toBe("connecting");
    expect(h.view.result.current.error).toBeNull();
    await act(async () => {
      await sleep(60); // backoff[1]=40 → the second reconnect connect runs
    });

    // The next connect readies → the session resumes instead of failing.
    await act(async () => {
      h.client.emit("ready", {
        type: "ready",
        seq: 1,
        sessionId: "s3",
        conversationId: "conv-1",
        turnDetection: "server_vad",
      });
      await Promise.resolve();
    });
    expect(h.view.result.current.state).toBe("listening");
  });
});

// ---------------------------------------------------------------------------
// `reconnecting` signal (JARVIS-1255): true only during a genuine retry
// ---------------------------------------------------------------------------

describe("reconnecting signal", () => {
  const FAST_BACKOFF = [20, 40, 60];
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  test("a retryable close flips reconnecting true while connecting; ready clears it", async () => {
    const h = renderController({ reconnectBackoffMs: FAST_BACKOFF });
    await startListening(h, { handsFree: true });
    // A live, first-connect session never carries the reconnect label.
    expect(useLiveVoiceStore.getState().reconnecting).toBe(false);

    // velay drops its tunnel → retryable 1013 → reconnect scheduled.
    await act(async () => {
      h.client.emit("closed", { code: 1013, reason: "tunnel disconnected" });
    });
    expect(h.view.result.current.state).toBe("connecting");
    expect(useLiveVoiceStore.getState().reconnecting).toBe(true);

    // Stays true across the backoff gap and the fresh connect (still no ready).
    await act(async () => {
      await sleep(40);
    });
    expect(h.view.result.current.state).toBe("connecting");
    expect(useLiveVoiceStore.getState().reconnecting).toBe(true);

    // The reconnected session readies → the reconnect label clears.
    await act(async () => {
      h.client.emit("ready", {
        type: "ready",
        seq: 1,
        sessionId: "s2",
        conversationId: "conv-1",
        turnDetection: "server_vad",
      });
      await Promise.resolve();
    });
    expect(h.view.result.current.state).toBe("listening");
    expect(useLiveVoiceStore.getState().reconnecting).toBe(false);
  });

  test("a first connect never sets reconnecting true", async () => {
    const h = renderController();
    expect(useLiveVoiceStore.getState().reconnecting).toBe(false);

    await act(async () => {
      await h.view.result.current.start("assistant-1", "conv-1");
    });
    // Initial connect: connecting, but NOT a reconnect.
    expect(h.view.result.current.state).toBe("connecting");
    expect(useLiveVoiceStore.getState().reconnecting).toBe(false);

    await act(async () => {
      h.client.emit("ready", {
        type: "ready",
        seq: 1,
        sessionId: "s1",
        conversationId: "conv-1",
      });
      await Promise.resolve();
    });
    expect(h.view.result.current.state).toBe("listening");
    expect(useLiveVoiceStore.getState().reconnecting).toBe(false);
  });

  test("the fail path clears reconnecting", async () => {
    const h = renderController({ reconnectBackoffMs: FAST_BACKOFF });
    await startListening(h, { handsFree: true });

    // Drop the tunnel and let the reconnect connect fire so a fresh (pre-ready)
    // session is attached while the reconnect label is still up.
    await act(async () => {
      h.client.emit("closed", { code: 1013, reason: "tunnel disconnected" });
    });
    await act(async () => {
      await sleep(40);
    });
    expect(useLiveVoiceStore.getState().reconnecting).toBe(true);

    // A fatal error on the reconnected session fails it (teardown → reset),
    // which must also drop the reconnect label.
    act(() => {
      h.client.emit("error", { reason: "protocol-error", message: "kaboom" });
    });
    expect(h.view.result.current.state).toBe("failed");
    expect(h.view.result.current.error).toBe("kaboom");
    expect(useLiveVoiceStore.getState().reconnecting).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Initial-connect resilience (JARVIS-1282): a managed/hands-free session's
// first connect must not flash `failed` for a transient pre-`ready` failure
// (cold velay tunnel, token-mint blip) while the room's avatar animates in.
// ---------------------------------------------------------------------------

describe("initial-connect resilience (JARVIS-1282)", () => {
  const FAST_BACKOFF = [20, 40, 60];

  /** Start a hands-free session and stop at `connecting` (no `ready` emitted). */
  async function startConnecting(
    h: ReturnType<typeof renderController>,
  ): Promise<void> {
    await act(async () => {
      await h.view.result.current.start("assistant-1", "conv-1", {
        handsFree: true,
      });
    });
    // Let the concurrently-started capture promise settle; state stays
    // `connecting` until a `ready` (never emitted here).
    await act(async () => {
      await flushMicrotasks();
    });
    expect(h.view.result.current.state).toBe("connecting");
  }

  test("retries a transient pre-ready connection failure instead of flashing failed, then readies", async () => {
    const h = renderController({ reconnectBackoffMs: FAST_BACKOFF });
    await startConnecting(h);

    // Cold velay tunnel rejects the first upgrade → a pre-`ready` connection
    // failure surfaces via the transport's `error` event.
    await act(async () => {
      const err: LiveVoiceClientError = {
        reason: "connection-failed",
        message: "Live-voice WebSocket error",
      };
      h.client.emit("error", err);
    });
    // Held in `connecting` (avatar keeps animating), NOT `failed`; no error
    // surfaced; a live stop control stays registered; and it reads as a first
    // connect ("Connecting…"), not a reconnect ("Reconnecting…").
    expect(h.view.result.current.state).toBe("connecting");
    expect(h.view.result.current.error).toBeNull();
    expect(useLiveVoiceStore.getState().reconnecting).toBe(false);
    expect(useLiveVoiceStore.getState().controls).not.toBeNull();

    // Backoff elapses → a fresh connect to the same conversation.
    await act(async () => {
      await sleep(30);
    });
    expect(h.client.connectArgs).toEqual({
      assistantId: "assistant-1",
      conversationId: "conv-1",
      turnDetection: "server_vad",
    });

    // The retry readies → listening; the error never appeared.
    await act(async () => {
      h.client.emit("ready", {
        type: "ready",
        seq: 1,
        sessionId: "s2",
        conversationId: "conv-1",
        turnDetection: "server_vad",
      });
      await Promise.resolve();
    });
    expect(h.view.result.current.state).toBe("listening");
    expect(h.view.result.current.error).toBeNull();
  });

  test("surfaces failed once the initial-connect retry budget is exhausted", async () => {
    // A single-attempt budget: one retry, then the next failure surfaces.
    const h = renderController({ reconnectBackoffMs: [20] });
    await startConnecting(h);

    await act(async () => {
      h.client.emit("error", {
        reason: "connection-failed",
        message: "cold tunnel",
      });
    });
    expect(h.view.result.current.state).toBe("connecting");

    // The one scheduled retry fires…
    await act(async () => {
      await sleep(30);
    });
    // …and also fails pre-`ready`: budget spent → surface the failure.
    await act(async () => {
      h.client.emit("error", {
        reason: "connection-failed",
        message: "still down",
      });
    });
    expect(h.view.result.current.state).toBe("failed");
    expect(h.view.result.current.error).toBe("still down");
  });

  test("does not retry the initial connect for a manual (non-hands-free) session", async () => {
    const h = renderController({ reconnectBackoffMs: [20] });
    await act(async () => {
      await h.view.result.current.start("assistant-1", "conv-1"); // manual
    });
    await act(async () => {
      await flushMicrotasks();
    });

    await act(async () => {
      h.client.emit("error", {
        reason: "connection-failed",
        message: "boom",
      });
    });
    expect(h.view.result.current.state).toBe("failed");
    expect(h.view.result.current.error).toBe("boom");
  });

  test("a non-connection pre-ready error (protocol-error) still fails immediately", async () => {
    const h = renderController({ reconnectBackoffMs: [20] });
    await startConnecting(h);

    await act(async () => {
      h.client.emit("error", {
        reason: "protocol-error",
        message: "bad frame",
      });
    });
    expect(h.view.result.current.state).toBe("failed");
    expect(h.view.result.current.error).toBe("bad frame");
  });

  test("a connection failure after ready is not retried by the initial-connect path", async () => {
    const h = renderController({ reconnectBackoffMs: [20] });
    await startListening(h, { handsFree: true });
    expect(h.view.result.current.state).toBe("listening");

    // Once connected, the initial-connect resilience is retired: a fatal
    // connection error fails the session outright as before.
    await act(async () => {
      h.client.emit("error", {
        reason: "connection-failed",
        message: "socket died",
      });
    });
    expect(h.view.result.current.state).toBe("failed");
    expect(h.view.result.current.error).toBe("socket died");
  });

  test("stop() during the initial-connect backoff cancels the pending retry", async () => {
    const h = renderController({ reconnectBackoffMs: [20] });
    await startConnecting(h);

    await act(async () => {
      h.client.emit("error", {
        reason: "connection-failed",
        message: "cold tunnel",
      });
    });
    expect(h.view.result.current.state).toBe("connecting");
    const connectArgsBeforeStop = h.client.connectArgs;

    await act(async () => {
      await h.view.result.current.stop();
    });
    expect(h.view.result.current.state).toBe("idle");

    // The backoff would have elapsed — but the timer was cancelled, so no
    // retry connect fires.
    await act(async () => {
      await sleep(40);
    });
    expect(h.view.result.current.state).toBe("idle");
    expect(h.client.connectArgs).toBe(connectArgsBeforeStop);
  });
});
