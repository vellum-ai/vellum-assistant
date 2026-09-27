import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { setConfig } from "../../__tests__/helpers/set-config.js";
import type {
  VoiceTurnCallbacks,
  VoiceTurnOptions,
} from "../../calls/voice-session-bridge.js";
import type { LiveVoiceFluxConfig } from "../../config/schemas/live-voice.js";
import type {
  StreamingTranscriber,
  SttProviderId,
  SttStreamServerEvent,
} from "../../stt/types.js";
import {
  LiveVoiceSession,
  type LiveVoiceSessionAudioArchiver,
  type LiveVoiceTtsStreamer,
} from "../live-voice-session.js";
import type { LiveVoiceSessionFactoryContext } from "../live-voice-session-manager.js";
import type {
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

function pcm(amplitude: number, sampleCount = 240): Uint8Array {
  const buffer = Buffer.alloc(sampleCount * 2);
  for (let index = 0; index < sampleCount; index += 1) {
    buffer.writeInt16LE(amplitude, index * 2);
  }
  return new Uint8Array(buffer);
}

// 10 ms of speech at 24 kHz.
const LOUD_CHUNK = pcm(8_000);
// 300 ms of speech at 24 kHz, comfortably past the default sustained-speech
// barge-in guard (250 ms) in a single chunk.
const SUSTAINED_LOUD_CHUNK = pcm(8_000, 7_200);

/**
 * Flux has no `finalizeUtterance`: the session keeps the stream open when
 * provider end-of-turn owns the boundary, otherwise it closes each cycle.
 * Events are scripted, and `stop()` only flushes explicitly supplied text.
 */
class MockFluxTranscriber implements StreamingTranscriber {
  readonly boundaryId = "daemon-streaming" as const;
  readonly received: Buffer[] = [];
  stopped = false;
  onAudio: ((chunk: Buffer) => void) | null = null;
  private onEvent: ((event: SttStreamServerEvent) => void) | null = null;

  constructor(readonly providerId: SttProviderId) {}

  async start(onEvent: (event: SttStreamServerEvent) => void): Promise<void> {
    this.onEvent = onEvent;
  }

  sendAudio(chunk: Buffer): void {
    this.received.push(Buffer.from(chunk));
    this.onAudio?.(chunk);
  }

  // Transcript Flux answers `CloseStream` with, for a turn still in flight
  // when the caller released. Null models a stop with nothing left to flush.
  pendingFlushText: string | null = null;
  holdStopEvents = false;

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    if (!this.holdStopEvents) {
      this.flushStopEvents();
    }
  }

  flushStopEvents(): void {
    if (this.pendingFlushText !== null) {
      this.onEvent?.({ type: "final", text: this.pendingFlushText });
    }
    this.onEvent?.({ type: "closed" });
  }

  emit(event: SttStreamServerEvent): void {
    this.onEvent?.(event);
  }

  // Flux's StartOfTurn frame, numbering the turn it opens.
  startOfTurn(turnIndex: number): void {
    this.emit({ type: "turn-start", turnIndex });
  }

  // Flux's EndOfTurn frame maps onto a `final` followed by a `turn-end`.
  endOfTurn(text: string, turnIndex?: number): void {
    this.emit({ type: "final", text });
    this.emit({
      type: "turn-end",
      text,
      confidence: 0.9,
      ...(turnIndex !== undefined ? { turnIndex } : {}),
    });
  }
}

