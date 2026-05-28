import { describe, expect, test } from "bun:test";

import type {
  LiveVoiceChannelClientLike,
  LiveVoicePcmCaptureLike,
  LiveVoicePcmPlaybackLike,
  LiveVoiceStoreLike,
} from "@/domains/voice/live-voice/live-voice-channel-manager";
import { LiveVoiceChannelManager } from "@/domains/voice/live-voice/live-voice-channel-manager";
import type {
  LiveVoiceChannelEvent,
  LiveVoiceChannelFailure,
  LiveVoiceChannelStartOptions,
} from "@/domains/voice/live-voice/live-voice-channel-client";
import type {
  LiveVoiceStore,
  LiveVoiceStoreState,
} from "@/domains/voice/live-voice/live-voice-store";
import type { LiveVoicePcmCaptureStartOptions } from "@/domains/voice/live-voice/pcm-capture";
import type { LiveVoiceTtsChunk } from "@/domains/voice/live-voice/pcm-playback";

// ---------------------------------------------------------------------------
// Fake store
//
// The real `useLiveVoiceStore` is a Zustand singleton; touching it from
// these tests would leak state across the test runner. We replicate the
// store's mutating actions over a plain object so each test has its own
// isolated snapshot.
// ---------------------------------------------------------------------------

const INITIAL_STORE_STATE: LiveVoiceStoreState = {
  state: "off",
  sessionId: null,
  conversationId: null,
  partialTranscript: "",
  finalTranscript: "",
  assistantTranscript: "",
  inputAmplitude: 0,
  errorMessage: "",
};

