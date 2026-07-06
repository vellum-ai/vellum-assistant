import { describe, expect, mock, test } from "bun:test";

import type { TurnDetectorConfig } from "../../calls/media-turn-detector.js";
import type {
  VoiceTurnCallbacks,
  VoiceTurnOptions,
} from "../../calls/voice-session-bridge.js";
import type {
  StreamingTranscriber,
  SttStreamServerEvent,
} from "../../stt/types.js";
import {
  LiveVoiceSession,
  type LiveVoiceTtsStreamer,
  type LiveVoiceTurnStarter,
} from "../live-voice-session.js";
import type { LiveVoiceSessionFactoryContext } from "../live-voice-session-manager.js";
import type {
  LiveVoiceTtsAudioChunk,
  LiveVoiceTtsOptions,
  LiveVoiceTtsResult,
} from "../live-voice-tts.js";
import {
  createLiveVoiceServerFrameSequencer,
  type LiveVoiceClientStartFrame,
  type LiveVoiceServerFrame,
} from "../protocol.js";

const SAMPLE_RATE = 24_000;

const VAD_START_FRAME = {
  type: "start",
  conversationId: "conversation-123",
  turnDetection: "server_vad",
  audio: {
    mimeType: "audio/pcm",
    sampleRate: SAMPLE_RATE,
    channels: 1,
  },
} as const satisfies LiveVoiceClientStartFrame;

const MANUAL_START_FRAME = {
  type: "start",
  conversationId: "conversation-123",
  audio: VAD_START_FRAME.audio,
} as const satisfies LiveVoiceClientStartFrame;

function pcm(amplitude: number, sampleCount = 240): Uint8Array {
  const buffer = Buffer.alloc(sampleCount * 2);
  for (let index = 0; index < sampleCount; index += 1) {
    buffer.writeInt16LE(amplitude, index * 2);
  }
  return new Uint8Array(buffer);
}

const LOUD_CHUNK = pcm(8_000);
const SILENT_CHUNK = pcm(0);

class MockStreamingTranscriber implements StreamingTranscriber {
  readonly providerId = "deepgram" as const;
  readonly boundaryId = "daemon-streaming" as const;
  readonly received: Buffer[] = [];
  stopped = false;
  private onEvent: ((event: SttStreamServerEvent) => void) | null = null;

  constructor(private readonly stopEvents: SttStreamServerEvent[]) {}

  async start(onEvent: (event: SttStreamServerEvent) => void): Promise<void> {
    this.onEvent = onEvent;
  }

  sendAudio(chunk: Buffer): void {
    this.received.push(Buffer.from(chunk));
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const event of this.stopEvents) {
      this.onEvent?.(event);
    }
  }
}

function createHarness(options: {
  startFrame?: LiveVoiceClientStartFrame;
  finals?: string[];
  startVoiceTurn?: LiveVoiceTurnStarter;
  streamTtsAudio?: LiveVoiceTtsStreamer | null;
  turnDetectorConfig?: TurnDetectorConfig;
  emitMetrics?: boolean;
  metricsClock?: () => number;
}) {
  const sequencer = createLiveVoiceServerFrameSequencer();
  const frames: LiveVoiceServerFrame[] = [];
  const context: LiveVoiceSessionFactoryContext = {
    sessionId: "session-123",
    startFrame: options.startFrame ?? VAD_START_FRAME,
    sendFrame: mock(async (payload) => {
      const frame = sequencer.next(payload);
      frames.push(frame);
      return frame;
    }),
  };

  const finals = options.finals ?? ["hello world"];
  const transcribers: MockStreamingTranscriber[] = [];
  const resolveTranscriber = mock(async () => {
    const text =
      finals[transcribers.length] ?? `utterance ${transcribers.length + 1}`;
    const transcriber = new MockStreamingTranscriber([
      { type: "final", text },
      { type: "closed" },
    ]);
    transcribers.push(transcriber);
    return transcriber;
  });

  let turnNumber = 0;
  const session = new LiveVoiceSession(context, {
    resolveTranscriber,
    startVoiceTurn:
      options.startVoiceTurn ??
      mock(async () => ({ turnId: "bridge-turn", abort: mock() })),
    streamTtsAudio: options.streamTtsAudio ?? null,
    emitMetrics: options.emitMetrics ?? false,
    ...(options.metricsClock ? { metricsClock: options.metricsClock } : {}),
    createTurnId: () => {
      turnNumber += 1;
      return `live-turn-${turnNumber}`;
    },
    turnDetectorConfig: options.turnDetectorConfig ?? {
      silenceThresholdMs: 40,
    },
  });

  return { frames, session, transcribers };
}

function frameTypes(frames: LiveVoiceServerFrame[]): string[] {
  return frames.map((frame) => frame.type);
}

function countType(frames: LiveVoiceServerFrame[], type: string): number {
  return frames.filter((frame) => frame.type === type).length;
}

