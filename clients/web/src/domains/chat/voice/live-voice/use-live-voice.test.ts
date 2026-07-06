/**
 * Tests for the `useLiveVoice` session controller.
 *
 * The three merged primitives — client, capture, player — are replaced with
 * hand-rolled fakes injected through `useLiveVoice`'s factory options, so no
 * WebSocket, microphone, or AudioContext is touched. The fakes expose drivers
 * (`emit`, `pushChunk`, `pushAmplitude`) so a test can drive multi-turn
 * sessions and assert the state-machine transitions, barge-in, automatic
 * ptt_release, and teardown.
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
  LiveVoiceClientEventMap,
  LiveVoiceClientEventName,
} from "@/domains/chat/voice/live-voice/live-voice-client";
import type {
  LiveVoiceAudioCapture,
  LiveVoiceAudioCaptureOptions,
  LiveVoiceCaptureResult,
} from "@/domains/chat/voice/live-voice/pcm-capture";
import type { LiveVoiceAudioPlayer } from "@/domains/chat/voice/live-voice/tts-playback";

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
// Fakes
// ---------------------------------------------------------------------------

class FakeClient {
  connectArgs: {
    assistantId: string;
    conversationId?: string;
    mode?: "ptt" | "open-mic";
  } | null = null;
  sentAudio: ArrayBuffer[] = [];
  pttReleaseCount = 0;
  interruptCount = 0;
  ended = false;
  closed = false;

  private handlers = new Map<
    LiveVoiceClientEventName,
    Set<(payload: never) => void>
  >();

  on<E extends LiveVoiceClientEventName>(
    event: E,
    handler: (payload: LiveVoiceClientEventMap[E]) => void,
  ): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as (payload: never) => void);
    return () => set?.delete(handler as (payload: never) => void);
  }

  async connect(args: {
    assistantId: string;
    conversationId?: string;
    mode?: "ptt" | "open-mic";
  }): Promise<void> {
    this.connectArgs = args;
  }

  sendAudio(pcm: ArrayBuffer): void {
    this.sentAudio.push(pcm);
  }
  pttRelease(): void {
    this.pttReleaseCount++;
  }
  interrupt(): void {
    this.interruptCount++;
  }
  end(): void {
    this.ended = true;
  }
  close(): void {
    this.closed = true;
  }

  /** Drive a server event to the controller's subscribed handlers. */
  emit<E extends LiveVoiceClientEventName>(
    event: E,
    payload: LiveVoiceClientEventMap[E],
  ): void {
    for (const handler of this.handlers.get(event) ?? []) {
      (handler as (payload: LiveVoiceClientEventMap[E]) => void)(payload);
    }
  }
}

class FakeCapture {
  readonly onChunk: (buf: ArrayBuffer) => void;
  readonly onAmplitude?: (amplitude: number) => void;

  startCount = 0;
  stopCount = 0;
  shutdownCount = 0;
  startResult: LiveVoiceCaptureResult = { ok: true };

  constructor(options: LiveVoiceAudioCaptureOptions) {
    this.onChunk = options.onChunk;
    this.onAmplitude = options.onAmplitude;
  }

  async start(): Promise<LiveVoiceCaptureResult> {
    this.startCount++;
    return this.startResult;
  }
  async stop(): Promise<void> {
    this.stopCount++;
  }
  async shutdown(): Promise<void> {
    this.shutdownCount++;
  }

  /** Feed a captured PCM chunk to the controller. */
  pushChunk(buf: ArrayBuffer): void {
    this.onChunk(buf);
  }
  /** Feed an amplitude reading to the controller. */
  pushAmplitude(amplitude: number): void {
    this.onAmplitude?.(amplitude);
  }
}

class FakePlayer {
  enqueued: unknown[] = [];
  stopCount = 0;
  disposeCount = 0;
  isPlaying = false;
  private drainResolvers: Array<() => void> = [];

  enqueue(chunk: unknown): void {
    this.enqueued.push(chunk);
    this.isPlaying = true;
  }
  stop(): void {
    this.stopCount++;
    this.isPlaying = false;
    this.resolveDrain();
  }
  async dispose(): Promise<void> {
    this.disposeCount++;
    this.stop();
  }
  async waitUntilDrained(): Promise<void> {
    if (!this.isPlaying) return;
    await new Promise<void>((resolve) => this.drainResolvers.push(resolve));
  }

