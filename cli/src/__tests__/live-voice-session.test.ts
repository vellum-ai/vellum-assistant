import { describe, expect, test } from "bun:test";

import type {
  LiveVoiceChannelClientEventHandler,
  LiveVoiceChannelClientEventMap,
  LiveVoiceChannelClientEventName,
} from "../lib/live-voice/channel-client.js";
import type {
  LiveVoicePcmCaptureOptions,
  LiveVoicePcmCaptureSession,
  LiveVoicePcmPlayback,
  LiveVoicePlaybackChunk,
} from "../lib/live-voice/audio.js";
import {
  LIVE_VOICE_BUSY_RETRY_DELAYS_MS,
  LiveVoicePushToTalkSession,
  type LiveVoiceForegroundState,
  type LiveVoiceSessionChannel,
  type LiveVoiceTimingMetric,
} from "../lib/live-voice/session.js";

class FakeCaptureSession implements LiveVoicePcmCaptureSession {
  readonly closed = new Promise<void>(() => {});
  readonly tail = Buffer.from([5, 6]);
  stopCount = 0;
  muted = false;

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  async stop(): Promise<Buffer | null> {
    this.stopCount += 1;
    return this.tail;
  }
}

class FakeCapture {
  readonly sessions: FakeCaptureSession[] = [];
  readonly options: LiveVoicePcmCaptureOptions[] = [];

  async startCapture(
    options: LiveVoicePcmCaptureOptions,
  ): Promise<LiveVoicePcmCaptureSession> {
    const session = new FakeCaptureSession();
    this.options.push(options);
    this.sessions.push(session);
    return session;
  }

  emit(frame: Buffer): void {
    this.options.at(-1)?.onFrame(frame, 0.1);
  }
}

class FakePlayback implements LiveVoicePcmPlayback {
  readonly chunks: LiveVoicePlaybackChunk[] = [];
  drainCount = 0;
  flushCount = 0;
  closeCount = 0;

  async write(chunk: LiveVoicePlaybackChunk): Promise<void> {
    this.chunks.push(chunk);
  }

  async drain(): Promise<void> {
    this.drainCount += 1;
  }

  async flush(): Promise<void> {
    this.flushCount += 1;
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

type ConnectBehavior =
  | {
      type: "ready";
      sessionId: string;
      conversationId: string;
    }
  | { type: "busy"; activeSessionId: string };

class FakeChannel implements LiveVoiceSessionChannel {
  readonly connectOptions: Array<{
    readonly conversationId?: string;
    readonly turnDetection?: "manual" | "server_vad";
  }> = [];
  readonly audio: Uint8Array[] = [];
  pttReleaseCount = 0;
  interruptCount = 0;
  endCount = 0;
  closeCount = 0;

  private readonly listeners: {
    [EventName in LiveVoiceChannelClientEventName]: Set<
      LiveVoiceChannelClientEventHandler<EventName>
    >;
  } = {
    ready: new Set(),
    busy: new Set(),
    frame: new Set(),
    error: new Set(),
    closed: new Set(),
  };

  constructor(private readonly behavior: ConnectBehavior) {}

  on<EventName extends LiveVoiceChannelClientEventName>(
    event: EventName,
    handler: LiveVoiceChannelClientEventHandler<EventName>,
  ): () => void {
    this.listeners[event].add(handler);
    return () => {
      this.listeners[event].delete(handler);
    };
  }

  connect(options: {
    readonly conversationId?: string;
    readonly turnDetection?: "manual" | "server_vad";
  }): void {
    this.connectOptions.push(options);
    queueMicrotask(() => {
      if (this.behavior.type === "ready") {
        this.emit("ready", {
          type: "ready",
          seq: 1,
          sessionId: this.behavior.sessionId,
          conversationId: this.behavior.conversationId,
          turnDetection: "manual",
        });
      } else {
        this.emit("busy", {
          type: "busy",
          seq: 1,
          activeSessionId: this.behavior.activeSessionId,
        });
        this.close();
      }
    });
  }

  sendAudio(pcm: ArrayBuffer | Uint8Array): void {
    this.audio.push(
      pcm instanceof Uint8Array ? Buffer.from(pcm) : new Uint8Array(pcm),
    );
  }

  pttRelease(): void {
    this.pttReleaseCount += 1;
  }

  interrupt(): void {
    this.interruptCount += 1;
  }

  end(): void {
    this.endCount += 1;
    this.emit("closed", {
      code: null,
      reason: "client closed",
      retryable: false,
    });
  }

  close(): void {
    this.closeCount += 1;
    this.emit("closed", {
      code: null,
      reason: "client closed",
      retryable: false,
    });
  }

  emit<EventName extends LiveVoiceChannelClientEventName>(
    event: EventName,
    payload: LiveVoiceChannelClientEventMap[EventName],
  ): void {
    for (const listener of this.listeners[event]) {
      listener(payload);
    }
  }
}

function makeHarness(
  behaviors: ConnectBehavior[],
  options: {
    captions?: "off" | "user" | "assistant" | "both";
    conversationId?: string;
  } = {},
) {
  const capture = new FakeCapture();
  const playback = new FakePlayback();
  const channels: FakeChannel[] = [];
  const states: LiveVoiceForegroundState[] = [];
  const captions: Array<{ role: "user" | "assistant"; text: string }> = [];
  const captionModes: string[] = [];
  const timings: LiveVoiceTimingMetric[] = [];
  const errors: Error[] = [];
  const sleeps: number[] = [];
  let now = 100;

  const session = new LiveVoicePushToTalkSession({
    resolveEndpoint: async () => ({
      url: "wss://voice.example.com/v1/live-voice?token=secret-value",
    }),
    createChannel: () => {
      const behavior = behaviors.shift();
      if (behavior === undefined) {
        throw new Error("No fake channel behavior remains.");
      }
      const channel = new FakeChannel(behavior);
      channels.push(channel);
      return channel;
    },
    capture,
    playback,
    ...(options.conversationId
      ? { conversationId: options.conversationId }
      : {}),
    ...(options.captions ? { captions: options.captions } : {}),
    now: () => now,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      now += milliseconds;
    },
    onState: (state) => states.push(state),
    onCaption: (role, text) => captions.push({ role, text }),
    onCaptionMode: (mode) => captionModes.push(mode),
    onTiming: (metric) => timings.push(metric),
    onError: (error) => errors.push(error),
  });

  return {
    session,
    capture,
    playback,
    channels,
    states,
    captions,
    captionModes,
    timings,
    errors,
    sleeps,
    advance(milliseconds: number) {
      now += milliseconds;
    },
  };
}

async function waitFor(
  condition: () => boolean,
  message = "condition",
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) {
      return;
    }
    await Bun.sleep(1);
  }
  throw new Error(`Timed out waiting for ${message}.`);
}

