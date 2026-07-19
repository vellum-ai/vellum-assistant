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
import type { LiveVoiceFrontModelConfig } from "../../config/schemas/live-voice.js";
import type {
  StreamingTranscriber,
  SttStreamServerEvent,
} from "../../stt/types.js";
import type {
  VoiceEndpointDecisionInput,
  VoiceFrontDecider,
} from "../front-decision.js";
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
  frontDecider?: VoiceFrontDecider | null;
  frontModelConfig?: Partial<LiveVoiceFrontModelConfig>;
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
  getTurnTeardown?: (conversationId: string) => Promise<void> | undefined;
  detachTeardownSettleTimeoutMs?: number;
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
    ...(options.frontDecider !== undefined
      ? { frontDecider: options.frontDecider }
      : {}),
    ...(options.frontModelConfig
      ? { frontModelConfig: options.frontModelConfig }
      : {}),
    ...(options.spawnBackgroundContinuation
      ? { spawnBackgroundContinuation: options.spawnBackgroundContinuation }
      : {}),
    ...(options.getTurnTeardown
      ? { getTurnTeardown: options.getTurnTeardown }
      : {}),
    ...(options.detachTeardownSettleTimeoutMs !== undefined
      ? { detachTeardownSettleTimeoutMs: options.detachTeardownSettleTimeoutMs }
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
      }): Promise<string> => "",
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
      }): Promise<string> =>
        new Promise<string>((resolve) => {
          args.signal.addEventListener("abort", () => resolve(""), {
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
      }): Promise<string> => "",
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
      }): Promise<string> => "",
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
      }): Promise<string> => "",
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
    await waitFor(() =>
      frames.some((frame) => frame.type === "turn_cancelled"),
    );
    await flushAsyncCallbacks();

    // Nothing to continue: no background subagent is spawned.
    expect(spawnBackgroundContinuation).not.toHaveBeenCalled();
    releaseTts?.();
  });

  test("voice-duplex-handoff on: the continuation fork waits for the interrupted turn's teardown to settle", async () => {
    setCachedOverrides({ "voice-duplex-handoff": true }, { fromGateway: true });
    const spawnBackgroundContinuation = mock(
      async (_args: {
        parentConversationId: string;
        objective: string;
        label: string;
        signal: AbortSignal;
      }): Promise<string> => "",
    );
    // Hold the interrupted turn's teardown open. Its partial (completed tool
    // calls) is only in forked history once the teardown settles, so the fork
    // must not spawn before then.
    let resolveTeardown: (() => void) | undefined;
    const teardown = new Promise<void>((resolve) => {
      resolveTeardown = resolve;
    });
    const getTurnTeardown = mock((_conversationId: string) => teardown);
    const streamTtsAudio = mock(async (options: LiveVoiceTtsOptions) => {
      options.onAudioChunk(makeTtsChunk("assistant audio"));
      return makeTtsResult("assistant audio");
    });
    const { frames, session } = createHarness({
      finals: ["first question", "second question"],
      streamTtsAudio,
      spawnBackgroundContinuation,
      getTurnTeardown,
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => frames.some((frame) => frame.type === "thinking"));

    // Barge in during thinking; the detach captures the teardown promise
    // synchronously but blocks the fork on it.
    await session.handleBinaryAudio(SUSTAINED_LOUD_CHUNK);
    await waitFor(() =>
      frames.some((frame) => frame.type === "turn_cancelled"),
    );
    await flushAsyncCallbacks();
    // Teardown still pending -> no fork yet.
    expect(getTurnTeardown).toHaveBeenCalledWith("conversation-123");
    expect(spawnBackgroundContinuation).not.toHaveBeenCalled();

    // Teardown settles -> the fork proceeds.
    resolveTeardown?.();
    await waitFor(() => spawnBackgroundContinuation.mock.calls.length === 1);
  });

  test("voice-duplex-handoff on: the continuation is skipped when the teardown wait times out", async () => {
    setCachedOverrides({ "voice-duplex-handoff": true }, { fromGateway: true });
    const spawnBackgroundContinuation = mock(
      async (_args: {
        parentConversationId: string;
        objective: string;
        label: string;
        signal: AbortSignal;
      }): Promise<string> => "",
    );
    // A teardown that never settles: the bounded wait times out, and the fork
    // must be skipped rather than snapshot history that may still be missing the
    // interrupted turn's completed tool calls.
    const getTurnTeardown = mock(
      (_conversationId: string) => new Promise<void>(() => {}),
    );
    const streamTtsAudio = mock(async (options: LiveVoiceTtsOptions) => {
      options.onAudioChunk(makeTtsChunk("assistant audio"));
      return makeTtsResult("assistant audio");
    });
    const { frames, session } = createHarness({
      finals: ["first question", "second question"],
      streamTtsAudio,
      spawnBackgroundContinuation,
      getTurnTeardown,
      // Tiny timeout so the bounded wait elapses within the test.
      detachTeardownSettleTimeoutMs: 10,
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => frames.some((frame) => frame.type === "thinking"));
    await session.handleBinaryAudio(SUSTAINED_LOUD_CHUNK);
    await waitFor(() =>
      frames.some((frame) => frame.type === "turn_cancelled"),
    );
    // Wait comfortably past the bounded teardown timeout, then confirm the
    // detach fell through without forking.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(spawnBackgroundContinuation).not.toHaveBeenCalled();
  });

  test("voice-duplex-handoff on: a client interrupt during the teardown wait skips the continuation", async () => {
    setCachedOverrides({ "voice-duplex-handoff": true }, { fromGateway: true });
    const spawnBackgroundContinuation = mock(
      async (_args: {
        parentConversationId: string;
        objective: string;
        label: string;
        signal: AbortSignal;
      }): Promise<string> => "",
    );
    // Never resolves: the detach is parked in the teardown wait until the stop
    // aborts it.
    let resolveTeardown: (() => void) | undefined;
    const teardown = new Promise<void>((resolve) => {
      resolveTeardown = resolve;
    });
    const getTurnTeardown = mock((_conversationId: string) => teardown);
    const streamTtsAudio = mock(async (options: LiveVoiceTtsOptions) => {
      options.onAudioChunk(makeTtsChunk("assistant audio"));
      return makeTtsResult("assistant audio");
    });
    const { frames, session } = createHarness({
      finals: ["first question", "second question"],
      streamTtsAudio,
      spawnBackgroundContinuation,
      getTurnTeardown,
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

    // The stop aborts the detach's controller mid-wait; the fork is skipped
    // even once the teardown later settles.
    await session.handleClientFrame({ type: "interrupt" });
    resolveTeardown?.();
    await flushAsyncCallbacks();
    expect(spawnBackgroundContinuation).not.toHaveBeenCalled();
  });

  // A startVoiceTurn stub that keeps the first turn "thinking" (so a barge-in
  // can land on it) but auto-completes every later turn so the single-turn lock
  // frees for the next utterance. Records each turn's options for inspection.
  function makeResurfaceTurnStarter(): {
    startVoiceTurn: LiveVoiceTurnStarter;
    calls: VoiceTurnOptions[];
  } {
    const calls: VoiceTurnOptions[] = [];
    const startVoiceTurn = mock(async (options: VoiceTurnOptions) => {
      calls.push(options);
      if (options.content !== "first question") {
        options.callbacks?.assistant_text_delta?.(makeTextDelta("ok"));
        options.callbacks?.message_complete?.(makeMessageComplete());
      }
      return { turnId: `bridge-turn-${calls.length}`, abort: mock() };
    });
    return { startVoiceTurn, calls };
  }

  test("voice-duplex-handoff on: a completed continuation's result folds into the next turn's control prompt", async () => {
    setCachedOverrides({ "voice-duplex-handoff": true }, { fromGateway: true });
    // Control the continuation's resolution so we know exactly when its result
    // is stashed relative to the turns we inspect.
    let resolveContinuation: ((result: string) => void) | undefined;
    const spawnBackgroundContinuation = mock(
      (_args: {
        parentConversationId: string;
        objective: string;
        label: string;
        signal: AbortSignal;
      }): Promise<string> =>
        new Promise<string>((resolve) => {
          resolveContinuation = resolve;
        }),
    );
    const { startVoiceTurn, calls } = makeResurfaceTurnStarter();
    const streamTtsAudio = mock(async (options: LiveVoiceTtsOptions) => {
      options.onAudioChunk(makeTtsChunk("assistant audio"));
      return makeTtsResult("assistant audio");
    });
    const { frames, session } = createHarness({
      finals: [
        "first question",
        "second question",
        "third question",
        "fourth question",
      ],
      startVoiceTurn,
      streamTtsAudio,
      spawnBackgroundContinuation,
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => frames.some((frame) => frame.type === "thinking"));

    // Barge in during thinking: turn 1 is cancelled and its continuation spawns
    // (but has not resolved). The barge-in follow-up turn launches meanwhile,
    // carrying the merge note but no continuation result yet.
    await session.handleBinaryAudio(SUSTAINED_LOUD_CHUNK);
    await waitFor(() => resolveContinuation !== undefined);
    await waitFor(() => calls.some((c) => c.content === "second question"));
    const followUp = calls.find((c) => c.content === "second question");
    expect(followUp?.voiceControlPrompt).toContain("interrupted");
    expect(followUp?.voiceControlPrompt).not.toContain("THE_RESULT");

    // The continuation finishes; its answer is stashed for the next turn.
    resolveContinuation?.("THE_RESULT");
    await flushAsyncCallbacks();

    // The next turn the user starts folds the continuation's answer in as
    // context (never spoken on its own).
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => calls.some((c) => c.content === "third question"));
    const resurfaced = calls.find((c) => c.content === "third question");
    expect(resurfaced?.voiceControlPrompt).toContain("THE_RESULT");
    expect(resurfaced?.voiceControlPrompt).toContain("background");

    // Consume-once: a later turn does not repeat it.
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => calls.some((c) => c.content === "fourth question"));
    const later = calls.find((c) => c.content === "fourth question");
    expect(later?.voiceControlPrompt).not.toContain("THE_RESULT");
  });

  test("voice-duplex-handoff on: a client interrupt drops a stashed continuation result", async () => {
    setCachedOverrides({ "voice-duplex-handoff": true }, { fromGateway: true });
    let resolveContinuation: ((result: string) => void) | undefined;
    const spawnBackgroundContinuation = mock(
      (_args: {
        parentConversationId: string;
        objective: string;
        label: string;
        signal: AbortSignal;
      }): Promise<string> =>
        new Promise<string>((resolve) => {
          resolveContinuation = resolve;
        }),
    );
    const { startVoiceTurn, calls } = makeResurfaceTurnStarter();
    const streamTtsAudio = mock(async (options: LiveVoiceTtsOptions) => {
      options.onAudioChunk(makeTtsChunk("assistant audio"));
      return makeTtsResult("assistant audio");
    });
    // The barge-in utterance transcribes to nothing, so no follow-up turn
    // consumes the stash before the interrupt lands.
    const { frames, session } = createHarness({
      finals: ["first question", "", "third question"],
      startVoiceTurn,
      streamTtsAudio,
      spawnBackgroundContinuation,
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => frames.some((frame) => frame.type === "thinking"));
    await session.handleBinaryAudio(SUSTAINED_LOUD_CHUNK);
    await waitFor(() => resolveContinuation !== undefined);

    // The continuation finishes and stashes its result...
    resolveContinuation?.("THE_RESULT");
    await flushAsyncCallbacks();

    // ...but a client interrupt is a hard stop that drops it.
    await session.handleClientFrame({ type: "interrupt" });
    await flushAsyncCallbacks();

    // The next turn carries no resurfaced result.
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => calls.some((c) => c.content === "third question"));
    const later = calls.find((c) => c.content === "third question");
    expect(later?.voiceControlPrompt).not.toContain("THE_RESULT");
  });

  test("voice-duplex-handoff on: an empty continuation result adds no context to the next turn", async () => {
    setCachedOverrides({ "voice-duplex-handoff": true }, { fromGateway: true });
    // Continuation ends with no answer text (e.g. it stopped on a tool call):
    // there is nothing to fold in.
    const spawnBackgroundContinuation = mock(
      async (_args: {
        parentConversationId: string;
        objective: string;
        label: string;
        signal: AbortSignal;
      }): Promise<string> => "",
    );
    const { startVoiceTurn, calls } = makeResurfaceTurnStarter();
    const streamTtsAudio = mock(async (options: LiveVoiceTtsOptions) => {
      options.onAudioChunk(makeTtsChunk("assistant audio"));
      return makeTtsResult("assistant audio");
    });
    const { frames, session } = createHarness({
      finals: ["first question", "second question", "third question"],
      startVoiceTurn,
      streamTtsAudio,
      spawnBackgroundContinuation,
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => frames.some((frame) => frame.type === "thinking"));
    await session.handleBinaryAudio(SUSTAINED_LOUD_CHUNK);
    await waitFor(() => spawnBackgroundContinuation.mock.calls.length === 1);
    // Let the barge-in follow-up turn launch and complete before the next
    // utterance, so the follow-on turn forms cleanly.
    await waitFor(() => calls.some((c) => c.content === "second question"));
    await flushAsyncCallbacks();

    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => calls.some((c) => c.content === "third question"));
    const later = calls.find((c) => c.content === "third question");
    expect(later?.voiceControlPrompt).not.toContain("background you finished");
  });

  test("voice-duplex-handoff on: a newer continuation's result survives an older one finishing later", async () => {
    setCachedOverrides({ "voice-duplex-handoff": true }, { fromGateway: true });
    // Capture each continuation's resolver in spawn (detach) order.
    const resolvers: Array<(result: string) => void> = [];
    const spawnBackgroundContinuation = mock(
      (_args: {
        parentConversationId: string;
        objective: string;
        label: string;
        signal: AbortSignal;
      }): Promise<string> =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    // Keep the first two turns "thinking" so both can be barged; auto-complete
    // the rest so the lock frees for later utterances.
    const calls: VoiceTurnOptions[] = [];
    const startVoiceTurn = mock(async (options: VoiceTurnOptions) => {
      calls.push(options);
      if (
        options.content !== "first question" &&
        options.content !== "second question"
      ) {
        options.callbacks?.assistant_text_delta?.(makeTextDelta("ok"));
        options.callbacks?.message_complete?.(makeMessageComplete());
      }
      return { turnId: `bridge-turn-${calls.length}`, abort: mock() };
    });
    const streamTtsAudio = mock(async (options: LiveVoiceTtsOptions) => {
      options.onAudioChunk(makeTtsChunk("assistant audio"));
      return makeTtsResult("assistant audio");
    });
    const { frames, session } = createHarness({
      finals: [
        "first question",
        "second question",
        "third question",
        "fourth question",
      ],
      startVoiceTurn,
      streamTtsAudio,
      spawnBackgroundContinuation,
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => frames.some((frame) => frame.type === "thinking"));

    // Barge #1 detaches the older continuation; its follow-up turn stays thinking
    // so barge #2 can detach the newer continuation.
    await session.handleBinaryAudio(SUSTAINED_LOUD_CHUNK);
    await waitFor(() => calls.some((c) => c.content === "second question"));
    await session.handleBinaryAudio(SUSTAINED_LOUD_CHUNK);
    await waitFor(() => calls.some((c) => c.content === "third question"));
    await waitFor(() => resolvers.length === 2);

    // The newer continuation finishes first, then the older one finishes late.
    // The sequence guard keeps the newer result regardless of completion order.
    resolvers[1]?.("NEWER_RESULT");
    resolvers[0]?.("OLDER_RESULT");
    await flushAsyncCallbacks();

    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => calls.some((c) => c.content === "fourth question"));
    const resurfaced = calls.find((c) => c.content === "fourth question");
    expect(resurfaced?.voiceControlPrompt).toContain("NEWER_RESULT");
    expect(resurfaced?.voiceControlPrompt).not.toContain("OLDER_RESULT");
  });

  test("voice-duplex-handoff on: a rapid second barge-in invalidates a first continuation that finishes after it", async () => {
    setCachedOverrides({ "voice-duplex-handoff": true }, { fromGateway: true });
    const resolvers: Array<(result: string) => void> = [];
    const spawnBackgroundContinuation = mock(
      (_args: {
        parentConversationId: string;
        objective: string;
        label: string;
        signal: AbortSignal;
      }): Promise<string> =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const calls: VoiceTurnOptions[] = [];
    const startVoiceTurn = mock(async (options: VoiceTurnOptions) => {
      calls.push(options);
      if (
        options.content !== "first question" &&
        options.content !== "second question"
      ) {
        options.callbacks?.assistant_text_delta?.(makeTextDelta("ok"));
        options.callbacks?.message_complete?.(makeMessageComplete());
      }
      return { turnId: `bridge-turn-${calls.length}`, abort: mock() };
    });
    const streamTtsAudio = mock(async (options: LiveVoiceTtsOptions) => {
      options.onAudioChunk(makeTtsChunk("assistant audio"));
      return makeTtsResult("assistant audio");
    });
    const { frames, session } = createHarness({
      finals: [
        "first question",
        "second question",
        "third question",
        "fourth question",
      ],
      startVoiceTurn,
      streamTtsAudio,
      spawnBackgroundContinuation,
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => frames.some((frame) => frame.type === "thinking"));
    // Barge #1 detaches continuation A (older); its follow-up turn stays thinking
    // so barge #2 can land on it.
    await session.handleBinaryAudio(SUSTAINED_LOUD_CHUNK);
    await waitFor(() => resolvers.length === 1);
    await waitFor(() => calls.some((c) => c.content === "second question"));
    // Barge #2 is a rapid second interruption: it bumps the sequence
    // synchronously, so A is invalidated even before barge #2's own async detach
    // runs.
    await session.handleBinaryAudio(SUSTAINED_LOUD_CHUNK);
    // A finishes AFTER barge #2 and must be rejected. The newer continuation is
    // left pending so it can't mask the bug by superseding A itself.
    resolvers[0]?.("OLDER_RESULT");
    await flushAsyncCallbacks();

    // A later turn carries no stale older result.
    await waitFor(() => calls.some((c) => c.content === "third question"));
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => calls.some((c) => c.content === "fourth question"));
    const resurfaced = calls.find((c) => c.content === "fourth question");
    expect(resurfaced?.voiceControlPrompt).not.toContain("OLDER_RESULT");
    expect(resurfaced?.voiceControlPrompt).not.toContain(
      "background you finished",
    );

    // Cleanup the still-pending newer continuation.
    await waitFor(() => resolvers.length === 2);
    resolvers[1]?.("");
  });

  test("voice-duplex-handoff on: a new barge-in drops an already-stashed continuation result", async () => {
    setCachedOverrides({ "voice-duplex-handoff": true }, { fromGateway: true });
    const resolvers: Array<(result: string) => void> = [];
    const spawnBackgroundContinuation = mock(
      (_args: {
        parentConversationId: string;
        objective: string;
        label: string;
        signal: AbortSignal;
      }): Promise<string> =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const calls: VoiceTurnOptions[] = [];
    const startVoiceTurn = mock(async (options: VoiceTurnOptions) => {
      calls.push(options);
      if (
        options.content !== "first question" &&
        options.content !== "second question"
      ) {
        options.callbacks?.assistant_text_delta?.(makeTextDelta("ok"));
        options.callbacks?.message_complete?.(makeMessageComplete());
      }
      return { turnId: `bridge-turn-${calls.length}`, abort: mock() };
    });
    const streamTtsAudio = mock(async (options: LiveVoiceTtsOptions) => {
      options.onAudioChunk(makeTtsChunk("assistant audio"));
      return makeTtsResult("assistant audio");
    });
    const { frames, session } = createHarness({
      finals: [
        "first question",
        "second question",
        "third question",
        "fourth question",
      ],
      startVoiceTurn,
      streamTtsAudio,
      spawnBackgroundContinuation,
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => frames.some((frame) => frame.type === "thinking"));

    // Barge #1 detaches continuation A; it finishes and stashes while it is the
    // latest detach.
    await session.handleBinaryAudio(SUSTAINED_LOUD_CHUNK);
    await waitFor(() => calls.some((c) => c.content === "second question"));
    await waitFor(() => resolvers.length === 1);
    resolvers[0]?.("A_RESULT");
    await flushAsyncCallbacks();

    // Barge #2 is a fresh interruption: it must drop A's already-stashed result
    // (and detach the newer continuation).
    await session.handleBinaryAudio(SUSTAINED_LOUD_CHUNK);
    await waitFor(() => calls.some((c) => c.content === "third question"));
    await waitFor(() => resolvers.length === 2);

    // The barge #2 follow-up turn carries no stale A result.
    const followUp = calls.find((c) => c.content === "third question");
    expect(followUp?.voiceControlPrompt).not.toContain("A_RESULT");

    // Cleanup the still-pending newer continuation.
    resolvers[1]?.("");
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
    const { frames, session, abort, speakFirstReply } =
      createSpeakingTurnHarness({ bargeInMinSpeechMs: 60 });
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
    const { frames, session, speakFirstReply } = createSpeakingTurnHarness({
      bargeInMinSpeechMs: 60,
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
      createSpeakingTurnHarness({ bargeInMinSpeechMs: 0 });
    await speakFirstReply();

    // A single 10 ms onset chunk cancels immediately — no accumulation.
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
      });
    await speakFirstReply();

    // A single speech chunk barges in immediately — proving the frame's 0 won.
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() =>
      frames.some((frame) => frame.type === "turn_cancelled"),
    );
    expect(
      frames.find((frame) => frame.type === "turn_cancelled"),
    ).toMatchObject({ type: "turn_cancelled", turnId: "live-turn-1" });
    await waitFor(() => abort.mock.calls.length === 1);
  });
});

// Stub semantic-endpointing decider: scripted hold/release decisions consumed
// in order, with every consulted input captured. Falls back to "release" once
// the script is exhausted, mirroring the real decider's fail-open bias.
function makeFrontDecider(decisions: Array<"hold" | "release">): {
  decider: VoiceFrontDecider;
  calls: VoiceEndpointDecisionInput[];
} {
  const calls: VoiceEndpointDecisionInput[] = [];
  return {
    calls,
    decider: {
      decideEndpoint: async (input) => {
        calls.push(input);
        return { action: decisions[calls.length - 1] ?? "release" };
      },
      generateAckText: async () => null,
    },
  };
}

describe("LiveVoiceSession semantic endpointing", () => {
  afterEach(() => clearCachedOverrides());

  const enableFrontModel = () =>
    setCachedOverrides({ "voice-front-model": true }, { fromGateway: true });

  // Arms the harness session, waits for its transcriber, and seeds a partial
  // so the silence boundary has transcript text for the decider to judge.
  async function startWithPartial(
    session: LiveVoiceSession,
    transcribers: MockStreamingTranscriber[],
    partialText = "hello wor",
  ): Promise<void> {
    await session.start();
    await waitFor(() => transcribers.length === 1);
    // Let the transcriber's start() wiring settle before emitting events.
    await flushAsyncCallbacks();
    transcribers[0]?.emit({ type: "partial", text: partialText });
  }

  test("a held silence boundary sends no utterance_end and replays after the extension", async () => {
    enableFrontModel();
    const { decider, calls } = makeFrontDecider(["hold", "release"]);
    const turnStarter = makeAutoCompletingTurnStarter(["Hi there."]);
    const { frames, session, transcribers } = createHarness({
      finals: ["hello world"],
      startVoiceTurn: turnStarter.startVoiceTurn,
      frontDecider: decider,
      frontModelConfig: { endpointExtensionMs: 30 },
    });

    await startWithPartial(session, transcribers);
    await session.handleBinaryAudio(LOUD_CHUNK);

    // First silence boundary: the decider holds — no utterance_end, no turn.
    await waitFor(() => calls.length === 1);
    expect(calls[0]).toEqual({
      transcriptSoFar: "",
      latestPartial: "hello wor",
      silenceThresholdMs: 40,
      extensionCount: 0,
    });
    expect(countType(frames, "utterance_end")).toBe(0);
    expect(countType(frames, "thinking")).toBe(0);

    // The extension elapses in continued silence: the boundary replays, the
    // decider releases, and the turn launches normally.
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ extensionCount: 1 });
    expect(frameTypes(frames)).toEqual([
      "ready",
      "stt_partial",
      "speech_started",
      "utterance_end",
      "stt_final",
      "thinking",
      "assistant_text_delta",
      "tts_done",
    ]);
    expect(
      frames.find((frame) => frame.type === "utterance_end"),
    ).toMatchObject({ reason: "silence" });
    expect(turnStarter.calls[0]).toMatchObject({ content: "hello world" });
  });

  test("speech resuming during a hold cancels the replay and the utterance keeps accumulating", async () => {
    enableFrontModel();
    const { decider, calls } = makeFrontDecider(["hold", "release"]);
    const turnStarter = makeAutoCompletingTurnStarter(["Okay."]);
    const { frames, session, transcribers } = createHarness({
      finals: ["hello there world"],
      startVoiceTurn: turnStarter.startVoiceTurn,
      frontDecider: decider,
      // Comfortably longer than the resumed speech's own silence boundary,
      // so a leaked (uncancelled) replay would surface as a third decider
      // consult / second utterance_end below.
      frontModelConfig: { endpointExtensionMs: 200 },
    });

    await startWithPartial(session, transcribers, "hello");
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => calls.length === 1);
    expect(countType(frames, "utterance_end")).toBe(0);

    // Speech resumes during the hold; the fresh silence boundary after it —
    // not the cancelled replay timer — drives the next decision.
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => calls.length === 2);
    expect(calls[1]).toMatchObject({ extensionCount: 1 });
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    // Wait out the original extension window: the cancelled replay never
    // re-fires the boundary.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(calls).toHaveLength(2);
    expect(countType(frames, "utterance_end")).toBe(1);
    // Both speech bursts fed the same utterance's transcriber (the second
    // resolves only when the completed turn re-arms), producing one released
    // turn end-to-end.
    expect(transcribers[0]?.received.length).toBeGreaterThanOrEqual(2);
    expect(turnStarter.calls).toHaveLength(1);
    expect(turnStarter.calls[0]).toMatchObject({
      content: "hello there world",
    });
  });

  test("a release decision produces the same frame sequence as the flag-off path", async () => {
    enableFrontModel();
    const { decider, calls } = makeFrontDecider(["release"]);
    const turnStarter = makeAutoCompletingTurnStarter(["Hi there."]);
    const { frames, session, transcribers } = createHarness({
      finals: ["hello world"],
      startVoiceTurn: turnStarter.startVoiceTurn,
      frontDecider: decider,
    });

    await startWithPartial(session, transcribers);
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    expect(calls).toHaveLength(1);
    expect(frameTypes(frames)).toEqual([
      "ready",
      "stt_partial",
      "speech_started",
      "utterance_end",
      "stt_final",
      "thinking",
      "assistant_text_delta",
      "tts_done",
    ]);
    expect(
      frames.find((frame) => frame.type === "utterance_end"),
    ).toMatchObject({ reason: "silence" });
  });

  test("endpointMaxExtensions caps consecutive holds and forces the release", async () => {
    enableFrontModel();
    const { decider, calls } = makeFrontDecider(["hold", "hold", "hold"]);
    const turnStarter = makeAutoCompletingTurnStarter(["Hi there."]);
    const { frames, session, transcribers } = createHarness({
      finals: ["hello world"],
      startVoiceTurn: turnStarter.startVoiceTurn,
      frontDecider: decider,
      frontModelConfig: { endpointExtensionMs: 20, endpointMaxExtensions: 1 },
    });

    await startWithPartial(session, transcribers);
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    // The single allowed hold consumed the decider's one consult; the replay
    // hit the cap and released without asking again.
    expect(calls).toHaveLength(1);
    expect(countType(frames, "utterance_end")).toBe(1);
    expect(turnStarter.calls).toHaveLength(1);
    expect(turnStarter.calls[0]).toMatchObject({ content: "hello world" });
  });

  test("with the voice-front-model flag off the decider is never consulted", async () => {
    const { decider, calls } = makeFrontDecider(["hold"]);
    const turnStarter = makeAutoCompletingTurnStarter(["Hi there."]);
    const { frames, session, transcribers } = createHarness({
      finals: ["hello world"],
      startVoiceTurn: turnStarter.startVoiceTurn,
      frontDecider: decider,
    });

    await startWithPartial(session, transcribers);
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    expect(calls).toHaveLength(0);
    expect(frameTypes(frames)).toEqual([
      "ready",
      "stt_partial",
      "speech_started",
      "utterance_end",
      "stt_final",
      "thinking",
      "assistant_text_delta",
      "tts_done",
    ]);
  });

  test("a max-duration boundary bypasses the decider entirely", async () => {
    enableFrontModel();
    const { decider, calls } = makeFrontDecider(["hold"]);
    const turnStarter = makeAutoCompletingTurnStarter(["Hi there."]);
    const { frames, session, transcribers } = createHarness({
      finals: ["hello world"],
      startVoiceTurn: turnStarter.startVoiceTurn,
      frontDecider: decider,
      // Silence can never fire; the max-duration cap ends the turn instead.
      turnDetectorConfig: { silenceThresholdMs: 10_000, maxTurnDurationMs: 40 },
    });

    await startWithPartial(session, transcribers);
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    expect(calls).toHaveLength(0);
    expect(
      frames.find((frame) => frame.type === "utterance_end"),
    ).toMatchObject({ reason: "max-duration" });
    expect(turnStarter.calls).toHaveLength(1);
  });

  test("a ptt_release forced boundary bypasses the decider and releases immediately", async () => {
    enableFrontModel();
    // A hold-happy decider: if the manual release were routed through it,
    // the boundary would be deferred and the frame sequence below would gain
    // an extension delay (or stall entirely).
    const { decider, calls } = makeFrontDecider(["hold", "hold"]);
    const turnStarter = makeAutoCompletingTurnStarter(["Hi there."]);
    const { frames, session, transcribers } = createHarness({
      finals: ["hello world"],
      startVoiceTurn: turnStarter.startVoiceTurn,
      frontDecider: decider,
      // A genuine silence boundary can never fire during the test; only the
      // client's explicit release ends the turn.
      turnDetectorConfig: { silenceThresholdMs: 10_000 },
    });

    await startWithPartial(session, transcribers);
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() =>
      frames.some((frame) => frame.type === "speech_started"),
    );

    await session.handleClientFrame({ type: "ptt_release" });
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    // The explicit release was never second-guessed: no decider consult, and
    // the boundary produced the normal utterance_end → turn-launch sequence.
    expect(calls).toHaveLength(0);
    expect(frameTypes(frames)).toEqual([
      "ready",
      "stt_partial",
      "speech_started",
      "utterance_end",
      "stt_final",
      "thinking",
      "assistant_text_delta",
      "tts_done",
    ]);
    expect(
      frames.find((frame) => frame.type === "utterance_end"),
    ).toMatchObject({ reason: "silence" });
    expect(turnStarter.calls).toHaveLength(1);
    expect(turnStarter.calls[0]).toMatchObject({ content: "hello world" });
  });

  test("session close during a hold clears the extension timer", async () => {
    enableFrontModel();
    const { decider, calls } = makeFrontDecider(["hold", "hold"]);
    const { frames, session, transcribers } = createHarness({
      finals: ["hello world"],
      frontDecider: decider,
      frontModelConfig: { endpointExtensionMs: 30 },
    });

    await startWithPartial(session, transcribers);
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => calls.length === 1);
    expect(countType(frames, "utterance_end")).toBe(0);

    await session.close("client_end");
    const framesAtClose = frames.length;

    // Well past the extension window: the cleared timer never replays the
    // boundary — no utterance_end, no second decider consult, no new frames.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(calls).toHaveLength(1);
    expect(countType(frames, "utterance_end")).toBe(0);
    expect(frames.length).toBe(framesAtClose);
  });
});