function makeTtsChunk(text: string): LiveVoiceTtsAudioChunk {
  return {
    type: "tts_audio",
    contentType: "audio/pcm",
    sampleRate: SAMPLE_RATE,
    dataBase64: Buffer.from(text).toString("base64"),
  };
}

function makeTtsResult(text: string): LiveVoiceTtsResult {
  return {
    provider: "fish-audio",
    contentType: "audio/pcm",
    sampleRate: SAMPLE_RATE,
    chunks: 1,
    bytes: Buffer.byteLength(text),
  };
}

function makeTextDelta(
  text: string,
): Parameters<NonNullable<VoiceTurnCallbacks["assistant_text_delta"]>>[0] {
  return {
    type: "assistant_text_delta",
    text,
    conversationId: "conversation-123",
  };
}

function makeMessageComplete(): Parameters<
  NonNullable<VoiceTurnCallbacks["message_complete"]>
>[0] {
  return {
    type: "message_complete",
    conversationId: "conversation-123",
    messageId: "assistant-message-123",
  };
}

// Completes each turn immediately: one text delta, then message_complete.
function makeAutoCompletingTurnStarter(replies: string[]): {
  startVoiceTurn: LiveVoiceTurnStarter;
  calls: VoiceTurnOptions[];
} {
  const calls: VoiceTurnOptions[] = [];
  const startVoiceTurn: LiveVoiceTurnStarter = async (options) => {
    calls.push(options);
    const reply = replies[calls.length - 1] ?? "Okay.";
    options.callbacks?.assistant_text_delta?.(makeTextDelta(reply));
    options.callbacks?.message_complete?.(makeMessageComplete());
    return { turnId: `bridge-turn-${calls.length}`, abort: mock() };
  };
  return { startVoiceTurn, calls };
}

async function waitFor(
  predicate: () => boolean,
  message = "Timed out waiting for live voice VAD test condition",
): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