function createHarness(options: {
  startFrame?: LiveVoiceClientStartFrame;
  providerId?: SttProviderId;
  fluxConfig?: Partial<LiveVoiceFluxConfig>;
  silenceThresholdMs?: number;
  continuationAnnounceSilenceMs?: number;
  startVoiceTurn?: (options: VoiceTurnOptions) => Promise<{
    turnId: string;
    abort: () => void;
  }>;
  streamTtsAudio?: LiveVoiceTtsStreamer | null;
  emitMetrics?: boolean;
  archiveAudio?: LiveVoiceSessionAudioArchiver;
  bargeInMinSpeechMs?: number;
  // Holds the STT dial open so a test can drive a whole utterance through the
  // window between `ready` and the resolved provider.
  resolveGate?: Promise<unknown>;
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

  const transcribers: MockFluxTranscriber[] = [];
  const resolveTranscriber = mock(async () => {
    if (options.resolveGate) {
      await options.resolveGate;
    }
    const transcriber = new MockFluxTranscriber(
      options.providerId ?? "deepgram-flux",
    );
    transcribers.push(transcriber);
    return transcriber;
  });

  const turnCalls: VoiceTurnOptions[] = [];
  const startVoiceTurn = mock(async (turnOptions: VoiceTurnOptions) => {
    turnCalls.push(turnOptions);
    if (options.startVoiceTurn) {
      return await options.startVoiceTurn(turnOptions);
    }
    return { turnId: `bridge-turn-${turnCalls.length}`, abort: mock() };
  });

  const session = new LiveVoiceSession(context, {
    resolveTranscriber,
    startVoiceTurn,
    streamTtsAudio: options.streamTtsAudio ?? null,
    emitMetrics: options.emitMetrics ?? false,
    archiveAudio: options.archiveAudio,
    bargeInMinSpeechMs: options.bargeInMinSpeechMs,
    continuationAnnounceSilenceMs: options.continuationAnnounceSilenceMs,
    spawnBackgroundContinuation: mock(async () => ""),
    turnDetectorConfig: {
      silenceThresholdMs: options.silenceThresholdMs ?? 40,
    },
    ...(options.fluxConfig ? { fluxConfig: options.fluxConfig } : {}),
  });

  return { frames, session, transcribers, turnCalls };
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

// Answers immediately: one text delta (which commits a speculative leg), then
// message_complete.
function autoCompletingTurn(
  reply = "Okay.",
): (
  options: VoiceTurnOptions,
) => Promise<{ turnId: string; abort: () => void }> {
  let count = 0;
  return async (options) => {
    count += 1;
    options.callbacks?.assistant_text_delta?.(makeTextDelta(reply));
    options.callbacks?.message_complete?.(makeMessageComplete());
    return { turnId: `bridge-turn-${count}`, abort: mock() };
  };
}

async function waitFor(
  predicate: () => boolean,
  message = "Timed out waiting for a live voice Flux test condition",
): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

async function flushAsyncCallbacks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// Holds the STT dial open until the test opens it, so the whole
// ready-before-resolve window is under the test's control.
function createDialGate(): { promise: Promise<void>; open: () => void } {
  let open = (): void => {};
  const promise = new Promise<void>((resolve) => {
    open = () => resolve();
  });
  return { promise, open };
}

function countFrames(
  frames: LiveVoiceServerFrame[],
  type: LiveVoiceServerFrame["type"],
): number {
  return frames.filter((frame) => frame.type === type).length;
}

// Waits for the completed turn's metrics frame and hands it back narrowed, so
// the assertions below read the endpoint fields without a type guard.
async function waitForTurnMetrics(
  frames: LiveVoiceServerFrame[],
): Promise<Extract<LiveVoiceServerFrame, { type: "metrics" }>> {
  const isTurnMetrics = (
    frame: LiveVoiceServerFrame,
  ): frame is Extract<LiveVoiceServerFrame, { type: "metrics" }> =>
    frame.type === "metrics" && frame.event === "turn_completed";
  await waitFor(
    () => frames.some(isTurnMetrics),
    "The completed turn never reported its metrics",
  );
  const metricsFrame = frames.find(isTurnMetrics);
  if (!metricsFrame) {
    throw new Error("The completed turn never reported its metrics");
  }
  return metricsFrame;
}

// Long enough for the 40 ms local silence timer to fire and hand the boundary
// to Flux (which arms the fail-open deadline and commits nothing).
const PAST_SILENCE_BOUNDARY_MS = 150;

const FLUX_ON = {
  turnEnd: { enabled: true },
  eotTimeoutMs: 500,
} as const satisfies Partial<LiveVoiceFluxConfig>;

// Turn-end is on by schema default, so a session that must run the local
// silence boundary has to say so. Naming it keeps those tests about the
// boundary they exercise rather than about a default they no longer own.
const FLUX_OFF = {
  turnEnd: { enabled: false },
} as const satisfies Partial<LiveVoiceFluxConfig>;

describe("LiveVoiceSession Flux end-of-turn", () => {
  test("holds a task outcome through a Flux pause and reply, then announces over idle input", async () => {
    const completeTurn = autoCompletingTurn(
      "The investigation found the cause.",
    );
    const { session, transcribers, turnCalls, frames } = createHarness({
      fluxConfig: { ...FLUX_ON, eotTimeoutMs: 2_000 },
      silenceThresholdMs: 30,
      continuationAnnounceSilenceMs: 10,
      startVoiceTurn: async (options) => {
        if (options.subagentNotification) {
          return completeTurn(options);
        }
        return { turnId: "question-turn", abort: mock() };
      },
      streamTtsAudio: async (options) => {
        const audio = pcm(100);
        options.onAudioChunk({
          type: "tts_audio",
          contentType: "audio/pcm",
          sampleRate: SAMPLE_RATE,
          dataBase64: Buffer.from(audio).toString("base64"),
        });
        return {
          provider: "fish-audio",
          contentType: "audio/pcm",
          sampleRate: SAMPLE_RATE,
          chunks: 1,
          bytes: audio.byteLength,
        };
      },
    });
    const feedQuietAudio = async () => {
      for (let index = 0; index < 12; index += 1) {
        await session.handleBinaryAudio(pcm(100));
        await sleep(10);
      }
    };
    try {
      await session.start();
      await waitFor(() => transcribers.length === 1);
      const transcriber = transcribers[0]!;
      await session.handleBinaryAudio(LOUD_CHUNK);
      transcriber.startOfTurn(0);
      transcriber.emit({ type: "partial", text: "Could you explain" });
      session.receiveSubagentNotification({
        taskId: "task-1",
        message: "The investigation found the cause.",
        metadata: {
          subagentNotification: {
            subagentId: "task-1",
            label: "Investigation",
            status: "completed",
          },
        },
      });

      const submittedBeforePause = transcriber.received.length;
      await feedQuietAudio();
      expect(transcriber.received.length - submittedBeforePause).toBe(12);
      expect(turnCalls).toHaveLength(0);

      await session.handleBinaryAudio(LOUD_CHUNK);
      transcriber.endOfTurn("Could you explain how this works?", 0);
      await waitFor(() => turnCalls.length === 1);
      expect(turnCalls[0]?.content).toBe("Could you explain how this works?");
      await feedQuietAudio();
      expect(turnCalls).toHaveLength(1);

      turnCalls[0]?.callbacks?.assistant_text_delta?.(
        makeTextDelta("Here is how it works."),
      );
      turnCalls[0]?.callbacks?.message_complete?.(makeMessageComplete());
      await feedQuietAudio();
      await waitFor(() => countFrames(frames, "tts_done") === 2);
      expect(turnCalls).toHaveLength(2);
      expect(turnCalls[1]?.hiddenSyntheticPrompt).toBe(true);
      expect(turnCalls[1]?.subagentNotification?.taskId).toBe("task-1");
      expect(transcribers).toHaveLength(1);
    } finally {
      await session.close("client_end");
    }
  });

  test("keeps continuous idle audio out of the request recording", async () => {
    const recordings: Buffer[] = [];
    const { session, transcribers } = createHarness({
      fluxConfig: FLUX_ON,
      startVoiceTurn: autoCompletingTurn(),
      archiveAudio: async (input) => {
        recordings.push(Buffer.from(input.audio.dataBase64, "base64"));
        return {
          type: "warning",
          warning: {
            code: "message_id_unavailable",
            message: "No persisted message in this test.",
          },
        };
      },
    });
    try {
      await session.start();
      await waitFor(() => transcribers.length === 1);
      for (let index = 0; index < 50; index++) {
        await session.handleBinaryAudio(pcm(100));
      }
      await session.handleBinaryAudio(LOUD_CHUNK);
      transcribers[0]!.endOfTurn("a complete question", 0);
      await waitFor(() => recordings.length === 1);
      expect(recordings).toEqual([Buffer.from(LOUD_CHUNK)]);
    } finally {
      await session.close("client_end");
    }
  });

  test("replaces confirmed playback echo with equal-duration silence for Flux", async () => {
    const echo = Buffer.alloc(SAMPLE_RATE * 2 * 2);
    for (let index = 0; index < echo.byteLength / 2; index++) {
      echo.writeInt16LE(
        Math.round(4_700 * Math.sin((2 * Math.PI * 200 * index) / SAMPLE_RATE)),
        index * 2,
      );
    }
    const { session, frames, transcribers } = createHarness({
      fluxConfig: FLUX_ON,
      startVoiceTurn: async (options) => {
        options.callbacks?.assistant_text_delta?.(
          makeTextDelta("Here is an answer."),
        );
        return { turnId: "bridge-turn", abort: mock() };
      },
      streamTtsAudio: async (options) => {
        options.onAudioChunk({
          type: "tts_audio",
          contentType: "audio/pcm",
          sampleRate: SAMPLE_RATE,
          dataBase64: echo.toString("base64"),
        });
        return {
          provider: "fish-audio",
          contentType: "audio/pcm",
          sampleRate: SAMPLE_RATE,
          chunks: 1,
          bytes: echo.byteLength,
        };
      },
    });
    try {
      await session.start();
      await session.handleBinaryAudio(LOUD_CHUNK);
      await waitFor(() => transcribers.length === 1);
      const transcriber = transcribers[0]!;
      transcriber.endOfTurn("a complete question", 0);
      await waitFor(() => countFrames(frames, "tts_audio") === 1);
      const before = transcriber.received.length;
      const echoChunk = echo.subarray(0, 480);
      for (let index = 0; index < 40; index++) {
        await session.handleBinaryAudio(echoChunk);
      }
      const submitted = Buffer.concat(transcriber.received.slice(before));
      expect(submitted.byteLength).toBe(echoChunk.byteLength * 40);
      expect(submitted.every((byte) => byte === 0)).toBe(true);
      expect(countFrames(frames, "turn_cancelled")).toBe(0);
    } finally {
      await session.close("client_end");
    }
  });

  test("keeps idle quiet audio flowing without starting a user request", async () => {
    const { frames, session, transcribers, turnCalls } = createHarness({
      fluxConfig: FLUX_ON,
    });
    try {
      await session.start();
      await waitFor(() => transcribers.length === 1);
      const quiet = pcm(100);
      for (let index = 0; index < 30; index++) {
        await session.handleBinaryAudio(quiet);
      }
      expect(transcribers[0]?.received).toEqual(
        Array.from({ length: 30 }, () => Buffer.from(quiet)),
      );
      expect(turnCalls).toHaveLength(0);
      expect(countFrames(frames, "speech_started")).toBe(0);
      expect(countFrames(frames, "utterance_end")).toBe(0);
    } finally {
      await session.close("client_end");
    }
  });

  test("gates idle room audio after one second while keeping Flux supplied with silence", async () => {
    const { frames, session, transcribers, turnCalls } = createHarness({
      fluxConfig: FLUX_ON,
    });
    try {
      await session.start();
      await waitFor(() => transcribers.length === 1);
      for (let index = 0; index < 200; index += 1) {
        await session.handleBinaryAudio(pcm(100));
      }
      const submitted = Buffer.concat(transcribers[0]!.received);
      expect(submitted).toEqual(
        Buffer.concat([
          Buffer.from(pcm(100, SAMPLE_RATE)),
          Buffer.alloc((SAMPLE_RATE * 2 * 800) / 1_000),
        ]),
      );
      expect(transcribers[0]!.stopped).toBe(false);
      expect(turnCalls).toHaveLength(0);
      expect(countFrames(frames, "speech_started")).toBe(0);
      expect(countFrames(frames, "utterance_end")).toBe(0);
    } finally {
      await session.close("client_end");
    }
  });

  test("a long pause gates noise without releasing the question or clipping resumed speech", async () => {
    const { frames, session, transcribers, turnCalls } = createHarness({
      fluxConfig: { ...FLUX_ON, eotTimeoutMs: 5_000 },
      startVoiceTurn: autoCompletingTurn(),
    });
    try {
      await session.start();
      await waitFor(() => transcribers.length === 1);
      const transcriber = transcribers[0]!;
      await session.handleBinaryAudio(LOUD_CHUNK);
      transcriber.startOfTurn(0);
      transcriber.emit({ type: "partial", text: "Could you explain" });
      for (let index = 0; index < 200; index += 1) {
        await session.handleBinaryAudio(pcm(100));
      }
      await sleep(PAST_SILENCE_BOUNDARY_MS);
      expect(turnCalls).toHaveLength(0);
      expect(countFrames(frames, "utterance_end")).toBe(0);

      const onset = pcm(300, SAMPLE_RATE / 5);
      await session.handleBinaryAudio(onset);
      await session.handleBinaryAudio(LOUD_CHUNK);
      expect(transcriber.received.at(-1)).toEqual(
        Buffer.concat([Buffer.from(onset), Buffer.from(LOUD_CHUNK)]),
      );
      const submitted = Buffer.concat(transcriber.received);
      expect(submitted.byteLength).toBe(
        LOUD_CHUNK.byteLength * 2 + SAMPLE_RATE * 2 * 2 + onset.byteLength,
      );
      transcriber.endOfTurn("Could you explain how penguins stay warm?", 0);
      await waitFor(() => turnCalls.length === 1);
      expect(turnCalls[0]?.content).toBe(
        "Could you explain how penguins stay warm?",
      );
      expect(transcribers).toHaveLength(1);
    } finally {
      await session.close("client_end");
    }
  });

  test("a replacement Flux stream does not receive the closed stream's buffered room audio", async () => {
    const { session, transcribers } = createHarness({ fluxConfig: FLUX_ON });
    try {
      await session.start();
      await waitFor(() => transcribers.length === 1);
      for (let index = 0; index < 200; index += 1) {
        await session.handleBinaryAudio(pcm(100));
      }
      transcribers[0]!.emit({ type: "closed" });
      await flushAsyncCallbacks();
      await session.handleBinaryAudio(LOUD_CHUNK);
      await waitFor(() => transcribers.length === 2);
      await waitFor(() => transcribers[1]!.received.length > 0);
      expect(Buffer.concat(transcribers[1]!.received)).toEqual(
        Buffer.from(LOUD_CHUNK),
      );
    } finally {
      await session.close("client_end");
    }
  });

  test("a provider can finish from trailing audio after the local silence boundary", async () => {
    const { session, transcribers, turnCalls } = createHarness({
      fluxConfig: FLUX_ON,
      startVoiceTurn: autoCompletingTurn(),
    });
    try {
      await session.start();
      await session.handleBinaryAudio(LOUD_CHUNK);
      await waitFor(() => transcribers.length === 1);
      const transcriber = transcribers[0]!;
      transcriber.emit({ type: "partial", text: "a complete question" });
      await sleep(PAST_SILENCE_BOUNDARY_MS);
      let quietChunks = 0;
      transcriber.onAudio = (chunk) => {
        if (chunk.every((byte) => byte === 0)) {
          quietChunks += 1;
          if (quietChunks === 20) {
            transcriber.endOfTurn("a complete question", 0);
          }
        }
      };
      for (let index = 0; index < 20; index++) {
        await session.handleBinaryAudio(pcm(0));
      }
      await waitFor(() => turnCalls.length === 1);
      expect(turnCalls[0]?.content).toBe("a complete question");
      expect(transcriber.stopped).toBe(false);
      expect(transcribers).toHaveLength(1);
    } finally {
      await session.close("client_end");
    }
  });

  test("preserves quiet continuation audio across a pause until Flux commits", async () => {
    const { frames, session, transcribers, turnCalls } = createHarness({
      fluxConfig: FLUX_ON,
      startVoiceTurn: autoCompletingTurn(),
    });
    try {
      await session.start();
      await session.handleBinaryAudio(LOUD_CHUNK);
      await waitFor(() => transcribers.length === 1);
      const transcriber = transcribers[0]!;
      transcriber.emit({ type: "partial", text: "did they help invent" });
      await sleep(PAST_SILENCE_BOUNDARY_MS);
      const continuation = [pcm(0), pcm(120, 7_200), pcm(0)];
      const before = transcriber.received.length;
      for (const chunk of continuation) {
        await session.handleBinaryAudio(chunk);
      }
      expect(transcriber.received.slice(before)).toEqual(
        continuation.map((chunk) => Buffer.from(chunk)),
      );
      expect(turnCalls).toHaveLength(0);
      expect(countFrames(frames, "utterance_end")).toBe(0);
      transcriber.endOfTurn("did they help invent ChatGPT", 0);
      await waitFor(() => turnCalls.length === 1);
      expect(turnCalls[0]?.content).toBe("did they help invent ChatGPT");
    } finally {
      await session.close("client_end");
    }
  });

  test("gates room noise during an active answer while preserving real barge-in", async () => {
    const { frames, session, transcribers, turnCalls } = createHarness({
      fluxConfig: FLUX_ON,
    });
    try {
      await session.start();
      await session.handleBinaryAudio(LOUD_CHUNK);
      await waitFor(() => transcribers.length === 1);
      const transcriber = transcribers[0]!;
      transcriber.endOfTurn("a complete question", 0);
      await waitFor(() => turnCalls.length === 1);
      const before = transcriber.received.length;
      for (let index = 0; index < 200; index++) {
        await session.handleBinaryAudio(pcm(100));
      }
      expect(Buffer.concat(transcriber.received.slice(before))).toEqual(
        Buffer.concat([
          Buffer.from(pcm(100, SAMPLE_RATE)),
          Buffer.alloc((SAMPLE_RATE * 2 * 800) / 1_000),
        ]),
      );
      expect(transcribers).toHaveLength(1);
      expect(countFrames(frames, "turn_cancelled")).toBe(0);
      expect(turnCalls).toHaveLength(1);
      await sleep(PAST_SILENCE_BOUNDARY_MS);
      await session.handleBinaryAudio(SUSTAINED_LOUD_CHUNK);
      expect(countFrames(frames, "turn_cancelled")).toBe(0);
      transcriber.startOfTurn(1);
      await waitFor(() => countFrames(frames, "turn_cancelled") === 1);
      expect(transcriber.received.at(-1)).toEqual(
        Buffer.concat([
          Buffer.from(pcm(100, SAMPLE_RATE / 5)),
          Buffer.from(SUSTAINED_LOUD_CHUNK),
        ]),
      );
    } finally {
      await session.close("client_end");
    }
  });

  test.each([
    { providerId: "deepgram-flux" as const, fluxConfig: FLUX_OFF },
    { providerId: "deepgram" as const, fluxConfig: FLUX_ON },
  ])("locally endpointed streams retain idle pre-roll: %j", async (options) => {
    const { session, transcribers } = createHarness(options);
    try {
      await session.start();
      await waitFor(() => transcribers.length === 1);
      await session.handleBinaryAudio(pcm(0));
      expect(transcribers[0]?.received).toHaveLength(0);
      await session.handleBinaryAudio(LOUD_CHUNK);
      expect(transcribers[0]?.received).toEqual([
        Buffer.from(pcm(0)),
        Buffer.from(LOUD_CHUNK),
      ]);
    } finally {
      await session.close("client_end");
    }
  });

  test("commits the turn on turn-end without an endpoint-decision leg", async () => {
    const { frames, session, transcribers, turnCalls } = createHarness({
      fluxConfig: FLUX_ON,
      // Long enough that the local silence boundary cannot be what commits.
      silenceThresholdMs: 10_000,
      startVoiceTurn: autoCompletingTurn(),
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => transcribers.length > 0);
    transcribers[0]?.endOfTurn("what is the weather");

    await waitFor(() => turnCalls.length === 1);
    expect(turnCalls[0]?.content).toBe("what is the weather");
    // Non-speculative dispatch: the front-door leg's decision rule is built
    // with includeHold false, so the hold token is never taught.
    expect(turnCalls[0]?.unifiedVerdict).toBeUndefined();
    expect(turnCalls[0]?.routingLeg).toBe("front-door");
    expect(frames.some((frame) => frame.type === "utterance_end")).toBe(true);

    await session.close("client_end");
  });

  test("still escalates on the [1] verdict after a flux commit", async () => {
    const { session, transcribers, turnCalls } = createHarness({
      fluxConfig: FLUX_ON,
      silenceThresholdMs: 10_000,
      startVoiceTurn: async (turnOptions) => {
        if (turnOptions.routingLeg === "front-door") {
          turnOptions.callbacks?.assistant_text_delta?.(
            makeTextDelta("[1] Let me check that for you."),
          );
        }
        return { turnId: "bridge-turn", abort: mock() };
      },
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => transcribers.length > 0);
    transcribers[0]?.endOfTurn("what is on my calendar");

    await waitFor(
      () => turnCalls.some((call) => call.routingLeg === "escalated"),
      "The escalate verdict never handed off to the escalated leg",
    );

    await session.close("client_end");
  });

  test("ignores turn-end when the flag is off and keeps the hold path", async () => {
    const { frames, session, transcribers, turnCalls } = createHarness({
      fluxConfig: FLUX_OFF,
      startVoiceTurn: autoCompletingTurn(),
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => transcribers.length > 0);
    transcribers[0]?.emit({ type: "partial", text: "hello there" });
    transcribers[0]?.endOfTurn("hello there");
    await flushAsyncCallbacks();

    // The turn-end event committed nothing: the silence boundary still owns
    // the commit, and it dispatches speculatively (the hold path).
    await waitFor(() => turnCalls.length === 1);
    expect(turnCalls[0]?.unifiedVerdict).toBe(true);
    expect(frames.some((frame) => frame.type === "utterance_end")).toBe(true);

    await session.close("client_end");
  });

  test("ignores turn-end from a provider that is not deepgram-flux", async () => {
    const { session, transcribers, turnCalls } = createHarness({
      providerId: "deepgram",
      fluxConfig: FLUX_ON,
      silenceThresholdMs: 10_000,
      startVoiceTurn: autoCompletingTurn(),
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => transcribers.length > 0);
    transcribers[0]?.endOfTurn("hello there");
    await flushAsyncCallbacks();

    expect(turnCalls).toHaveLength(0);

    await session.close("client_end");
  });

  test("reports the endpoint decision as flux", async () => {
    const { frames, session, transcribers, turnCalls } = createHarness({
      fluxConfig: FLUX_ON,
      silenceThresholdMs: 10_000,
      emitMetrics: true,
      startVoiceTurn: autoCompletingTurn(),
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => transcribers.length > 0);
    transcribers[0]?.endOfTurn("hello there");
    await waitFor(() => turnCalls.length === 1);

    const metricsFrame = await waitForTurnMetrics(frames);
    expect(metricsFrame.endpointDecisionSource).toBe("provider");
    expect(metricsFrame.endpointHoldCount).toBe(0);

    await session.close("client_end");
  });

  test("anchors the flux commit latency at the local speech-stop mark", async () => {
    const { frames, session, transcribers, turnCalls } = createHarness({
      fluxConfig: { turnEnd: { enabled: true }, eotTimeoutMs: 30_000 },
      // Long enough that the local silence boundary cannot be what commits,
      // and that the fail-open deadline stays far away.
      silenceThresholdMs: 10_000,
      emitMetrics: true,
      startVoiceTurn: autoCompletingTurn(),
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => transcribers.length > 0);
    // Silence between the caller's last above-gate chunk and the commit. A
    // dispatch-anchored number would not see it; the speech-stop anchor must.
    await sleep(250);
    transcribers[0]?.endOfTurn("hello there");
    await waitFor(() => turnCalls.length === 1);

    const metricsFrame = await waitForTurnMetrics(frames);
    // Date.now() vs setTimeout can undershoot the sleep by a millisecond on
    // a loaded runner. The assertion is that the speech-stop anchor saw the
    // pause, not that the timer is exact.
    expect(metricsFrame.endpointCommitLatencyMs).toBeGreaterThanOrEqual(240);

    await session.close("client_end");
  });

  test("records the commit latency on the front-door path too, with no hold", async () => {
    const { frames, session, transcribers, turnCalls } = createHarness({
      // Turn-end off: the latch is down and the local silence boundary owns
      // the commit, which is arm A of the measurement run.
      fluxConfig: FLUX_OFF,
      silenceThresholdMs: 40,
      emitMetrics: true,
      startVoiceTurn: autoCompletingTurn(),
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => transcribers.length > 0);
    transcribers[0]?.emit({ type: "partial", text: "hello there" });
    await waitFor(() => turnCalls.length === 1);

    // The turn committed straight through, so it records no endpoint decision
    // at all. The commit latency is recorded regardless, which is what makes
    // the two arms one population rather than two.
    const metricsFrame = await waitForTurnMetrics(frames);
    expect(metricsFrame.endpointDecisionSource).toBeUndefined();
    // The silence timer is 40 ms. CI clock jitter can report 39. The
    // assertion is that the front-door path recorded a silence-scale
    // latency, not that setTimeout fired on the exact millisecond.
    expect(metricsFrame.endpointCommitLatencyMs).toBeGreaterThanOrEqual(30);

    await session.close("client_end");
  });

  test("records no commit latency for a turn that never committed", async () => {
    const { frames, session, transcribers } = createHarness({
      fluxConfig: { turnEnd: { enabled: true }, eotTimeoutMs: 30_000 },
      silenceThresholdMs: 10_000,
      emitMetrics: true,
      startVoiceTurn: autoCompletingTurn(),
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => transcribers.length > 0);
    transcribers[0]?.emit({ type: "partial", text: "hello the" });
    // Nothing ends this turn: no flux turn-end, no silence boundary, and the
    // fail-open deadline is 30 s away.
    await flushAsyncCallbacks();
    await session.close("client_end");

    const metricsFrames = frames.filter((frame) => frame.type === "metrics");
    expect(metricsFrames.length).toBeGreaterThan(0);
    for (const frame of metricsFrames) {
      expect(frame).not.toHaveProperty("endpointCommitLatencyMs");
    }
  });

  test("falls back to the silence-boundary path when no turn-end arrives", async () => {
    const { session, transcribers, turnCalls } = createHarness({
      fluxConfig: FLUX_ON,
      startVoiceTurn: autoCompletingTurn(),
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => transcribers.length > 0);
    // Flux is transcribing but its EndOfTurn never arrives.
    transcribers[0]?.emit({ type: "partial", text: "are you still there" });

    // The local silence boundary (40 ms) passes without committing anything:
    // the fallback deadline (eotTimeoutMs plus the margin) owns this
    // utterance.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(turnCalls).toHaveLength(0);

    await waitFor(
      () => turnCalls.length === 1,
      "Flux fallback never replayed the silence boundary",
    );
    // Back on the existing path: a speculative dispatch that knows the hold
    // token, judging the partial the silence boundary saw.
    expect(turnCalls[0]?.content).toBe("are you still there");
    expect(turnCalls[0]?.unifiedVerdict).toBe(true);

    await session.close("client_end");
  }, 10_000);

  test("commits a turn-end that arrives after the local silence boundary", async () => {
    const { frames, session, transcribers, turnCalls } = createHarness({
      fluxConfig: FLUX_ON,
      silenceThresholdMs: 40,
      startVoiceTurn: autoCompletingTurn(),
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => transcribers.length > 0);

    // The boundary passes and commits nothing: Flux owns it.
    await sleep(PAST_SILENCE_BOUNDARY_MS);
    expect(turnCalls).toHaveLength(0);

    // No resumed speech, so this turn-end is the one the boundary was waiting
    // for and it commits exactly as before.
    transcribers[0]?.endOfTurn("what is the weather");
    await waitFor(
      () => turnCalls.length === 1,
      "A non-stale turn-end after the silence boundary never committed",
    );
    expect(turnCalls[0]?.content).toBe("what is the weather");
    expect(turnCalls[0]?.unifiedVerdict).toBeUndefined();
    expect(frames.some((frame) => frame.type === "utterance_end")).toBe(true);

    await session.close("client_end");
  });

  test("drops a turn-end that arrives after the caller resumed speaking", async () => {
    const { frames, session, transcribers, turnCalls } = createHarness({
      fluxConfig: FLUX_ON,
      silenceThresholdMs: 40,
      startVoiceTurn: autoCompletingTurn(),
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => transcribers.length > 0);
    const transcriber = transcribers[0];
    transcriber?.emit({ type: "partial", text: "what is the" });
    await sleep(PAST_SILENCE_BOUNDARY_MS);

    // The caller draws breath and keeps going before the provider's turn-end
    // for the speech that boundary closed reaches the session.
    await session.handleBinaryAudio(LOUD_CHUNK);
    expect(countFrames(frames, "speech_started")).toBe(0);
    const receivedBeforeResume = transcriber?.received.length ?? 0;

    transcriber?.emit({
      type: "turn-end",
      text: "what is the",
      confidence: 0.9,
    });
    await flushAsyncCallbacks();

    // Dropped: no boundary frame, the transcriber keeps running, no turn.
    expect(frames.some((frame) => frame.type === "utterance_end")).toBe(false);
    expect(transcriber?.stopped).toBe(false);
    expect(turnCalls).toHaveLength(0);

    // ...and the resumed speech still routes into the same open utterance.
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(
      () => (transcriber?.received.length ?? 0) > receivedBeforeResume,
      "The resumed speech stopped reaching the transcriber",
    );

    await session.close("client_end");
  });

  test("commits a fast turn-end for the still-open turn after a mid-thought pause", async () => {
    const { frames, session, transcribers, turnCalls } = createHarness({
      fluxConfig: FLUX_ON,
      silenceThresholdMs: 40,
      emitMetrics: true,
      startVoiceTurn: autoCompletingTurn(),
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => transcribers.length > 0);
    const transcriber = transcribers[0];
    transcriber?.startOfTurn(0);
    transcriber?.emit({ type: "partial", text: "what is the" });

    // A mid-thought pause, long enough for the local silence boundary to hand
    // the cycle to Flux, and then the caller keeps going.
    await sleep(PAST_SILENCE_BOUNDARY_MS);
    await session.handleBinaryAudio(LOUD_CHUNK);
    expect(countFrames(frames, "speech_started")).toBe(1);

    // Flux ends the turn it kept open across the pause, beating the next local
    // silence boundary: the fast commit this feature exists for. Nothing here
    // sleeps past that boundary, on purpose.
    const emittedAtMs = Date.now();
    transcriber?.endOfTurn("what is the weather today", 0);
    await waitFor(
      () => turnCalls.length === 1,
      "The fast turn-end after a mid-thought pause never committed",
    );
    const commitLatencyMs = Date.now() - emittedAtMs;

    // The fail-open budget is eotTimeoutMs (500 ms) plus the margin (1000 ms).
    // A commit anywhere near it means the turn-end was dropped and the
    // deadline committed in its place.
    expect(commitLatencyMs).toBeLessThan(300);
    expect(turnCalls[0]?.content).toBe("what is the weather today");
    // The Flux path, not the speculative hold path the deadline falls back to.
    expect(turnCalls[0]?.unifiedVerdict).toBeUndefined();
    expect(frames.some((frame) => frame.type === "utterance_end")).toBe(true);

    const metricsFrame = await waitForTurnMetrics(frames);
    expect(metricsFrame.endpointDecisionSource).toBe("provider");

    await session.close("client_end");
  });

  test("drops a turn-end for a turn flux has already superseded", async () => {
    const { frames, session, transcribers, turnCalls } = createHarness({
      fluxConfig: FLUX_ON,
      silenceThresholdMs: 40,
      startVoiceTurn: autoCompletingTurn(),
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => transcribers.length > 0);
    const transcriber = transcribers[0];
    transcriber?.startOfTurn(0);
    transcriber?.emit({ type: "partial", text: "what is the" });
    await sleep(PAST_SILENCE_BOUNDARY_MS);

    await session.handleBinaryAudio(LOUD_CHUNK);
    expect(countFrames(frames, "speech_started")).toBe(1);
    const receivedBeforeResume = transcriber?.received.length ?? 0;

    // Flux closed turn 0 and opened turn 1 for the resumed speech, so the
    // end-of-turn for turn 0 trailing behind describes speech the caller has
    // moved past.
    transcriber?.startOfTurn(1);
    transcriber?.emit({
      type: "turn-end",
      text: "what is the",
      confidence: 0.9,
      turnIndex: 0,
    });
    await flushAsyncCallbacks();

    expect(frames.some((frame) => frame.type === "utterance_end")).toBe(false);
    expect(transcriber?.stopped).toBe(false);
    expect(turnCalls).toHaveLength(0);
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(
      () => (transcriber?.received.length ?? 0) > receivedBeforeResume,
      "The resumed speech stopped reaching the transcriber",
    );

    // Turn 1's own end-of-turn is the one that commits.
    transcriber?.endOfTurn("what is the weather today", 1);
    await waitFor(
      () => turnCalls.length === 1,
      "The superseding turn never committed",
    );
    expect(turnCalls[0]?.content).toBe("what is the weather today");
    expect(turnCalls[0]?.unifiedVerdict).toBeUndefined();

    await session.close("client_end");
  });

  test("commits the resumed turn on the next turn-end after dropping a stale one", async () => {
    const { frames, session, transcribers, turnCalls } = createHarness({
      fluxConfig: FLUX_ON,
      silenceThresholdMs: 40,
      startVoiceTurn: autoCompletingTurn(),
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => transcribers.length > 0);
    await sleep(PAST_SILENCE_BOUNDARY_MS);

    await session.handleBinaryAudio(LOUD_CHUNK);
    expect(countFrames(frames, "speech_started")).toBe(0);
    transcribers[0]?.emit({
      type: "turn-end",
      text: "what is the",
      confidence: 0.9,
    });
    await flushAsyncCallbacks();
    expect(turnCalls).toHaveLength(0);

    // The caller finishes for real: the next silence boundary re-stamps the
    // cycle, so Flux's turn-end for the resumed speech commits it.
    await sleep(PAST_SILENCE_BOUNDARY_MS);
    transcribers[0]?.endOfTurn("what is the weather today");

    await waitFor(
      () => turnCalls.length === 1,
      "The resumed turn never committed after the stale turn-end was dropped",
    );
    expect(turnCalls[0]?.content).toBe("what is the weather today");
    expect(turnCalls[0]?.unifiedVerdict).toBeUndefined();
    expect(frames.some((frame) => frame.type === "utterance_end")).toBe(true);

    await session.close("client_end");
  });

  test("falls back to the deadline when nothing follows the dropped turn-end", async () => {
    const { session, transcribers, turnCalls } = createHarness({
      fluxConfig: FLUX_ON,
      silenceThresholdMs: 40,
      startVoiceTurn: autoCompletingTurn(),
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => transcribers.length > 0);
    transcribers[0]?.emit({ type: "partial", text: "are you still there" });
    await sleep(PAST_SILENCE_BOUNDARY_MS);

    await session.handleBinaryAudio(LOUD_CHUNK);
    transcribers[0]?.emit({
      type: "turn-end",
      text: "are you still there",
      confidence: 0.9,
    });
    await flushAsyncCallbacks();
    expect(turnCalls).toHaveLength(0);

    // Flux says nothing more. The next silence boundary re-arms the fail-open
    // deadline, so the utterance still commits on the silence path instead of
    // hanging open forever.
    await waitFor(
      () => turnCalls.length === 1,
      "The utterance hung after the stale turn-end was dropped",
    );
    expect(turnCalls[0]?.content).toBe("are you still there");
    expect(turnCalls[0]?.unifiedVerdict).toBe(true);

    await session.close("client_end");
  }, 10_000);

  test.each([
    { providerId: "deepgram-flux" as const, flagOn: true },
    { providerId: "deepgram-flux" as const, flagOn: false },
    { providerId: "vellum-flux" as const, flagOn: true },
    { providerId: "vellum-flux" as const, flagOn: false },
  ])(
    "only provider speech starts interrupt playback: %j",
    async ({ providerId, flagOn }) => {
      const streamTtsAudio = mock(async (ttsOptions: LiveVoiceTtsOptions) => {
        ttsOptions.onAudioChunk({
          type: "tts_audio",
          contentType: "audio/pcm",
          sampleRate: SAMPLE_RATE,
          dataBase64: Buffer.from("assistant audio").toString("base64"),
        });
        return {
          provider: "fish-audio",
          contentType: "audio/pcm",
          sampleRate: SAMPLE_RATE,
          chunks: 1,
          bytes: 15,
        } satisfies LiveVoiceTtsResult;
      });
      const { frames, session, transcribers } = createHarness({
        providerId,
        fluxConfig: flagOn ? FLUX_ON : FLUX_OFF,
        silenceThresholdMs: 10_000,
        streamTtsAudio,
        // The leg never completes, so the turn is still in flight when the
        // caller speaks over it.
        startVoiceTurn: async (turnOptions) => {
          turnOptions.callbacks?.assistant_text_delta?.(
            makeTextDelta("Let me tell you a long story."),
          );
          return { turnId: "bridge-turn-1", abort: mock() };
        },
      });

      await session.start();
      await session.handleBinaryAudio(LOUD_CHUNK);
      await waitFor(() => transcribers.length > 0);
      transcribers[0]?.startOfTurn(0);
      if (flagOn) {
        transcribers[0]?.endOfTurn("tell me a story");
      } else {
        transcribers[0]?.emit({ type: "final", text: "tell me a story" });
        await session.handleClientFrame({ type: "ptt_release" });
      }
      await waitFor(() => frames.some((frame) => frame.type === "tts_audio"));

      const speechStarts = countFrames(frames, "speech_started");
      await session.handleBinaryAudio(SUSTAINED_LOUD_CHUNK);
      await flushAsyncCallbacks();
      expect(countFrames(frames, "speech_started")).toBe(speechStarts);
      expect(countFrames(frames, "turn_cancelled")).toBe(0);

      // Per-cycle streams restart the provider's turn numbering.
      transcribers.at(-1)?.startOfTurn(flagOn ? 1 : 0);
      await waitFor(
        () => countFrames(frames, "speech_started") === speechStarts + 1,
        "Provider speech start did not interrupt playback",
      );
      await waitFor(() =>
        frames.some((frame) => frame.type === "turn_cancelled"),
      );
      const types = frames.map((frame) => frame.type);
      expect(types.lastIndexOf("speech_started")).toBeLessThan(
        types.indexOf("turn_cancelled"),
      );

      await session.close("client_end");
    },
  );

  test("provider speech starts are immediate and ignore duplicate or older turn indices", async () => {
    const { frames, session, transcribers } = createHarness({
      fluxConfig: FLUX_ON,
      bargeInMinSpeechMs: 5_000,
    });
    try {
      await session.start();
      await waitFor(() => transcribers.length === 1);
      await session.handleBinaryAudio(SUSTAINED_LOUD_CHUNK);
      expect(countFrames(frames, "speech_started")).toBe(0);

      const transcriber = transcribers[0]!;
      transcriber.startOfTurn(2);
      await waitFor(() => countFrames(frames, "speech_started") === 1);
      transcriber.startOfTurn(2);
      transcriber.startOfTurn(1);
      await session.handleBinaryAudio(SUSTAINED_LOUD_CHUNK);
      expect(countFrames(frames, "speech_started")).toBe(1);
      transcriber.startOfTurn(3);
      await waitFor(() => countFrames(frames, "speech_started") === 2);
    } finally {
      await session.close("client_end");
    }
  });

  test("provider-confirmed quiet speech interrupts a thinking turn", async () => {
    const abort = mock();
    const { frames, session, transcribers, turnCalls } = createHarness({
      fluxConfig: FLUX_ON,
      bargeInMinSpeechMs: 5_000,
      startVoiceTurn: async () => ({ turnId: "thinking-turn", abort }),
    });
    try {
      await session.start();
      await waitFor(() => transcribers.length === 1);
      const transcriber = transcribers[0]!;
      await session.handleBinaryAudio(LOUD_CHUNK);
      transcriber.startOfTurn(0);
      transcriber.endOfTurn("start an investigation", 0);
      await waitFor(() => turnCalls.length === 1);
      await session.handleBinaryAudio(pcm(100));

      // The previous turn's duplicate cannot interrupt the reply it caused.
      transcriber.startOfTurn(0);
      expect(countFrames(frames, "turn_cancelled")).toBe(0);
      transcriber.startOfTurn(1);
      await waitFor(() => countFrames(frames, "turn_cancelled") === 1);
      expect(countFrames(frames, "speech_started")).toBe(2);
      expect(abort).toHaveBeenCalledTimes(1);
    } finally {
      await session.close("client_end");
    }
  });

  test("provider speech start flushes the playback tail of a completed turn", async () => {
    const { frames, session, transcribers } = createHarness({
      fluxConfig: FLUX_ON,
      startVoiceTurn: autoCompletingTurn(),
      streamTtsAudio: async (options) => {
        const audio = pcm(100, SAMPLE_RATE * 2);
        options.onAudioChunk({
          type: "tts_audio",
          contentType: "audio/pcm",
          sampleRate: SAMPLE_RATE,
          dataBase64: Buffer.from(audio).toString("base64"),
        });
        return {
          provider: "fish-audio",
          contentType: "audio/pcm",
          sampleRate: SAMPLE_RATE,
          chunks: 1,
          bytes: audio.byteLength,
        };
      },
    });
    try {
      await session.start();
      await waitFor(() => transcribers.length === 1);
      const transcriber = transcribers[0]!;
      await session.handleBinaryAudio(LOUD_CHUNK);
      transcriber.startOfTurn(0);
      transcriber.endOfTurn("tell me a story", 0);
      await waitFor(() => countFrames(frames, "tts_done") === 1);
      await session.handleBinaryAudio(SUSTAINED_LOUD_CHUNK);
      expect(countFrames(frames, "speech_started")).toBe(1);

      transcriber.startOfTurn(1);
      await waitFor(() => countFrames(frames, "speech_started") === 2);
      expect(countFrames(frames, "turn_cancelled")).toBe(0);
    } finally {
      await session.close("client_end");
    }
  });

  test("provider speech start does not interrupt manual sessions", async () => {
    const { frames, session, transcribers } = createHarness({
      startFrame: { ...VAD_START_FRAME, turnDetection: "manual" },
      fluxConfig: FLUX_ON,
    });
    try {
      await session.start();
      await waitFor(() => transcribers.length === 1);
      await session.handleBinaryAudio(SUSTAINED_LOUD_CHUNK);
      transcribers[0]?.startOfTurn(0);
      await flushAsyncCallbacks();
      expect(countFrames(frames, "speech_started")).toBe(0);
      expect(countFrames(frames, "turn_cancelled")).toBe(0);
    } finally {
      await session.close("client_end");
    }
  });

  test("provider speech start discards a pending speculative reply", async () => {
    const discard = mock(async () => {});
    const { frames, session, transcribers, turnCalls } = createHarness({
      fluxConfig: FLUX_OFF,
      startVoiceTurn: async () => ({
        turnId: "speculative-turn",
        abort: mock(),
        discard,
      }),
    });
    try {
      await session.start();
      await waitFor(() => transcribers.length === 1);
      const transcriber = transcribers[0]!;
      await session.handleBinaryAudio(LOUD_CHUNK);
      transcriber.startOfTurn(0);
      transcriber.emit({ type: "final", text: "what is the" });
      await waitFor(() => turnCalls.length === 1);
      expect(turnCalls[0]?.unifiedVerdict).toBeDefined();

      await session.handleBinaryAudio(LOUD_CHUNK);
      expect(discard).not.toHaveBeenCalled();
      transcriber.startOfTurn(1);
      await waitFor(() => discard.mock.calls.length === 1);
      await flushAsyncCallbacks();
      expect(countFrames(frames, "speech_started")).toBe(2);
      expect(countFrames(frames, "turn_cancelled")).toBe(0);
    } finally {
      await session.close("client_end");
    }
  });
});

/**
 * The window between `ready` and the resolved transcriber. `start()` arms the
 * utterance in the background so the client's mic acquisition overlaps the STT
 * handshake, which means a fast caller can speak AND fall silent before the
 * dial answers. These tests seed `services.stt.provider` for real, because the
 * latch is armed from the configured provider before the dial and reconciled
 * with the resolved one after it.
 */
describe("LiveVoiceSession Flux end-of-turn during the STT dial", () => {
  beforeEach(() => {
    setConfig("services", {
      stt: {
        provider: "deepgram",
        providers: { deepgram: { model: "flux" } },
      },
    });
  });

  afterEach(() => {
    setConfig("services", { stt: { provider: "deepgram", providers: {} } });
  });

  test("empty Flux updates do not prevent a language change during idle input", async () => {
    const { session, transcribers } = createHarness({ fluxConfig: FLUX_ON });
    try {
      await session.start();
      await waitFor(() => transcribers.length === 1);
      transcribers[0]!.emit({ type: "partial", text: "" });
      setConfig("services", {
        stt: {
          provider: "deepgram",
          providers: { deepgram: { model: "flux" } },
          language: "es",
        },
      });
      await session.handleBinaryAudio(pcm(0));
      await waitFor(() => transcribers.length === 2);
      expect(transcribers[0]!.stopped).toBe(true);
      await session.handleBinaryAudio(pcm(100));
      expect(transcribers[1]!.received.at(-1)).toEqual(Buffer.from(pcm(100)));
    } finally {
      await session.close("client_end");
    }
  });

  test("waits for turn-end when the boundary lands before the dial resolves", async () => {
    const gate = createDialGate();
    const { frames, session, transcribers, turnCalls } = createHarness({
      fluxConfig: FLUX_ON,
      silenceThresholdMs: 40,
      resolveGate: gate.promise,
      startVoiceTurn: autoCompletingTurn(),
    });

    await session.start();
    expect(transcribers).toHaveLength(0);

    // The caller speaks and falls silent entirely inside the handshake
    // window, so the whole first turn is decided before any provider answers.
    await session.handleBinaryAudio(LOUD_CHUNK);
    await sleep(PAST_SILENCE_BOUNDARY_MS);

    // The silence boundary passed and committed nothing: the latch was seeded
    // from the configured provider, so Flux owns this boundary like any other.
    expect(transcribers).toHaveLength(0);
    expect(countFrames(frames, "utterance_end")).toBe(0);
    expect(turnCalls).toHaveLength(0);

    gate.open();
    await waitFor(() => transcribers.length > 0);
    transcribers[0]?.endOfTurn("what is the weather");

    await waitFor(
      () => turnCalls.length === 1,
      "The first utterance never committed on the Flux end-of-turn",
    );
    // Committed by Flux, not by the silence path: non-speculative dispatch.
    expect(turnCalls[0]?.content).toBe("what is the weather");
    expect(turnCalls[0]?.unifiedVerdict).toBeUndefined();
    expect(countFrames(frames, "utterance_end")).toBe(1);

    await session.close("client_end");
  });

  test("unwinds the seeded latch when the dial resolves to another provider", async () => {
    const gate = createDialGate();
    const { frames, session, transcribers, turnCalls } = createHarness({
      // Config names Flux, so the latch is seeded, but the dial answers with
      // another provider: a fallback, or a resolver reading a config the
      // session no longer matches. That provider never sends an end-of-turn.
      providerId: "deepgram",
      // Far enough out that the fail-open deadline alone cannot be what
      // releases this utterance inside the test's budget.
      fluxConfig: { turnEnd: { enabled: true }, eotTimeoutMs: 30_000 },
      silenceThresholdMs: 40,
      resolveGate: gate.promise,
      startVoiceTurn: autoCompletingTurn(),
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await sleep(PAST_SILENCE_BOUNDARY_MS);
    // Deferred under the seeded latch, exactly as a real Flux session would.
    expect(countFrames(frames, "utterance_end")).toBe(0);

    gate.open();
    await waitFor(() => transcribers.length > 0);

    // The deferred boundary is replayed as soon as the dial disproves the
    // seed, instead of being stranded on a deadline 30 s away.
    await waitFor(
      () => countFrames(frames, "utterance_end") === 1,
      "The utterance deferred under the seeded latch never released",
    );
    expect(countFrames(frames, "speech_started")).toBe(1);
    await waitFor(
      () => transcribers[0]?.stopped === true,
      "The utterance never finished releasing",
    );
    // ...and nothing routed through the Flux commit path.
    expect(turnCalls.every((call) => call.unifiedVerdict !== undefined)).toBe(
      true,
    );

    await session.close("client_end");
  });

  test.each([true, false])(
    "replays local onset when the dial falls back from Flux (turn-end %s)",
    async (flagOn) => {
      const gate = createDialGate();
      const { frames, session } = createHarness({
        providerId: "vellum",
        fluxConfig: flagOn ? FLUX_ON : FLUX_OFF,
        silenceThresholdMs: 10_000,
        resolveGate: gate.promise,
      });
      try {
        await session.start();
        await session.handleBinaryAudio(LOUD_CHUNK);
        expect(countFrames(frames, "speech_started")).toBe(0);
        gate.open();
        await waitFor(() => countFrames(frames, "speech_started") === 1);
        await session.handleBinaryAudio(LOUD_CHUNK);
        expect(countFrames(frames, "speech_started")).toBe(1);
      } finally {
        gate.open();
        await session.close("client_end");
      }
    },
  );

  test.each([
    { providerId: "vellum" as const, audio: LOUD_CHUNK, interrupts: false },
    {
      providerId: "vellum" as const,
      audio: SUSTAINED_LOUD_CHUNK,
      interrupts: true,
    },
    {
      providerId: "deepgram-flux" as const,
      audio: LOUD_CHUNK,
      interrupts: true,
    },
  ])(
    "speech released before the dial interrupts only after provider or guard confirmation: $providerId",
    async ({ providerId, audio, interrupts }) => {
      const gate = createDialGate();
      const abort = mock();
      const { frames, session, transcribers } = createHarness({
        providerId,
        fluxConfig: FLUX_OFF,
        resolveGate: gate.promise,
        startVoiceTurn: async () => ({ turnId: "greeting-turn", abort }),
      });
      try {
        await session.start();
        await session.handleClientFrame({
          type: "text",
          text: "Say hello.",
          hidden: true,
        });
        await waitFor(() => countFrames(frames, "thinking") === 1);
        await session.handleBinaryAudio(audio);
        await waitFor(() => countFrames(frames, "utterance_end") === 1);
        expect(countFrames(frames, "speech_started")).toBe(0);
        expect(countFrames(frames, "turn_cancelled")).toBe(0);

        gate.open();
        await gate.promise;
        const transcriber = transcribers[0]!;
        if (providerId === "deepgram-flux") {
          transcriber.onAudio = () => {
            transcriber.startOfTurn(0);
          };
        }
        await waitFor(() => transcriber.stopped);
        await flushAsyncCallbacks();
        expect(countFrames(frames, "speech_started")).toBe(interrupts ? 1 : 0);
        expect(countFrames(frames, "turn_cancelled")).toBe(interrupts ? 1 : 0);
        expect(abort).toHaveBeenCalledTimes(interrupts ? 1 : 0);
      } finally {
        gate.open();
        await session.close("client_end");
      }
    },
  );

  test("a fully parked follow-up retains its guard when the next dial falls back", async () => {
    const abort = mock();
    const options = {
      providerId: "deepgram-flux" as SttProviderId,
      fluxConfig: FLUX_ON,
      startVoiceTurn: async () => ({ turnId: "reply-turn", abort }),
    };
    const { frames, session, transcribers } = createHarness(options);
    try {
      await session.start();
      await waitFor(() => transcribers.length === 1);
      const first = transcribers[0]!;
      first.holdStopEvents = true;
      first.pendingFlushText = "tell me a story";
      await session.handleBinaryAudio(LOUD_CHUNK);
      first.startOfTurn(0);
      await session.handleClientFrame({ type: "ptt_release" });
      await waitFor(() => first.stopped);

      // The first input is released but cannot dispatch until its final arrives.
      await session.handleBinaryAudio(SUSTAINED_LOUD_CHUNK);
      await sleep(PAST_SILENCE_BOUNDARY_MS);
      options.providerId = "vellum";
      first.flushStopEvents();
      await waitFor(() => countFrames(frames, "thinking") === 1);
      expect(countFrames(frames, "turn_cancelled")).toBe(0);

      // Idle input arms the parked follow-up without any further speech.
      await session.handleBinaryAudio(pcm(0));
      await waitFor(() => transcribers.length === 2);
      await waitFor(() => countFrames(frames, "turn_cancelled") === 1);
      expect(abort).toHaveBeenCalledTimes(1);
      expect(transcribers[1]!.received).toContainEqual(
        Buffer.from(SUSTAINED_LOUD_CHUNK),
      );
    } finally {
      await session.close("client_end");
    }
  });

  test("seeds the latch from the live-voice role, not the global provider", async () => {
    // The configuration roles exist for: live voice on flux while the global
    // stays on a family that owns no turn boundary. Seeding from the global
    // leaves the latch false, and the opening utterance closes its silence
    // boundary on the caller's side before the dial can correct it.
    setConfig("services", {
      stt: {
        provider: "deepgram",
        providers: { deepgram: {} },
        roles: { liveVoice: { provider: "deepgram", model: "flux" } },
      },
    });
    const gate = createDialGate();
    const { frames, session, transcribers, turnCalls } = createHarness({
      fluxConfig: FLUX_ON,
      silenceThresholdMs: 40,
      resolveGate: gate.promise,
      startVoiceTurn: autoCompletingTurn(),
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await sleep(PAST_SILENCE_BOUNDARY_MS);

    // Deferred under the seeded latch: Flux owns this boundary.
    expect(countFrames(frames, "utterance_end")).toBe(0);
    expect(countFrames(frames, "speech_started")).toBe(0);
    expect(turnCalls).toHaveLength(0);

    gate.open();
    await waitFor(() => transcribers.length > 0);
    transcribers[0]?.endOfTurn("what is the weather");

    await waitFor(
      () => turnCalls.length === 1,
      "The opening utterance never committed on the Flux end-of-turn",
    );
    expect(turnCalls[0]?.content).toBe("what is the weather");
    expect(countFrames(frames, "utterance_end")).toBe(1);

    await session.close("client_end");
  });

  test("seeds only provider starts when provider end-of-turn is disabled", async () => {
    const gate = createDialGate();
    const { frames, session, transcribers, turnCalls } = createHarness({
      // Turn-end explicitly off while config still selects the flux family.
      fluxConfig: FLUX_OFF,
      silenceThresholdMs: 40,
      resolveGate: gate.promise,
      startVoiceTurn: autoCompletingTurn(),
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);

    // The local silence boundary releases, but local onset cannot interrupt.
    await waitFor(
      () => countFrames(frames, "utterance_end") === 1,
      "The flag-off silence boundary stopped releasing during the dial",
    );
    expect(turnCalls).toHaveLength(0);
    expect(countFrames(frames, "speech_started")).toBe(0);

    gate.open();
    await waitFor(() => transcribers.length > 0);
    transcribers[0]?.endOfTurn("hello there");
    await flushAsyncCallbacks();

    // The turn-end commits nothing on top of the boundary that already ran.
    expect(countFrames(frames, "utterance_end")).toBe(1);

    await session.close("client_end");
  });

  test("keeps one stream across turns when the provider owns the boundary", async () => {
    const { session, transcribers, turnCalls } = createHarness({
      fluxConfig: FLUX_ON,
      // Long enough that only the provider can be closing these turns.
      silenceThresholdMs: 10_000,
      startVoiceTurn: autoCompletingTurn(),
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => transcribers.length > 0);
    transcribers[0]?.startOfTurn(0);
    transcribers[0]?.endOfTurn("what is the weather", 0);
    await waitFor(() => turnCalls.length === 1);
    await flushAsyncCallbacks();

    // Second utterance on the same session. A stream torn down per utterance
    // would lose the audio arriving while its replacement dials, which is
    // what eats the opening words of every turn after the first.
    await session.handleBinaryAudio(LOUD_CHUNK);
    transcribers[0]?.startOfTurn(1);
    transcribers[0]?.endOfTurn("and tomorrow", 1);
    await waitFor(() => turnCalls.length === 2);

    expect(transcribers).toHaveLength(1);
    expect(transcribers[0]?.stopped).toBe(false);
    expect(turnCalls[1]?.content).toBe("and tomorrow");

    await session.close("client_end");
  });

  test("closes the stream when a caller-side boundary releases the turn", async () => {
    const { session, transcribers, turnCalls } = createHarness({
      fluxConfig: FLUX_ON,
      startVoiceTurn: autoCompletingTurn(),
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => transcribers.length > 0);
    // Flux transcribes but never closes the turn, so the fail-open deadline
    // releases it. Nothing sealed this cycle provider-side, so the only way
    // to make Flux answer for the turn still open is to close the stream.
    transcribers[0]?.emit({ type: "partial", text: "are you still there" });

    await waitFor(
      () => turnCalls.length === 1,
      "Flux fallback never replayed the silence boundary",
    );
    expect(transcribers[0]?.stopped).toBe(true);

    // The closing stream stays routable: its flush and its close both arrive
    // after stop(), and the cycle is sealed by that close.
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(
      () => transcribers.length === 2,
      "The next utterance never dialed a replacement stream",
    );

    await session.close("client_end");
  }, 10_000);

  test("rearms an empty fallback cycle while the previous reply is active", async () => {
    const abort = mock();
    const { frames, session, transcribers, turnCalls } = createHarness({
      fluxConfig: FLUX_ON,
      startVoiceTurn: async (turnOptions) => {
        turnOptions.callbacks?.assistant_text_delta?.(
          makeTextDelta("Working on the edit."),
        );
        return { turnId: "editing-turn", abort };
      },
    });

    try {
      await session.start();
      await waitFor(() => transcribers.length === 1);
      const transcriber = transcribers[0]!;
      await session.handleBinaryAudio(LOUD_CHUNK);
      transcriber.startOfTurn(0);
      transcriber.endOfTurn("edit the clip", 0);
      await waitFor(() => turnCalls.length === 1);

      const speechStarts = countFrames(frames, "speech_started");
      await session.handleBinaryAudio(SUSTAINED_LOUD_CHUNK);
      // No provider speech start or transcript arrives for this local onset.
      await waitFor(() => transcriber.stopped);
      await waitFor(
        () => transcribers.length >= 2,
        "An empty fallback cycle blocked the replacement stream behind the reply",
      );
      expect(countFrames(frames, "utterance_discarded")).toBe(1);
      expect(countFrames(frames, "speech_started")).toBe(speechStarts);
      expect(countFrames(frames, "turn_cancelled")).toBe(0);
      expect(abort).not.toHaveBeenCalled();
      expect(turnCalls).toHaveLength(1);

      const replacement = transcribers.at(-1)!;
      await session.handleBinaryAudio(SUSTAINED_LOUD_CHUNK);
      expect(replacement.received.length).toBeGreaterThan(0);
      replacement.startOfTurn(0);
      await waitFor(() => countFrames(frames, "turn_cancelled") === 1);
      expect(countFrames(frames, "speech_started")).toBe(speechStarts + 1);
      expect(abort).toHaveBeenCalledTimes(1);

      replacement.endOfTurn("stop editing", 0);
      await waitFor(() => turnCalls.length === 2);
      expect(turnCalls[1]?.content).toBe("stop editing");
    } finally {
      await session.close("client_end");
    }
  }, 10_000);

  test("keeps a nonempty fallback transcript queued behind the previous reply", async () => {
    const abort = mock();
    const { frames, session, transcribers, turnCalls } = createHarness({
      fluxConfig: FLUX_ON,
      startVoiceTurn: async () => ({ turnId: "editing-turn", abort }),
    });

    try {
      await session.start();
      await waitFor(() => transcribers.length === 1);
      const transcriber = transcribers[0]!;
      await session.handleBinaryAudio(LOUD_CHUNK);
      transcriber.startOfTurn(0);
      transcriber.endOfTurn("edit the clip", 0);
      await waitFor(() => turnCalls.length === 1);

      transcriber.pendingFlushText = "show me the result";
      await session.handleBinaryAudio(SUSTAINED_LOUD_CHUNK);
      await waitFor(() => transcriber.stopped);
      await flushAsyncCallbacks();
      expect(turnCalls).toHaveLength(1);
      expect(countFrames(frames, "utterance_discarded")).toBe(0);
      expect(abort).not.toHaveBeenCalled();

      turnCalls[0]?.callbacks?.message_complete?.(makeMessageComplete());
      await waitFor(() => turnCalls.length === 2);
      expect(turnCalls[1]?.content).toBe("show me the result");
    } finally {
      await session.close("client_end");
    }
  }, 10_000);

  test("routes a closing stream's flush into the turn it released", async () => {
    const { session, transcribers, turnCalls } = createHarness({
      fluxConfig: FLUX_ON,
      startVoiceTurn: autoCompletingTurn(),
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => transcribers.length > 0);
    const transcriber = transcribers[0];
    // Flux transcribes nothing and never closes the turn, so the fail-open
    // deadline releases a cycle with no transcript: there is no speculative
    // dispatch to answer this turn, only what the close flushes.
    if (transcriber) {
      transcriber.pendingFlushText = "the whole sentence";
    }

    await waitFor(
      () => turnCalls.length === 1,
      "The flushed transcript never reached an assistant turn",
    );
    expect(turnCalls[0]?.content).toBe("the whole sentence");

    await session.close("client_end");
  }, 10_000);

  test("tears the stream down per utterance while the flag is off", async () => {
    const { session, transcribers, turnCalls } = createHarness({
      fluxConfig: { turnEnd: { enabled: false } },
      startVoiceTurn: autoCompletingTurn(),
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => transcribers.length > 0);
    transcribers[0]?.emit({ type: "final", text: "hello there" });

    // With provider turn-end disabled the local silence boundary owns the
    // turn, and a stream the caller can neither flush nor rely on to seal
    // itself must close for its transcript to land.
    await waitFor(
      () => turnCalls.length === 1,
      "The silence boundary never committed the turn",
    );
    expect(transcribers[0]?.stopped).toBe(true);

    await session.close("client_end");
  }, 10_000);
});
