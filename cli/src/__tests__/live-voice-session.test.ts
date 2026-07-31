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
  LiveVoiceForegroundSession,
  type LiveVoiceForegroundState,
  type LiveVoiceMode,
  type LiveVoiceSessionChannel,
  type LiveVoiceTimingMetric,
} from "../lib/live-voice/session.js";

class FakeCaptureSession implements LiveVoicePcmCaptureSession {
  readonly closed: Promise<void>;
  readonly tail = Buffer.from([5, 6]);
  stopCount = 0;
  muted = false;
  private rejectClosed: (error: Error) => void = () => {};

  constructor() {
    this.closed = new Promise<void>((_resolve, reject) => {
      this.rejectClosed = reject;
    });
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  fail(error: Error): void {
    this.rejectClosed(error);
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
      turnDetection?: "manual" | "server_vad";
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
          turnDetection: this.behavior.turnDetection ?? "manual",
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
    mode?: LiveVoiceMode;
    sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
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
  const microphoneStates: boolean[] = [];
  const modeChanges: Array<{ mode: LiveVoiceMode; reason: string }> = [];
  const echoSummaries: unknown[] = [];
  let now = 100;

  const session = new LiveVoiceForegroundSession({
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
    ...(options.mode ? { mode: options.mode } : {}),
    ...(options.conversationId
      ? { conversationId: options.conversationId }
      : {}),
    ...(options.captions ? { captions: options.captions } : {}),
    now: () => now,
    sleep:
      options.sleep ??
      (async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      }),
    onState: (state) => states.push(state),
    onCaption: (role, text) => captions.push({ role, text }),
    onCaptionMode: (mode) => captionModes.push(mode),
    onTiming: (metric) => timings.push(metric),
    onError: (error) => errors.push(error),
    onMicrophoneState: (muted) => microphoneStates.push(muted),
    onModeChange: (mode, reason) => modeChanges.push({ mode, reason }),
    onEchoSummary: (summary) => echoSummaries.push(summary),
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
    microphoneStates,
    modeChanges,
    echoSummaries,
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

describe("LiveVoiceForegroundSession", () => {
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

  test("keeps push-to-talk capture active when STT arrives before release", async () => {
    const harness = makeHarness(
      [
        {
          type: "ready",
          sessionId: "session-1",
          conversationId: "conversation-1",
        },
      ],
      { captions: "user" },
    );

    await harness.session.start();
    await harness.session.handleKey("enter");
    harness.capture.emit(Buffer.from([1, 2]));
    harness.channels[0].emit("frame", {
      type: "stt_partial",
      seq: 2,
      text: "hello",
    });
    await waitFor(() => harness.captions.length === 1);

    expect(harness.session.currentState).toBe("listening");
    harness.capture.emit(Buffer.from([3, 4]));
    await harness.session.handleKey("enter");

    expect(harness.channels[0].audio.map((value) => [...value])).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
    expect(harness.capture.sessions[0].stopCount).toBe(1);
    expect(harness.channels[0].pttReleaseCount).toBe(1);
    expect(harness.session.currentState).toBe("transcribing");
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

  test("keeps two server-VAD turns on one socket with continuous capture", async () => {
    const harness = makeHarness(
      [
        {
          type: "ready",
          sessionId: "session-open",
          conversationId: "conversation-open",
          turnDetection: "server_vad",
        },
      ],
      { mode: "open-mic" },
    );

    await harness.session.start();
    expect(harness.channels[0].connectOptions).toEqual([
      { turnDetection: "server_vad" },
    ]);
    expect(harness.capture.sessions).toHaveLength(1);
    expect(harness.session.currentState).toBe("listening");
    expect(harness.microphoneStates).toEqual([false]);

    for (let turn = 1; turn <= 2; turn += 1) {
      harness.capture.emit(Buffer.from([turn, turn]));
      harness.channels[0].emit("frame", {
        type: "speech_started",
        seq: turn * 10,
      });
      harness.channels[0].emit("frame", {
        type: "utterance_end",
        seq: turn * 10 + 1,
        reason: "silence",
      });
      harness.channels[0].emit("frame", {
        type: "thinking",
        seq: turn * 10 + 2,
        turnId: `turn-${turn}`,
      });
      harness.channels[0].emit("frame", {
        type: "tts_audio",
        seq: turn * 10 + 3,
        mimeType: "audio/pcm",
        sampleRate: 16_000,
        dataBase64: Buffer.from([turn, turn]).toString("base64"),
      });
      harness.channels[0].emit("frame", {
        type: "tts_done",
        seq: turn * 10 + 4,
        turnId: `turn-${turn}`,
      });
      await waitFor(
        () => harness.playback.drainCount === turn,
        `turn ${turn} playback drain`,
      );
    }

    expect(harness.channels).toHaveLength(1);
    expect(harness.channels[0].endCount).toBe(0);
    expect(harness.capture.sessions).toHaveLength(1);
    expect(harness.capture.sessions[0].stopCount).toBe(0);
    expect(harness.session.currentState).toBe("listening");
    await harness.session.shutdown();
  });

  test("fails instead of silently listening after capture exits", async () => {
    const harness = makeHarness(
      [
        {
          type: "ready",
          sessionId: "session-open",
          conversationId: "conversation-open",
          turnDetection: "server_vad",
        },
      ],
      { mode: "open-mic" },
    );
    await harness.session.start();
    expect(harness.session.currentState).toBe("listening");

    harness.capture.sessions[0].fail(
      new Error("pw-record stopped unexpectedly with code 0."),
    );

    await waitFor(() => harness.session.currentState === "failed");
    await harness.session.waitUntilClosed();
    expect(harness.errors).toEqual([
      new Error("pw-record stopped unexpectedly with code 0."),
    ]);
    expect(harness.capture.sessions[0].stopCount).toBe(1);
    expect(harness.channels[0].endCount).toBe(1);
  });

  test("mutes with equal-duration zeros while preserving capture during TTS", async () => {
    const harness = makeHarness(
      [
        {
          type: "ready",
          sessionId: "session-open",
          conversationId: "conversation-open",
          turnDetection: "server_vad",
        },
      ],
      { mode: "open-mic" },
    );
    await harness.session.start();

    await harness.session.handleKey("mute");
    harness.capture.emit(Buffer.from([1, 2, 3, 4]));
    expect(harness.channels[0].audio[0]).toEqual(Buffer.alloc(4));
    expect(harness.capture.sessions[0].muted).toBe(true);
    expect(harness.microphoneStates.at(-1)).toBe(true);

    harness.channels[0].emit("frame", {
      type: "thinking",
      seq: 2,
      turnId: "turn-1",
    });
    harness.channels[0].emit("frame", {
      type: "tts_audio",
      seq: 3,
      mimeType: "audio/pcm",
      sampleRate: 16_000,
      dataBase64: Buffer.from([5, 6]).toString("base64"),
    });
    await waitFor(() => harness.playback.chunks.length === 1);
    await harness.session.handleKey("mute");
    harness.capture.emit(Buffer.from([7, 8, 9, 10]));

    expect(harness.channels[0].audio[1]).toEqual(Buffer.from([7, 8, 9, 10]));
    expect(harness.capture.sessions[0].stopCount).toBe(0);
    await harness.session.shutdown();
  });

  test("drops late TTS after cancellation and reports scalar echo evidence", async () => {
    const harness = makeHarness(
      [
        {
          type: "ready",
          sessionId: "session-open",
          conversationId: "conversation-open",
          turnDetection: "server_vad",
        },
      ],
      { mode: "open-mic" },
    );
    await harness.session.start();
    harness.capture.emit(Buffer.alloc(1_600));

    harness.channels[0].emit("frame", {
      type: "thinking",
      seq: 2,
      turnId: "turn-1",
    });
    const audiblePcm = Buffer.alloc(1_600);
    for (let offset = 0; offset < audiblePcm.length; offset += 2) {
      audiblePcm.writeInt16LE(8_000, offset);
    }
    harness.channels[0].emit("frame", {
      type: "tts_audio",
      seq: 3,
      mimeType: "audio/pcm",
      sampleRate: 16_000,
      dataBase64: audiblePcm.toString("base64"),
    });
    await waitFor(() => harness.playback.chunks.length === 1);
    harness.capture.emit(Buffer.alloc(1_600));
    harness.channels[0].emit("frame", {
      type: "tts_done",
      seq: 4,
      turnId: "turn-1",
    });
    await waitFor(() => harness.echoSummaries.length === 1);

    harness.channels[0].emit("frame", {
      type: "turn_cancelled",
      seq: 5,
      turnId: "turn-1",
    });
    harness.channels[0].emit("frame", {
      type: "tts_audio",
      seq: 6,
      mimeType: "audio/pcm",
      sampleRate: 16_000,
      dataBase64: Buffer.from([9, 10]).toString("base64"),
    });
    await waitFor(() => harness.playback.flushCount >= 1);

    expect(harness.playback.chunks).toHaveLength(1);
    expect(harness.echoSummaries[0]).toMatchObject({ sampleCount: 1 });
    await harness.session.shutdown();
  });

  test("reconnects bounded retryable closes with mode, mute, and conversation", async () => {
    const harness = makeHarness(
      [
        {
          type: "ready",
          sessionId: "session-1",
          conversationId: "conversation-open",
          turnDetection: "server_vad",
        },
        {
          type: "ready",
          sessionId: "session-2",
          conversationId: "conversation-open",
          turnDetection: "server_vad",
        },
      ],
      { mode: "open-mic", captions: "both" },
    );
    await harness.session.start();
    await harness.session.handleKey("mute");

    harness.channels[0].emit("closed", {
      code: 1012,
      reason: "service restart",
      retryable: true,
    });
    await waitFor(
      () =>
        harness.channels.length === 2 && harness.capture.sessions.length === 2,
      "open-mic reconnect",
    );

    expect(harness.channels[1].connectOptions).toEqual([
      {
        conversationId: "conversation-open",
        turnDetection: "server_vad",
      },
    ]);
    expect(harness.capture.sessions[0].stopCount).toBe(1);
    expect(harness.capture.sessions[1].muted).toBe(true);
    expect(harness.playback.flushCount).toBeGreaterThanOrEqual(1);
    expect(harness.session.currentMode).toBe("open-mic");
    harness.channels[1].emit("frame", {
      type: "stt_final",
      seq: 2,
      text: "reconnected user caption",
    });
    harness.channels[1].emit("frame", {
      type: "assistant_text_delta",
      seq: 3,
      text: "reconnected assistant caption",
    });
    await waitFor(() => harness.captions.length === 2);
    expect(harness.captions).toEqual([
      { role: "user", text: "reconnected user caption" },
      { role: "assistant", text: "reconnected assistant caption" },
    ]);
    await harness.session.shutdown();
  });

  test("bounds reconnect attempts and fails after the retry schedule", async () => {
    const harness = makeHarness(
      [
        {
          type: "ready",
          sessionId: "session-1",
          conversationId: "conversation-open",
          turnDetection: "server_vad",
        },
      ],
      { mode: "open-mic" },
    );
    await harness.session.start();

    harness.channels[0].emit("closed", {
      code: 1013,
      reason: "try again later",
      retryable: true,
    });
    await harness.session.waitUntilClosed();

    expect(harness.sleeps).toEqual([...LIVE_VOICE_BUSY_RETRY_DELAYS_MS]);
    expect(harness.session.currentState).toBe("failed");
    expect(harness.errors[0]?.message).toContain(
      "No fake channel behavior remains",
    );
  });

  test("tears down cleanly while a reconnect delay is pending", async () => {
    let resolveSleepStarted: (() => void) | undefined;
    const sleepStarted = new Promise<void>((resolve) => {
      resolveSleepStarted = resolve;
    });
    const harness = makeHarness(
      [
        {
          type: "ready",
          sessionId: "session-1",
          conversationId: "conversation-open",
          turnDetection: "server_vad",
        },
      ],
      {
        mode: "open-mic",
        sleep: async (_milliseconds, signal) =>
          await new Promise<void>((resolve, reject) => {
            resolveSleepStarted?.();
            const handleAbort = (): void => {
              reject(new Error("aborted"));
            };
            signal.addEventListener("abort", handleAbort, { once: true });
          }),
      },
    );
    await harness.session.start();
    harness.channels[0].emit("closed", {
      code: 1012,
      reason: "service restart",
      retryable: true,
    });
    await sleepStarted;

    await harness.session.shutdown();

    expect(harness.session.currentState).toBe("ended");
    expect(harness.playback.closeCount).toBe(1);
    expect(harness.errors).toEqual([]);
  });

  test("falls back to push-to-talk when ready does not confirm server VAD", async () => {
    const harness = makeHarness(
      [
        {
          type: "ready",
          sessionId: "session-old",
          conversationId: "conversation-old",
          turnDetection: "manual",
        },
      ],
      { mode: "open-mic" },
    );

    await harness.session.start();

    expect(harness.session.currentMode).toBe("push-to-talk");
    expect(harness.capture.sessions).toHaveLength(0);
    expect(harness.modeChanges[0]).toMatchObject({ mode: "push-to-talk" });
    expect(harness.modeChanges[0]?.reason).toContain("Falling back");
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