async function flushAsyncCallbacks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("LiveVoiceSession server VAD", () => {
  test("silence then speech then silence emits speech_started, utterance_end, and runs a turn", async () => {
    const { frames, session } = createHarness({
      finals: ["hello world"],
      startVoiceTurn: makeAutoCompletingTurnStarter(["Hi there."])
        .startVoiceTurn,
    });

    await session.start();
    await session.handleBinaryAudio(SILENT_CHUNK);
    expect(frameTypes(frames)).toEqual(["ready"]);

    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    expect(frameTypes(frames)).toEqual([
      "ready",
      "speech_started",
      "utterance_end",
      "stt_final",
      "thinking",
      "assistant_text_delta",
      "tts_done",
    ]);
    expect(
      frames.find((frame) => frame.type === "utterance_end"),
    ).toMatchObject({
      type: "utterance_end",
      reason: "silence",
    });
    expect(frames.find((frame) => frame.type === "thinking")).toMatchObject({
      type: "thinking",
      turnId: "live-turn-1",
    });
  });

  test("barge-in during TTS emits speech_started before turn_cancelled and aborts the turn", async () => {
    let callbacks: VoiceTurnCallbacks | undefined;
    let lateTtsChunk: ((chunk: LiveVoiceTtsAudioChunk) => void) | undefined;
    const abort = mock();
    const startVoiceTurn = mock(async (options: VoiceTurnOptions) => {
      callbacks ??= options.callbacks;
      return { turnId: "bridge-turn", abort };
    });
    const streamTtsAudio = mock(async (options: LiveVoiceTtsOptions) => {
      lateTtsChunk = options.onAudioChunk;
      options.onAudioChunk(makeTtsChunk("assistant audio"));
      return makeTtsResult("assistant audio");
    });
    const { frames, session, transcribers } = createHarness({
      finals: ["what's the weather", "actually never mind"],
      startVoiceTurn,
      streamTtsAudio,
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => frames.some((frame) => frame.type === "thinking"));

    callbacks?.assistant_text_delta?.(makeTextDelta("It is sunny today."));
    await waitFor(() => frames.some((frame) => frame.type === "tts_audio"));

    // User speaks over the assistant's audio.
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() =>
      frames.some((frame) => frame.type === "turn_cancelled"),
    );

    const types = frameTypes(frames);
    const bargeInSpeechStartedIndex = types.lastIndexOf("speech_started");
    const turnCancelledIndex = types.indexOf("turn_cancelled");
    expect(bargeInSpeechStartedIndex).toBeGreaterThan(-1);
    expect(bargeInSpeechStartedIndex).toBeLessThan(turnCancelledIndex);
    expect(frames[turnCancelledIndex]).toMatchObject({
      type: "turn_cancelled",
      turnId: "live-turn-1",
    });
    await waitFor(() => abort.mock.calls.length === 1);

    // A late TTS chunk for the cancelled turn is suppressed.
    lateTtsChunk?.(makeTtsChunk("late audio"));
    await flushAsyncCallbacks();
    expect(frameTypes(frames).lastIndexOf("tts_audio")).toBeLessThan(
      turnCancelledIndex,
    );
    expect(
      frames.some(
        (frame) => frame.type === "tts_done" && frame.turnId === "live-turn-1",
      ),
    ).toBe(false);

    // The barge-in speech was captured from onset into the next utterance.
    await waitFor(() => transcribers.length === 2);
    await waitFor(() => (transcribers[1]?.received.length ?? 0) > 0);
    await waitFor(() => startVoiceTurn.mock.calls.length === 2);
    expect(startVoiceTurn.mock.calls[1]?.[0]).toMatchObject({
      content: "actually never mind",
    });
    expect(countType(frames, "utterance_end")).toBe(2);
  });

  test("speech while the turn is still thinking emits speech_started but does not cancel", async () => {
    let callbacks: VoiceTurnCallbacks | undefined;
    const abort = mock();
    const startVoiceTurn = mock(async (options: VoiceTurnOptions) => {
      callbacks ??= options.callbacks;
      return { turnId: "bridge-turn", abort };
    });
    const streamTtsAudio = mock(async (options: LiveVoiceTtsOptions) => {
      options.onAudioChunk(makeTtsChunk("assistant audio"));
      return makeTtsResult("assistant audio");
    });
    const { frames, session } = createHarness({
      finals: ["first question", "second question"],
      startVoiceTurn,
      streamTtsAudio,
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => frames.some((frame) => frame.type === "thinking"));

    // No TTS audio has been forwarded yet — the turn is still "thinking".
    await session.handleBinaryAudio(LOUD_CHUNK);
    await flushAsyncCallbacks();

    expect(countType(frames, "speech_started")).toBe(2);
    expect(countType(frames, "turn_cancelled")).toBe(0);
    expect(abort).not.toHaveBeenCalled();

    // The unspoken reply still completes normally.
    callbacks?.assistant_text_delta?.(makeTextDelta("Here is the answer."));
    callbacks?.message_complete?.(makeMessageComplete());
    await waitFor(() =>
      frames.some(
        (frame) => frame.type === "tts_done" && frame.turnId === "live-turn-1",
      ),
    );
    expect(countType(frames, "turn_cancelled")).toBe(0);
  });

  test("runs two VAD turns back-to-back on one session", async () => {
    const { startVoiceTurn, calls } = makeAutoCompletingTurnStarter([
      "First reply.",
      "Second reply.",
    ]);
    const { frames, session } = createHarness({
      finals: ["turn one", "turn two"],
      startVoiceTurn,
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => countType(frames, "tts_done") === 1);

    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => countType(frames, "tts_done") === 2);

    expect(countType(frames, "speech_started")).toBe(2);
    expect(countType(frames, "utterance_end")).toBe(2);
    const thinkingTurnIds = frames.flatMap((frame) =>
      frame.type === "thinking" ? [frame.turnId] : [],
    );
    expect(thinkingTurnIds).toEqual(["live-turn-1", "live-turn-2"]);
    expect(calls.map((options) => options.content)).toEqual([
      "turn one",
      "turn two",
    ]);
  });

  test("ptt_release acts as a manual utterance override in server_vad mode", async () => {
    const { frames, session } = createHarness({
      finals: ["cut me off"],
      startVoiceTurn: makeAutoCompletingTurnStarter(["Done."]).startVoiceTurn,
      // A long silence threshold proves the release came from the client
      // frame, not the silence timer.
      turnDetectorConfig: { silenceThresholdMs: 5_000 },
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() =>
      frames.some((frame) => frame.type === "speech_started"),
    );

    await session.handleClientFrame({ type: "ptt_release" });
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    expect(frameTypes(frames)).toEqual([
      "ready",
      "speech_started",
      "utterance_end",
      "stt_final",
      "thinking",
      "assistant_text_delta",
      "tts_done",
    ]);
  });

  test("VAD turns report sttMs from the utterance_end boundary", async () => {
    let now = 1_000;
    const { frames, session } = createHarness({
      finals: ["measure me"],
      startVoiceTurn: makeAutoCompletingTurnStarter(["Measured."])
        .startVoiceTurn,
      emitMetrics: true,
      metricsClock: () => {
        now += 10;
        return now;
      },
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() =>
      frames.some(
        (frame) => frame.type === "metrics" && frame.event === "turn_completed",
      ),
    );

    const completedMetrics = frames.find(
      (frame) => frame.type === "metrics" && frame.event === "turn_completed",
    );
    expect(completedMetrics).toMatchObject({
      type: "metrics",
      turnId: "live-turn-1",
      sttMs: 10,
    });
  });

  test("manual mode emits none of the VAD frames", async () => {
    const { frames, session } = createHarness({
      startFrame: MANUAL_START_FRAME,
      finals: ["hello world"],
      startVoiceTurn: makeAutoCompletingTurnStarter(["Hi."]).startVoiceTurn,
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await session.handleClientFrame({ type: "ptt_release" });
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    expect(frameTypes(frames)).toEqual([
      "ready",
      "stt_final",
      "thinking",
      "assistant_text_delta",
      "tts_done",
    ]);
  });
});