describe("LiveVoicePushToTalkSession", () => {
  test("retains the conversation and opens a fresh manual session after playback drains", async () => {
    const harness = makeHarness(
      [
        {
          type: "ready",
          sessionId: "session-1",
          conversationId: "conversation-1",
        },
        {
          type: "ready",
          sessionId: "session-2",
          conversationId: "conversation-1",
        },
      ],
      { conversationId: "conversation-requested" },
    );

    await harness.session.start();
    expect(harness.channels[0].connectOptions).toEqual([
      {
        conversationId: "conversation-requested",
        turnDetection: "manual",
      },
    ]);

    await harness.session.handleKey("enter");
    harness.capture.emit(Buffer.from([1, 2, 3, 4]));
    harness.advance(10);
    await harness.session.handleKey("enter");
    expect(harness.channels[0].audio.map((value) => [...value])).toEqual([
      [1, 2, 3, 4],
      [5, 6],
    ]);
    expect(harness.channels[0].pttReleaseCount).toBe(1);

    harness.advance(400);
    harness.channels[0].emit("frame", {
      type: "tts_audio",
      seq: 2,
      mimeType: "audio/pcm",
      sampleRate: 16_000,
      dataBase64: Buffer.from([7, 8]).toString("base64"),
    });
    harness.channels[0].emit("frame", {
      type: "tts_done",
      seq: 3,
      turnId: "turn-1",
    });

    await waitFor(
      () =>
        harness.channels.length === 2 &&
        harness.session.currentState === "ready",
      "the next ready session",
    );
    expect(harness.playback.chunks[0].audio).toEqual(Buffer.from([7, 8]));
    expect(harness.playback.drainCount).toBe(1);
    expect(harness.channels[0].endCount).toBe(1);
    expect(harness.channels[1].connectOptions).toEqual([
      {
        conversationId: "conversation-1",
        turnDetection: "manual",
      },
    ]);
    expect(harness.timings).toContainEqual({
      name: "input_end_to_first_tts",
      durationMs: 400,
    });

    await harness.session.shutdown();
  });

  test("retries when a same-session busy frame is followed by the client's immediate close", async () => {
    const harness = makeHarness([
      {
        type: "ready",
        sessionId: "session-1",
        conversationId: "conversation-1",
      },
      { type: "busy", activeSessionId: "session-1" },
      { type: "busy", activeSessionId: "session-1" },
      {
        type: "ready",
        sessionId: "session-2",
        conversationId: "conversation-1",
      },
    ]);

    await harness.session.start();
    harness.channels[0].emit("frame", {
      type: "utterance_discarded",
      seq: 2,
    });

    await waitFor(
      () =>
        harness.channels.length === 4 &&
        harness.session.currentState === "ready",
      "same-session retry",
    );
    expect(harness.sleeps).toEqual([100, 250]);
    expect(harness.channels[1].closeCount).toBe(1);
    expect(harness.channels[2].closeCount).toBe(1);
    expect(harness.errors).toEqual([]);
    await harness.session.shutdown();
  });

  test("still treats a close after ready as fatal", async () => {
    const harness = makeHarness([
      {
        type: "ready",
        sessionId: "session-1",
        conversationId: "conversation-1",
      },
    ]);

    await harness.session.start();
    harness.channels[0].emit("closed", {
      code: 1006,
      reason: "network connection lost",
      retryable: false,
    });

    await harness.session.waitUntilClosed();
    expect(harness.session.currentState).toBe("failed");
    expect(harness.errors[0]?.message).toBe("network connection lost");
  });

  test("does not steal a different active session", async () => {
    const harness = makeHarness([
      {
        type: "ready",
        sessionId: "session-1",
        conversationId: "conversation-1",
      },
      { type: "busy", activeSessionId: "session-other" },
    ]);

    await harness.session.start();
    harness.channels[0].emit("frame", {
      type: "utterance_discarded",
      seq: 2,
    });

    await harness.session.waitUntilClosed();
    expect(harness.session.currentState).toBe("failed");
    expect(harness.errors[0]?.message).toContain("session-other");
    expect(harness.sleeps).toEqual([]);
  });

  test("stops retrying after the bounded release schedule", async () => {
    const harness = makeHarness([
      {
        type: "ready",
        sessionId: "session-1",
        conversationId: "conversation-1",
      },
      ...Array.from({ length: 5 }, () => ({
        type: "busy" as const,
        activeSessionId: "session-1",
      })),
    ]);

    await harness.session.start();
    harness.channels[0].emit("frame", {
      type: "utterance_discarded",
      seq: 2,
    });

    await harness.session.waitUntilClosed();
    expect(harness.sleeps).toEqual([...LIVE_VOICE_BUSY_RETRY_DELAYS_MS]);
    expect(harness.errors[0]?.message).toContain("still releasing");
  });

  test("keeps captions off by default and cycles caption visibility", async () => {
    const harness = makeHarness([
      {
        type: "ready",
        sessionId: "session-1",
        conversationId: "conversation-1",
      },
    ]);
    await harness.session.start();

    harness.channels[0].emit("frame", {
      type: "stt_final",
      seq: 2,
      text: "hidden user caption",
    });
    harness.channels[0].emit("frame", {
      type: "assistant_text_delta",
      seq: 3,
      text: "hidden assistant caption",
    });
    await waitFor(() => harness.states.includes("transcribing"));
    expect(harness.captions).toEqual([]);

    await harness.session.handleKey("captions");
    harness.channels[0].emit("frame", {
      type: "stt_final",
      seq: 4,
      text: "visible user caption",
    });
    harness.channels[0].emit("frame", {
      type: "assistant_text_delta",
      seq: 5,
      text: "still hidden",
    });
    await waitFor(() => harness.captions.length === 1);
    expect(harness.captionModes).toEqual(["user"]);
    expect(harness.captions).toEqual([
      { role: "user", text: "visible user caption" },
    ]);
    await harness.session.shutdown();
  });

  test("interrupts an active reply and flushes playback", async () => {
    const harness = makeHarness([
      {
        type: "ready",
        sessionId: "session-1",
        conversationId: "conversation-1",
      },
    ]);
    await harness.session.start();
    harness.channels[0].emit("frame", {
      type: "thinking",
      seq: 2,
      turnId: "turn-1",
    });
    await waitFor(() => harness.session.currentState === "thinking");

    await harness.session.handleKey("interrupt");
    expect(harness.channels[0].interruptCount).toBe(1);
    expect(harness.playback.flushCount).toBe(1);
    await harness.session.shutdown();
  });

  test("cleans up capture, playback, and the channel idempotently", async () => {
    const harness = makeHarness([
      {
        type: "ready",
        sessionId: "session-1",
        conversationId: "conversation-1",
      },
    ]);
    await harness.session.start();
    await harness.session.handleKey("enter");

    await Promise.all([
      harness.session.shutdown(),
      harness.session.shutdown(),
      harness.session.shutdown(),
    ]);

    expect(harness.capture.sessions[0].stopCount).toBe(1);
    expect(harness.channels[0].endCount).toBe(1);
    expect(harness.playback.flushCount).toBe(1);
    expect(harness.playback.closeCount).toBe(1);
    expect(harness.session.currentState).toBe("ended");
  });
});