  /** Simulate playback finishing naturally. */
  finishPlayback(): void {
    this.isPlaying = false;
    this.resolveDrain();
  }
  private resolveDrain(): void {
    const resolvers = this.drainResolvers;
    this.drainResolvers = [];
    for (const resolve of resolvers) resolve();
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** A PCM chunk of `ms` milliseconds at 16 kHz mono Int16. */
function pcmChunk(ms: number): ArrayBuffer {
  const samples = Math.round((16000 * ms) / 1000);
  return new Int16Array(samples).buffer;
}

function renderController(options: { stuckTurnTimeoutMs?: number } = {}) {
  const client = new FakeClient();
  const player = new FakePlayer();
  let capture!: FakeCapture;

  const view = renderHook(() =>
    useLiveVoice({
      createClient: () => client as unknown as LiveVoiceChannelClient,
      createPlayer: () => player as unknown as LiveVoiceAudioPlayer,
      createCapture: (opts) => {
        capture = new FakeCapture(opts);
        return capture as unknown as LiveVoiceAudioCapture;
      },
      ...options,
    }),
  );

  return {
    view,
    client,
    player,
    getCapture: () => capture,
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
// Multi-turn session
// ---------------------------------------------------------------------------

describe("multi-turn session", () => {
  test("drives two turns over one socket: … → speaking → listening → speaking → listening", async () => {
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

    // tts_done awaits playback drain, then resumes listening on the same
    // socket and mic — the session is multi-turn, so nothing is torn down.
    await act(async () => {
      h.client.emit("ttsDone", { type: "tts_done", seq: 8, turnId: "t1" });
      h.player.finishPlayback();
      await Promise.resolve();
    });
    expect(h.view.result.current.state).toBe("listening");
    expect(h.client.closed).toBe(false);
    expect(h.client.ended).toBe(false);
    expect(h.getCapture().shutdownCount).toBe(0);
    // No mic re-acquisition: the original capture graph spans both turns.
    expect(h.getCapture().startCount).toBe(1);

    // Second turn: forwarding re-opened, so captured audio streams again.
    act(() => {
      h.getCapture().pushAmplitude(0.1);
      h.getCapture().pushChunk(pcmChunk(20));
    });
    expect(h.client.sentAudio).toHaveLength(2);

    act(() => {
      h.client.emit("sttFinal", { type: "stt_final", seq: 9, text: "again" });
    });
    expect(h.view.result.current.finalTranscript).toBe("again");

    act(() => {
      h.client.emit("thinking", { type: "thinking", seq: 10, turnId: "t2" });
    });
    // The per-turn assistant transcript resets for the new response.
    expect(h.view.result.current.assistantTranscript).toBe("");
    expect(h.view.result.current.state).toBe("thinking");

    act(() => {
      h.client.emit("ttsAudio", {
        type: "tts_audio",
        seq: 11,
        mimeType: "audio/pcm",
        sampleRate: 24000,
        dataBase64: "AAAA",
      });
    });
    expect(h.view.result.current.state).toBe("speaking");
    expect(h.player.enqueued).toHaveLength(2);

    await act(async () => {
      h.client.emit("ttsDone", { type: "tts_done", seq: 12, turnId: "t2" });
      h.player.finishPlayback();
      await Promise.resolve();
    });
    expect(h.view.result.current.state).toBe("listening");
    expect(h.client.closed).toBe(false);
    expect(h.getCapture().shutdownCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Barge-in
// ---------------------------------------------------------------------------

describe("barge-in", () => {
  test("amplitude over threshold while speaking stops playback and interrupts; the interrupted frame resumes listening on the same socket", async () => {
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

    // Playback is stopped and a single interrupt is sent; the session stays
    // open awaiting the server's `interrupted` confirmation.
    expect(h.player.isPlaying).toBe(false);
    expect(h.client.interruptCount).toBe(1);
    expect(h.client.closed).toBe(false);
    expect(h.view.result.current.state).toBe("speaking");

    act(() => {
      h.client.emit("interrupted", {
        type: "interrupted",
        seq: 4,
        turnId: "t1",
      });
    });
    expect(h.view.result.current.state).toBe("listening");
    expect(h.client.closed).toBe(false);
    expect(h.getCapture().shutdownCount).toBe(0);

    // Forwarding re-opened: the next utterance streams on the same socket.
    act(() => {
      h.getCapture().pushAmplitude(0.1);
      h.getCapture().pushChunk(pcmChunk(20));
    });
    expect(h.client.sentAudio).toHaveLength(1);
  });

  test("server-initiated interrupted (no local threshold crossing) flushes playback and resumes listening", async () => {
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
    expect(h.player.isPlaying).toBe(true);

    act(() => {
      h.client.emit("interrupted", {
        type: "interrupted",
        seq: 4,
        turnId: "t1",
      });
    });

    // The client never initiated the barge-in, yet playback is flushed and
    // the session resumes listening.
    expect(h.client.interruptCount).toBe(0);
    expect(h.player.isPlaying).toBe(false);
    expect(h.view.result.current.state).toBe("listening");
    expect(h.client.closed).toBe(false);
    expect(h.getCapture().shutdownCount).toBe(0);
  });

  test("interrupted (e.g. during the synthesis tail) re-arms barge-in for the next response", async () => {
    const h = renderController();
    await startListening(h);

    // First response: local barge-in consumes the one-shot interrupt.
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
    });
    expect(h.client.interruptCount).toBe(1);

    // The server confirms — even when the confirmation came from the
    // session-level tail interrupt rather than the controller.
    act(() => {
      h.client.emit("interrupted", { type: "interrupted", seq: 4, turnId: "t1" });
    });
    expect(h.view.result.current.state).toBe("listening");

    // Next response: the one-shot was reset, so barge-in works again.
    act(() => {
      h.client.emit("thinking", { type: "thinking", seq: 5, turnId: "t2" });
      h.client.emit("ttsAudio", {
        type: "tts_audio",
        seq: 6,
        mimeType: "audio/pcm",
        sampleRate: 24000,
        dataBase64: "AAAA",
      });
      h.getCapture().pushAmplitude(0.3);
    });
    expect(h.client.interruptCount).toBe(2);
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

  test("realistic turn: auto-release → speaking → barge-in resumes listening for the next turn", async () => {
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
    // speaks: a loud reading interrupts (barge-in); the server's `interrupted`
    // confirmation resumes listening without tearing anything down.
    act(() => {
      capture.pushAmplitude(0.3); // over BARGE_IN_AMPLITUDE_THRESHOLD
    });
    expect(h.client.interruptCount).toBe(1);
    expect(h.player.isPlaying).toBe(false);

    act(() => {
      h.client.emit("interrupted", {
        type: "interrupted",
        seq: 6,
        turnId: "t1",
      });
    });
    expect(h.view.result.current.state).toBe("listening");
    expect(capture.shutdownCount).toBe(0);
    expect(h.client.closed).toBe(false);

    // The next utterance auto-releases again on the same session (the
    // per-turn release/speech flags were reset by the resume).
    act(() => {
      capture.pushAmplitude(0.1);
      capture.pushChunk(pcmChunk(200));
      capture.pushAmplitude(0.0);
      capture.pushChunk(pcmChunk(1000));
    });
    expect(h.client.pttReleaseCount).toBe(2);
    expect(h.view.result.current.state).toBe("transcribing");
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
// Server turn boundary
// ---------------------------------------------------------------------------

describe("turn_boundary", () => {
  test("while listening moves to transcribing (server segmented the turn)", async () => {
    const h = renderController();
    await startListening(h);

    act(() => {
      h.client.emit("turnBoundary", { type: "turn_boundary", seq: 2 });
    });

    expect(h.view.result.current.state).toBe("transcribing");
    // The transition is UI-only: no client-side ptt_release is sent.
    expect(h.client.pttReleaseCount).toBe(0);
  });

  test("outside listening leaves the state alone", async () => {
    const h = renderController();
    await startListening(h);

    act(() => {
      h.client.emit("thinking", { type: "thinking", seq: 2, turnId: "t1" });
      h.client.emit("turnBoundary", { type: "turn_boundary", seq: 3 });
    });

    expect(h.view.result.current.state).toBe("thinking");
  });
});

// ---------------------------------------------------------------------------
// Server-initiated session end
// ---------------------------------------------------------------------------

describe("session_ended", () => {
  test("plays out buffered goodbye audio, then tears down to idle — the trailing socket close does not cut it off", async () => {
    const h = renderController();
    await startListening(h);

    // The server speaks a goodbye (out-of-turn tts is buffered/played),
    // announces the end, then closes the socket.
    await act(async () => {
      h.client.emit("ttsAudio", {
        type: "tts_audio",
        seq: 2,
        mimeType: "audio/pcm",
        sampleRate: 24000,
        dataBase64: "AAAA",
      });
      h.client.emit("sessionEnded", {
        type: "session_ended",
        seq: 3,
        reason: "Call completed",
      });
      h.client.emit("closed", undefined);
      await Promise.resolve();
    });

    // Goodbye still playing: the session drains before tearing down.
    expect(h.player.isPlaying).toBe(true);
    expect(h.view.result.current.state).toBe("ending");
    expect(h.getCapture().shutdownCount).toBe(0);

    await act(async () => {
      h.player.finishPlayback();
      await Promise.resolve();
    });

    expect(h.view.result.current.state).toBe("idle");
    expect(h.player.disposeCount).toBeGreaterThanOrEqual(1);
    expect(h.getCapture().shutdownCount).toBe(1);
  });

  test("with no pending audio it tears down to idle immediately", async () => {
    const h = renderController();
    await startListening(h);

    await act(async () => {
      h.client.emit("sessionEnded", {
        type: "session_ended",
        seq: 2,
        reason: "Maximum call duration reached",
      });
      await Promise.resolve();
    });

    expect(h.view.result.current.state).toBe("idle");
    expect(h.getCapture().shutdownCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Empty-turn recovery
// ---------------------------------------------------------------------------

describe("turn_cancelled", () => {
  test("while thinking resumes listening for the next utterance", async () => {
    const h = renderController();
    await startListening(h);

    act(() => {
      h.client.emit("turnBoundary", { type: "turn_boundary", seq: 2 });
      h.client.emit("thinking", { type: "thinking", seq: 3, turnId: "t1" });
    });
    expect(h.view.result.current.state).toBe("thinking");

    act(() => {
      h.client.emit("turnCancelled", {
        type: "turn_cancelled",
        seq: 4,
        reason: "empty_transcript",
      });
    });

    expect(h.view.result.current.state).toBe("listening");

    // Forwarding re-opened: the next utterance streams again.
    act(() => {
      h.getCapture().pushAmplitude(0.1);
      h.getCapture().pushChunk(pcmChunk(20));
    });
    expect(h.client.sentAudio).toHaveLength(1);
  });

  test("an empty stt_final after release does not advance to thinking", async () => {
    const h = renderController();
    await startListening(h);

    // Auto-release: speech then silence.
    act(() => {
      h.getCapture().pushAmplitude(0.1);
      h.getCapture().pushChunk(pcmChunk(200));
      h.getCapture().pushAmplitude(0.0);
      h.getCapture().pushChunk(pcmChunk(1000));
    });
    expect(h.view.result.current.state).toBe("transcribing");

    act(() => {
      h.client.emit("sttFinal", { type: "stt_final", seq: 2, text: "   " });
    });

    // No assistant turn is coming for an empty transcript — hold until
    // turn_cancelled resumes listening.
    expect(h.view.result.current.state).toBe("transcribing");

    act(() => {
      h.client.emit("turnCancelled", {
        type: "turn_cancelled",
        seq: 3,
        reason: "empty_transcript",
      });
    });
    expect(h.view.result.current.state).toBe("listening");
  });

  test("stuck-turn backstop resumes listening when the server goes silent", async () => {
    const h = renderController({ stuckTurnTimeoutMs: 40 });
    await startListening(h);

    act(() => {
      h.client.emit("turnBoundary", { type: "turn_boundary", seq: 2 });
    });
    expect(h.view.result.current.state).toBe("transcribing");

    // No server frames arrive; the backstop fires and recovers the session.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 90));
    });

    expect(h.view.result.current.state).toBe("listening");
    expect(h.client.closed).toBe(false);
  });

  test("stuck-turn backstop does not fire once the response is speaking", async () => {
    const h = renderController({ stuckTurnTimeoutMs: 40 });
    await startListening(h);

    act(() => {
      h.client.emit("turnBoundary", { type: "turn_boundary", seq: 2 });
      h.client.emit("thinking", { type: "thinking", seq: 3, turnId: "t1" });
      h.client.emit("ttsAudio", {
        type: "tts_audio",
        seq: 4,
        mimeType: "audio/pcm",
        sampleRate: 24000,
        dataBase64: "AAAA",
      });
    });
    expect(h.view.result.current.state).toBe("speaking");

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 90));
    });

    expect(h.view.result.current.state).toBe("speaking");
  });
});

// ---------------------------------------------------------------------------
// Mode threading
// ---------------------------------------------------------------------------

describe("session mode", () => {
  test("start() forwards a requested mode to the connect args", async () => {
    const h = renderController();

    await act(async () => {
      await h.view.result.current.start("assistant-1", "conv-1", "open-mic");
    });

    expect(h.client.connectArgs).toEqual({
      assistantId: "assistant-1",
      conversationId: "conv-1",
      mode: "open-mic",
    });
  });

  test("start() without a mode leaves it out (server default PTT)", async () => {
    const h = renderController();

    await act(async () => {
      await h.view.result.current.start("assistant-1", "conv-1");
    });

    expect(h.client.connectArgs).toEqual({
      assistantId: "assistant-1",
      conversationId: "conv-1",
    });
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