function createFakeStore(): LiveVoiceStoreLike {
  const snapshot: LiveVoiceStoreState = { ...INITIAL_STORE_STATE };
  const api: LiveVoiceStore = {
    ...snapshot,
    setState: (s) => {
      api.state = s;
    },
    setSessionInfo: ({ sessionId, conversationId }) => {
      api.sessionId = sessionId;
      api.conversationId = conversationId;
    },
    setPartialTranscript: (text) => {
      api.partialTranscript = text;
    },
    setFinalTranscript: (text) => {
      api.finalTranscript = text;
    },
    appendAssistantTranscript: (delta) => {
      api.assistantTranscript = api.assistantTranscript + delta;
    },
    clearAssistantTranscript: () => {
      api.assistantTranscript = "";
    },
    setInputAmplitude: (amp) => {
      api.inputAmplitude = amp;
    },
    setError: (msg) => {
      api.errorMessage = msg;
    },
    reset: () => {
      Object.assign(api, INITIAL_STORE_STATE);
    },
  };
  return { getState: () => api };
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/**
 * Captures the `onEvent` / `onFailure` callbacks from `start()` so each
 * test can drive event sequences synchronously. Records every method
 * call so assertions can verify both the call ordering and the payloads
 * the manager forwarded.
 */
class FakeClient implements LiveVoiceChannelClientLike {
  startCalls: LiveVoiceChannelStartOptions[] = [];
  sendAudioCalls: Array<ArrayBuffer | Int16Array> = [];
  releasePushToTalkCalls = 0;
  interruptCalls = 0;
  endCalls = 0;
  closeCalls = 0;

  /** Most recent `onEvent` callback captured from `start()`. */
  onEvent: ((event: LiveVoiceChannelEvent) => void) | null = null;
  /** Most recent `onFailure` callback captured from `start()`. */
  onFailure: ((failure: LiveVoiceChannelFailure) => void) | null = null;

  async start(options: LiveVoiceChannelStartOptions): Promise<void> {
    this.startCalls.push(options);
    this.onEvent = options.onEvent;
    this.onFailure = options.onFailure;
  }

  sendAudio(data: ArrayBuffer | Int16Array): void {
    this.sendAudioCalls.push(data);
  }

  releasePushToTalk(): void {
    this.releasePushToTalkCalls += 1;
  }

  interrupt(): void {
    this.interruptCalls += 1;
  }

  async end(): Promise<void> {
    this.endCalls += 1;
  }

  close(): void {
    this.closeCalls += 1;
  }

  /** Drive an event through the manager. */
  emit(event: LiveVoiceChannelEvent): void {
    if (!this.onEvent) {
      throw new Error("FakeClient.start has not been called");
    }
    this.onEvent(event);
  }

  /** Drive a failure through the manager. */
  fail(failure: LiveVoiceChannelFailure): void {
    if (!this.onFailure) {
      throw new Error("FakeClient.start has not been called");
    }
    this.onFailure(failure);
  }
}

class FakeCapture implements LiveVoicePcmCaptureLike {
  startCalls: LiveVoicePcmCaptureStartOptions[] = [];
  stopCalls = 0;
  shutdownCalls = 0;
  /** Return value for the next `start()` call. Defaults to true. */
  startResult = true;

  async start(options: LiveVoicePcmCaptureStartOptions): Promise<boolean> {
    this.startCalls.push(options);
    return this.startResult;
  }

  stop(): void {
    this.stopCalls += 1;
  }

  shutdown(): void {
    this.shutdownCalls += 1;
  }
}

class FakePlayback implements LiveVoicePcmPlaybackLike {
  isPlaying = false;
  /**
   * Ordered call log used to assert call sequencing (e.g. that
   * `resetForNextResponse` ran BEFORE the first `enqueueTtsAudio` for a
   * new turn).
   */
  callLog: string[] = [];
  enqueueCalls: LiveVoiceTtsChunk[] = [];
  handleInterruptCalls = 0;
  handleEndCalls = 0;
  handleSessionErrorCalls = 0;
  resetCalls = 0;
  waitCalls = 0;

  /**
   * Controls whether `waitUntilPlaybackFinishes()` resolves synchronously
   * (default) or returns a manually controlled promise. Tests that need
   * to race teardown against the `ttsDone` continuation flip this to a
   * deferred promise and resolve it after driving the teardown.
   */
  private pendingWait: { promise: Promise<void>; resolve: () => void } | null =
    null;

  enqueueTtsAudio(chunk: LiveVoiceTtsChunk): void {
    this.callLog.push("enqueueTtsAudio");
    this.enqueueCalls.push(chunk);
  }

  handleInterrupt(): void {
    this.callLog.push("handleInterrupt");
    this.handleInterruptCalls += 1;
  }

  handleEnd(): void {
    this.callLog.push("handleEnd");
    this.handleEndCalls += 1;
  }

  handleSessionError(): void {
    this.callLog.push("handleSessionError");
    this.handleSessionErrorCalls += 1;
  }

  resetForNextResponse(): void {
    this.callLog.push("resetForNextResponse");
    this.resetCalls += 1;
  }

  async waitUntilPlaybackFinishes(): Promise<void> {
    this.callLog.push("waitUntilPlaybackFinishes");
    this.waitCalls += 1;
    if (this.pendingWait) {
      await this.pendingWait.promise;
    }
  }

  /**
   * Make the next `waitUntilPlaybackFinishes()` call hang until the
   * returned `resolve` is invoked. Used to simulate the race where
   * teardown happens between `ttsDone` and playback drain finishing.
   */
  deferNextWait(): () => void {
    let resolveFn: () => void = () => {};
    const promise = new Promise<void>((resolve) => {
      resolveFn = resolve;
    });
    this.pendingWait = { promise, resolve: resolveFn };
    return () => {
      resolveFn();
      this.pendingWait = null;
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Harness {
  manager: LiveVoiceChannelManager;
  /**
   * Returns the most-recently-built fake client. The manager
   * constructs a fresh client via the factory in every `start()` call,
   * so tests resolve the client lazily (after calling `start`) rather
   * than destructuring it up front. Tests that want to inspect a
   * prior session's client should snapshot the returned reference
   * before driving the next `start()`.
   */
  client(): FakeClient;
  /** Every client the factory has handed out, oldest-first. */
  clients: FakeClient[];
  /**
   * Returns the most-recently-built fake capture. Like the client,
   * capture is built lazily inside `start()` via the factory, so tests
   * must resolve it after `start()`. Snapshot the returned reference
   * before driving another `start()` if you need to inspect the prior
   * session's capture.
   */
  capture(): FakeCapture;
  /** Every capture the factory has handed out, oldest-first. */
  captures: FakeCapture[];
  /**
   * Returns the most-recently-built fake playback. Same lazy semantics
   * as `capture()` — playback is built per `start()`.
   */
  playback(): FakePlayback;
  /** Every playback the factory has handed out, oldest-first. */
  playbacks: FakePlayback[];
  store: LiveVoiceStoreLike;
}

function makeHarness(): Harness {
  const clients: FakeClient[] = [];
  const captures: FakeCapture[] = [];
  const playbacks: FakePlayback[] = [];
  const store = createFakeStore();
  const manager = new LiveVoiceChannelManager({
    clientFactory: () => {
      const next = new FakeClient();
      clients.push(next);
      return next;
    },
    captureFactory: () => {
      const next = new FakeCapture();
      captures.push(next);
      return next;
    },
    playbackFactory: () => {
      const next = new FakePlayback();
      playbacks.push(next);
      return next;
    },
    store,
  });
  return {
    manager,
    clients,
    captures,
    playbacks,
    store,
    client: () => {
      const latest = clients[clients.length - 1];
      if (!latest) {
        throw new Error(
          "FakeClient factory has not been invoked yet — call manager.start first",
        );
      }
      return latest;
    },
    capture: () => {
      const latest = captures[captures.length - 1];
      if (!latest) {
        throw new Error(
          "FakeCapture factory has not been invoked yet — call manager.start first",
        );
      }
      return latest;
    },
    playback: () => {
      const latest = playbacks[playbacks.length - 1];
      if (!latest) {
        throw new Error(
          "FakePlayback factory has not been invoked yet — call manager.start first",
        );
      }
      return latest;
    },
  };
}

/**
 * Yield to the microtask queue. `startCapture()` runs synchronously
 * inside an `onEvent` handler but its `await capture.start(...)`
 * resolves on a microtask, so tests await an already-resolved promise
 * to let those continuations land before asserting.
 */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LiveVoiceChannelManager", () => {
  describe("happy path", () => {
    test("walks the macOS state machine through a full turn", async () => {
      const harness = makeHarness();
      const { manager, store } = harness;

      await manager.start("conv-1");
      const client = harness.client();
      const capture = harness.capture();
      const playback = harness.playback();
      expect(store.getState().state).toBe("connecting");
      expect(client.startCalls.length).toBe(1);
      expect(client.startCalls[0]!.conversationId).toBe("conv-1");

      // ready → store session info + start capture → listening.
      client.emit({
        type: "ready",
        sessionId: "sess-1",
        conversationId: "conv-1",
      });
      await flushMicrotasks();
      expect(store.getState().sessionId).toBe("sess-1");
      expect(store.getState().conversationId).toBe("conv-1");
      expect(capture.startCalls.length).toBe(1);
      expect(store.getState().state).toBe("listening");

      // Mic chunks forward to client.sendAudio; amplitude lands in store.
      const pcm = new Int16Array([1, 2, 3, 4]);
      capture.startCalls[0]!.onChunk({
        pcm16: pcm,
        frameCount: pcm.length,
        amplitude: 0.42,
      });
      capture.startCalls[0]!.onAmplitude?.(0.42);
      expect(client.sendAudioCalls).toEqual([pcm]);
      expect(store.getState().inputAmplitude).toBe(0.42);

      // sttPartial → transcribing + partial transcript recorded.
      client.emit({ type: "sttPartial", text: "hello", seq: 1 });
      expect(store.getState().state).toBe("transcribing");
      expect(store.getState().partialTranscript).toBe("hello");

      // sttFinal → final transcript stored, partial cleared.
      client.emit({ type: "sttFinal", text: "hello world", seq: 2 });
      expect(store.getState().finalTranscript).toBe("hello world");
      expect(store.getState().partialTranscript).toBe("");

      // thinking → state moves to thinking; assistant transcript cleared.
      client.emit({ type: "thinking", turnId: "turn-1" });
      expect(store.getState().state).toBe("thinking");

      // assistantTextDelta → speaking + appended.
      client.emit({ type: "assistantTextDelta", text: "Hi ", seq: 3 });
      expect(store.getState().state).toBe("speaking");
      expect(store.getState().assistantTranscript).toBe("Hi ");

      client.emit({ type: "assistantTextDelta", text: "there!", seq: 4 });
      expect(store.getState().assistantTranscript).toBe("Hi there!");
      // Second delta does not re-enter `speaking`.
      expect(store.getState().state).toBe("speaking");

      // ttsAudio → first chunk re-opens the playback gate, then enqueues.
      const ttsPcm = new Uint8Array([0, 1, 2, 3]);
      client.emit({
        type: "ttsAudio",
        pcm: ttsPcm,
        mimeType: "audio/pcm",
        sampleRate: 24000,
        seq: 5,
      });
      expect(playback.enqueueCalls.length).toBe(1);
      expect(playback.enqueueCalls[0]).toEqual({
        pcm: ttsPcm,
        mimeType: "audio/pcm",
        sampleRate: 24000,
        channels: 1,
      });
      // First chunk of the response: reset must come BEFORE enqueue so
      // the playback gate is open.
      expect(playback.callLog).toEqual([
        "resetForNextResponse",
        "enqueueTtsAudio",
      ]);

      // ttsDone → waitUntilPlaybackFinishes runs, transcript reset,
      // state back to listening. The reset count picks up a second call
      // from the `completeAssistantTurn` continuation.
      client.emit({ type: "ttsDone", turnId: "turn-1" });
      await flushMicrotasks();
      expect(playback.waitCalls).toBe(1);
      expect(playback.resetCalls).toBe(2);
      expect(store.getState().assistantTranscript).toBe("");
      expect(store.getState().state).toBe("listening");
    });
  });

  describe("interrupt path", () => {
    test("interruptSpeakingAndStartListening interrupts client + playback and restarts capture", async () => {
      const harness = makeHarness();
      const { manager } = harness;
      await manager.start("conv-1");
      const client = harness.client();
      const capture = harness.capture();
      const playback = harness.playback();
      client.emit({
        type: "ready",
        sessionId: "sess-1",
        conversationId: "conv-1",
      });
      await flushMicrotasks();
      const captureStartsBefore = capture.startCalls.length;

      await manager.interruptSpeakingAndStartListening("conv-1");
      await flushMicrotasks();

      expect(client.interruptCalls).toBe(1);
      expect(playback.handleInterruptCalls).toBe(1);
      expect(capture.startCalls.length).toBe(captureStartsBefore + 1);
    });
  });

  describe("end path", () => {
    test("end shuts down capture, drains playback, ends client, resets store", async () => {
      const harness = makeHarness();
      const { manager, store } = harness;
      await manager.start("conv-1");
      const client = harness.client();
      const capture = harness.capture();
      const playback = harness.playback();
      client.emit({
        type: "ready",
        sessionId: "sess-1",
        conversationId: "conv-1",
      });
      await flushMicrotasks();

      // Seed some store state to confirm reset clears it.
      store.getState().setFinalTranscript("dirty");

      await manager.end();

      expect(capture.shutdownCalls).toBe(1);
      expect(playback.handleEndCalls).toBe(1);
      expect(client.endCalls).toBe(1);
      // The protocol-level `end` frame is sent — `close()` is not.
      expect(client.closeCalls).toBe(0);

      const state = store.getState();
      expect(state.state).toBe("off");
      expect(state.sessionId).toBeNull();
      expect(state.conversationId).toBeNull();
      expect(state.finalTranscript).toBe("");
      expect(state.errorMessage).toBe("");
    });
  });

  describe("early failure path", () => {
    test("busy failure tears down capture+playback and surfaces error state", async () => {
      const harness = makeHarness();
      const { manager, store } = harness;

      await manager.start("conv-1");
      const client = harness.client();
      const capture = harness.capture();
      const playback = harness.playback();
      expect(store.getState().state).toBe("connecting");

      // No `ready` yet — server reports another session is already active.
      client.fail({ type: "busy", activeSessionId: "sess-other" });

      expect(store.getState().state).toBe("failed");
      expect(store.getState().errorMessage.length).toBeGreaterThan(0);
      expect(capture.shutdownCalls).toBe(1);
      expect(playback.handleInterruptCalls).toBe(1);
      // No protocol `end` frame; we tear down via `close()`.
      expect(client.endCalls).toBe(0);
      expect(client.closeCalls).toBe(1);
    });

    test("failure with explicit message stores that message verbatim", async () => {
      const harness = makeHarness();
      const { manager, store } = harness;
      await manager.start("conv-1");
      const client = harness.client();

      client.fail({
        type: "connectionFailed",
        message: "WebSocket error",
      });

      expect(store.getState().errorMessage).toBe("WebSocket error");
      expect(store.getState().state).toBe("failed");
    });
  });

  describe("capture failure after ready", () => {
    test("capture.start() returning false transitions to failed and tears down", async () => {
      // Regression: previously the manager silently dropped a `false`
      // return from `capture.start()` (mic permission denied / no
      // AudioContext / etc.), leaving the store stuck in `connecting`
      // and the UI showing "Connecting voice conversation" forever.
      // After the ready frame the WS-side connection timeout has already
      // been cancelled, so there is no other recovery path.
      const harness = makeHarness();
      const { manager, store } = harness;

      await manager.start("conv-1");
      const client = harness.client();
      const capture = harness.capture();
      const playback = harness.playback();
      expect(store.getState().state).toBe("connecting");

      // Mic will fail to start once `ready` triggers `startCapture()`.
      capture.startResult = false;

      client.emit({
        type: "ready",
        sessionId: "sess-1",
        conversationId: "conv-1",
      });
      await flushMicrotasks();
      await flushMicrotasks();

      // Manager transitioned the session to `failed` via the same path
      // as a server-driven failure, surfacing an error message to the
      // overlay.
      expect(store.getState().state).toBe("failed");
      expect(store.getState().errorMessage.length).toBeGreaterThan(0);

      // Same teardown shape as `handleFailure`: capture shutdown,
      // playback interrupt, client closed (not `end()`).
      expect(capture.shutdownCalls).toBe(1);
      expect(playback.handleInterruptCalls).toBe(1);
      expect(client.closeCalls).toBe(1);
      expect(client.endCalls).toBe(0);
    });
  });

  describe("stopListening", () => {
    test("releases push-to-talk and stops capture, keeps channel open", async () => {
      const harness = makeHarness();
      const { manager } = harness;
      await manager.start("conv-1");
      const client = harness.client();
      const capture = harness.capture();
      client.emit({
        type: "ready",
        sessionId: "sess-1",
        conversationId: "conv-1",
      });
      await flushMicrotasks();

      await manager.stopListening();

      expect(client.releasePushToTalkCalls).toBe(1);
      expect(capture.stopCalls).toBe(1);
      expect(client.endCalls).toBe(0);
      expect(client.closeCalls).toBe(0);
    });
  });

  describe("barge-in playback gate", () => {
    test("re-opens playback gate before the first ttsAudio of a new turn after interrupt", async () => {
      const harness = makeHarness();
      const { manager } = harness;

      await manager.start("conv-1");
      const client = harness.client();
      const capture = harness.capture();
      const playback = harness.playback();
      client.emit({
        type: "ready",
        sessionId: "sess-1",
        conversationId: "conv-1",
      });
      await flushMicrotasks();

      // ---- Turn 1: assistant speaks. ----
      client.emit({ type: "sttFinal", text: "first", seq: 1 });
      client.emit({ type: "thinking", turnId: "turn-1" });
      client.emit({ type: "assistantTextDelta", text: "ok", seq: 2 });

      const turn1Pcm = new Uint8Array([1, 2]);
      client.emit({
        type: "ttsAudio",
        pcm: turn1Pcm,
        mimeType: "audio/pcm",
        sampleRate: 24000,
        seq: 3,
      });

      // First chunk of turn 1 must reset BEFORE enqueueing.
      const turn1Calls = playback.callLog.filter(
        (call) =>
          call === "resetForNextResponse" || call === "enqueueTtsAudio",
      );
      expect(turn1Calls).toEqual([
        "resetForNextResponse",
        "enqueueTtsAudio",
      ]);
      const turn1ResetCount = playback.resetCalls;

      // ---- User barges in: interrupt slams the playback gate shut. ----
      await manager.interruptSpeakingAndStartListening("conv-1");
      await flushMicrotasks();
      expect(playback.handleInterruptCalls).toBe(1);
      // Capture restarts after the interrupt.
      expect(capture.startCalls.length).toBeGreaterThan(1);

      // ---- Turn 2: new utterance produces TTS. The first chunk of
      //      turn 2 must re-open the gate before enqueueing, otherwise
      //      `acceptsAudio === false` silently drops the audio. ----
      client.emit({ type: "sttFinal", text: "second", seq: 4 });
      client.emit({ type: "thinking", turnId: "turn-2" });
      client.emit({ type: "assistantTextDelta", text: "again", seq: 5 });

      const turn2Pcm = new Uint8Array([3, 4]);
      const callsBeforeTurn2 = playback.callLog.length;
      client.emit({
        type: "ttsAudio",
        pcm: turn2Pcm,
        mimeType: "audio/pcm",
        sampleRate: 24000,
        seq: 6,
      });

      // The next two calls (after the snapshot) must be reset → enqueue,
      // in that order — the new turn's first chunk re-opens the gate
      // before it tries to enqueue.
      expect(playback.callLog.slice(callsBeforeTurn2)).toEqual([
        "resetForNextResponse",
        "enqueueTtsAudio",
      ]);
      expect(playback.resetCalls).toBe(turn1ResetCount + 1);
    });

    test("subsequent ttsAudio chunks in the same turn do not call resetForNextResponse again", async () => {
      const harness = makeHarness();
      const { manager } = harness;

      await manager.start("conv-1");
      const client = harness.client();
      const playback = harness.playback();
      client.emit({
        type: "ready",
        sessionId: "sess-1",
        conversationId: "conv-1",
      });
      await flushMicrotasks();

      client.emit({ type: "sttFinal", text: "hi", seq: 1 });
      client.emit({ type: "thinking", turnId: "turn-1" });
      client.emit({ type: "assistantTextDelta", text: "ok", seq: 2 });

      client.emit({
        type: "ttsAudio",
        pcm: new Uint8Array([1]),
        mimeType: "audio/pcm",
        sampleRate: 24000,
        seq: 3,
      });
      expect(playback.resetCalls).toBe(1);

      // Second chunk in the same response should NOT call reset again —
      // the gate is already open.
      client.emit({
        type: "ttsAudio",
        pcm: new Uint8Array([2]),
        mimeType: "audio/pcm",
        sampleRate: 24000,
        seq: 4,
      });
      expect(playback.resetCalls).toBe(1);
      expect(playback.enqueueCalls.length).toBe(2);
    });
  });

  describe("ttsDone teardown race", () => {
    test("ttsDone continuation bails after end() arrives during the playback drain", async () => {
      const harness = makeHarness();
      const { manager, store } = harness;

      await manager.start("conv-1");
      const client = harness.client();
      const playback = harness.playback();
      client.emit({
        type: "ready",
        sessionId: "sess-1",
        conversationId: "conv-1",
      });
      await flushMicrotasks();

      client.emit({ type: "sttFinal", text: "hi", seq: 1 });
      client.emit({ type: "thinking", turnId: "turn-1" });
      client.emit({ type: "assistantTextDelta", text: "ok", seq: 2 });

      // First chunk enqueues and opens the gate (resetCalls = 1).
      client.emit({
        type: "ttsAudio",
        pcm: new Uint8Array([1]),
        mimeType: "audio/pcm",
        sampleRate: 24000,
        seq: 3,
      });
      expect(playback.resetCalls).toBe(1);

      // Make the upcoming drain hang so we can teardown mid-await.
      const resolveDrain = playback.deferNextWait();

      // ttsDone kicks off completeAssistantTurn, which awaits
      // waitUntilPlaybackFinishes — but we haven't resolved yet.
      client.emit({ type: "ttsDone", turnId: "turn-1" });
      await flushMicrotasks();
      expect(playback.waitCalls).toBe(1);
      // No post-await mutations yet — still in `speaking`.
      expect(store.getState().state).toBe("speaking");

      // User ends the session BEFORE the drain finishes. This bumps the
      // session generation, so the in-flight continuation must bail.
      await manager.end();
      expect(store.getState().state).toBe("off");
      const resetCallsAtTeardown = playback.resetCalls;

      // Now resolve the drain — the continuation resumes but should
      // detect the generation mismatch and return without touching the
      // store or calling resetForNextResponse.
      resolveDrain();
      await flushMicrotasks();
      await flushMicrotasks();

      expect(store.getState().state).toBe("off");
      // No extra reset call from the cancelled continuation.
      expect(playback.resetCalls).toBe(resetCallsAtTeardown);
    });

    test("ttsDone continuation bails after a failure arrives during the playback drain", async () => {
      const harness = makeHarness();
      const { manager, store } = harness;

      await manager.start("conv-1");
      const client = harness.client();
      const playback = harness.playback();
      client.emit({
        type: "ready",
        sessionId: "sess-1",
        conversationId: "conv-1",
      });
      await flushMicrotasks();

      client.emit({ type: "thinking", turnId: "turn-1" });
      client.emit({ type: "assistantTextDelta", text: "ok", seq: 1 });
      client.emit({
        type: "ttsAudio",
        pcm: new Uint8Array([1]),
        mimeType: "audio/pcm",
        sampleRate: 24000,
        seq: 2,
      });

      const resolveDrain = playback.deferNextWait();
      client.emit({ type: "ttsDone", turnId: "turn-1" });
      await flushMicrotasks();

      // Failure arrives mid-await — bumps the generation.
      client.fail({ type: "abnormalClosure", code: 1006, reason: "boom" });
      expect(store.getState().state).toBe("failed");
      const resetCallsAtFailure = playback.resetCalls;

      resolveDrain();
      await flushMicrotasks();
      await flushMicrotasks();

      // State stays `failed` — not clobbered back to `listening`.
      expect(store.getState().state).toBe("failed");
      expect(playback.resetCalls).toBe(resetCallsAtFailure);
    });
  });

  describe("client factory", () => {
    test("start → end → start uses a fresh client each time", async () => {
      const { manager, clients, store } = makeHarness();

      // ---- Session 1: start then end. ----
      await manager.start("conv-1");
      expect(clients.length).toBe(1);
      const firstClient = clients[0]!;
      expect(firstClient.startCalls.length).toBe(1);

      firstClient.emit({
        type: "ready",
        sessionId: "sess-1",
        conversationId: "conv-1",
      });
      await flushMicrotasks();

      await manager.end();
      expect(firstClient.endCalls).toBe(1);
      expect(store.getState().state).toBe("off");

      // ---- Session 2: a brand-new client must be built. ----
      await manager.start("conv-2");
      expect(clients.length).toBe(2);
      const secondClient = clients[1]!;
      expect(secondClient).not.toBe(firstClient);
      expect(secondClient.startCalls.length).toBe(1);
      expect(secondClient.startCalls[0]!.conversationId).toBe("conv-2");
      // The old (closed) client must not be touched again.
      expect(firstClient.startCalls.length).toBe(1);

      // The second client's `ready` event drives the second session
      // through the same listening transition as the first.
      secondClient.emit({
        type: "ready",
        sessionId: "sess-2",
        conversationId: "conv-2",
      });
      await flushMicrotasks();
      expect(store.getState().state).toBe("listening");
      expect(store.getState().sessionId).toBe("sess-2");
    });

    test("failure path discards the client so the next start gets a fresh one", async () => {
      const { manager, clients } = makeHarness();

      await manager.start("conv-1");
      const firstClient = clients[0]!;
      firstClient.fail({ type: "connectionFailed", message: "boom" });
      expect(firstClient.closeCalls).toBe(1);

      await manager.start("conv-2");
      expect(clients.length).toBe(2);
      const secondClient = clients[1]!;
      expect(secondClient).not.toBe(firstClient);
      expect(secondClient.startCalls.length).toBe(1);
    });
  });

  describe("capture + playback factories", () => {
    test("start → end → start rebuilds capture and playback so the new session can listen", async () => {
      const harness = makeHarness();
      const { manager, captures, playbacks, store } = harness;

      // ---- Session 1: start, ready, end. ----
      await manager.start("conv-1");
      expect(captures.length).toBe(1);
      expect(playbacks.length).toBe(1);
      const firstCapture = captures[0]!;
      const firstPlayback = playbacks[0]!;

      // `end()` calls shutdown — for the real `LiveVoicePcmCapture`,
      // this would set `isShutdown = true` and any subsequent `start()`
      // would return false, leaving the next session stuck in
      // `connecting`. We must therefore build a fresh capture/playback.
      await manager.end();
      expect(firstCapture.shutdownCalls).toBe(1);
      expect(firstPlayback.handleEndCalls).toBe(1);

      // ---- Session 2: a brand-new capture and playback must be built. ----
      await manager.start("conv-2");
      expect(captures.length).toBe(2);
      expect(playbacks.length).toBe(2);
      const secondCapture = captures[1]!;
      const secondPlayback = playbacks[1]!;
      expect(secondCapture).not.toBe(firstCapture);
      expect(secondPlayback).not.toBe(firstPlayback);
      // The new capture has not been shut down — start() can transition
      // the second session past `connecting`.
      expect(secondCapture.shutdownCalls).toBe(0);
      expect(secondPlayback.handleEndCalls).toBe(0);

      // Drive the second session through `ready` to confirm the new
      // capture actually starts (it would not on a recycled-and-shutdown
      // instance — the second session would be stuck in `connecting`).
      const secondClient = harness.client();
      secondClient.emit({
        type: "ready",
        sessionId: "sess-2",
        conversationId: "conv-2",
      });
      await flushMicrotasks();
      expect(secondCapture.startCalls.length).toBe(1);
      expect(store.getState().state).toBe("listening");
    });

    test("failure path discards capture and playback so the next start gets fresh ones", async () => {
      const harness = makeHarness();
      const { manager, captures, playbacks } = harness;

      await manager.start("conv-1");
      const firstCapture = captures[0]!;
      const firstPlayback = playbacks[0]!;
      const firstClient = harness.client();

      // Failure tears down capture (shutdown) and playback (interrupt),
      // and must drop both references so the next start builds fresh
      // ones.
      firstClient.fail({ type: "connectionFailed", message: "boom" });
      expect(firstCapture.shutdownCalls).toBe(1);
      expect(firstPlayback.handleInterruptCalls).toBe(1);

      await manager.start("conv-2");
      expect(captures.length).toBe(2);
      expect(playbacks.length).toBe(2);
      expect(captures[1]).not.toBe(firstCapture);
      expect(playbacks[1]).not.toBe(firstPlayback);
    });
  });

  describe("muted ttsDone ends the session", () => {
    test("ttsDone after stopListening tears down the session instead of staying half-alive", async () => {
      const harness = makeHarness();
      const { manager, store } = harness;

      await manager.start("conv-1");
      const client = harness.client();
      const capture = harness.capture();
      client.emit({
        type: "ready",
        sessionId: "sess-1",
        conversationId: "conv-1",
      });
      await flushMicrotasks();

      // Run a normal turn so we're in `speaking` when ttsDone arrives.
      client.emit({ type: "thinking", turnId: "turn-1" });
      client.emit({ type: "assistantTextDelta", text: "ok", seq: 1 });
      client.emit({
        type: "ttsAudio",
        pcm: new Uint8Array([1]),
        mimeType: "audio/pcm",
        sampleRate: 24000,
        seq: 2,
      });
      expect(store.getState().state).toBe("speaking");

      // User releases PTT — `ptt_release` is terminal on the server, so
      // the session is logically done once `ttsDone` lands.
      await manager.stopListening();
      expect(client.releasePushToTalkCalls).toBe(1);

      // ttsDone fires after the mute. The continuation must end the
      // session instead of dangling in a half-alive state — otherwise
      // the user's next utterance hits a server-side closed session.
      client.emit({ type: "ttsDone", turnId: "turn-1" });
      await flushMicrotasks();
      await flushMicrotasks();

      // Full teardown ran: store reset, client.end + capture.shutdown
      // both invoked exactly once.
      expect(store.getState().state).toBe("off");
      expect(store.getState().sessionId).toBeNull();
      expect(store.getState().assistantTranscript).toBe("");
      expect(client.endCalls).toBe(1);
      expect(capture.shutdownCalls).toBe(1);
    });

    test("post-mute teardown lets the next start() build a fresh session", async () => {
      const harness = makeHarness();
      const { manager, store, clients } = harness;

      await manager.start("conv-1");
      const firstClient = harness.client();
      firstClient.emit({
        type: "ready",
        sessionId: "sess-1",
        conversationId: "conv-1",
      });
      await flushMicrotasks();

      // Run a turn that ends with stopListening + ttsDone — the session
      // is now fully torn down.
      firstClient.emit({ type: "thinking", turnId: "turn-1" });
      firstClient.emit({ type: "assistantTextDelta", text: "ok", seq: 1 });
      firstClient.emit({
        type: "ttsAudio",
        pcm: new Uint8Array([1]),
        mimeType: "audio/pcm",
        sampleRate: 24000,
        seq: 2,
      });
      await manager.stopListening();
      firstClient.emit({ type: "ttsDone", turnId: "turn-1" });
      await flushMicrotasks();
      await flushMicrotasks();
      expect(store.getState().state).toBe("off");

      // Next start() builds a brand-new client/capture/playback and
      // walks the new session through `listening` as usual.
      await manager.start("conv-2");
      expect(clients.length).toBe(2);
      const secondClient = clients[1]!;
      expect(secondClient).not.toBe(firstClient);
      secondClient.emit({
        type: "ready",
        sessionId: "sess-2",
        conversationId: "conv-2",
      });
      await flushMicrotasks();
      expect(store.getState().state).toBe("listening");
      expect(store.getState().sessionId).toBe("sess-2");
    });

    test("start() resets isUserMuted so a new session is not stuck muted", async () => {
      const { manager, clients, store } = makeHarness();

      // Session 1: mute then end without un-muting.
      await manager.start("conv-1");
      clients[0]!.emit({
        type: "ready",
        sessionId: "sess-1",
        conversationId: "conv-1",
      });
      await flushMicrotasks();
      await manager.stopListening();
      await manager.end();

      // Session 2: start fresh — the mute flag must be cleared.
      await manager.start("conv-2");
      const secondClient = clients[1]!;
      secondClient.emit({
        type: "ready",
        sessionId: "sess-2",
        conversationId: "conv-2",
      });
      await flushMicrotasks();

      secondClient.emit({ type: "thinking", turnId: "turn-1" });
      secondClient.emit({ type: "assistantTextDelta", text: "hi", seq: 1 });
      secondClient.emit({
        type: "ttsAudio",
        pcm: new Uint8Array([1]),
        mimeType: "audio/pcm",
        sampleRate: 24000,
        seq: 2,
      });
      secondClient.emit({ type: "ttsDone", turnId: "turn-1" });
      await flushMicrotasks();
      expect(store.getState().state).toBe("listening");
    });
  });
});
