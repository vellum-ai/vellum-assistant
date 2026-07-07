/**
 * Tests for the `useLiveVoice` session controller.
 *
 * The three merged primitives — client, capture, player — are replaced with
 * the shared fakes from `live-voice-fakes.test-helper.ts`, injected through
 * `useLiveVoice`'s factory options, so no WebSocket, microphone, or
 * AudioContext is touched.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
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

function renderController(extraOptions: { observeAudioState?: boolean } = {}) {
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
        return capture as unknown as LiveVoiceAudioCapture;
      },
      ...extraOptions,
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
async function startListening(h: ReturnType<typeof renderController>) {
  await act(async () => {
    await h.view.result.current.start("assistant-1", "conv-1");
  });
  // `ready` kicks off capture; await the microtask that resolves capture.start.
  await act(async () => {
    h.client.emit("ready", {
      type: "ready",
      seq: 1,
      sessionId: "s1",
      conversationId: "conv-1",
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

  test("capture failure fails the session", async () => {
    const h = renderController();
    await act(async () => {
      await h.view.result.current.start("assistant-1");
    });
    await act(async () => {
      // The capture instance exists once start() ran; make its start fail.
      h.getCapture().startResult = {
        ok: false,
        error: "permission-denied",
      };
      h.client.emit("ready", {
        type: "ready",
        seq: 1,
        sessionId: "s1",
        conversationId: "conv-1",
      });
      await Promise.resolve();
    });

    expect(h.view.result.current.state).toBe("failed");
    expect(h.client.closed).toBe(true);
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
