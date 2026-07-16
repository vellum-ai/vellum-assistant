import { afterEach, describe, expect, mock, test } from "bun:test";

import type { TurnDetectorConfig } from "../../calls/media-turn-detector.js";
import type {
  VoiceTurnCallbacks,
  VoiceTurnOptions,
} from "../../calls/voice-session-bridge.js";
import {
  clearCachedOverrides,
  setCachedOverrides,
} from "../../config/feature-flag-cache.js";
import {
  getConfig,
  loadRawConfig,
  saveRawConfig,
} from "../../config/loader.js";
import type {
  StreamingTranscriber,
  SttStreamServerEvent,
} from "../../stt/types.js";
import type { LiveVoiceAudioArchiveResult } from "../live-voice-archive.js";
import {
  createLiveVoiceSession,
  type LiveVoiceBackgroundContinuationSpawner,
  LiveVoiceSession,
  type LiveVoiceSessionAudioArchiver,
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

// 10 ms of speech at 24 kHz.
const LOUD_CHUNK = pcm(8_000);
// 300 ms of speech at 24 kHz — comfortably exceeds the default sustained-speech
// barge-in guard (bargeInMinSpeechMs, 250 ms) in a single chunk, so a lone
// chunk trips barge-in. Must stay above that default.
const SUSTAINED_LOUD_CHUNK = pcm(8_000, 7_200);
const SILENT_CHUNK = pcm(0);

class MockStreamingTranscriber implements StreamingTranscriber {
  readonly providerId = "deepgram" as const;
  readonly boundaryId = "daemon-streaming" as const;
  readonly received: Buffer[] = [];
  stopped = false;
  private onEvent: ((event: SttStreamServerEvent) => void) | null = null;

  constructor(
    private readonly stopEvents: SttStreamServerEvent[],
    private readonly holdStopEvents = false,
  ) {}

  async start(onEvent: (event: SttStreamServerEvent) => void): Promise<void> {
    this.onEvent = onEvent;
  }

  sendAudio(chunk: Buffer): void {
    this.received.push(Buffer.from(chunk));
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (!this.holdStopEvents) {
      this.flushStopEvents();
    }
  }

  flushStopEvents(): void {
    for (const event of this.stopEvents) {
      this.onEvent?.(event);
    }
  }

  // Provider-initiated event (e.g. an idle-timeout close), no stop() needed.
  emit(event: SttStreamServerEvent): void {
    this.onEvent?.(event);
  }
}

function createHarness(options: {
  startFrame?: LiveVoiceClientStartFrame;
  finals?: string[];
  startVoiceTurn?: LiveVoiceTurnStarter;
  streamTtsAudio?: LiveVoiceTtsStreamer | null;
  archiveAudio?: LiveVoiceSessionAudioArchiver;
  turnDetectorConfig?: TurnDetectorConfig;
  speechEnergyThreshold?: number;
  bargeInMinSpeechMs?: number;
  echoEmaHalfLifeMs?: number;
  echoBargeInMargin?: number;
  emitMetrics?: boolean;
  metricsClock?: () => number;
  // Return a promise to hold a frame's transport write open (a backed-up
  // outbound queue); return null to write immediately.
  holdSendFrame?: (
    payload: Parameters<LiveVoiceSessionFactoryContext["sendFrame"]>[0],
  ) => Promise<void> | null;
  // Transcriber indices whose stop events wait for flushStopEvents().
  holdStopEventsFor?: number[];
  // Build the session through the production factory (with the credential
  // preflight skipped) instead of the constructor, so the liveVoice.vad
  // config path is exercised: unset thresholds come from getConfig().
  viaFactory?: boolean;
  spawnBackgroundContinuation?: LiveVoiceBackgroundContinuationSpawner;
}) {
  const sequencer = createLiveVoiceServerFrameSequencer();
  const frames: LiveVoiceServerFrame[] = [];
  const context: LiveVoiceSessionFactoryContext = {
    sessionId: "session-123",
    startFrame: options.startFrame ?? VAD_START_FRAME,
    sendFrame: mock(async (payload) => {
      await options.holdSendFrame?.(payload);
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
    const transcriber = new MockStreamingTranscriber(
      [{ type: "final", text }, { type: "closed" }],
      options.holdStopEventsFor?.includes(transcribers.length) ?? false,
    );
    transcribers.push(transcriber);
    return transcriber;
  });

  let turnNumber = 0;
  const sessionOptions = {
    resolveTranscriber,
    startVoiceTurn:
      options.startVoiceTurn ??
      mock(async () => ({ turnId: "bridge-turn", abort: mock() })),
    streamTtsAudio: options.streamTtsAudio ?? null,
    archiveAudio: options.archiveAudio ?? null,
    emitMetrics: options.emitMetrics ?? false,
    ...(options.metricsClock ? { metricsClock: options.metricsClock } : {}),
    createTurnId: () => {
      turnNumber += 1;
      return `live-turn-${turnNumber}`;
    },
    // Factory sessions leave unset thresholds to the config path; direct
    // sessions default to a short silence timer to keep tests fast.
    turnDetectorConfig:
      options.turnDetectorConfig ??
      (options.viaFactory ? undefined : { silenceThresholdMs: 40 }),
    speechEnergyThreshold: options.speechEnergyThreshold,
    bargeInMinSpeechMs: options.bargeInMinSpeechMs,
    echoEmaHalfLifeMs: options.echoEmaHalfLifeMs,
    echoBargeInMargin: options.echoBargeInMargin,
    ...(options.spawnBackgroundContinuation
      ? { spawnBackgroundContinuation: options.spawnBackgroundContinuation }
      : {}),
  };
  const session = options.viaFactory
    ? createLiveVoiceSession(context, {
        ...sessionOptions,
        // Credential-free harness: every leg is injected, so skip the preflight.
        resolveCredentialReadiness: null,
      })
    : new LiveVoiceSession(context, sessionOptions);

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
  // The voice-duplex-handoff flag is toggled via the override cache in a few
  // tests below; reset it so it never leaks into the flag-off default cases.
  afterEach(() => clearCachedOverrides());

  test("ready echoes turnDetection server_vad", async () => {
    const { frames, session } = createHarness({});

    await session.start();

    expect(frames[0]).toMatchObject({
      type: "ready",
      turnDetection: "server_vad",
    });
  });

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
      // Neutralize the echo-adaptive gate (threshold pinned to the 800
      // floor, warm-up over after one chunk) — this test is about barge-in
      // mechanics, not echo suppression.
      echoBargeInMargin: 0.001,
      echoEmaHalfLifeMs: 4,
      finals: ["what's the weather", "actually never mind"],
      startVoiceTurn,
      streamTtsAudio,
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => frames.some((frame) => frame.type === "thinking"));

    callbacks?.assistant_text_delta?.(makeTextDelta("It is sunny today."));
    await waitFor(() => frames.some((frame) => frame.type === "tts_audio"));

    // Sustained speech over the assistant's audio meets the default guard.
    await session.handleBinaryAudio(SUSTAINED_LOUD_CHUNK);
    // The sustained chunk is the first in-window audio, so its trip is
    // deferred by the echo gate's onset warm-up; the follow-up chunk fires
    // the accumulated run.
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

  test("speech while the first tts_audio send is stuck in the queue does not cancel; barge-in works once it lands", async () => {
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
    let releaseDeltaSend: (() => void) | undefined;
    const { frames, session } = createHarness({
      // Neutralize the echo-adaptive gate (threshold pinned to the 800
      // floor, warm-up over after one chunk) — this test is about barge-in
      // mechanics, not echo suppression.
      echoBargeInMargin: 0.001,
      echoEmaHalfLifeMs: 4,
      finals: ["what's the weather", "wait actually", "stop please"],
      startVoiceTurn,
      streamTtsAudio,
      // Hold the assistant_text_delta write open so the queued tts_audio
      // frame sits behind it, unsent.
      holdSendFrame: (payload) => {
        if (payload.type !== "assistant_text_delta" || releaseDeltaSend) {
          return null;
        }
        return new Promise<void>((resolve) => {
          releaseDeltaSend = resolve;
        });
      },
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => frames.some((frame) => frame.type === "thinking"));

    callbacks?.assistant_text_delta?.(makeTextDelta("It is sunny today."));
    await waitFor(() => releaseDeltaSend !== undefined);
    await waitFor(() => streamTtsAudio.mock.calls.length === 1);

    // A short blip while the tts_audio frame is queued but unsent: the
    // sustained-speech guard is not met, so nothing cancels yet.
    await session.handleBinaryAudio(LOUD_CHUNK);
    await flushAsyncCallbacks();
    expect(countType(frames, "turn_cancelled")).toBe(0);
    expect(abort).not.toHaveBeenCalled();

    // Unblock the queue: the reply's audio is actually delivered.
    releaseDeltaSend?.();
    await waitFor(() => frames.some((frame) => frame.type === "tts_audio"));
    expect(countType(frames, "turn_cancelled")).toBe(0);
    expect(abort).not.toHaveBeenCalled();

    // Once audio has genuinely gone out, new sustained speech barge-ins.
    await waitFor(() => countType(frames, "utterance_end") === 2);
    await session.handleBinaryAudio(SUSTAINED_LOUD_CHUNK);
    // The sustained chunk is the first in-window audio, so its trip is
    // deferred by the echo gate's onset warm-up; the follow-up chunk fires
    // the accumulated run.
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() =>
      frames.some((frame) => frame.type === "turn_cancelled"),
    );
    expect(
      frames.find((frame) => frame.type === "turn_cancelled"),
    ).toMatchObject({
      type: "turn_cancelled",
      turnId: "live-turn-1",
    });
    await waitFor(() => abort.mock.calls.length === 1);
  });

  test("sustained speech while the turn is still thinking aborts the pre-TTS turn", async () => {
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

    // No assistant_text_delta yet — the turn is still pre-TTS "thinking".
    // Sustained speech over the unspoken reply meets the barge-in guard and
    // cancels the in-flight turn before it ever starts talking (JARVIS-1266).
    await session.handleBinaryAudio(SUSTAINED_LOUD_CHUNK);
    await waitFor(() =>
      frames.some((frame) => frame.type === "turn_cancelled"),
    );

    const types = frameTypes(frames);
    const bargeInSpeechStartedIndex = types.lastIndexOf("speech_started");
    const turnCancelledIndex = types.indexOf("turn_cancelled");
    expect(bargeInSpeechStartedIndex).toBeGreaterThan(-1);
    expect(bargeInSpeechStartedIndex).toBeLessThan(turnCancelledIndex);
    expect(countType(frames, "turn_cancelled")).toBe(1);
    expect(frames[turnCancelledIndex]).toMatchObject({
      type: "turn_cancelled",
      turnId: "live-turn-1",
    });
    await waitFor(() => abort.mock.calls.length === 1);

    // The aborted thinking turn never produced audio and never completes:
    // no orphaned/late assistant response lands after the interrupt.
    expect(countType(frames, "tts_audio")).toBe(0);
    expect(
      frames.some(
        (frame) => frame.type === "tts_done" && frame.turnId === "live-turn-1",
      ),
    ).toBe(false);

    // The barge-in speech was captured from onset into the next utterance,
    // which starts its own turn. Exactly one startVoiceTurn per real utterance
    // (the bridge emits one user_message_echo per call) — no double echo.
    await waitFor(() => startVoiceTurn.mock.calls.length === 2);
    expect(startVoiceTurn.mock.calls[1]?.[0]).toMatchObject({
      content: "second question",
    });
    expect(countType(frames, "utterance_end")).toBe(2);
  });

  test("a thinking barge-in merges the interrupted request into the next turn's control prompt", async () => {
    const startVoiceTurn = mock(async (_options: VoiceTurnOptions) => {
      return { turnId: "bridge-turn", abort: mock() };
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

    // Barge in while the first turn is still thinking, then let the barge-in
    // utterance start its own turn.
    await session.handleBinaryAudio(SUSTAINED_LOUD_CHUNK);
    await waitFor(() => startVoiceTurn.mock.calls.length === 2);

    // The barged (first) turn ran on the plain control prompt.
    const firstPrompt =
      startVoiceTurn.mock.calls[0]?.[0]?.voiceControlPrompt ?? "";
    expect(firstPrompt).not.toContain("interrupted");
    expect(firstPrompt).not.toContain("first question");

    // The follow-up turn's visible content is only what the user just said,
    // but its control prompt carries the interrupted request so the model
    // merges the two instead of treating it as a fresh follow-up.
    const second = startVoiceTurn.mock.calls[1]?.[0];
    expect(second).toMatchObject({ content: "second question" });
    expect(second?.voiceControlPrompt).toContain("first question");
    expect(second?.voiceControlPrompt).toContain("interrupted");
  });

  test("an ordinary turn carries no interruption merge context", async () => {
    const { startVoiceTurn, calls } = makeAutoCompletingTurnStarter(["Hi."]);
    const { frames, session } = createHarness({
      finals: ["hello there"],
      startVoiceTurn,
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => countType(frames, "tts_done") === 1);

    expect(calls).toHaveLength(1);
    const prompt = calls[0]?.voiceControlPrompt ?? "";
    expect(prompt).toContain("live voice session");
    expect(prompt).not.toContain("interrupted");
  });

  test("a discarded barge-in utterance does not leak merge context into a later turn", async () => {
    const startVoiceTurn = mock(async (_options: VoiceTurnOptions) => {
      return { turnId: "bridge-turn", abort: mock() };
    });
    const streamTtsAudio = mock(async (options: LiveVoiceTtsOptions) => {
      options.onAudioChunk(makeTtsChunk("assistant audio"));
      return makeTtsResult("assistant audio");
    });
    // The barge-in utterance (second) transcribes to nothing and is discarded.
    const { frames, session } = createHarness({
      finals: ["first question", "", "third question"],
      startVoiceTurn,
      streamTtsAudio,
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => frames.some((frame) => frame.type === "thinking"));

    // Barge in during thinking (arms the pending merge context), but the
    // barge-in utterance is discarded (empty transcript), which must drop it.
    await session.handleBinaryAudio(SUSTAINED_LOUD_CHUNK);
    await waitFor(() =>
      frames.some((frame) => frame.type === "utterance_discarded"),
    );

    // A later, unrelated turn must not carry the discarded request.
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => startVoiceTurn.mock.calls.length === 2);
    const laterTurn = startVoiceTurn.mock.calls[1]?.[0];
    expect(laterTurn).toMatchObject({ content: "third question" });
    expect(laterTurn?.voiceControlPrompt).not.toContain("interrupted");
    expect(laterTurn?.voiceControlPrompt).not.toContain("first question");
  });

  test("a client interrupt after a barge-in drops the pending merge context", async () => {
    const startVoiceTurn = mock(async (_options: VoiceTurnOptions) => {
      return { turnId: "bridge-turn", abort: mock() };
    });
    const streamTtsAudio = mock(async (options: LiveVoiceTtsOptions) => {
      options.onAudioChunk(makeTtsChunk("assistant audio"));
      return makeTtsResult("assistant audio");
    });
    const { frames, session } = createHarness({
      finals: ["first question", "second question", "third question"],
      startVoiceTurn,
      streamTtsAudio,
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => frames.some((frame) => frame.type === "thinking"));

    // Barge in during thinking, then the client interrupts before the barge-in
    // utterance launches a turn.
    await session.handleBinaryAudio(SUSTAINED_LOUD_CHUNK);
    await waitFor(() =>
      frames.some((frame) => frame.type === "turn_cancelled"),
    );
    await session.handleClientFrame({ type: "interrupt" });
    await flushAsyncCallbacks();
    const callsAtInterrupt = startVoiceTurn.mock.calls.length;

    // Any later turn must not carry the discarded request.
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => startVoiceTurn.mock.calls.length > callsAtInterrupt);
    const laterTurn = startVoiceTurn.mock.calls.at(-1)?.[0];
    expect(laterTurn?.voiceControlPrompt).not.toContain("interrupted");
    expect(laterTurn?.voiceControlPrompt).not.toContain("first question");
  });

  test("voice-duplex-handoff on: a thinking barge-in spawns a background continuation", async () => {
    setCachedOverrides({ "voice-duplex-handoff": true }, { fromGateway: true });
    const spawnBackgroundContinuation = mock(
      async (_args: {
        parentConversationId: string;
        objective: string;
        label: string;
        signal: AbortSignal;
      }) => {},
    );
    const streamTtsAudio = mock(async (options: LiveVoiceTtsOptions) => {
      options.onAudioChunk(makeTtsChunk("assistant audio"));
      return makeTtsResult("assistant audio");
    });
    const { frames, session } = createHarness({
      finals: ["first question", "second question"],
      streamTtsAudio,
      spawnBackgroundContinuation,
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => frames.some((frame) => frame.type === "thinking"));

    // Barge in during thinking; the interrupted turn is continued in the
    // background rather than discarded.
    await session.handleBinaryAudio(SUSTAINED_LOUD_CHUNK);
    await waitFor(() => spawnBackgroundContinuation.mock.calls.length === 1);

    const spawnArgs = spawnBackgroundContinuation.mock.calls[0]?.[0];
    expect(spawnArgs?.parentConversationId).toBe("conversation-123");
    expect(spawnArgs?.label).toContain("live-turn-1");
    // The objective carries the interrupted request so the continuation knows
    // what to finish even before the user message is persisted into history.
    expect(spawnArgs?.objective).toContain("first question");
  });

  test("voice-duplex-handoff on: a client interrupt aborts an in-flight continuation", async () => {
    setCachedOverrides({ "voice-duplex-handoff": true }, { fromGateway: true });
    // Hang the continuation so it is still in flight when the interrupt lands;
    // resolve it when its signal aborts.
    const spawnBackgroundContinuation = mock(
      (args: {
        parentConversationId: string;
        objective: string;
        label: string;
        signal: AbortSignal;
      }) =>
        new Promise<void>((resolve) => {
          args.signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
        }),
    );
    const streamTtsAudio = mock(async (options: LiveVoiceTtsOptions) => {
      options.onAudioChunk(makeTtsChunk("assistant audio"));
      return makeTtsResult("assistant audio");
    });
    const { frames, session } = createHarness({
      finals: ["first question", "second question"],
      streamTtsAudio,
      spawnBackgroundContinuation,
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => frames.some((frame) => frame.type === "thinking"));
    await session.handleBinaryAudio(SUSTAINED_LOUD_CHUNK);
    await waitFor(() => spawnBackgroundContinuation.mock.calls.length === 1);

    const signal = spawnBackgroundContinuation.mock.calls[0]?.[0]?.signal;
    expect(signal?.aborted).toBe(false);

    // A stop hard-ends the still-running continuation via its abort signal.
    await session.handleClientFrame({ type: "interrupt" });
    await flushAsyncCallbacks();
    expect(signal?.aborted).toBe(true);
  });

  test("voice-duplex-handoff on: a client interrupt during barge-in cleanup skips the continuation", async () => {
    setCachedOverrides({ "voice-duplex-handoff": true }, { fromGateway: true });
    const spawnBackgroundContinuation = mock(
      async (_args: {
        parentConversationId: string;
        objective: string;
        label: string;
        signal: AbortSignal;
      }) => {},
    );
    const streamTtsAudio = mock(async (options: LiveVoiceTtsOptions) => {
      options.onAudioChunk(makeTtsChunk("assistant audio"));
      return makeTtsResult("assistant audio");
    });
    let releaseTurnCancelled: (() => void) | undefined;
    const { frames, session } = createHarness({
      finals: ["first question", "second question"],
      streamTtsAudio,
      spawnBackgroundContinuation,
      // Hold the barge-in's turn_cancelled send so its teardown blocks before
      // the detach would spawn.
      holdSendFrame: (payload) => {
        if (payload.type !== "turn_cancelled" || releaseTurnCancelled) {
          return null;
        }
        return new Promise<void>((resolve) => {
          releaseTurnCancelled = resolve;
        });
      },
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => frames.some((frame) => frame.type === "thinking"));

    // Barge in; the teardown blocks on the held turn_cancelled, before the
    // detach spawns.
    await session.handleBinaryAudio(SUSTAINED_LOUD_CHUNK);
    await waitFor(() => releaseTurnCancelled !== undefined);

    // The stop lands during the cleanup gap. interrupt()'s abortDetachedRuns
    // bumps the generation synchronously (even though interrupt then blocks on
    // the same held frame's drain), so releasing the frame lets the barge-in
    // teardown resume and see the stop.
    const interruptDone = session.handleClientFrame({ type: "interrupt" });
    releaseTurnCancelled?.();
    await interruptDone;
    await flushAsyncCallbacks();
    expect(spawnBackgroundContinuation).not.toHaveBeenCalled();
  });

  test("voice-duplex-handoff off (default): a thinking barge-in spawns no continuation", async () => {
    const spawnBackgroundContinuation = mock(
      async (_args: {
        parentConversationId: string;
        objective: string;
        label: string;
        signal: AbortSignal;
      }) => {},
    );
    const streamTtsAudio = mock(async (options: LiveVoiceTtsOptions) => {
      options.onAudioChunk(makeTtsChunk("assistant audio"));
      return makeTtsResult("assistant audio");
    });
    const { frames, session } = createHarness({
      finals: ["first question", "second question"],
      streamTtsAudio,
      spawnBackgroundContinuation,
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => frames.some((frame) => frame.type === "thinking"));
    await session.handleBinaryAudio(SUSTAINED_LOUD_CHUNK);
    await waitFor(() =>
      frames.some((frame) => frame.type === "turn_cancelled"),
    );
    await flushAsyncCallbacks();
    expect(spawnBackgroundContinuation).not.toHaveBeenCalled();
  });

  test("voice-duplex-handoff on: no continuation when the model already completed", async () => {
    setCachedOverrides({ "voice-duplex-handoff": true }, { fromGateway: true });
    let callbacks: VoiceTurnCallbacks | undefined;
    const spawnBackgroundContinuation = mock(
      async (_args: {
        parentConversationId: string;
        objective: string;
        label: string;
        signal: AbortSignal;
      }) => {},
    );
    const startVoiceTurn = mock(async (options: VoiceTurnOptions) => {
      callbacks ??= options.callbacks;
      return { turnId: "bridge-turn", abort: mock() };
    });
    let releaseTts: (() => void) | undefined;
    const streamTtsAudio = mock(async (options: LiveVoiceTtsOptions) => {
      options.onAudioChunk(makeTtsChunk("assistant audio"));
      // Hang so tts_done never fires: the turn stays completed-but-not-finalized.
      await new Promise<void>((resolve) => {
        releaseTts = resolve;
      });
      return makeTtsResult("assistant audio");
    });
    const { frames, session } = createHarness({
      // Neutralize the echo-adaptive gate (threshold pinned to the 800
      // floor, warm-up over after one chunk) — this test is about barge-in
      // mechanics, not echo suppression.
      echoBargeInMargin: 0.001,
      echoEmaHalfLifeMs: 4,
      finals: ["first question", "second question"],
      startVoiceTurn,
      streamTtsAudio,
      spawnBackgroundContinuation,
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => callbacks !== undefined);

    // The model finishes generating (assistantCompleted), but TTS is still
    // playing, so the turn is not finalized.
    callbacks?.assistant_text_delta?.(makeTextDelta("done"));
    callbacks?.message_complete?.(makeMessageComplete());
    await waitFor(() => frames.some((frame) => frame.type === "tts_audio"));

    // Barge in over the playing, already-complete reply.
    await session.handleBinaryAudio(SUSTAINED_LOUD_CHUNK);
    // The sustained chunk is the first in-window audio, so its trip is
    // deferred by the echo gate's onset warm-up; the follow-up chunk fires
    // the accumulated run.
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() =>
      frames.some((frame) => frame.type === "turn_cancelled"),
    );
    await flushAsyncCallbacks();

    // Nothing to continue: no background subagent is spawned.
    expect(spawnBackgroundContinuation).not.toHaveBeenCalled();
    releaseTts?.();
  });

  test("a late assistant_text_delta after a thinking barge-in never reaches the client", async () => {
    let callbacks: VoiceTurnCallbacks | undefined;
    const abort = mock();
    const startVoiceTurn = mock(async (options: VoiceTurnOptions) => {
      callbacks ??= options.callbacks;
      return { turnId: "bridge-turn", abort };
    });
    let releaseTurnCancelled: (() => void) | undefined;
    const { frames, session } = createHarness({
      finals: ["first question", "second question"],
      startVoiceTurn,
      // Suspend the async barge-in teardown at the turn_cancelled send so the
      // aborted turn stays non-finalized — the exact window a late model delta
      // could race into before cancelAssistantTurn finishes.
      holdSendFrame: (payload) => {
        if (payload.type !== "turn_cancelled" || releaseTurnCancelled) {
          return null;
        }
        return new Promise<void>((resolve) => {
          releaseTurnCancelled = resolve;
        });
      },
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => callbacks !== undefined);

    // Barge in while thinking; teardown blocks on the held turn_cancelled, so
    // the turn is aborted but not yet finalized.
    await session.handleBinaryAudio(SUSTAINED_LOUD_CHUNK);
    await waitFor(() => releaseTurnCancelled !== undefined);

    // A first assistant_text_delta lands in that window — fenced on the abort
    // signal, it must not be forwarded to the client.
    callbacks?.assistant_text_delta?.(makeTextDelta("stale thinking reply"));
    await flushAsyncCallbacks();
    expect(countType(frames, "assistant_text_delta")).toBe(0);

    releaseTurnCancelled?.();
    await waitFor(() =>
      frames.some((frame) => frame.type === "turn_cancelled"),
    );
    expect(countType(frames, "assistant_text_delta")).toBe(0);
  });

  test("a queued assistant_text_delta is dropped at send time once a thinking barge-in aborts", async () => {
    let callbacks: VoiceTurnCallbacks | undefined;
    const abort = mock();
    const startVoiceTurn = mock(async (options: VoiceTurnOptions) => {
      callbacks ??= options.callbacks;
      return { turnId: "bridge-turn", abort };
    });
    let releaseFirstDelta: (() => void) | undefined;
    // No TTS streamer: the turn emits text but never leaves the pre-TTS phase.
    const { frames, session } = createHarness({
      finals: ["first question", "second question"],
      startVoiceTurn,
      streamTtsAudio: null,
      // Hold the first assistant_text_delta's transport write so the second
      // one sits queued behind it (a backed-up outbound queue).
      holdSendFrame: (payload) => {
        if (
          payload.type !== "assistant_text_delta" ||
          releaseFirstDelta !== undefined
        ) {
          return null;
        }
        return new Promise<void>((resolve) => {
          releaseFirstDelta = resolve;
        });
      },
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => callbacks !== undefined);

    // First delta passes shouldSend, then blocks in the transport; the second
    // is enqueued behind it and has not yet been send-time checked.
    callbacks?.assistant_text_delta?.(makeTextDelta("early reply"));
    await waitFor(() => releaseFirstDelta !== undefined);
    callbacks?.assistant_text_delta?.(makeTextDelta("leaked tail"));

    // Barge in while both deltas are queued: the turn aborts before the second
    // delta drains.
    await session.handleBinaryAudio(SUSTAINED_LOUD_CHUNK);
    await flushAsyncCallbacks();

    // Release the queue: the first (already-committed) delta writes, but the
    // second must be dropped by the send-time guard — no cancelled-reply text
    // leaks after the abort.
    releaseFirstDelta?.();
    await waitFor(() =>
      frames.some((frame) => frame.type === "turn_cancelled"),
    );
    expect(countType(frames, "assistant_text_delta")).toBe(1);
    expect(
      frames.some(
        (frame) =>
          frame.type === "assistant_text_delta" && frame.text === "leaked tail",
      ),
    ).toBe(false);
  });

  test("a thinking barge-in that rejects the pending turn start emits no error frame", async () => {
    // startVoiceTurn hangs like a real turn waiting for the conversation lock
    // and rejects when the turn's signal aborts (the waitForIdle behavior), so
    // the turn is still "thinking" with no handle when barge-in hits.
    const startVoiceTurn: LiveVoiceTurnStarter = async (options) => {
      await new Promise<void>((_resolve, reject) => {
        const fail = () =>
          reject(new Error("turn aborted while waiting for the lock"));
        if (options.signal?.aborted) {
          fail();
          return;
        }
        options.signal?.addEventListener("abort", fail, { once: true });
      });
      return { turnId: "bridge-turn", abort: mock() };
    };
    let releaseTurnCancelled: (() => void) | undefined;
    const { frames, session } = createHarness({
      finals: ["first question", "second question"],
      startVoiceTurn,
      holdSendFrame: (payload) => {
        if (payload.type !== "turn_cancelled" || releaseTurnCancelled) {
          return null;
        }
        return new Promise<void>((resolve) => {
          releaseTurnCancelled = resolve;
        });
      },
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => frames.some((frame) => frame.type === "thinking"));

    // Barge in while the turn's start is still pending on the lock: the abort
    // rejects startVoiceTurn, whose catch must treat the aborted turn as dead
    // rather than surface a stray error frame while teardown is in flight.
    await session.handleBinaryAudio(SUSTAINED_LOUD_CHUNK);
    await waitFor(() => releaseTurnCancelled !== undefined);
    await flushAsyncCallbacks();
    expect(countType(frames, "error")).toBe(0);

    releaseTurnCancelled?.();
    await waitFor(() =>
      frames.some((frame) => frame.type === "turn_cancelled"),
    );
    expect(countType(frames, "error")).toBe(0);
  });

  test("a brief blip while thinking arms the guard but does not cancel", async () => {
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

    // A short blip (well under bargeInMinSpeechMs) while the turn is still
    // "thinking": the sustained-speech guard arms but does not trip, so a
    // cough or noise cannot kill the in-flight agent loop.
    await session.handleBinaryAudio(LOUD_CHUNK);
    await flushAsyncCallbacks();

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
    expect(abort).not.toHaveBeenCalled();
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

  test("idle silence is skipped and a bounded pre-roll flushes on speech onset", async () => {
    const archivedUserAudio: Buffer[] = [];
    const archiveAudio: LiveVoiceSessionAudioArchiver = async (input) => {
      if (input.role === "user") {
        archivedUserAudio.push(Buffer.from(input.audio.dataBase64, "base64"));
      }
      const result: LiveVoiceAudioArchiveResult = {
        type: "warning",
        warning: { code: "archive_failed", message: "not archived in test" },
      };
      return result;
    };
    const { frames, session, transcribers } = createHarness({
      finals: ["hello there"],
      startVoiceTurn: makeAutoCompletingTurnStarter(["Hi."]).startVoiceTurn,
      archiveAudio,
    });

    await session.start();
    const transcriber = transcribers[0];
    for (let index = 0; index < 40; index += 1) {
      await session.handleBinaryAudio(SILENT_CHUNK);
    }

    // An open idle mic never reaches the transcriber or the archive buffer.
    expect(transcriber?.received).toHaveLength(0);
    expect(frameTypes(frames)).toEqual(["ready"]);

    await session.handleBinaryAudio(LOUD_CHUNK);

    // Speech onset flushes the capped pre-roll ahead of the speech chunk.
    const silent = Buffer.from(SILENT_CHUNK);
    const loud = Buffer.from(LOUD_CHUNK);
    expect(transcriber?.received).toHaveLength(26);
    expect(
      transcriber?.received.slice(0, 25).every((chunk) => chunk.equals(silent)),
    ).toBe(true);
    expect(transcriber?.received.at(-1)?.equals(loud)).toBe(true);

    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));
    await waitFor(() => archivedUserAudio.length === 1);
    // Archived user audio covers pre-roll + speech, not the idle stretch.
    expect(archivedUserAudio[0]?.byteLength).toBe(26 * SILENT_CHUNK.byteLength);
  });

  test("an utterance captured during an open turn seeds its metrics marks", async () => {
    let now = 0;
    const turnCallbacks: VoiceTurnCallbacks[] = [];
    const startVoiceTurn: LiveVoiceTurnStarter = async (options) => {
      turnCallbacks.push(options.callbacks ?? {});
      return { turnId: `bridge-turn-${turnCallbacks.length}`, abort: mock() };
    };
    const { frames, session } = createHarness({
      finals: ["first question", "second question"],
      startVoiceTurn,
      emitMetrics: true,
      metricsClock: () => {
        now += 10;
        return now;
      },
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => frames.some((frame) => frame.type === "thinking"));

    // The second utterance runs its full VAD cycle while turn 1 is still
    // thinking, so its early marks land before its metrics turn can open.
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => countType(frames, "utterance_end") === 2);
    await waitFor(() => countType(frames, "stt_final") === 2);

    turnCallbacks[0]?.assistant_text_delta?.(makeTextDelta("First answer."));
    turnCallbacks[0]?.message_complete?.(makeMessageComplete());
    await waitFor(() => turnCallbacks.length === 2);
    turnCallbacks[1]?.assistant_text_delta?.(makeTextDelta("Second answer."));
    turnCallbacks[1]?.message_complete?.(makeMessageComplete());

    await waitFor(() =>
      frames.some(
        (frame) =>
          frame.type === "metrics" &&
          frame.event === "turn_completed" &&
          frame.turnId === "live-turn-2",
      ),
    );
    const completedMetrics = frames.find(
      (frame) =>
        frame.type === "metrics" &&
        frame.event === "turn_completed" &&
        frame.turnId === "live-turn-2",
    );
    if (completedMetrics?.type !== "metrics") {
      throw new Error("Expected a turn_completed metrics frame for turn 2.");
    }

    // sttMs spans the stashed utterance_end → final_transcript marks.
    expect(completedMetrics.sttMs).toBe(10);
    expect(completedMetrics.llmFirstDeltaMs).not.toBeNull();
    expect(completedMetrics.totalMs).toBeGreaterThan(0);

    const snapshot = completedMetrics.metrics as {
      recentTurns: Array<{
        turnId: string;
        timestamps: {
          speechStartAtMs: number | null;
          utteranceEndAtMs: number | null;
        };
      }>;
    };
    const turn = snapshot.recentTurns.find(
      (recent) => recent.turnId === "live-turn-2",
    );
    expect(turn?.timestamps.speechStartAtMs).not.toBeNull();
    expect(turn?.timestamps.utteranceEndAtMs).not.toBeNull();
  });

  test("barge-in racing message_complete cancels the turn and keeps the interrupting utterance", async () => {
    let firstTurnCallbacks: VoiceTurnCallbacks | undefined;
    const abort = mock();
    let turnCalls = 0;
    const startVoiceTurn = mock(async (options: VoiceTurnOptions) => {
      turnCalls += 1;
      if (turnCalls === 1) {
        firstTurnCallbacks = options.callbacks;
        return { turnId: "bridge-turn-1", abort };
      }
      options.callbacks?.assistant_text_delta?.(makeTextDelta("Sure."));
      options.callbacks?.message_complete?.(makeMessageComplete());
      return { turnId: "bridge-turn-2", abort: mock() };
    });
    const streamTtsAudio = mock(async (options: LiveVoiceTtsOptions) => {
      options.onAudioChunk(makeTtsChunk(`audio:${options.text}`));
      return makeTtsResult(options.text);
    });
    const { frames, session } = createHarness({
      // Neutralize the echo-adaptive gate (threshold pinned to the 800
      // floor, warm-up over after one chunk) — this test is about barge-in
      // mechanics, not echo suppression.
      echoBargeInMargin: 0.001,
      echoEmaHalfLifeMs: 4,
      finals: ["what's the weather", "actually never mind"],
      startVoiceTurn,
      streamTtsAudio,
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => frames.some((frame) => frame.type === "thinking"));

    firstTurnCallbacks?.assistant_text_delta?.(
      makeTextDelta("It is sunny today."),
    );
    await waitFor(() => frames.some((frame) => frame.type === "tts_audio"));

    // Age the echo window past its (pinned-tiny) warm-up with a silent
    // chunk, so the barge-in below trips synchronously inside
    // handleBinaryAudio and can race the queued completion.
    await session.handleBinaryAudio(SILENT_CHUNK);

    // The LLM finishes just as the user barges in: message_complete queues
    // the completion continuation and the abort fires before it runs.
    firstTurnCallbacks?.message_complete?.(makeMessageComplete());
    await session.handleBinaryAudio(SUSTAINED_LOUD_CHUNK);
    await waitFor(() =>
      frames.some((frame) => frame.type === "turn_cancelled"),
    );

    // The cancelled turn never completes: no tts_done for it.
    expect(
      frames.some(
        (frame) => frame.type === "tts_done" && frame.turnId === "live-turn-1",
      ),
    ).toBe(false);
    expect(
      frames.find((frame) => frame.type === "turn_cancelled"),
    ).toMatchObject({ turnId: "live-turn-1" });

    // The interrupting utterance survives and drives the next turn.
    await waitFor(() => turnCalls === 2);
    expect(startVoiceTurn.mock.calls[1]?.[0]).toMatchObject({
      content: "actually never mind",
    });
    await waitFor(() =>
      frames.some(
        (frame) => frame.type === "tts_done" && frame.turnId === "live-turn-2",
      ),
    );
    expect(abort).toHaveBeenCalledTimes(1);
  });

  test("speech in the release→turn-start window is pre-rolled into the next utterance", async () => {
    const { startVoiceTurn, calls } = makeAutoCompletingTurnStarter([
      "First reply.",
      "Second reply.",
    ]);
    const { frames, session, transcribers } = createHarness({
      finals: ["hello world", "resumed speech"],
      startVoiceTurn,
      // A long silence threshold keeps utterance boundaries under the
      // test's control via ptt_release.
      turnDetectorConfig: { silenceThresholdMs: 5_000 },
      holdStopEventsFor: [0],
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await session.handleClientFrame({ type: "ptt_release" });
    await waitFor(() => transcribers[0]?.stopped === true);

    // Speech resumes while the released utterance still waits for its
    // transcriber to close — the turn cannot start yet.
    await session.handleBinaryAudio(LOUD_CHUNK);
    await session.handleBinaryAudio(LOUD_CHUNK);
    expect(transcribers[0]?.received).toHaveLength(1);

    // The transcriber closes; turn 1 runs and the next utterance arms.
    transcribers[0]?.flushStopEvents();
    await waitFor(() => countType(frames, "tts_done") === 1);
    await waitFor(() => transcribers.length === 2);

    // The next chunk flushes the window speech ahead of itself.
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => (transcribers[1]?.received.length ?? 0) === 3);
    const loud = Buffer.from(LOUD_CHUNK);
    expect(transcribers[1]?.received.every((chunk) => chunk.equals(loud))).toBe(
      true,
    );

    // The resumed speech still becomes a turn.
    await session.handleClientFrame({ type: "ptt_release" });
    await waitFor(() => calls.length === 2);
    expect(calls[1]?.content).toBe("resumed speech");
  });

  test("a full utterance parked in the release→turn-start window flushes and turns without more speech", async () => {
    const { startVoiceTurn, calls } = makeAutoCompletingTurnStarter([
      "First reply.",
      "Second reply.",
    ]);
    const { frames, session, transcribers } = createHarness({
      finals: ["hello world", "quick follow-up"],
      startVoiceTurn,
      holdStopEventsFor: [0],
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => countType(frames, "utterance_end") === 1);
    await waitFor(() => transcribers[0]?.stopped === true);

    // A complete follow-up utterance lands in the release→turn-start window:
    // speech is parked, then the detector's silence timer ends its turn
    // while the released cycle still blocks arming.
    await session.handleBinaryAudio(LOUD_CHUNK);
    await session.handleBinaryAudio(LOUD_CHUNK);
    await new Promise((resolve) => setTimeout(resolve, 60));

    // Ongoing idle-mic silence must not evict the parked speech.
    for (let index = 0; index < 40; index += 1) {
      await session.handleBinaryAudio(SILENT_CHUNK);
    }

    // Turn 1 runs; the parked utterance then flushes and turns on its own —
    // no further speech arrives past this point.
    transcribers[0]?.flushStopEvents();
    await waitFor(
      () => countType(frames, "tts_done") === 2,
      "Timed out waiting for the parked utterance to run its own turn",
    );

    expect(calls.map((options) => options.content)).toEqual([
      "hello world",
      "quick follow-up",
    ]);
    const loud = Buffer.from(LOUD_CHUNK);
    expect(
      transcribers[1]?.received.filter((chunk) => chunk.equals(loud)),
    ).toHaveLength(2);
    expect(
      transcribers[1]?.received
        .slice(0, 2)
        .every((chunk) => chunk.equals(loud)),
    ).toBe(true);

    // The parked utterance's boundary replays after turn 1 completes.
    const types = frameTypes(frames);
    expect(countType(frames, "utterance_end")).toBe(2);
    expect(types.lastIndexOf("utterance_end")).toBeGreaterThan(
      types.indexOf("tts_done"),
    );
  });

  test("an idle transcriber close before speech re-arms capture for the next utterance", async () => {
    const { startVoiceTurn, calls } = makeAutoCompletingTurnStarter(["Hi."]);
    const { frames, session, transcribers } = createHarness({
      finals: ["never spoken", "hello after close"],
      startVoiceTurn,
    });

    await session.start();
    // Idle mic ahead of the close: these chunks sit in the pre-roll ring.
    await session.handleBinaryAudio(SILENT_CHUNK);
    await session.handleBinaryAudio(SILENT_CHUNK);
    await session.handleBinaryAudio(SILENT_CHUNK);

    // Provider idle-timeout closes the armed transcriber before any speech.
    transcribers[0]?.emit({ type: "closed" });
    await flushAsyncCallbacks();
    // Recovery is lazy: nothing re-arms until speech arrives.
    expect(transcribers).toHaveLength(1);

    // The first speech after the close arms a fresh utterance; the pre-roll
    // and the speech chunk all reach the new transcriber.
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => (transcribers[1]?.received.length ?? 0) === 4);

    expect(transcribers[0]?.received).toHaveLength(0);
    const silent = Buffer.from(SILENT_CHUNK);
    const loud = Buffer.from(LOUD_CHUNK);
    expect(
      transcribers[1]?.received
        .slice(0, 3)
        .every((chunk) => chunk.equals(silent)),
    ).toBe(true);
    expect(transcribers[1]?.received.at(-1)?.equals(loud)).toBe(true);

    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.content).toBe("hello after close");
    expect(countType(frames, "utterance_discarded")).toBe(0);
    expect(countType(frames, "error")).toBe(0);
  });

  test("an idle transcriber close during an in-flight turn neither disturbs the turn nor double-arms", async () => {
    let firstTurnCallbacks: VoiceTurnCallbacks | undefined;
    const startVoiceTurn = mock(async (options: VoiceTurnOptions) => {
      if (startVoiceTurn.mock.calls.length === 1) {
        firstTurnCallbacks = options.callbacks;
        return { turnId: "bridge-turn-1", abort: mock() };
      }
      options.callbacks?.assistant_text_delta?.(makeTextDelta("Sure."));
      options.callbacks?.message_complete?.(makeMessageComplete());
      return { turnId: "bridge-turn-2", abort: mock() };
    });
    const { frames, session, transcribers } = createHarness({
      finals: ["first question", "never spoken", "follow-up"],
      startVoiceTurn,
      // A long silence threshold keeps utterance 2 unreleased when its
      // transcriber closes; boundaries are driven by ptt_release.
      turnDetectorConfig: { silenceThresholdMs: 5_000 },
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await session.handleClientFrame({ type: "ptt_release" });
    await waitFor(() => frames.some((frame) => frame.type === "thinking"));

    // Speech during the thinking turn arms utterance 2...
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => (transcribers[1]?.received.length ?? 0) === 1);
    // ...whose transcriber then idle-closes before the utterance ends.
    transcribers[1]?.emit({ type: "closed" });
    await flushAsyncCallbacks();

    // The in-flight turn is untouched and nothing re-armed underneath it.
    expect(transcribers).toHaveLength(2);
    expect(countType(frames, "turn_cancelled")).toBe(0);

    // Turn 1 completes normally; the post-turn re-arm then arms exactly once.
    firstTurnCallbacks?.assistant_text_delta?.(makeTextDelta("Answer one."));
    firstTurnCallbacks?.message_complete?.(makeMessageComplete());
    await waitFor(() =>
      frames.some(
        (frame) => frame.type === "tts_done" && frame.turnId === "live-turn-1",
      ),
    );
    await waitFor(() => transcribers.length === 3);
    await flushAsyncCallbacks();
    expect(transcribers).toHaveLength(3);
    expect(countType(frames, "turn_cancelled")).toBe(0);
    expect(countType(frames, "utterance_discarded")).toBe(0);
    expect(countType(frames, "error")).toBe(0);

    // The recovered capture path still runs a full follow-up turn.
    await session.handleBinaryAudio(LOUD_CHUNK);
    await session.handleClientFrame({ type: "ptt_release" });
    await waitFor(() => startVoiceTurn.mock.calls.length === 2);
    expect(startVoiceTurn.mock.calls[1]?.[0]).toMatchObject({
      content: "follow-up",
    });
  });

  test("utterance_discarded is sent before finalization so a newer utterance's frames follow it", async () => {
    let releaseArchive: (() => void) | undefined;
    const archiveAudio: LiveVoiceSessionAudioArchiver = async (input) => {
      if (input.role === "user" && !releaseArchive) {
        await new Promise<void>((resolve) => {
          releaseArchive = resolve;
        });
      }
      const result: LiveVoiceAudioArchiveResult = {
        type: "warning",
        warning: { code: "archive_failed", message: "held in test" },
      };
      return result;
    };
    const { startVoiceTurn, calls } = makeAutoCompletingTurnStarter(["Sure."]);
    const { frames, session } = createHarness({
      finals: ["   ", "real question"],
      startVoiceTurn,
      archiveAudio,
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    // The discard frame goes out while finalization is still held on the
    // archive hook.
    await waitFor(() =>
      frames.some((frame) => frame.type === "utterance_discarded"),
    );

    // A newer utterance arms and ends during the held finalization; its
    // state must not be blipped by a stale discard afterwards.
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => countType(frames, "utterance_end") === 2);
    releaseArchive?.();
    await waitFor(() => calls.length === 1);

    expect(countType(frames, "utterance_discarded")).toBe(1);
    const types = frameTypes(frames);
    expect(types.indexOf("utterance_discarded")).toBeLessThan(
      types.lastIndexOf("utterance_end"),
    );
    expect(calls[0]?.content).toBe("real question");
  });

  test("an empty VAD utterance emits utterance_discarded", async () => {
    const startVoiceTurn = mock(async () => ({
      turnId: "bridge-turn",
      abort: mock(),
    }));
    const { frames, session } = createHarness({
      finals: ["   "],
      startVoiceTurn,
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() =>
      frames.some((frame) => frame.type === "utterance_discarded"),
    );

    expect(startVoiceTurn).not.toHaveBeenCalled();
    const types = frameTypes(frames);
    expect(types.indexOf("utterance_end")).toBeLessThan(
      types.indexOf("utterance_discarded"),
    );
  });

  test("manual mode does not emit utterance_discarded for an empty transcript", async () => {
    const startVoiceTurn = mock(async () => ({
      turnId: "bridge-turn",
      abort: mock(),
    }));
    const { frames, session } = createHarness({
      startFrame: MANUAL_START_FRAME,
      finals: ["   "],
      startVoiceTurn,
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await session.handleClientFrame({ type: "ptt_release" });
    await flushAsyncCallbacks();

    expect(startVoiceTurn).not.toHaveBeenCalled();
    expect(countType(frames, "utterance_discarded")).toBe(0);
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

describe("LiveVoiceSession VAD threshold configuration", () => {
  // Mean amplitude 1000: speech under the default 800 gate, silence under a
  // raised 2000 gate.
  const BORDERLINE_CHUNK = pcm(1_000);

  test("a configured silenceThresholdMs of 300 ends the turn after ~300 ms of silence", async () => {
    const { frames, session } = createHarness({
      finals: ["timed turn"],
      startVoiceTurn: makeAutoCompletingTurnStarter(["Done."]).startVoiceTurn,
      turnDetectorConfig: { silenceThresholdMs: 300 },
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() =>
      frames.some((frame) => frame.type === "speech_started"),
    );
    await session.handleBinaryAudio(SILENT_CHUNK);

    // Well before the 300 ms threshold the turn is still open.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(countType(frames, "utterance_end")).toBe(0);

    // The silence timer then ends the turn at ~300 ms after the last speech.
    await waitFor(() => countType(frames, "utterance_end") === 1);
    expect(
      frames.find((frame) => frame.type === "utterance_end"),
    ).toMatchObject({ type: "utterance_end", reason: "silence" });
  });

  test("a session-level speechEnergyThreshold flips a borderline chunk's speech classification", async () => {
    // Under the default 800 gate the borderline chunk is speech.
    const defaultGate = createHarness({});
    await defaultGate.session.start();
    await defaultGate.session.handleBinaryAudio(BORDERLINE_CHUNK);
    await waitFor(() => countType(defaultGate.frames, "speech_started") === 1);

    // Under a raised gate the exact same chunk is silence.
    const raisedGate = createHarness({ speechEnergyThreshold: 2_000 });
    await raisedGate.session.start();
    await raisedGate.session.handleBinaryAudio(BORDERLINE_CHUNK);
    await flushAsyncCallbacks();
    expect(countType(raisedGate.frames, "speech_started")).toBe(0);
  });

  test("with no config set the factory defaults to 800 energy / 1200 ms silence / 30 s max turn / 250 ms barge-in", async () => {
    // The test workspace has no liveVoice config, so the factory reads the
    // schema defaults.
    expect(getConfig().liveVoice.vad).toEqual({
      speechEnergyThreshold: 800,
      silenceThresholdMs: 1200,
      maxTurnDurationMs: 30_000,
      bargeInMinSpeechMs: 250,
      echoBargeInMargin: 1.5,
      echoEmaHalfLifeMs: 400,
    });

    const { frames, session } = createHarness({ viaFactory: true });
    await session.start();

    // Mean amplitude exactly at the default gate (800) is still silence...
    await session.handleBinaryAudio(pcm(800));
    await flushAsyncCallbacks();
    expect(countType(frames, "speech_started")).toBe(0);

    // ...one step above it is speech.
    await session.handleBinaryAudio(pcm(801));
    await waitFor(() => countType(frames, "speech_started") === 1);
  });

  test("the factory threads liveVoice.vad config into the server VAD", async () => {
    const originalRaw = loadRawConfig();
    saveRawConfig({
      ...originalRaw,
      liveVoice: {
        vad: {
          speechEnergyThreshold: 2_000,
          silenceThresholdMs: 100,
          maxTurnDurationMs: 30_000,
        },
      },
    });

    try {
      const { frames, session } = createHarness({
        viaFactory: true,
        finals: ["configured turn"],
        startVoiceTurn: makeAutoCompletingTurnStarter(["Done."]).startVoiceTurn,
      });
      await session.start();

      // Above the code default (800) but below the configured 2000 gate:
      // classified as silence.
      await session.handleBinaryAudio(BORDERLINE_CHUNK);
      await flushAsyncCallbacks();
      expect(countType(frames, "speech_started")).toBe(0);

      // Above the configured gate: speech — and the configured 100 ms
      // silence threshold ends the turn well inside the waitFor budget,
      // where the default 800 ms would time it out.
      await session.handleBinaryAudio(pcm(3_000));
      await waitFor(() => countType(frames, "utterance_end") === 1);
      expect(
        frames.find((frame) => frame.type === "utterance_end"),
      ).toMatchObject({ type: "utterance_end", reason: "silence" });
    } finally {
      saveRawConfig(originalRaw);
    }
  });

  // JARVIS-1284 (in-session gear): a mid-session `update_config` frame retunes
  // the live turn detector's pause, so the "pause before reply" slider in the
  // voice room takes effect without reconnecting.
  test("update_config retunes the live silence threshold mid-session", async () => {
    const { frames, session } = createHarness({
      // Start with a long pause that would time the waitFor out on its own.
      startFrame: { ...VAD_START_FRAME, silenceThresholdMs: 5_000 },
      finals: ["configured turn"],
      startVoiceTurn: makeAutoCompletingTurnStarter(["Done."]).startVoiceTurn,
    });
    await session.start();

    // Retune to a short pause mid-session…
    await session.handleClientFrame({
      type: "update_config",
      silenceThresholdMs: 60,
    });

    // …so this utterance ends ~60 ms after speech, inside the waitFor budget.
    await session.handleBinaryAudio(pcm(3_000));
    await waitFor(() => countType(frames, "utterance_end") === 1);
    expect(
      frames.find((frame) => frame.type === "utterance_end"),
    ).toMatchObject({ type: "utterance_end", reason: "silence" });
  });

  // JARVIS-1284: the per-session start-frame `silenceThresholdMs` wins over the
  // daemon-config/option value, so the client's "pause before reply" setting
  // takes effect.
  test("start-frame silenceThresholdMs overrides the option value", async () => {
    const { frames, session } = createHarness({
      // A short per-session pause on the start frame…
      startFrame: { ...VAD_START_FRAME, silenceThresholdMs: 60 },
      // …beats a long option/config threshold that would otherwise time the
      // waitFor out.
      turnDetectorConfig: { silenceThresholdMs: 5_000 },
      finals: ["configured turn"],
      startVoiceTurn: makeAutoCompletingTurnStarter(["Done."]).startVoiceTurn,
    });
    await session.start();

    // One speech chunk, then silence: the turn ends ~60 ms later (the frame's
    // value), well inside the waitFor budget — the 5 s option would time out.
    await session.handleBinaryAudio(pcm(3_000));
    await waitFor(() => countType(frames, "utterance_end") === 1);
    expect(
      frames.find((frame) => frame.type === "utterance_end"),
    ).toMatchObject({ type: "utterance_end", reason: "silence" });
  });
});

describe("LiveVoiceSession sustained-speech barge-in guard", () => {
  // Boots a session whose first turn is audibly speaking (its tts_audio
  // frame reached the client) — the state the guard protects. Utterance
  // boundaries are driven by ptt_release under a long silence threshold, so
  // detector timers stay out of the guard's audio-duration accounting.
  function createSpeakingTurnHarness(options: {
    bargeInMinSpeechMs: number;
    echoEmaHalfLifeMs?: number;
    echoBargeInMargin?: number;
    finals?: string[];
    startFrame?: LiveVoiceClientStartFrame;
  }) {
    let callbacks: VoiceTurnCallbacks | undefined;
    const abort = mock();
    const startVoiceTurn = mock(async (turnOptions: VoiceTurnOptions) => {
      callbacks ??= turnOptions.callbacks;
      return { turnId: "bridge-turn", abort };
    });
    const streamTtsAudio = mock(async (ttsOptions: LiveVoiceTtsOptions) => {
      ttsOptions.onAudioChunk(makeTtsChunk("assistant audio"));
      return makeTtsResult("assistant audio");
    });
    const harness = createHarness({
      finals: options.finals ?? ["what's the weather", "actually never mind"],
      startVoiceTurn,
      streamTtsAudio,
      bargeInMinSpeechMs: options.bargeInMinSpeechMs,
      echoEmaHalfLifeMs: options.echoEmaHalfLifeMs,
      echoBargeInMargin: options.echoBargeInMargin,
      turnDetectorConfig: { silenceThresholdMs: 5_000 },
      ...(options.startFrame ? { startFrame: options.startFrame } : {}),
    });

    async function speakFirstReply(): Promise<void> {
      await harness.session.start();
      await harness.session.handleBinaryAudio(LOUD_CHUNK);
      await harness.session.handleClientFrame({ type: "ptt_release" });
      await waitFor(() =>
        harness.frames.some((frame) => frame.type === "thinking"),
      );
      callbacks?.assistant_text_delta?.(makeTextDelta("It is sunny today."));
      await waitFor(() =>
        harness.frames.some((frame) => frame.type === "tts_audio"),
      );
    }

    function completeFirstReply(): void {
      callbacks?.message_complete?.(makeMessageComplete());
    }

    return { ...harness, abort, speakFirstReply, completeFirstReply };
  }

  test("speech shorter than the guard leaves the speaking turn untouched", async () => {
    const { frames, session, abort, speakFirstReply, completeFirstReply } =
      createSpeakingTurnHarness({
        bargeInMinSpeechMs: 60,
        finals: ["what's the weather", "   "],
      });
    await speakFirstReply();

    // 30 ms of speech then silence: never reaches the 60 ms guard.
    for (let index = 0; index < 3; index += 1) {
      await session.handleBinaryAudio(LOUD_CHUNK);
    }
    await session.handleBinaryAudio(SILENT_CHUNK);
    await flushAsyncCallbacks();

    expect(countType(frames, "turn_cancelled")).toBe(0);
    expect(countType(frames, "speech_started")).toBe(1);
    expect(abort).not.toHaveBeenCalled();

    // The reply completes in full; the noise utterance then dies via the
    // empty-transcript discard path, never having flushed playback.
    await session.handleClientFrame({ type: "ptt_release" });
    completeFirstReply();
    await waitFor(() => countType(frames, "utterance_discarded") === 1);
    expect(
      frames.some(
        (frame) => frame.type === "tts_done" && frame.turnId === "live-turn-1",
      ),
    ).toBe(true);
    expect(countType(frames, "turn_cancelled")).toBe(0);
    expect(countType(frames, "speech_started")).toBe(1);
    expect(abort).not.toHaveBeenCalled();
  });

  test("sustained speech reaching the guard flushes playback and cancels the turn", async () => {
    // Tiny margin + half-life neutralize the echo-adaptive gate (threshold
    // pinned to the 800 floor, warm-up over after one chunk) so this test
    // isolates the guard's accumulation mechanics.
    const { frames, session, abort, speakFirstReply } =
      createSpeakingTurnHarness({
        bargeInMinSpeechMs: 60,
        echoBargeInMargin: 0.001,
        echoEmaHalfLifeMs: 4,
      });
    await speakFirstReply();

    // 50 ms of consecutive speech: one chunk short of the 60 ms guard.
    for (let index = 0; index < 5; index += 1) {
      await session.handleBinaryAudio(LOUD_CHUNK);
    }
    await flushAsyncCallbacks();
    expect(countType(frames, "turn_cancelled")).toBe(0);
    expect(countType(frames, "speech_started")).toBe(1);
    expect(abort).not.toHaveBeenCalled();

    // The 6th consecutive chunk reaches 60 ms: the deferred speech_started
    // flushes playback and the turn cancels.
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() =>
      frames.some((frame) => frame.type === "turn_cancelled"),
    );

    const types = frameTypes(frames);
    expect(countType(frames, "speech_started")).toBe(2);
    expect(types.lastIndexOf("speech_started")).toBeLessThan(
      types.indexOf("turn_cancelled"),
    );
    expect(
      frames.find((frame) => frame.type === "turn_cancelled"),
    ).toMatchObject({ type: "turn_cancelled", turnId: "live-turn-1" });
    await waitFor(() => abort.mock.calls.length === 1);
  });

  test("a non-speech chunk resets the sustained-speech run", async () => {
    // Tiny margin + half-life neutralize the echo-adaptive gate — see above.
    const { frames, session, speakFirstReply } = createSpeakingTurnHarness({
      bargeInMinSpeechMs: 60,
      echoBargeInMargin: 0.001,
      echoEmaHalfLifeMs: 4,
    });
    await speakFirstReply();

    // 50 ms of speech, a silence blip, then 50 ms more: neither run reaches
    // the guard because the blip zeroes the accumulator.
    for (let index = 0; index < 5; index += 1) {
      await session.handleBinaryAudio(LOUD_CHUNK);
    }
    await session.handleBinaryAudio(SILENT_CHUNK);
    for (let index = 0; index < 5; index += 1) {
      await session.handleBinaryAudio(LOUD_CHUNK);
    }
    await flushAsyncCallbacks();
    expect(countType(frames, "turn_cancelled")).toBe(0);

    // A 6th consecutive speech chunk completes a full 60 ms run.
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() =>
      frames.some((frame) => frame.type === "turn_cancelled"),
    );
  });

  test("bargeInMinSpeechMs 0 restores instant barge-in", async () => {
    const { frames, session, abort, speakFirstReply } =
      createSpeakingTurnHarness({
        bargeInMinSpeechMs: 0,
        // Neutralize the echo gate's threshold; its onset warm-up still
        // shields the first in-window chunk via the deferral guard.
        echoBargeInMargin: 0.001,
        echoEmaHalfLifeMs: 4,
      });
    await speakFirstReply();

    // The onset chunk arms the warm-up deferral guard; the next chunk fires
    // with no sustained-run accumulation — the instant contract under the
    // echo gate.
    await session.handleBinaryAudio(LOUD_CHUNK);
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() =>
      frames.some((frame) => frame.type === "turn_cancelled"),
    );

    const types = frameTypes(frames);
    expect(types.lastIndexOf("speech_started")).toBeLessThan(
      types.indexOf("turn_cancelled"),
    );
    await waitFor(() => abort.mock.calls.length === 1);
  });

  test("onset while listening is instant regardless of the guard", async () => {
    // A guard no amount of speech in this test could satisfy: any
    // speech_started at all proves the instant listening path.
    const { frames, session } = createHarness({
      finals: ["hello world"],
      bargeInMinSpeechMs: 10_000,
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => countType(frames, "speech_started") === 1);
  });

  test("the guard also covers the client playback tail after tts_done", async () => {
    let callbacks: VoiceTurnCallbacks | undefined;
    const abort = mock();
    const startVoiceTurn = mock(async (turnOptions: VoiceTurnOptions) => {
      callbacks ??= turnOptions.callbacks;
      return { turnId: "bridge-turn", abort };
    });
    // One full second of PCM: the server clears the turn on tts_done while
    // the client is still audibly draining this tail.
    const longTailChunk: LiveVoiceTtsAudioChunk = {
      type: "tts_audio",
      contentType: "audio/pcm",
      sampleRate: SAMPLE_RATE,
      dataBase64: Buffer.alloc(2 * SAMPLE_RATE).toString("base64"),
    };
    const streamTtsAudio = mock(async (ttsOptions: LiveVoiceTtsOptions) => {
      ttsOptions.onAudioChunk(longTailChunk);
      return makeTtsResult("assistant audio");
    });
    const { frames, session } = createHarness({
      finals: ["what's the weather", "   "],
      startVoiceTurn,
      streamTtsAudio,
      bargeInMinSpeechMs: 60,
      // Tiny margin + half-life neutralize the echo-adaptive gate (threshold
      // pinned to the floor, warm-up over after one chunk) so this test
      // isolates the guard's playback-tail coverage.
      echoBargeInMargin: 0.001,
      echoEmaHalfLifeMs: 4,
      turnDetectorConfig: { silenceThresholdMs: 5_000 },
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await session.handleClientFrame({ type: "ptt_release" });
    await waitFor(() => frames.some((frame) => frame.type === "thinking"));
    callbacks?.assistant_text_delta?.(makeTextDelta("It is sunny today."));
    await waitFor(() => frames.some((frame) => frame.type === "tts_audio"));
    callbacks?.message_complete?.(makeMessageComplete());
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));
    const baseline = countType(frames, "speech_started");

    // A sub-guard noise blip during the drain window must not flush the
    // audible tail.
    for (let index = 0; index < 3; index += 1) {
      await session.handleBinaryAudio(LOUD_CHUNK);
    }
    await session.handleBinaryAudio(SILENT_CHUNK);
    await flushAsyncCallbacks();
    expect(countType(frames, "speech_started")).toBe(baseline);

    // Sustained speech during the drain window trips the guard: the tail
    // flushes (speech_started) — with no turn left to cancel.
    for (let index = 0; index < 6; index += 1) {
      await session.handleBinaryAudio(LOUD_CHUNK);
    }
    await waitFor(() => countType(frames, "speech_started") === baseline + 1);
    expect(countType(frames, "turn_cancelled")).toBe(0);
    expect(abort).not.toHaveBeenCalled();
  });

  // JARVIS-1284: the per-session start-frame `bargeInMinSpeechMs` wins over the
  // daemon-config/option value, so the client's "interrupt sensitivity" setting
  // takes effect.
  test("start-frame bargeInMinSpeechMs overrides the option value (0 → instant barge-in)", async () => {
    const { frames, session, abort, speakFirstReply } =
      createSpeakingTurnHarness({
        // The option (daemon config) would make barge-in effectively impossible…
        bargeInMinSpeechMs: 5_000,
        // …but the start-frame override disables the guard, so barge-in is
        // instant.
        startFrame: { ...VAD_START_FRAME, bargeInMinSpeechMs: 0 },
        // Neutralize the echo gate's threshold; its onset warm-up still
        // shields the first in-window chunk via the deferral guard.
        echoBargeInMargin: 0.001,
        echoEmaHalfLifeMs: 4,
      });
    await speakFirstReply();

    // The chunk after onset barges in with no accumulated run — proving the
    // frame's 0 won over the 5s option.
    await session.handleBinaryAudio(LOUD_CHUNK);
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() =>
      frames.some((frame) => frame.type === "turn_cancelled"),
    );
    expect(
      frames.find((frame) => frame.type === "turn_cancelled"),
    ).toMatchObject({ type: "turn_cancelled", turnId: "live-turn-1" });
    await waitFor(() => abort.mock.calls.length === 1);
  });

  // JARVIS-1296: while assistant audio is playing, a chunk only counts as
  // speech above max(speechEnergyThreshold, echoBargeInMargin × echo EMA), so
  // loud TTS echo leaking through imperfect client echo cancellation cannot
  // self-interrupt the reply, while a user talking over it still can. Tests
  // compress echoEmaHalfLifeMs to 5 ms: the first 10 ms chunk lands in the
  // onset warm-up (half-life/2 = 2.5 ms, quartered attack half-life 1.25 ms,
  // alpha ≈ 0.996), so a 3000 chunk converges the EMA to ≈ 2988 — threshold
  // ≈ 4482 at the default 1.5 margin — and steady echo sits under its own
  // margin from the second chunk on.
  describe("echo-adaptive gate", () => {
    test("steady loud echo during playback never fires speech_started or cancels the turn", async () => {
      const { frames, session, abort, speakFirstReply } =
        createSpeakingTurnHarness({
          bargeInMinSpeechMs: 60,
          echoEmaHalfLifeMs: 5,
        });
      await speakFirstReply();
      const baseline = countType(frames, "speech_started");

      // 400 ms of steady synthetic echo at 3000 — well above the 800 floor
      // and far past the 60 ms guard. The onset chunk folds into the EMA
      // before the guard arms; every later chunk sits under 1.5 × EMA and
      // classifies as silence, so the guard never accumulates.
      for (let index = 0; index < 40; index += 1) {
        await session.handleBinaryAudio(pcm(3_000));
      }
      await flushAsyncCallbacks();

      expect(countType(frames, "speech_started")).toBe(baseline);
      expect(countType(frames, "turn_cancelled")).toBe(0);
      expect(abort).not.toHaveBeenCalled();
    });

    test("abrupt loud echo at playback onset is absorbed by the warm-up, not fired as barge-in", async () => {
      // Cold-start case: steady loud echo from the very first in-window
      // chunk. The onset chunk arms the guard, but the warm-up (half-life/2
      // = 20 ms of audio here) keeps the reference learning at the fast
      // attack rate despite the armed guard, so it overtakes the echo and
      // zeroes the run before the 60 ms guard can trip — no deferred trip
      // ever fires. Mirrors 250 ms guard vs 200 ms warm-up at the 400 ms
      // production half-life.
      const { frames, session, abort, speakFirstReply } =
        createSpeakingTurnHarness({
          bargeInMinSpeechMs: 60,
          echoEmaHalfLifeMs: 40,
        });
      await speakFirstReply();
      const baseline = countType(frames, "speech_started");

      for (let index = 0; index < 30; index += 1) {
        await session.handleBinaryAudio(pcm(3_000));
      }
      await flushAsyncCallbacks();

      expect(countType(frames, "speech_started")).toBe(baseline);
      expect(countType(frames, "turn_cancelled")).toBe(0);
      expect(abort).not.toHaveBeenCalled();
    });

    test("sustained speech above the echo margin still barges in", async () => {
      const { frames, session, abort, speakFirstReply } =
        createSpeakingTurnHarness({
          bargeInMinSpeechMs: 60,
          echoEmaHalfLifeMs: 5,
        });
      await speakFirstReply();

      // Steady echo at 3000 converges the reference (suppressed, as above).
      for (let index = 0; index < 10; index += 1) {
        await session.handleBinaryAudio(pcm(3_000));
      }
      await flushAsyncCallbacks();
      expect(countType(frames, "turn_cancelled")).toBe(0);

      // The user talks over the echo: 6000 clears the ≈ 4482 threshold and
      // sustains past the guard, so the deferred speech_started flushes
      // playback and the turn cancels.
      for (let index = 0; index < 7; index += 1) {
        await session.handleBinaryAudio(pcm(6_000));
      }
      await waitFor(() =>
        frames.some((frame) => frame.type === "turn_cancelled"),
      );
      expect(
        frames.find((frame) => frame.type === "turn_cancelled"),
      ).toMatchObject({ type: "turn_cancelled", turnId: "live-turn-1" });
      await waitFor(() => abort.mock.calls.length === 1);
    });

    test("a thinking (pre-TTS) turn keeps base-threshold barge-in sensitivity", async () => {
      const abort = mock();
      const startVoiceTurn = mock(async () => ({
        turnId: "bridge-turn",
        abort,
      }));
      const { frames, session } = createHarness({
        finals: ["what's the weather", "actually never mind"],
        startVoiceTurn,
        bargeInMinSpeechMs: 60,
        echoEmaHalfLifeMs: 5,
        turnDetectorConfig: { silenceThresholdMs: 5_000 },
      });
      await session.start();
      await session.handleBinaryAudio(LOUD_CHUNK);
      await session.handleClientFrame({ type: "ptt_release" });
      await waitFor(() => frames.some((frame) => frame.type === "thinking"));

      // No assistant audio is playing yet, so the echo gate is inert: 70 ms
      // at 3000 clears the 800 floor and cancels the thinking turn exactly
      // as without the gate (JARVIS-1266 feel unchanged).
      for (let index = 0; index < 7; index += 1) {
        await session.handleBinaryAudio(pcm(3_000));
      }
      await waitFor(() =>
        frames.some((frame) => frame.type === "turn_cancelled"),
      );
      await waitFor(() => abort.mock.calls.length === 1);
    });

    test("the echo reference resets when the window closes", async () => {
      const { frames, session, speakFirstReply, completeFirstReply } =
        createSpeakingTurnHarness({
          bargeInMinSpeechMs: 60,
          echoEmaHalfLifeMs: 5,
          finals: ["what's the weather", "   "],
        });
      await speakFirstReply();
      const baseline = countType(frames, "speech_started");

      // Sub-floor echo at 790 converges the reference without ever arming
      // the guard; amplitude-1000 chunks then sit under 1.5 × EMA (~1180)
      // and stay classified as silence while the reply is playing.
      for (let index = 0; index < 4; index += 1) {
        await session.handleBinaryAudio(pcm(790));
      }
      for (let index = 0; index < 3; index += 1) {
        await session.handleBinaryAudio(pcm(1_000));
      }
      await flushAsyncCallbacks();
      expect(countType(frames, "speech_started")).toBe(baseline);

      // The reply completes and the tiny playback tail drains: the echo
      // window closes and the reference resets.
      completeFirstReply();
      await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

      // The same amplitude-1000 chunk is speech immediately at the 800
      // floor — a stale reference would have swallowed it.
      await session.handleBinaryAudio(pcm(1_000));
      await waitFor(() => countType(frames, "speech_started") === baseline + 1);
    });

    test("a guard trip reached during warm-up is deferred and dissolved by the converging reference", async () => {
      // With the guard (20 ms) SHORTER than the warm-up (half-life/2 =
      // 20 ms of audio), onset echo accumulates to the trip while its chunks
      // are still judged against a warming reference — the per-chunk
      // deferral holds the trip, and the reference overtakes the echo on the
      // next chunk, zeroing the run before it can ever fire.
      const { frames, session, abort, speakFirstReply } =
        createSpeakingTurnHarness({
          bargeInMinSpeechMs: 20,
          echoEmaHalfLifeMs: 40,
        });
      await speakFirstReply();
      const baseline = countType(frames, "speech_started");

      for (let index = 0; index < 30; index += 1) {
        await session.handleBinaryAudio(pcm(3_000));
      }
      await flushAsyncCallbacks();

      expect(countType(frames, "speech_started")).toBe(baseline);
      expect(countType(frames, "turn_cancelled")).toBe(0);
      expect(abort).not.toHaveBeenCalled();
    });

    test("instant barge-in (guard disabled) is still shielded from onset echo, then fires instantly once warm", async () => {
      const { frames, session, abort, speakFirstReply } =
        createSpeakingTurnHarness({
          bargeInMinSpeechMs: 0,
          echoEmaHalfLifeMs: 40,
        });
      await speakFirstReply();

      // Onset echo: the warm-up arms a deferral guard even with
      // bargeInMinSpeechMs 0, and the converging reference absorbs the echo
      // — without this shield the very first chunk would cancel the turn.
      for (let index = 0; index < 30; index += 1) {
        await session.handleBinaryAudio(pcm(3_000));
      }
      await flushAsyncCallbacks();
      expect(countType(frames, "turn_cancelled")).toBe(0);

      // Post-warm-up, instant behavior is back: the first chunk clearing the
      // converged margin fires without accumulating a sustained run.
      await session.handleBinaryAudio(pcm(8_000));
      await waitFor(() =>
        frames.some((frame) => frame.type === "turn_cancelled"),
      );
      await waitFor(() => abort.mock.calls.length === 1);
    });

    test("a live speech run crossing into playback (turn collision) keeps user-first semantics and trips", async () => {
      let callbacks: VoiceTurnCallbacks | undefined;
      const abort = mock();
      const startVoiceTurn = mock(async (turnOptions: VoiceTurnOptions) => {
        callbacks ??= turnOptions.callbacks;
        return { turnId: "bridge-turn", abort };
      });
      const streamTtsAudio = mock(async (ttsOptions: LiveVoiceTtsOptions) => {
        ttsOptions.onAudioChunk(makeTtsChunk("assistant audio"));
        return makeTtsResult("assistant audio");
      });
      const { frames, session } = createHarness({
        finals: ["what's the weather", "actually never mind"],
        startVoiceTurn,
        streamTtsAudio,
        bargeInMinSpeechMs: 60,
        echoEmaHalfLifeMs: 400,
        turnDetectorConfig: { silenceThresholdMs: 5_000 },
      });
      await session.start();
      await session.handleBinaryAudio(LOUD_CHUNK);
      await session.handleClientFrame({ type: "ptt_release" });
      await waitFor(() => frames.some((frame) => frame.type === "thinking"));

      // 30 ms of live speech arms the guard while the turn is thinking...
      for (let index = 0; index < 3; index += 1) {
        await session.handleBinaryAudio(pcm(3_000));
      }
      // ...then TTS starts mid-run. The carried-over guard keeps user-first
      // semantics: frozen reference, base threshold, normal trip at 60 ms —
      // the onset warm-up must not defer or absorb the colliding user.
      callbacks?.assistant_text_delta?.(makeTextDelta("It is sunny today."));
      await waitFor(() => frames.some((frame) => frame.type === "tts_audio"));
      for (let index = 0; index < 4; index += 1) {
        await session.handleBinaryAudio(pcm(3_000));
      }
      await waitFor(() =>
        frames.some((frame) => frame.type === "turn_cancelled"),
      );
      await waitFor(() => abort.mock.calls.length === 1);
    });

    test("a pre-playback noise blip whose run already ended does not block echo learning", async () => {
      let callbacks: VoiceTurnCallbacks | undefined;
      const abort = mock();
      const startVoiceTurn = mock(async (turnOptions: VoiceTurnOptions) => {
        callbacks ??= turnOptions.callbacks;
        return { turnId: "bridge-turn", abort };
      });
      const streamTtsAudio = mock(async (ttsOptions: LiveVoiceTtsOptions) => {
        ttsOptions.onAudioChunk(makeTtsChunk("assistant audio"));
        return makeTtsResult("assistant audio");
      });
      const { frames, session } = createHarness({
        finals: ["what's the weather", "actually never mind"],
        startVoiceTurn,
        streamTtsAudio,
        bargeInMinSpeechMs: 60,
        echoEmaHalfLifeMs: 40,
        turnDetectorConfig: { silenceThresholdMs: 5_000 },
      });
      await session.start();
      await session.handleBinaryAudio(LOUD_CHUNK);
      await session.handleClientFrame({ type: "ptt_release" });
      await waitFor(() => frames.some((frame) => frame.type === "thinking"));

      // A cough during thinking arms the guard, then a silent chunk zeroes
      // its run — the guard object itself stays armed.
      for (let index = 0; index < 2; index += 1) {
        await session.handleBinaryAudio(pcm(3_000));
      }
      await session.handleBinaryAudio(SILENT_CHUNK);
      // TTS starts: the armed-but-settled guard is NOT a turn collision, so
      // the onset warm-up learns the echo and steady loud echo cannot run
      // out the lingering guard against the base threshold.
      callbacks?.assistant_text_delta?.(makeTextDelta("It is sunny today."));
      await waitFor(() => frames.some((frame) => frame.type === "tts_audio"));
      const baseline = countType(frames, "turn_cancelled");
      for (let index = 0; index < 40; index += 1) {
        await session.handleBinaryAudio(pcm(3_000));
      }
      await flushAsyncCallbacks();
      expect(countType(frames, "turn_cancelled")).toBe(baseline);
      expect(abort).not.toHaveBeenCalled();
    });

    test("the echo reference freezes while the barge-in guard is armed", async () => {
      const { frames, session, speakFirstReply } = createSpeakingTurnHarness({
        bargeInMinSpeechMs: 60,
        echoEmaHalfLifeMs: 5,
      });
      await speakFirstReply();

      // The onset chunk arms the guard and seeds the reference during the
      // single-chunk warm-up (fast attack converges EMA to ~2400, threshold
      // ~3600); the warm-up then ends and the reference freezes while the
      // guard stays armed.
      await session.handleBinaryAudio(pcm(2_400));
      // 100 ms at 3300 sits under the frozen ~3600 threshold (silence).
      // Were the EMA still tracking, it would converge to ~3300 and lift
      // the threshold to ~4950 — swallowing the 4000 override below.
      for (let index = 0; index < 10; index += 1) {
        await session.handleBinaryAudio(pcm(3_300));
      }
      await flushAsyncCallbacks();
      expect(countType(frames, "turn_cancelled")).toBe(0);

      // 4000 clears the frozen ~3600 threshold and sustains past the guard —
      // the reference did not move while the guard was armed.
      for (let index = 0; index < 7; index += 1) {
        await session.handleBinaryAudio(pcm(4_000));
      }
      await waitFor(() =>
        frames.some((frame) => frame.type === "turn_cancelled"),
      );
    });
  });
});
