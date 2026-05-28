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
  enqueueCalls: LiveVoiceTtsChunk[] = [];
  handleInterruptCalls = 0;
  handleEndCalls = 0;
  handleSessionErrorCalls = 0;
  resetCalls = 0;
  waitCalls = 0;

  enqueueTtsAudio(chunk: LiveVoiceTtsChunk): void {
    this.enqueueCalls.push(chunk);
  }

  handleInterrupt(): void {
    this.handleInterruptCalls += 1;
  }

  handleEnd(): void {
    this.handleEndCalls += 1;
  }

  handleSessionError(): void {
    this.handleSessionErrorCalls += 1;
  }

  resetForNextResponse(): void {
    this.resetCalls += 1;
  }

  async waitUntilPlaybackFinishes(): Promise<void> {
    this.waitCalls += 1;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Harness {
  manager: LiveVoiceChannelManager;
  client: FakeClient;
  capture: FakeCapture;
  playback: FakePlayback;
  store: LiveVoiceStoreLike;
}

function makeHarness(): Harness {
  const client = new FakeClient();
  const capture = new FakeCapture();
  const playback = new FakePlayback();
  const store = createFakeStore();
  const manager = new LiveVoiceChannelManager({
    client,
    capture,
    playback,
    store,
  });
  return { manager, client, capture, playback, store };
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
      const { manager, client, capture, playback, store } = makeHarness();

      await manager.start("conv-1");
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

      // ttsAudio → playback enqueued with pcm chunk payload.
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

      // ttsDone → waitUntilPlaybackFinishes runs, transcript reset,
      // state back to listening.
      client.emit({ type: "ttsDone", turnId: "turn-1" });
      await flushMicrotasks();
      expect(playback.waitCalls).toBe(1);
      expect(playback.resetCalls).toBe(1);
      expect(store.getState().assistantTranscript).toBe("");
      expect(store.getState().state).toBe("listening");
    });
  });

  describe("interrupt path", () => {
    test("interruptSpeakingAndStartListening interrupts client + playback and restarts capture", async () => {
      const { manager, client, capture, playback } = makeHarness();
      await manager.start("conv-1");
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
      const { manager, client, capture, playback, store } = makeHarness();
      await manager.start("conv-1");
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
      const { manager, client, capture, playback, store } = makeHarness();

      await manager.start("conv-1");
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
      const { manager, client, store } = makeHarness();
      await manager.start("conv-1");

      client.fail({
        type: "connectionFailed",
        message: "WebSocket error",
      });

      expect(store.getState().errorMessage).toBe("WebSocket error");
      expect(store.getState().state).toBe("failed");
    });
  });

  describe("stopListening", () => {
    test("releases push-to-talk and stops capture, keeps channel open", async () => {
      const { manager, client, capture } = makeHarness();
      await manager.start("conv-1");
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
});
