import { describe, expect, mock, test } from "bun:test";

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
 * Flux-shaped streaming transcriber: no `finalizeUtterance` (Flux owns turn
 * boundaries, so the session runs it per cycle), and every transcript event is
 * scripted by the test. `stop()` closes without inventing a trailing final,
 * exactly as Flux does: its transcript is committed by EndOfTurn.
 */
class MockFluxTranscriber implements StreamingTranscriber {
  readonly boundaryId = "daemon-streaming" as const;
  readonly received: Buffer[] = [];
  stopped = false;
  private onEvent: ((event: SttStreamServerEvent) => void) | null = null;

  constructor(readonly providerId: SttProviderId) {}

  async start(onEvent: (event: SttStreamServerEvent) => void): Promise<void> {
    this.onEvent = onEvent;
  }

  sendAudio(chunk: Buffer): void {
    this.received.push(Buffer.from(chunk));
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.onEvent?.({ type: "closed" });
  }

  emit(event: SttStreamServerEvent): void {
    this.onEvent?.(event);
  }

  // Flux's EndOfTurn frame maps onto a `final` followed by a `turn-end`.
  endOfTurn(text: string): void {
    this.emit({ type: "final", text });
    this.emit({ type: "turn-end", text, confidence: 0.9 });
  }
}

function createHarness(options: {
  providerId?: SttProviderId;
  fluxConfig?: Partial<LiveVoiceFluxConfig>;
  silenceThresholdMs?: number;
  startVoiceTurn?: (options: VoiceTurnOptions) => Promise<{
    turnId: string;
    abort: () => void;
  }>;
  streamTtsAudio?: LiveVoiceTtsStreamer | null;
  emitMetrics?: boolean;
}) {
  const sequencer = createLiveVoiceServerFrameSequencer();
  const frames: LiveVoiceServerFrame[] = [];
  const context: LiveVoiceSessionFactoryContext = {
    sessionId: "session-123",
    startFrame: VAD_START_FRAME,
    sendFrame: mock(async (payload) => {
      const frame = sequencer.next(payload);
      frames.push(frame);
      return frame;
    }),
  };

  const transcribers: MockFluxTranscriber[] = [];
  const resolveTranscriber = mock(async () => {
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

const FLUX_ON = {
  turnEnd: { enabled: true },
  eotTimeoutMs: 500,
} as const satisfies Partial<LiveVoiceFluxConfig>;

describe("LiveVoiceSession Flux end-of-turn", () => {
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
    await waitFor(() =>
      frames.some(
        (frame) => frame.type === "metrics" && frame.event === "turn_completed",
      ),
    );

    const metricsFrame = frames.find(
      (frame) => frame.type === "metrics" && frame.event === "turn_completed",
    );
    expect(metricsFrame).toBeDefined();
    if (metricsFrame?.type === "metrics") {
      expect(metricsFrame.endpointDecisionSource).toBe("flux");
      expect(metricsFrame.endpointHoldCount).toBe(0);
    }

    await session.close("client_end");
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

  for (const flagOn of [false, true]) {
    test(`barge-in during playback fires from local VAD (flux turn end ${
      flagOn ? "on" : "off"
    })`, async () => {
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
        ...(flagOn ? { fluxConfig: FLUX_ON } : {}),
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
      if (flagOn) {
        transcribers[0]?.endOfTurn("tell me a story");
      } else {
        transcribers[0]?.emit({ type: "final", text: "tell me a story" });
        await session.handleClientFrame({ type: "ptt_release" });
      }
      await waitFor(() => frames.some((frame) => frame.type === "thinking"));

      // Local energy detection, not the provider's turn model, is what
      // interrupts the assistant.
      await session.handleBinaryAudio(SUSTAINED_LOUD_CHUNK);
      await waitFor(
        () => frames.some((frame) => frame.type === "speech_started"),
        "Local VAD barge-in never fired",
      );
      await waitFor(() =>
        frames.some((frame) => frame.type === "turn_cancelled"),
      );

      await session.close("client_end");
    });
  }
});
