import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, mock, test } from "bun:test";

import type { TurnDetectorConfig } from "../../calls/media-turn-detector.js";
import type {
  VoiceTurnCallbacks,
  VoiceTurnOptions,
} from "../../calls/voice-session-bridge.js";
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
import { __resetRegistryForTesting } from "../../tools/registry.js";
import { getWorkspaceSkillsDir } from "../../util/platform.js";
import type { LiveVoiceAudioArchiveResult } from "../live-voice-archive.js";
import {
  CONTINUATION_DELIVERY_CONTENT,
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

// The closed-session delivery route writes into the parent conversation, which
// needs a live conversation store. Stub the seam so the assertion is about
// where the answer went, not about conversation plumbing.
//
// `mock.module` is process-global in Bun and leaks into sibling files that run
// in the same process — run this file on its own (`bun test <path>`).
const injectMessageIntoParentMock = mock(
  (_parentConversationId: string, _message: string) => {},
);
mock.module("../../subagent/notify.js", () => ({
  injectMessageIntoParent: injectMessageIntoParentMock,
  notifyParentFromChild: mock(async () => {}),
}));

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

function tonePcm(
  amplitude: number,
  frequencyHz: number,
  sampleCount = 240,
): Uint8Array {
  const buffer = Buffer.alloc(sampleCount * 2);
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = Math.round(
      amplitude * Math.sin((2 * Math.PI * frequencyHz * index) / SAMPLE_RATE),
    );
    buffer.writeInt16LE(sample, index * 2);
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
// A sub-threshold "ducked" chunk. While the assistant is audibly playing, the
// browser's half-duplex echo canceller attenuates the user's near-end voice, so
// the server classifies the post-AEC audio as below the speech-energy gate:
// a barge-in mid-playback arrives as loud runs split by these ducked gaps.
// 10 ms at 24 kHz, mean amplitude well under the 800 threshold.
const DUCKED_CHUNK = pcm(200);

class MockStreamingTranscriber implements StreamingTranscriber {
  readonly providerId = "deepgram" as const;
  readonly boundaryId = "daemon-streaming" as const;
  readonly received: Buffer[] = [];
  stopped = false;
  private onEvent: ((event: SttStreamServerEvent) => void) | null = null;
  private flushed = false;
  // Claimed on the first audio chunk, so the scripted transcript is spent in
  // the order cycles hear speech (see takeScriptedFinal).
  private scriptedFinal: string | null = null;

  constructor(
    private readonly takeScriptedFinal: () => string,
    private readonly holdStopEvents = false,
  ) {}

  async start(onEvent: (event: SttStreamServerEvent) => void): Promise<void> {
    this.onEvent = onEvent;
  }

  sendAudio(chunk: Buffer): void {
    this.scriptedFinal ??= this.takeScriptedFinal();
    this.received.push(Buffer.from(chunk));
  }

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
    if (this.flushed) {
      return;
    }
    this.flushed = true;
    // A stream that was never sent audio has nothing to transcribe, so a real
    // provider closes without a final. Scripting one anyway lets a cycle that
    // arms and tears down in the same breath (a client interrupt racing the
    // post-cancel re-arm) hand the session a transcript it never heard, which
    // launches a turn nothing will ever finalize and wedges the
    // one-turn-at-a-time gate for every later utterance.
    if (this.scriptedFinal !== null) {
      this.onEvent?.({ type: "final", text: this.scriptedFinal });
    }
    this.onEvent?.({ type: "closed" });
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
  echoBargeInMargin?: number;
  echoEmaHalfLifeMs?: number;
  echoDrainSlackMs?: number;
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
  continuationAnnounceSilenceMs?: number;
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
  // Scripted finals are handed out in the order cycles first receive audio,
  // not in the order they arm. Server VAD arms and discards audio-free cycles
  // on wall-clock timers (the trailing-silence timer, the post-cancel re-arm),
  // so how many cycles have armed by a given point depends on how fast the
  // event loop is, while the order the test feeds audio in does not. Keying
  // off audio keeps `finals` reading as "what the user says, in order".
  let scriptedFinalIndex = 0;
  const takeScriptedFinal = (): string => {
    const text =
      finals[scriptedFinalIndex] ?? `utterance ${scriptedFinalIndex + 1}`;
    scriptedFinalIndex += 1;
    return text;
  };
  const transcribers: MockStreamingTranscriber[] = [];
  const resolveTranscriber = mock(async () => {
    const transcriber = new MockStreamingTranscriber(
      takeScriptedFinal,
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
    echoBargeInMargin:
      options.echoBargeInMargin ?? (options.viaFactory ? undefined : 1),
    echoEmaHalfLifeMs: options.echoEmaHalfLifeMs,
    echoDrainSlackMs: options.echoDrainSlackMs,
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
    ...(options.continuationAnnounceSilenceMs !== undefined
      ? {
          continuationAnnounceSilenceMs: options.continuationAnnounceSilenceMs,
        }
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

function makePcmTtsChunk(audio: Uint8Array): LiveVoiceTtsAudioChunk {
  return {
    type: "tts_audio",
    contentType: "audio/pcm",
    sampleRate: SAMPLE_RATE,
    dataBase64: Buffer.from(audio).toString("base64"),
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
  // 5ms timers stretch under CI load, so the budget is wall-clock rather
  // than a poll count. 4s stays under bun's 5s per-test timeout so this
  // message, not bun's, reports a failure.
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

/**
 * Write a skill into the (per-process temp) workspace skills dir so the
 * `skill_load` contention gate resolves it from the real on-disk catalog.
 */
function installSkillFixture(id: string, body: string): void {
  const directory = join(getWorkspaceSkillsDir(), id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "SKILL.md"),
    `---\nname: ${id}\ndescription: Fixture skill for the contention gate\n---\n\n${body}\n`,
  );
}

/**
 * Barge in during thinking so the interrupted turn detaches a continuation,
 * then hand back the follow-up turn's options plus the continuation's abort
 * signal — the two handles every foreground-wins assertion needs. The
 * continuation hangs until its signal aborts, so it is still in flight while
 * the follow-up turn starts tools.
 */
async function startForegroundWinsScenario(): Promise<{
  followUp: VoiceTurnOptions | undefined;
  signal: AbortSignal | undefined;
}> {
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
  const calls: VoiceTurnOptions[] = [];
  const startVoiceTurn = mock(async (options: VoiceTurnOptions) => {
    calls.push(options);
    return { turnId: `bridge-turn-${calls.length}`, abort: mock() };
  });
  const streamTtsAudio = mock(async (options: LiveVoiceTtsOptions) => {
    options.onAudioChunk(makeTtsChunk("assistant audio"));
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
  await waitFor(() => frames.some((frame) => frame.type === "thinking"));
  await session.handleBinaryAudio(SUSTAINED_LOUD_CHUNK);
  await waitFor(() => spawnBackgroundContinuation.mock.calls.length === 1);
  await waitFor(() => calls.some((c) => c.content === "second question"));

  const signal = spawnBackgroundContinuation.mock.calls[0]?.[0]?.signal;
  expect(signal?.aborted).toBe(false);
  return {
    followUp: calls.find((c) => c.content === "second question"),
    signal,
  };
}

describe("LiveVoiceSession server VAD", () => {
  // The foreground-wins classification consults the tool registry's owner map
  // (a tool is only provably read-only when it is the trusted built-in);
  // register the core baseline so built-in names resolve like in the daemon.
  beforeAll(() => __resetRegistryForTesting());

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

  test("a thinking barge-in spawns a background continuation", async () => {
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

  test("a client interrupt aborts an in-flight continuation", async () => {
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

  test("a client interrupt during barge-in cleanup skips the continuation", async () => {
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

  test("no continuation when the model already completed", async () => {
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

  test("the continuation fork waits for the interrupted turn's teardown to settle", async () => {
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

  test("the continuation is skipped when the teardown wait times out", async () => {
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

  test("a client interrupt during the teardown wait skips the continuation", async () => {
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

  // Records every turn's options and completes none of them, so every turn
  // stays "thinking" and a barge-in always lands on a live one.
  function makeNeverCompletingTurnStarter(): {
    startVoiceTurn: LiveVoiceTurnStarter;
    calls: VoiceTurnOptions[];
  } {
    const calls: VoiceTurnOptions[] = [];
    const startVoiceTurn = mock(async (options: VoiceTurnOptions) => {
      calls.push(options);
      return { turnId: `bridge-turn-${calls.length}`, abort: mock() };
    });
    return { startVoiceTurn, calls };
  }

  test("a completed continuation's result folds into the next turn's control prompt", async () => {
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

  test("a client interrupt drops a stashed continuation result", async () => {
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
    //
    // "third question" is repeated because finals are handed out by transcriber
    // creation order, and the session pre-arms a transcriber for the next
    // utterance. The interrupt below can discard that pre-armed one and re-arm,
    // which shifts the final utterance onto the following index — with a
    // 3-entry list it would fall off the end and transcribe to the "utterance
    // N" placeholder, so the wait for "third question" would time out rather
    // than fail on the assertion. Both landing spots carry the same text.
    const { frames, session } = createHarness({
      finals: ["first question", "", "third question", "third question"],
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

  test("an empty continuation result adds no context to the next turn", async () => {
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

  test("a newer continuation's result survives an older one finishing later", async () => {
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

  test("a rapid second barge-in invalidates a first continuation that finishes after it", async () => {
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
    // runs — and A's run itself is ABORTED, so a still-writing older
    // continuation can never overlap the newer full-ability one.
    await session.handleBinaryAudio(SUSTAINED_LOUD_CHUNK);
    await waitFor(
      () =>
        spawnBackgroundContinuation.mock.calls[0]?.[0]?.signal.aborted === true,
    );
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

    // The newer continuation was not collateral damage of superseding A.
    await waitFor(() => resolvers.length === 2);
    expect(spawnBackgroundContinuation.mock.calls[1]?.[0]?.signal.aborted).toBe(
      false,
    );
    // Cleanup the still-pending newer continuation.
    resolvers[1]?.("");
  });

  test("a new barge-in drops an already-stashed continuation result", async () => {
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

  test("a foreground consequential tool start aborts an in-flight continuation", async () => {
    const { followUp, signal } = await startForegroundWinsScenario();

    // The follow-up turn starts a consequential tool: foreground wins the
    // workspace, so the still-running continuation is aborted before the two
    // can race on writes. `remember` is deliberately NOT on the core
    // side-effect name list — the classification must fail closed on any
    // tool that is not provably read-only, not just named writers.
    followUp?.callbacks?.tool_use_start?.("remember", {
      toolUseId: "tool-1",
    });
    expect(signal?.aborted).toBe(true);
  });

  test("a read-only built-in leaves the continuation running; an unclassified tool fails closed", async () => {
    const { followUp, signal } = await startForegroundWinsScenario();

    // A provably read-only built-in cannot contend on the workspace: the
    // continuation survives (this is the topic-change case the handoff
    // exists for).
    followUp?.callbacks?.tool_use_start?.("file_read", { toolUseId: "tool-1" });
    expect(signal?.aborted).toBe(false);

    // web_fetch is a network read: it cannot corrupt local state, so it does
    // not contend even though it is on the core SIDE_EFFECT_TOOLS list (which
    // exists for a permission question, not a contention one). This is the
    // canonical topic-change case — "what's the weather?" over a running
    // build — and it is exactly what the handoff exists to keep alive.
    followUp?.callbacks?.tool_use_start?.("web_fetch", {
      toolUseId: "tool-3",
    });
    expect(signal?.aborted).toBe(false);

    // A tool the registry does not know (e.g. an MCP or plugin tool) is not
    // provably non-contending: fail closed and abort.
    followUp?.callbacks?.tool_use_start?.("calendar_lookup", {
      toolUseId: "tool-4",
    });
    expect(signal?.aborted).toBe(true);
  });

  test("an installed static skill_load leaves the continuation running", async () => {
    installSkillFixture("static-fixture-skill", "Plain instructions.");
    const { followUp, signal } = await startForegroundWinsScenario();

    // Re-entering a skill that is installed locally and renders no inline
    // commands is a pure read — and it is the first call of nearly every
    // barge-in follow-up, so it must not kill the continuation.
    followUp?.callbacks?.tool_use_start?.("skill_load", {
      toolUseId: "tool-1",
      input: { skill: "static-fixture-skill" },
    });
    expect(signal?.aborted).toBe(false);

    // web_fetch is exempt by name regardless of input.
    followUp?.callbacks?.tool_use_start?.("web_fetch", {
      toolUseId: "tool-2",
      input: { url: "https://example.com" },
    });
    expect(signal?.aborted).toBe(false);

    // skill_execute is a dispatcher whose resolved inner tool can mutate.
    followUp?.callbacks?.tool_use_start?.("skill_execute", {
      toolUseId: "tool-3",
      input: { skill: "static-fixture-skill" },
    });
    expect(signal?.aborted).toBe(true);
  });

  test("a skill_load with inline command expansions aborts the continuation", async () => {
    installSkillFixture(
      "dynamic-fixture-skill",
      "Current status: !`git status --short`",
    );
    const { followUp, signal } = await startForegroundWinsScenario();

    // Inline expansions run shell at load time, so this load writes to the
    // host and contends like any other mutator.
    followUp?.callbacks?.tool_use_start?.("skill_load", {
      toolUseId: "tool-1",
      input: { skill: "dynamic-fixture-skill" },
    });
    expect(signal?.aborted).toBe(true);
  });

  test("a skill_load with no input aborts the continuation", async () => {
    const { followUp, signal } = await startForegroundWinsScenario();

    // Without the input there is no way to tell a pure read from an
    // auto-installing load: fail closed.
    followUp?.callbacks?.tool_use_start?.("skill_load", {
      toolUseId: "tool-1",
    });
    expect(signal?.aborted).toBe(true);
  });

  test("a foreground-wins abort keeps an already-stashed continuation result", async () => {
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
    const { startVoiceTurn, calls } = makeNeverCompletingTurnStarter();
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

    // Barge in; the follow-up turn launches, then the continuation finishes
    // and stashes its answer for the NEXT turn while the follow-up still runs.
    await session.handleBinaryAudio(SUSTAINED_LOUD_CHUNK);
    await waitFor(() => resolveContinuation !== undefined);
    await waitFor(() => calls.some((c) => c.content === "second question"));
    resolveContinuation?.("THE_RESULT");
    await flushAsyncCallbacks();

    // The follow-up turn starts writing: the foreground-wins abort fires, but
    // a completed continuation's stashed answer cannot race anything and is
    // kept.
    const followUp = calls.find((c) => c.content === "second question");
    followUp?.callbacks?.tool_use_start?.("file_write", {
      toolUseId: "tool-1",
    });
    followUp?.callbacks?.assistant_text_delta?.(makeTextDelta("ok"));
    followUp?.callbacks?.message_complete?.(makeMessageComplete());
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    // The next turn still folds the stashed answer in as context.
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => calls.some((c) => c.content === "third question"));
    const resurfaced = calls.find((c) => c.content === "third question");
    expect(resurfaced?.voiceControlPrompt).toContain("THE_RESULT");
  });

  // A continuation spawner whose run resolves only when the test says so, so
  // the finished-continuation moment is exact.
  function makeControlledContinuation() {
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
    return {
      spawnBackgroundContinuation,
      finish: (result: string) => resolveContinuation?.(result),
    };
  }

  function makeImmediateTts(): LiveVoiceTtsStreamer {
    return mock(async (options: LiveVoiceTtsOptions) => {
      options.onAudioChunk(makeTtsChunk("assistant audio"));
      return makeTtsResult("assistant audio");
    });
  }

  // ~600 ms of 24 kHz mono PCM in a single chunk, so the client-side playback
  // tail estimate outlives the turn that produced it by a wide margin.
  function makeLongTailTts(): LiveVoiceTtsStreamer {
    const audio = "x".repeat(28_800);
    return mock(async (options: LiveVoiceTtsOptions) => {
      options.onAudioChunk(makeTtsChunk(audio));
      return makeTtsResult(audio);
    });
  }

  function announcementOf(
    calls: VoiceTurnOptions[],
  ): VoiceTurnOptions | undefined {
    return calls.find((c) => c.content === CONTINUATION_DELIVERY_CONTENT);
  }

  function announcementCount(calls: VoiceTurnOptions[]): number {
    return calls.filter((c) => c.content === CONTINUATION_DELIVERY_CONTENT)
      .length;
  }

  test("a continuation finishing on an idle live call is announced", async () => {
    const continuation = makeControlledContinuation();
    const { startVoiceTurn, calls } = makeResurfaceTurnStarter();
    const { frames, session } = createHarness({
      // The barge-in utterance transcribes to nothing, so no follow-up turn
      // runs and the call goes quiet.
      finals: ["first question", ""],
      startVoiceTurn,
      streamTtsAudio: makeImmediateTts(),
      spawnBackgroundContinuation: continuation.spawnBackgroundContinuation,
      continuationAnnounceSilenceMs: 20,
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => frames.some((frame) => frame.type === "thinking"));
    await session.handleBinaryAudio(SUSTAINED_LOUD_CHUNK);
    await waitFor(
      () => continuation.spawnBackgroundContinuation.mock.calls.length === 1,
    );
    await waitFor(() =>
      frames.some((frame) => frame.type === "utterance_discarded"),
    );

    // Nobody is speaking, so the session starts the delivery turn itself.
    continuation.finish("THE_RESULT");
    await waitFor(() => announcementOf(calls) !== undefined);
    const announcement = announcementOf(calls);
    expect(announcement?.voiceControlPrompt).toContain("THE_RESULT");
    expect(announcement?.voiceControlPrompt).toContain("first question");
  });

  test("an announcement persists hidden and is never delivered twice", async () => {
    const continuation = makeControlledContinuation();
    const { startVoiceTurn, calls } = makeResurfaceTurnStarter();
    const { frames, session } = createHarness({
      finals: ["first question", "", "third question"],
      startVoiceTurn,
      streamTtsAudio: makeImmediateTts(),
      spawnBackgroundContinuation: continuation.spawnBackgroundContinuation,
      continuationAnnounceSilenceMs: 20,
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => frames.some((frame) => frame.type === "thinking"));
    await session.handleBinaryAudio(SUSTAINED_LOUD_CHUNK);
    await waitFor(
      () => continuation.spawnBackgroundContinuation.mock.calls.length === 1,
    );
    await waitFor(() =>
      frames.some((frame) => frame.type === "utterance_discarded"),
    );

    continuation.finish("THE_RESULT");
    await waitFor(() => announcementOf(calls) !== undefined);
    const announcement = announcementOf(calls);
    // The turn the user never started persists as an internal instruction, so
    // nothing renders as a user bubble; the answer rides the control prompt.
    expect(announcement?.content).toBe(CONTINUATION_DELIVERY_CONTENT);
    expect(announcement?.hiddenSyntheticPrompt).toBe(true);

    // Announced, so the stash must not repeat it on the user's next turn.
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => calls.some((c) => c.content === "third question"));
    const later = calls.find((c) => c.content === "third question");
    expect(later?.voiceControlPrompt).not.toContain("THE_RESULT");
  });

  test("a user utterance before the silence elapses cancels the announcement", async () => {
    const continuation = makeControlledContinuation();
    const { startVoiceTurn, calls } = makeResurfaceTurnStarter();
    const { frames, session } = createHarness({
      finals: ["first question", "", "third question"],
      startVoiceTurn,
      streamTtsAudio: makeImmediateTts(),
      spawnBackgroundContinuation: continuation.spawnBackgroundContinuation,
      // Long enough that the user always speaks first.
      continuationAnnounceSilenceMs: 5_000,
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => frames.some((frame) => frame.type === "thinking"));
    await session.handleBinaryAudio(SUSTAINED_LOUD_CHUNK);
    await waitFor(
      () => continuation.spawnBackgroundContinuation.mock.calls.length === 1,
    );
    await waitFor(() =>
      frames.some((frame) => frame.type === "utterance_discarded"),
    );

    continuation.finish("THE_RESULT");
    await flushAsyncCallbacks();

    // The user speaks first: their turn delivers the answer through the stash,
    // and the announcement is dropped rather than repeating it after.
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => calls.some((c) => c.content === "third question"));
    const spoken = calls.find((c) => c.content === "third question");
    expect(spoken?.voiceControlPrompt).toContain("THE_RESULT");
    await flushAsyncCallbacks();
    expect(announcementOf(calls)).toBeUndefined();
  });

  test("an active turn at fire time announces after the turn becomes idle", async () => {
    const continuation = makeControlledContinuation();
    const { startVoiceTurn, calls } = makeNeverCompletingTurnStarter();
    const { frames, session } = createHarness({
      // The barge-in utterance transcribes, so a follow-up turn holds the floor
      // for the whole announcement window.
      finals: ["first question", "second question", "third question"],
      startVoiceTurn,
      streamTtsAudio: makeImmediateTts(),
      spawnBackgroundContinuation: continuation.spawnBackgroundContinuation,
      continuationAnnounceSilenceMs: 20,
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => frames.some((frame) => frame.type === "thinking"));
    await session.handleBinaryAudio(SUSTAINED_LOUD_CHUNK);
    await waitFor(
      () => continuation.spawnBackgroundContinuation.mock.calls.length === 1,
    );
    await waitFor(() => calls.some((c) => c.content === "second question"));

    // The continuation finishes while the follow-up turn is still running, so
    // it remains queued instead of speaking over the assistant.
    continuation.finish("THE_RESULT");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(announcementOf(calls)).toBeUndefined();

    // Completing the active turn re-arms the silence window and announces the
    // result without requiring another user turn.
    const followUp = calls.find((c) => c.content === "second question");
    followUp?.callbacks?.assistant_text_delta?.(makeTextDelta("ok"));
    followUp?.callbacks?.message_complete?.(makeMessageComplete());
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));
    await waitFor(() => announcementOf(calls) !== undefined);
    expect(announcementOf(calls)?.voiceControlPrompt).toContain("THE_RESULT");
  });

  test("a client interrupt between finish and fire cancels the announcement", async () => {
    const continuation = makeControlledContinuation();
    const { startVoiceTurn, calls } = makeResurfaceTurnStarter();
    const { frames, session } = createHarness({
      finals: ["first question", ""],
      startVoiceTurn,
      streamTtsAudio: makeImmediateTts(),
      spawnBackgroundContinuation: continuation.spawnBackgroundContinuation,
      continuationAnnounceSilenceMs: 300,
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => frames.some((frame) => frame.type === "thinking"));
    await session.handleBinaryAudio(SUSTAINED_LOUD_CHUNK);
    await waitFor(
      () => continuation.spawnBackgroundContinuation.mock.calls.length === 1,
    );
    await waitFor(() =>
      frames.some((frame) => frame.type === "utterance_discarded"),
    );

    continuation.finish("THE_RESULT");
    await flushAsyncCallbacks();
    await session.handleClientFrame({ type: "interrupt" });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(announcementOf(calls)).toBeUndefined();
  });

  test("closing the session between finish and fire cancels the announcement", async () => {
    const continuation = makeControlledContinuation();
    const { startVoiceTurn, calls } = makeResurfaceTurnStarter();
    const { frames, session } = createHarness({
      finals: ["first question", ""],
      startVoiceTurn,
      streamTtsAudio: makeImmediateTts(),
      spawnBackgroundContinuation: continuation.spawnBackgroundContinuation,
      continuationAnnounceSilenceMs: 300,
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => frames.some((frame) => frame.type === "thinking"));
    await session.handleBinaryAudio(SUSTAINED_LOUD_CHUNK);
    await waitFor(
      () => continuation.spawnBackgroundContinuation.mock.calls.length === 1,
    );
    await waitFor(() =>
      frames.some((frame) => frame.type === "utterance_discarded"),
    );

    continuation.finish("THE_RESULT");
    await flushAsyncCallbacks();
    await session.close("client_end");
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(announcementOf(calls)).toBeUndefined();
  });

  test("a barge-in over an announcement spawns no continuation", async () => {
    const continuation = makeControlledContinuation();
    const { startVoiceTurn, calls } = makeNeverCompletingTurnStarter();
    const { frames, session } = createHarness({
      finals: ["first question", "", "third question"],
      startVoiceTurn,
      streamTtsAudio: makeImmediateTts(),
      spawnBackgroundContinuation: continuation.spawnBackgroundContinuation,
      continuationAnnounceSilenceMs: 20,
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => frames.some((frame) => frame.type === "thinking"));
    await session.handleBinaryAudio(SUSTAINED_LOUD_CHUNK);
    await waitFor(
      () => continuation.spawnBackgroundContinuation.mock.calls.length === 1,
    );
    await waitFor(() =>
      frames.some((frame) => frame.type === "utterance_discarded"),
    );

    continuation.finish("THE_RESULT");
    await waitFor(() => announcementOf(calls) !== undefined);

    // Cutting in over an announcement means the user is answering it, not
    // asking for it to be finished in the background — the skip reason is
    // `announcement_turn` and nothing new is forked.
    await session.handleBinaryAudio(SUSTAINED_LOUD_CHUNK);
    await waitFor(() => countType(frames, "turn_cancelled") === 2);
    await flushAsyncCallbacks();
    expect(continuation.spawnBackgroundContinuation.mock.calls.length).toBe(1);
  });

  test("a barge-in over an announcement returns the answer to the stash", async () => {
    const continuation = makeControlledContinuation();
    const { startVoiceTurn, calls } = makeNeverCompletingTurnStarter();
    const { frames, session } = createHarness({
      finals: ["first question", "", "third question"],
      startVoiceTurn,
      streamTtsAudio: makeImmediateTts(),
      spawnBackgroundContinuation: continuation.spawnBackgroundContinuation,
      continuationAnnounceSilenceMs: 20,
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => frames.some((frame) => frame.type === "thinking"));
    await session.handleBinaryAudio(SUSTAINED_LOUD_CHUNK);
    await waitFor(
      () => continuation.spawnBackgroundContinuation.mock.calls.length === 1,
    );
    await waitFor(() =>
      frames.some((frame) => frame.type === "utterance_discarded"),
    );

    continuation.finish("THE_RESULT");
    await waitFor(() => announcementOf(calls) !== undefined);

    // The user cuts in while the announcement turn is still in flight, so it
    // never delivers. Nothing is forked to replace it (the work is finished),
    // so the stash is the only route left for the answer.
    await session.handleBinaryAudio(SUSTAINED_LOUD_CHUNK);
    await waitFor(() => countType(frames, "turn_cancelled") === 2);

    await waitFor(() => calls.some((c) => c.content === "third question"));
    const later = calls.find((c) => c.content === "third question");
    expect(later?.voiceControlPrompt).toContain("THE_RESULT");
    // One announcement, and no second one racing the real turn: the answer is
    // recoverable, not duplicated.
    await flushAsyncCallbacks();
    expect(announcementCount(calls)).toBe(1);
  });

  test("an announcement turn that cannot start hands the answer back to the stash", async () => {
    const continuation = makeControlledContinuation();
    const calls: VoiceTurnOptions[] = [];
    const startVoiceTurn = mock(async (options: VoiceTurnOptions) => {
      calls.push(options);
      // The announcement turn cannot start — the conversation is busy from
      // another surface. Real user turns still start normally.
      if (options.content === CONTINUATION_DELIVERY_CONTENT) {
        throw new Error("conversation is busy");
      }
      if (options.content !== "first question") {
        options.callbacks?.assistant_text_delta?.(makeTextDelta("ok"));
        options.callbacks?.message_complete?.(makeMessageComplete());
      }
      return { turnId: `bridge-turn-${calls.length}`, abort: mock() };
    });
    const { frames, session } = createHarness({
      finals: ["first question", "", "third question"],
      startVoiceTurn,
      streamTtsAudio: makeImmediateTts(),
      spawnBackgroundContinuation: continuation.spawnBackgroundContinuation,
      continuationAnnounceSilenceMs: 20,
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => frames.some((frame) => frame.type === "thinking"));
    await session.handleBinaryAudio(SUSTAINED_LOUD_CHUNK);
    await waitFor(
      () => continuation.spawnBackgroundContinuation.mock.calls.length === 1,
    );
    await waitFor(() =>
      frames.some((frame) => frame.type === "utterance_discarded"),
    );

    continuation.finish("THE_RESULT");
    await waitFor(() => announcementOf(calls) !== undefined);
    await waitFor(() => frames.some((frame) => frame.type === "error"));
    await flushAsyncCallbacks();
    // The failed attempt is not retried; the stash is the fallback route.
    expect(announcementCount(calls)).toBe(1);

    // Nothing was spoken, so the answer is still there for the user's next turn
    // rather than being dropped with the announcement.
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => calls.some((c) => c.content === "third question"));
    const later = calls.find((c) => c.content === "third question");
    expect(later?.voiceControlPrompt).toContain("THE_RESULT");
  });

  test("an announcement whose launch throws hands the answer back to the stash", async () => {
    const { startVoiceTurn, calls } = makeResurfaceTurnStarter();
    const { session } = createHarness({
      finals: ["stashed question"],
      startVoiceTurn,
      continuationAnnounceSilenceMs: 20,
    });

    await session.start();
    await flushAsyncCallbacks();

    const internals = session as unknown as {
      pendingContinuationResult: string | null;
      pendingAnnouncement: { request: string; answer: string } | null;
      scheduleContinuationAnnouncement: () => void;
      launchAssistantTurn: (
        utterance: unknown,
        content: string,
        opts?: unknown,
      ) => Promise<boolean>;
    };
    // The announcement's launch REJECTS rather than returning false — a frame
    // write failing ahead of the leg's own error handling. The `started ===
    // false` re-stash never runs on that path, so only the catch can save the
    // answer.
    const launch = internals.launchAssistantTurn.bind(session);
    internals.launchAssistantTurn = async (utterance, content, opts) => {
      if (content === CONTINUATION_DELIVERY_CONTENT) {
        throw new Error("thinking frame write failed");
      }
      return launch(utterance, content, opts);
    };
    internals.pendingContinuationResult = "THE_RESULT";
    internals.pendingAnnouncement = {
      request: "the first question",
      answer: "THE_RESULT",
    };
    internals.scheduleContinuationAnnouncement();

    // The attempt runs (the queue empties) and throws.
    await waitFor(() => internals.pendingAnnouncement === null);
    await flushAsyncCallbacks();
    expect(announcementOf(calls)).toBeUndefined();
    expect(internals.pendingContinuationResult).toBe("THE_RESULT");

    // ...so the user's next turn still carries it.
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => calls.some((c) => c.content === "stashed question"));
    expect(
      calls.find((c) => c.content === "stashed question")?.voiceControlPrompt,
    ).toContain("THE_RESULT");
  });

  test("closing the room delivers a queued announcement into the conversation", async () => {
    injectMessageIntoParentMock.mockClear();
    const continuation = makeControlledContinuation();
    const { startVoiceTurn } = makeResurfaceTurnStarter();
    const { frames, session } = createHarness({
      finals: ["first question", ""],
      startVoiceTurn,
      streamTtsAudio: makeImmediateTts(),
      spawnBackgroundContinuation: continuation.spawnBackgroundContinuation,
      // Long enough that the announcement is still queued when the room closes.
      continuationAnnounceSilenceMs: 5_000,
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => frames.some((frame) => frame.type === "thinking"));
    await session.handleBinaryAudio(SUSTAINED_LOUD_CHUNK);
    await waitFor(
      () => continuation.spawnBackgroundContinuation.mock.calls.length === 1,
    );
    await waitFor(() =>
      frames.some((frame) => frame.type === "utterance_discarded"),
    );

    continuation.finish("THE_RESULT");
    await flushAsyncCallbacks();
    expect(injectMessageIntoParentMock).not.toHaveBeenCalled();

    // The user hangs up before the silence elapses. Neither armed route can
    // still run, so the finished answer takes the closed-session route into the
    // thread instead of being dropped.
    await session.close("client_end");
    expect(injectMessageIntoParentMock).toHaveBeenCalledTimes(1);
    const [conversationId, message] =
      injectMessageIntoParentMock.mock.calls[0] ?? [];
    expect(conversationId).toBe("conversation-123");
    expect(message).toContain("THE_RESULT");
    expect(message).toContain("[Background work finished]");
    expect(message).toContain("first question");
  });

  test("closing during an active announcement delivers the result into the conversation", async () => {
    injectMessageIntoParentMock.mockClear();
    const continuation = makeControlledContinuation();
    const { startVoiceTurn, calls } = makeNeverCompletingTurnStarter();
    const { frames, session } = createHarness({
      finals: ["first question", ""],
      startVoiceTurn,
      streamTtsAudio: makeImmediateTts(),
      spawnBackgroundContinuation: continuation.spawnBackgroundContinuation,
      continuationAnnounceSilenceMs: 20,
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => frames.some((frame) => frame.type === "thinking"));
    await session.handleBinaryAudio(SUSTAINED_LOUD_CHUNK);
    await waitFor(
      () => continuation.spawnBackgroundContinuation.mock.calls.length === 1,
    );
    await waitFor(() =>
      frames.some((frame) => frame.type === "utterance_discarded"),
    );

    continuation.finish("THE_RESULT");
    await waitFor(() => announcementOf(calls) !== undefined);
    expect(injectMessageIntoParentMock).not.toHaveBeenCalled();

    await session.close("client_end");
    expect(injectMessageIntoParentMock).toHaveBeenCalledTimes(1);
    const [conversationId, message] =
      injectMessageIntoParentMock.mock.calls[0] ?? [];
    expect(conversationId).toBe("conversation-123");
    expect(message).toContain("THE_RESULT");
    expect(message).toContain("[Background work finished]");
    expect(message).toContain("first question");
  });

  test("a speculatively dispatched turn carries the stashed answer and cancels the announcement", async () => {
    const continuation = makeControlledContinuation();
    const { startVoiceTurn, calls } = makeResurfaceTurnStarter();
    const { frames, session, transcribers } = createHarness({
      finals: ["first question", "", "third question"],
      startVoiceTurn,
      streamTtsAudio: makeImmediateTts(),
      spawnBackgroundContinuation: continuation.spawnBackgroundContinuation,
      // Long enough for the speculative turn below to launch first, short
      // enough that an announcement that survived it would fire inside the
      // test's own wait.
      continuationAnnounceSilenceMs: 250,
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => frames.some((frame) => frame.type === "thinking"));
    await session.handleBinaryAudio(SUSTAINED_LOUD_CHUNK);
    await waitFor(
      () => continuation.spawnBackgroundContinuation.mock.calls.length === 1,
    );
    await waitFor(() =>
      frames.some((frame) => frame.type === "utterance_discarded"),
    );

    // The continuation finishes on an idle call: stash and announcement are
    // both armed for the one answer.
    continuation.finish("THE_RESULT");
    await flushAsyncCallbacks();

    // The user speaks again with a partial already in hand, so the silence
    // boundary dispatches the turn SPECULATIVELY — the default hands-free path
    // (endpointMaxExtensions defaults to 2) rather than the release path.
    await waitFor(() => transcribers.length === 3);
    transcribers[2]?.emit({ type: "partial", text: "third question" });
    await session.handleBinaryAudio(LOUD_CHUNK);

    await waitFor(() => calls.some((c) => c.content === "third question"));
    const speculative = calls.find((c) => c.content === "third question");
    // The verdict rule is the proof this leg was dispatched speculatively.
    expect(speculative?.unifiedVerdict).toBe(true);
    expect(speculative?.voiceControlPrompt).toContain("THE_RESULT");

    // The user's own turn is the delivery, so the queued announcement is
    // cancelled rather than speaking the same answer again afterwards.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(announcementCount(calls)).toBe(0);
  });

  test("a held speculative turn hands the stashed answer back for the replay", async () => {
    const continuation = makeControlledContinuation();
    const calls: VoiceTurnOptions[] = [];
    const discard = mock(async () => {});
    // The first turn stays thinking so the barge-in lands on it. Every
    // speculative leg afterwards answers with the hold token while it is
    // offered one (`unifiedVerdict`), and answers for real on the replay.
    const startVoiceTurn: LiveVoiceTurnStarter = async (options) => {
      calls.push(options);
      const index = calls.length;
      if (options.content !== "first question") {
        const reply = options.unifiedVerdict === true ? "[0]" : "Sure thing.";
        setTimeout(() => {
          options.callbacks?.assistant_text_delta?.(makeTextDelta(reply));
          if (reply !== "[0]") {
            options.callbacks?.message_complete?.(makeMessageComplete());
          }
        }, 0);
      }
      return { turnId: `bridge-turn-${index}`, abort: mock(), discard };
    };
    const { frames, session, transcribers } = createHarness({
      finals: ["first question", "", "third question"],
      startVoiceTurn,
      streamTtsAudio: makeImmediateTts(),
      spawnBackgroundContinuation: continuation.spawnBackgroundContinuation,
      frontModelConfig: { endpointExtensionMs: 30 },
      // The announcement must not fire during the hold window — the replay
      // turn is the delivery this test is about.
      continuationAnnounceSilenceMs: 5_000,
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => frames.some((frame) => frame.type === "thinking"));
    await session.handleBinaryAudio(SUSTAINED_LOUD_CHUNK);
    await waitFor(
      () => continuation.spawnBackgroundContinuation.mock.calls.length === 1,
    );
    await waitFor(() =>
      frames.some((frame) => frame.type === "utterance_discarded"),
    );

    continuation.finish("THE_RESULT");
    await flushAsyncCallbacks();

    await waitFor(() => transcribers.length === 3);
    transcribers[2]?.emit({ type: "partial", text: "third question" });
    await session.handleBinaryAudio(LOUD_CHUNK);

    // The speculative leg holds: it is rolled back, taking nothing with it.
    await waitFor(() => discard.mock.calls.length === 1);

    // The extension replays the boundary and the replay leg answers. It is a
    // different dispatch, so it only carries the answer if the rollback gave
    // it back.
    await waitFor(
      () => calls.filter((c) => c.content === "third question").length === 2,
    );
    const replay = calls.filter((c) => c.content === "third question")[1];
    expect(replay?.unifiedVerdict).toBeUndefined();
    expect(replay?.voiceControlPrompt).toContain("THE_RESULT");
  });

  test("an announcement waits out the client's queued playback", async () => {
    const continuation = makeControlledContinuation();
    const { startVoiceTurn, calls } = makeNeverCompletingTurnStarter();
    const { frames, session } = createHarness({
      finals: ["first question", "second question", "third question"],
      startVoiceTurn,
      streamTtsAudio: makeLongTailTts(),
      spawnBackgroundContinuation: continuation.spawnBackgroundContinuation,
      continuationAnnounceSilenceMs: 200,
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => frames.some((frame) => frame.type === "thinking"));
    await session.handleBinaryAudio(SUSTAINED_LOUD_CHUNK);
    await waitFor(
      () => continuation.spawnBackgroundContinuation.mock.calls.length === 1,
    );
    await waitFor(() => calls.some((c) => c.content === "second question"));

    // The continuation finishes while the follow-up turn still holds the floor.
    continuation.finish("THE_RESULT");
    await flushAsyncCallbacks();

    // That reply completes: the turn is cleared server-side, but the client
    // still has ~600 ms of its audio queued.
    const followUp = calls.find((c) => c.content === "second question");
    followUp?.callbacks?.assistant_text_delta?.(makeTextDelta("ok"));
    followUp?.callbacks?.message_complete?.(makeMessageComplete());
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    // The silence timer elapses mid-tail: the call looks idle but the previous
    // reply is still audible, so the announcement holds.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(announcementOf(calls)).toBeUndefined();

    // Once the queued audio has drained it lands, instead of being dropped for
    // having been blocked.
    await waitFor(() => announcementOf(calls) !== undefined);
    expect(announcementOf(calls)?.voiceControlPrompt).toContain("THE_RESULT");
  });

  test("captured push-to-talk audio with no transcript yet defers the announcement", async () => {
    const { startVoiceTurn, calls } = makeResurfaceTurnStarter();
    const { session } = createHarness({
      startFrame: MANUAL_START_FRAME,
      finals: ["ptt question"],
      startVoiceTurn,
      continuationAnnounceSilenceMs: 20,
    });

    await session.start();
    // Settle the arm so the cycle is streaming: from here audio goes straight
    // to the transcriber and never lands in the pending buffer.
    await flushAsyncCallbacks();

    // The user is holding the button and talking. The transcriber emits
    // nothing until the release, so the cycle has no partial and no final —
    // every transcript-derived idle signal still reads "nobody is speaking".
    await session.handleBinaryAudio(LOUD_CHUNK);

    // A manual session reaches the announcement path only through machinery a
    // server_vad barge-in owns, so the state a finished continuation leaves
    // behind is staged directly: the stashed answer plus its queued
    // announcement.
    const internals = session as unknown as {
      pendingContinuationResult: string | null;
      pendingAnnouncement: { request: string; answer: string } | null;
      scheduleContinuationAnnouncement: () => void;
    };
    internals.pendingContinuationResult = "THE_RESULT";
    internals.pendingAnnouncement = {
      request: "the first question",
      answer: "THE_RESULT",
    };
    internals.scheduleContinuationAnnouncement();

    // The silence timer and the single retry both find the utterance in
    // flight, so the session never speaks over the in-progress utterance.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(announcementOf(calls)).toBeUndefined();

    // ...and the answer is still stashed for the turn the user does start.
    await session.handleClientFrame({ type: "ptt_release" });
    await waitFor(() => calls.some((c) => c.content === "ptt question"));
    expect(
      calls.find((c) => c.content === "ptt question")?.voiceControlPrompt,
    ).toContain("THE_RESULT");
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
    // The first transcriber closes before it is sent any audio, so it never
    // claims a scripted final: the one entry belongs to the cycle that speech
    // actually reaches.
    const { frames, session, transcribers } = createHarness({
      finals: ["hello after close"],
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
      echoDrainSlackMs: 300,
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
    echoDrainSlackMs?: number;
    ttsAudio?: Uint8Array;
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
      ttsOptions.onAudioChunk(
        options.ttsAudio
          ? makePcmTtsChunk(options.ttsAudio)
          : makeTtsChunk("assistant audio"),
      );
      return makeTtsResult("assistant audio");
    });
    const harness = createHarness({
      finals: options.finals ?? ["what's the weather", "actually never mind"],
      startVoiceTurn,
      streamTtsAudio,
      bargeInMinSpeechMs: options.bargeInMinSpeechMs,
      echoEmaHalfLifeMs: options.echoEmaHalfLifeMs ?? 4,
      echoBargeInMargin: options.echoBargeInMargin ?? 1,
      echoDrainSlackMs: options.echoDrainSlackMs ?? 60_000,
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

  test("a brief sub-threshold gap does not reset the sustained-speech run", async () => {
    const { frames, session, abort, speakFirstReply } =
      createSpeakingTurnHarness({ bargeInMinSpeechMs: 60 });
    await speakFirstReply();

    // 50 ms of speech, then one ducked gap: while the assistant is playing, the
    // half-duplex echo canceller attenuates the user's voice, so the server
    // sees a sub-threshold chunk mid-utterance. The gap (10 ms) is far shorter
    // than BARGE_IN_GAP_TOLERANCE_MS, so it must NOT zero the run.
    for (let index = 0; index < 5; index += 1) {
      await session.handleBinaryAudio(LOUD_CHUNK);
    }
    await session.handleBinaryAudio(DUCKED_CHUNK);
    await flushAsyncCallbacks();
    expect(countType(frames, "turn_cancelled")).toBe(0);

    // A single further speech chunk carries the retained 50 ms run across the
    // gap to the 60 ms guard and cancels: the gap left the accumulator intact,
    // so one more 10 ms chunk is enough rather than a fresh 60 ms run.
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() =>
      frames.some((frame) => frame.type === "turn_cancelled"),
    );
    expect(
      frames.find((frame) => frame.type === "turn_cancelled"),
    ).toMatchObject({ type: "turn_cancelled", turnId: "live-turn-1" });
    await waitFor(() => abort.mock.calls.length === 1);
  });

  test("a gap longer than the tolerance resets the sustained-speech run", async () => {
    const { frames, session, abort, speakFirstReply } =
      createSpeakingTurnHarness({ bargeInMinSpeechMs: 60 });
    await speakFirstReply();

    // 50 ms of speech, then a ducked gap longer than BARGE_IN_GAP_TOLERANCE_MS
    // (25 chunks = 250 ms): a real pause rather than a syllable boundary, so the
    // run resets. The harness silence threshold is 5 s, so the detector never
    // ends the utterance here — the reset is the gap-tolerance logic, not
    // utterance end.
    for (let index = 0; index < 5; index += 1) {
      await session.handleBinaryAudio(LOUD_CHUNK);
    }
    for (let index = 0; index < 25; index += 1) {
      await session.handleBinaryAudio(DUCKED_CHUNK);
    }
    // 50 ms more speech: because the run reset, this accumulates from zero and
    // stays under the 60 ms guard — the two stretches do not sum across the long
    // gap into a false barge-in.
    for (let index = 0; index < 5; index += 1) {
      await session.handleBinaryAudio(LOUD_CHUNK);
    }
    await flushAsyncCallbacks();
    expect(countType(frames, "turn_cancelled")).toBe(0);
    expect(abort).not.toHaveBeenCalled();

    // A 6th consecutive speech chunk (with the 5 above) completes a fresh 60 ms
    // run after the reset and cancels normally.
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() =>
      frames.some((frame) => frame.type === "turn_cancelled"),
    );
  });

  test("a gap of exactly the tolerance is tolerated and does not reset the run", async () => {
    const { frames, session, abort, speakFirstReply } =
      createSpeakingTurnHarness({ bargeInMinSpeechMs: 60 });
    await speakFirstReply();

    // 50 ms of speech, then a ducked gap of exactly BARGE_IN_GAP_TOLERANCE_MS
    // (20 chunks = 200 ms). The tolerance is inclusive — the web client batches
    // PCM into 50 ms frames, so a ducked run lands on the boundary exactly — so
    // this gap does not reset the accumulated speech.
    for (let index = 0; index < 5; index += 1) {
      await session.handleBinaryAudio(LOUD_CHUNK);
    }
    for (let index = 0; index < 20; index += 1) {
      await session.handleBinaryAudio(DUCKED_CHUNK);
    }
    // One more speech chunk carries the retained 50 ms run to the 60 ms guard
    // and cancels — proof the exactly-200 ms gap left the accumulator intact.
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() =>
      frames.some((frame) => frame.type === "turn_cancelled"),
    );
    expect(
      frames.find((frame) => frame.type === "turn_cancelled"),
    ).toMatchObject({ type: "turn_cancelled", turnId: "live-turn-1" });
    await waitFor(() => abort.mock.calls.length === 1);
  });

  test("sparse periodic blips separated by boundary gaps do not accumulate into a barge-in", async () => {
    const { frames, session, abort, speakFirstReply } =
      createSpeakingTurnHarness({ bargeInMinSpeechMs: 60 });
    await speakFirstReply();

    // A 10 ms blip every 200 ms models residual echo/noise, not sustained
    // speech: each blip clears the consecutive-gap timer while the boundary gap
    // (20 chunks = 200 ms) escapes the per-gap reset. Enough cycles to reach the
    // 60 ms guard by pure blip-summing (6 blips) plus margin. The duty-cycle
    // ceiling (cumulative tolerated silence > bargeInMinSpeechMs * 4 = 240 ms)
    // resets the run every few cycles, so the blips never sum into a barge-in.
    for (let cycle = 0; cycle < 9; cycle += 1) {
      await session.handleBinaryAudio(LOUD_CHUNK);
      for (let index = 0; index < 20; index += 1) {
        await session.handleBinaryAudio(DUCKED_CHUNK);
      }
    }
    await flushAsyncCallbacks();
    expect(countType(frames, "turn_cancelled")).toBe(0);
    expect(abort).not.toHaveBeenCalled();
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

  describe("echo-adaptive barge-in", () => {
    const playbackEchoChunk = tonePcm(4_700, 200);
    const bargeInSpeechChunk = tonePcm(9_400, 530);
    const playbackReference = tonePcm(4_700, 200, SAMPLE_RATE * 2);

    test("steady loud playback echo does not interrupt the turn", async () => {
      const { frames, session, abort, speakFirstReply } =
        createSpeakingTurnHarness({
          bargeInMinSpeechMs: 60,
          echoBargeInMargin: 1.5,
          echoEmaHalfLifeMs: 40,
          ttsAudio: playbackReference,
        });
      await speakFirstReply();
      const speechStartedBaseline = countType(frames, "speech_started");

      for (let index = 0; index < 40; index += 1) {
        await session.handleBinaryAudio(playbackEchoChunk);
      }
      await flushAsyncCallbacks();

      expect(countType(frames, "speech_started")).toBe(speechStartedBaseline);
      expect(countType(frames, "turn_cancelled")).toBe(0);
      expect(abort).not.toHaveBeenCalled();
    });

    test("speech above the learned echo margin still interrupts", async () => {
      const { frames, session, abort, speakFirstReply } =
        createSpeakingTurnHarness({
          bargeInMinSpeechMs: 60,
          echoBargeInMargin: 1.5,
          echoEmaHalfLifeMs: 400,
          ttsAudio: playbackReference,
        });
      await speakFirstReply();

      for (let index = 0; index < 25; index += 1) {
        await session.handleBinaryAudio(playbackEchoChunk);
      }
      for (let index = 0; index < 8; index += 1) {
        await session.handleBinaryAudio(bargeInSpeechChunk);
      }

      await waitFor(() => countType(frames, "turn_cancelled") === 1);
      await waitFor(() => abort.mock.calls.length === 1);
    });

    test("classified echo resets a partial guard run immediately", async () => {
      const { frames, session, abort, speakFirstReply } =
        createSpeakingTurnHarness({
          bargeInMinSpeechMs: 60,
          echoBargeInMargin: 1.5,
          echoEmaHalfLifeMs: 400,
          ttsAudio: playbackReference,
        });
      await speakFirstReply();

      for (let index = 0; index < 25; index += 1) {
        await session.handleBinaryAudio(playbackEchoChunk);
      }
      for (let index = 0; index < 5; index += 1) {
        await session.handleBinaryAudio(bargeInSpeechChunk);
      }
      await session.handleBinaryAudio(playbackEchoChunk);
      await session.handleBinaryAudio(bargeInSpeechChunk);
      await flushAsyncCallbacks();

      expect(countType(frames, "turn_cancelled")).toBe(0);
      expect(abort).not.toHaveBeenCalled();

      for (let index = 0; index < 5; index += 1) {
        await session.handleBinaryAudio(bargeInSpeechChunk);
      }
      await waitFor(() => countType(frames, "turn_cancelled") === 1);
    });

    test("quiet playback keeps fixed-threshold barge-in sensitivity", async () => {
      const { frames, session, abort, speakFirstReply } =
        createSpeakingTurnHarness({
          bargeInMinSpeechMs: 60,
          echoBargeInMargin: 1.5,
          echoEmaHalfLifeMs: 40,
          ttsAudio: playbackReference,
        });
      await speakFirstReply();

      for (let index = 0; index < 31; index += 1) {
        await session.handleBinaryAudio(pcm(200));
      }
      for (let index = 0; index < 7; index += 1) {
        await session.handleBinaryAudio(bargeInSpeechChunk);
      }

      await waitFor(() => countType(frames, "turn_cancelled") === 1);
      await waitFor(() => abort.mock.calls.length === 1);
    });

    test("playback echo is not forwarded as transcription pre-roll", async () => {
      const { frames, session, transcribers, speakFirstReply } =
        createSpeakingTurnHarness({
          bargeInMinSpeechMs: 60,
          echoBargeInMargin: 1.5,
          echoEmaHalfLifeMs: 40,
          ttsAudio: playbackReference,
        });
      await speakFirstReply();

      const echoChunk = playbackEchoChunk;
      for (let index = 0; index < 5; index += 1) {
        await session.handleBinaryAudio(echoChunk);
      }
      for (let index = 0; index < 7; index += 1) {
        await session.handleBinaryAudio(bargeInSpeechChunk);
      }
      await waitFor(() => countType(frames, "turn_cancelled") === 1);

      const echoBuffer = Buffer.from(echoChunk);
      expect(
        transcribers.some((transcriber) =>
          transcriber.received.some((buffer) => buffer.equals(echoBuffer)),
        ),
      ).toBe(false);
    });

    test("instant barge-in remains protected from onset echo", async () => {
      const { frames, session, abort, speakFirstReply } =
        createSpeakingTurnHarness({
          bargeInMinSpeechMs: 0,
          echoBargeInMargin: 1.5,
          echoEmaHalfLifeMs: 40,
          ttsAudio: playbackReference,
        });
      await speakFirstReply();

      for (let index = 0; index < 30; index += 1) {
        await session.handleBinaryAudio(playbackEchoChunk);
      }
      await flushAsyncCallbacks();
      expect(countType(frames, "turn_cancelled")).toBe(0);

      await session.handleBinaryAudio(bargeInSpeechChunk);
      await waitFor(() => countType(frames, "turn_cancelled") === 1);
      await waitFor(() => abort.mock.calls.length === 1);
    });

    test("echo suppression covers the client playback tail", async () => {
      const { frames, session, abort, speakFirstReply, completeFirstReply } =
        createSpeakingTurnHarness({
          bargeInMinSpeechMs: 60,
          echoBargeInMargin: 1.5,
          echoEmaHalfLifeMs: 40,
          ttsAudio: playbackReference,
        });
      await speakFirstReply();
      completeFirstReply();
      await waitFor(() => frames.some((frame) => frame.type === "tts_done"));
      const speechStartedBaseline = countType(frames, "speech_started");

      for (let index = 0; index < 40; index += 1) {
        await session.handleBinaryAudio(playbackEchoChunk);
      }
      await flushAsyncCallbacks();

      expect(countType(frames, "speech_started")).toBe(speechStartedBaseline);
      expect(countType(frames, "turn_cancelled")).toBe(0);
      expect(abort).not.toHaveBeenCalled();
    });

    test("speech at playback onset cannot seed its own echo threshold", async () => {
      const { frames, session, abort, speakFirstReply, transcribers } =
        createSpeakingTurnHarness({
          bargeInMinSpeechMs: 250,
          echoBargeInMargin: 1.5,
          echoEmaHalfLifeMs: 400,
          ttsAudio: playbackReference,
        });
      await speakFirstReply();

      const onsetSpeech = tonePcm(9_400, 530, 7_200);
      await session.handleBinaryAudio(onsetSpeech);

      await waitFor(() => countType(frames, "turn_cancelled") === 1);
      await waitFor(() => abort.mock.calls.length === 1);
      expect(
        transcribers.some((transcriber) =>
          transcriber.received.some((buffer) =>
            buffer.equals(Buffer.from(onsetSpeech)),
          ),
        ),
      ).toBe(true);
    });

    test("speech already in progress bypasses playback warm-up", async () => {
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
        finals: ["what's the weather", "actually never mind"],
        startVoiceTurn,
        streamTtsAudio,
        bargeInMinSpeechMs: 60,
        echoBargeInMargin: 1.5,
        echoEmaHalfLifeMs: 400,
        echoDrainSlackMs: 60_000,
        turnDetectorConfig: { silenceThresholdMs: 5_000 },
      });

      await session.start();
      await session.handleBinaryAudio(LOUD_CHUNK);
      await session.handleClientFrame({ type: "ptt_release" });
      await waitFor(() => frames.some((frame) => frame.type === "thinking"));
      for (let index = 0; index < 3; index += 1) {
        await session.handleBinaryAudio(pcm(3_000));
      }
      callbacks?.assistant_text_delta?.(makeTextDelta("It is sunny today."));
      await waitFor(() => frames.some((frame) => frame.type === "tts_audio"));
      for (let index = 0; index < 3; index += 1) {
        await session.handleBinaryAudio(pcm(3_000));
      }

      await waitFor(() => countType(frames, "turn_cancelled") === 1);
      await waitFor(() => abort.mock.calls.length === 1);
    });
  });
});

describe("LiveVoiceSession unified front-door endpointing", () => {
  function spokenDeltaText(frames: LiveVoiceServerFrame[]): string {
    return frames
      .filter((frame) => frame.type === "assistant_text_delta")
      .map((frame) => (frame as { text: string }).text)
      .join("");
  }

  // A scriptable speculative starter: per-call delta scripts, with discard
  // tracked so hold-verdict rollback is observable.
  function makeVerdictTurnStarter(scripts: string[][]): {
    startVoiceTurn: LiveVoiceTurnStarter;
    calls: VoiceTurnOptions[];
    discard: ReturnType<typeof mock>;
  } {
    const calls: VoiceTurnOptions[] = [];
    const discard = mock(async () => {});
    const startVoiceTurn: LiveVoiceTurnStarter = async (options) => {
      calls.push(options);
      const script = scripts[calls.length - 1];
      // An empty script models a leg that stays in flight (no verdict, no
      // completion) — a non-empty one streams its deltas then completes.
      if (script && script.length > 0) {
        setTimeout(() => {
          for (const text of script) {
            options.callbacks?.assistant_text_delta?.(makeTextDelta(text));
          }
          options.callbacks?.message_complete?.(makeMessageComplete());
        }, 0);
      }
      return { turnId: `bridge-turn-${calls.length}`, abort: mock(), discard };
    };
    return { startVoiceTurn, calls, discard };
  }

  async function startWithPartial(
    session: LiveVoiceSession,
    transcribers: MockStreamingTranscriber[],
    partialText = "hello wor",
  ): Promise<void> {
    await session.start();
    await waitFor(() => transcribers.length === 1);
    await flushAsyncCallbacks();
    transcribers[0]?.emit({ type: "partial", text: partialText });
  }

  test("a chatty answer commits: verdict leg replaces the decider, frames follow commit order", async () => {
    const starter = makeVerdictTurnStarter([["Hey! Not much."]]);
    const { frames, session, transcribers } = createHarness({
      finals: ["hello world"],
      startVoiceTurn: starter.startVoiceTurn,
    });

    await startWithPartial(session, transcribers);
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    // The leg IS the endpoint decision.
    expect(starter.calls).toHaveLength(1);
    // Dispatched speculatively on the pre-finalize transcript, as the
    // front-door leg with the verdict rule requested.
    expect(starter.calls[0]).toMatchObject({
      content: "hello wor",
      routingLeg: "front-door",
      unifiedVerdict: true,
    });
    // Deferred boundary work lands at commit, before the first spoken delta.
    const types = frameTypes(frames);
    expect(types.indexOf("utterance_end")).toBeGreaterThan(-1);
    expect(types.indexOf("utterance_end")).toBeLessThan(
      types.indexOf("thinking"),
    );
    expect(types.indexOf("thinking")).toBeLessThan(
      types.indexOf("assistant_text_delta"),
    );
    expect(starter.discard).not.toHaveBeenCalled();
  });

  test("a hold verdict discards the leg silently and the extension replays the boundary", async () => {
    const starter = makeVerdictTurnStarter([["[0]"], ["Sure thing."]]);
    const { frames, session, transcribers } = createHarness({
      finals: ["hello world"],
      startVoiceTurn: starter.startVoiceTurn,
      frontModelConfig: { endpointExtensionMs: 30 },
    });

    await startWithPartial(session, transcribers);
    await session.handleBinaryAudio(LOUD_CHUNK);

    // First leg returned the hold token: rollback, no user-visible frames.
    await waitFor(() => starter.discard.mock.calls.length === 1);
    expect(countType(frames, "utterance_end")).toBe(0);
    expect(countType(frames, "thinking")).toBe(0);
    expect(countType(frames, "assistant_text_delta")).toBe(0);

    // The extension elapses in continued silence: the boundary replays, the
    // second speculative leg answers, and the turn commits normally.
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));
    expect(starter.calls).toHaveLength(2);
    expect(countType(frames, "utterance_end")).toBe(1);
    expect(countType(frames, "thinking")).toBe(1);
    expect(spokenDeltaText(frames)).toContain("Sure thing.");
    // The spoken stream never contains the verdict token.
    expect(spokenDeltaText(frames)).not.toContain("[0]");
    // One hold per utterance: the replay leg is not offered the hold verdict
    // again — a second silence means the caller is done.
    expect(starter.calls[0]?.unifiedVerdict).toBe(true);
    expect(starter.calls[1]?.unifiedVerdict).toBeUndefined();
  });

  test("a verdict that misses the deadline commits the turn (fail-open)", async () => {
    // The leg never produces a verdict — a provider TTFT tail. The deadline
    // must commit the turn so the caller gets the thinking frame (and the
    // ack timer arms) instead of unbounded structural silence.
    const starter = makeVerdictTurnStarter([[]]);
    const { frames, session, transcribers } = createHarness({
      finals: ["hello world"],
      startVoiceTurn: starter.startVoiceTurn,
      frontModelConfig: {
        endpointDecisionTimeoutMs: 40,
        endpointExtensionMs: 60_000,
      },
    });

    await startWithPartial(session, transcribers);
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => starter.calls.length === 1);

    await waitFor(() => countType(frames, "thinking") === 1);
    expect(countType(frames, "utterance_end")).toBe(1);
    // Fail-open commits; nothing was discarded or rolled back.
    expect(starter.discard).not.toHaveBeenCalled();
  });

  test("a final that extends the held transcript replays the boundary immediately", async () => {
    const starter = makeVerdictTurnStarter([["[0]"], ["Got it."]]);
    const { frames, session, transcribers } = createHarness({
      finals: ["hello world how are you"],
      startVoiceTurn: starter.startVoiceTurn,
      // Extension far beyond the test window: only the fresh-final path can
      // re-dispatch in time.
      frontModelConfig: { endpointExtensionMs: 60_000 },
    });

    await startWithPartial(session, transcribers);
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => starter.discard.mock.calls.length === 1);

    // The finalized transcript lands mid-extension and extends the partial
    // the hold judged ("hello wor"): the hold was judged on stale text, so
    // the boundary replays now instead of after the extension window.
    transcribers[0]?.emit({ type: "final", text: "hello world how are you" });
    await waitFor(() => starter.calls.length === 2);
    expect(starter.calls[1]?.content).toBe("hello world how are you");
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));
    expect(spokenDeltaText(frames)).toContain("Got it.");
  });

  test("speech resuming mid-verdict discards the leg and the utterance keeps accumulating", async () => {
    // First leg never produces a verdict (in flight); second answers.
    const starter = makeVerdictTurnStarter([[], ["Got it all."]]);
    const { frames, session, transcribers } = createHarness({
      finals: ["hello there world"],
      startVoiceTurn: starter.startVoiceTurn,
      frontModelConfig: { endpointExtensionMs: 5_000 },
    });

    await startWithPartial(session, transcribers);
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => starter.calls.length === 1);

    // The caller keeps talking while the verdict is in flight: silent
    // discard, no frames for the abandoned leg.
    transcribers[0]?.emit({ type: "partial", text: "hello wor and more" });
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => starter.discard.mock.calls.length === 1);
    expect(countType(frames, "utterance_end")).toBe(0);
    expect(countType(frames, "thinking")).toBe(0);

    // The next silence re-speculates with the grown transcript and commits.
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));
    expect(starter.calls).toHaveLength(2);
    expect(starter.calls[1]?.content).toBe("hello wor and more");
    expect(countType(frames, "utterance_end")).toBe(1);
  });

  test("a discard that beats the bridge handle still rolls back the user row", async () => {
    const discard = mock(async () => {});
    const abort = mock();
    let resolveHandle: (() => void) | null = null;
    const calls: VoiceTurnOptions[] = [];
    const startVoiceTurn: LiveVoiceTurnStarter = async (options) => {
      calls.push(options);
      if (calls.length === 1) {
        // The speculative leg's handle resolution is delayed past the
        // discard — models startVoiceTurn still inside its persist wait.
        await new Promise<void>((resolve) => {
          resolveHandle = resolve;
        });
        return { turnId: "bridge-slow", abort, discard };
      }
      return { turnId: `bridge-${calls.length}`, abort: mock() };
    };
    const { session, transcribers } = createHarness({
      finals: ["hello there world"],
      startVoiceTurn,
      frontModelConfig: { endpointExtensionMs: 5_000 },
    });

    await startWithPartial(session, transcribers);
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => calls.length === 1);

    // Speech resumes while the handle is still unresolved: the discard
    // finds handle === null and can only latch the request.
    transcribers[0]?.emit({ type: "partial", text: "hello wor and more" });
    await session.handleBinaryAudio(LOUD_CHUNK);

    // The handle finally arrives: it must complete the rollback via
    // discard(), not a plain abort that leaks the persisted user row.
    await waitFor(() => resolveHandle !== null);
    // Cast: TS narrows the closure-assigned resolver to null here.
    (resolveHandle as (() => void) | null)?.();
    await waitFor(() => discard.mock.calls.length === 1);
    expect(abort).not.toHaveBeenCalled();
  });

  test("a manual release during the verdict window commits the leg instead of discarding it", async () => {
    const discard = mock(async () => {});
    let callbacks: VoiceTurnCallbacks | undefined;
    const calls: VoiceTurnOptions[] = [];
    const startVoiceTurn: LiveVoiceTurnStarter = async (options) => {
      calls.push(options);
      callbacks = options.callbacks;
      return { turnId: "bridge-manual", abort: mock(), discard };
    };
    const { frames, session, transcribers } = createHarness({
      finals: ["hello world"],
      startVoiceTurn,
      frontModelConfig: { endpointExtensionMs: 5_000 },
    });

    await startWithPartial(session, transcribers);
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => calls.length === 1);

    // The caller hits release while the verdict is still in flight: the
    // utterance releases immediately (utterance_end goes out now).
    await session.handleClientFrame({ type: "ptt_release" });
    expect(countType(frames, "utterance_end")).toBe(1);

    // The verdict arrives as a normal answer — the caller explicitly asked
    // to answer now, so it must commit into the released utterance.
    callbacks?.assistant_text_delta?.(makeTextDelta("Hi there."));
    callbacks?.message_complete?.(makeMessageComplete());
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    expect(discard).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    // No duplicate utterance_end from the commit; the thinking frame and
    // the spoken answer still go out.
    expect(countType(frames, "utterance_end")).toBe(1);
    expect(countType(frames, "thinking")).toBe(1);
    expect(spokenDeltaText(frames)).toContain("Hi there.");
  });

  test("a hold verdict after a manual release relaunches a fresh leg on the released utterance", async () => {
    const discard = mock(async () => {});
    let firstCallbacks: VoiceTurnCallbacks | undefined;
    const calls: VoiceTurnOptions[] = [];
    const startVoiceTurn: LiveVoiceTurnStarter = async (options) => {
      calls.push(options);
      if (calls.length === 1) {
        firstCallbacks = options.callbacks;
        return { turnId: "bridge-held", abort: mock(), discard };
      }
      // The relaunched leg answers normally.
      setTimeout(() => {
        options.callbacks?.assistant_text_delta?.(
          makeTextDelta("Fresh answer."),
        );
        options.callbacks?.message_complete?.(makeMessageComplete());
      }, 0);
      return { turnId: `bridge-${calls.length}`, abort: mock() };
    };
    const { frames, session, transcribers } = createHarness({
      finals: ["hello world"],
      startVoiceTurn,
      frontModelConfig: { endpointExtensionMs: 5_000 },
    });

    await startWithPartial(session, transcribers);
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => calls.length === 1);

    await session.handleClientFrame({ type: "ptt_release" });

    // The hold lands after the caller already said they were done: moot.
    // The held leg rolls back and a fresh leg answers the released
    // utterance instead of the turn dying with no response.
    firstCallbacks?.assistant_text_delta?.(makeTextDelta("[0]"));
    await waitFor(() => calls.length === 2);
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    expect(discard).toHaveBeenCalledTimes(1);
    expect(spokenDeltaText(frames)).toContain("Fresh answer.");
    expect(spokenDeltaText(frames)).not.toContain("[0]");
  });
});
