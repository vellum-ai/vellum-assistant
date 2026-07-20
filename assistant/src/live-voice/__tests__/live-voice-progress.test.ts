import { describe, expect, mock, test } from "bun:test";

import { sanitizeForTts } from "../../calls/tts-text-sanitizer.js";
import type {
  VoiceTurnCallbacks,
  VoiceTurnOptions,
} from "../../calls/voice-session-bridge.js";
import type {
  LiveVoiceFrontModelConfig,
  LiveVoiceProgressConfig,
} from "../../config/schemas/live-voice.js";
import type {
  StreamingTranscriber,
  SttStreamServerEvent,
} from "../../stt/types.js";
import { pickAckPhrase, pickProgressPhrase } from "../ack-phrases.js";
import type {
  VoiceFrontDecider,
  VoiceProgressTextInput,
} from "../front-decision.js";
import {
  LiveVoiceSession,
  type LiveVoiceTtsStreamer,
  type LiveVoiceTurnStarter,
} from "../live-voice-session.js";
import type { LiveVoiceSessionFactoryContext } from "../live-voice-session-manager.js";
import type { LiveVoiceTtsOptions } from "../live-voice-tts.js";
import {
  createLiveVoiceServerFrameSequencer,
  type LiveVoiceClientStartFrame,
  type LiveVoiceServerFrame,
} from "../protocol.js";

const START_FRAME = {
  type: "start",
  conversationId: "conversation-123",
  audio: {
    mimeType: "audio/pcm",
    sampleRate: 24_000,
    channels: 1,
  },
} as const satisfies LiveVoiceClientStartFrame;

// Generous enough that the slow-first-delta ack never fires during a test;
// the immediate tool-start ack still speaks and is asserted where relevant.
const GENEROUS_ACK_TIMEOUT_MS = 60_000;

const GENERATED_NARRATION = "Progress text.";
// Acks and narrations pass through the same TTS sanitizer; each fresh
// session's phrase counters start at 0.
const EXPECTED_TOOL_ACK = sanitizeForTts(pickAckPhrase("tool_use", 0)).trim();
const EXPECTED_PROGRESS_FALLBACK = sanitizeForTts(pickProgressPhrase(0)).trim();

class MockStreamingTranscriber implements StreamingTranscriber {
  readonly providerId = "deepgram" as const;
  readonly boundaryId = "daemon-streaming" as const;
  private onEvent: ((event: SttStreamServerEvent) => void) | null = null;

  async start(onEvent: (event: SttStreamServerEvent) => void): Promise<void> {
    this.onEvent = onEvent;
  }

  sendAudio(): void {}

  stop(): void {
    this.onEvent?.({ type: "final", text: "hello" });
    this.onEvent?.({ type: "closed" });
  }
}

function createContext(): {
  context: LiveVoiceSessionFactoryContext;
  frames: LiveVoiceServerFrame[];
} {
  const sequencer = createLiveVoiceServerFrameSequencer();
  const frames: LiveVoiceServerFrame[] = [];

  return {
    frames,
    context: {
      sessionId: "session-123",
      startFrame: START_FRAME,
      sendFrame: mock(async (payload) => {
        const frame = sequencer.next(payload);
        frames.push(frame);
        return frame;
      }),
    },
  };
}

function createCapturingTurnStarter(): {
  startVoiceTurn: LiveVoiceTurnStarter;
  getCallbacks: () => VoiceTurnCallbacks | undefined;
} {
  let callbacks: VoiceTurnCallbacks | undefined;
  const startVoiceTurn = mock(async (options: VoiceTurnOptions) => {
    callbacks = options.callbacks;
    return { turnId: "bridge-turn-1", abort: mock() };
  });
  return { startVoiceTurn, getCallbacks: () => callbacks };
}

function createRecordingTtsStreamer(): {
  streamTtsAudio: LiveVoiceTtsStreamer;
  ttsTexts: string[];
} {
  const ttsTexts: string[] = [];
  const streamTtsAudio = mock(async (options: LiveVoiceTtsOptions) => {
    ttsTexts.push(options.text);
    return {
      provider: "fish-audio" as const,
      contentType: "audio/pcm",
      sampleRate: 24_000,
      chunks: 1,
      bytes: Buffer.byteLength(options.text),
    };
  });
  return { streamTtsAudio, ttsTexts };
}

function makeProgressDecider(
  generateProgressText: VoiceFrontDecider["generateProgressText"],
): VoiceFrontDecider {
  return {
    decideEndpoint: async () => ({ action: "release" }),
    generateAckText: async () => null,
    generateProgressText,
  };
}

function progressConfig(
  overrides: Partial<LiveVoiceProgressConfig> = {},
): Partial<LiveVoiceFrontModelConfig> {
  return {
    ackFirstDeltaTimeoutMs: GENEROUS_ACK_TIMEOUT_MS,
    progress: {
      enabled: true,
      opsThreshold: 3,
      idleIntervalMs: 60_000,
      minGapMs: 10,
      maxPerTurn: 3,
      generationTimeoutMs: 1_500,
      ...overrides,
    },
  };
}

function createProgressHarness(options: {
  frontModelConfig: Partial<LiveVoiceFrontModelConfig>;
  frontDecider: VoiceFrontDecider;
}) {
  const { startVoiceTurn, getCallbacks } = createCapturingTurnStarter();
  const { streamTtsAudio, ttsTexts } = createRecordingTtsStreamer();
  const { context, frames } = createContext();
  const session = new LiveVoiceSession(context, {
    resolveTranscriber: mock(async () => new MockStreamingTranscriber()),
    startVoiceTurn,
    streamTtsAudio,
    frontModelConfig: options.frontModelConfig,
    frontDecider: options.frontDecider,
    createTurnId: () => "live-turn-1",
  });

  return { frames, session, getCallbacks, ttsTexts };
}

async function startReleasedTurn(
  session: LiveVoiceSession,
  getCallbacks: () => VoiceTurnCallbacks | undefined,
): Promise<void> {
  await session.start();
  await session.handleClientFrame({ type: "ptt_release" });
  await waitFor(() => getCallbacks() !== undefined);
}

async function waitFor(
  predicate: () => boolean,
  message = "Timed out waiting for live voice progress test condition",
): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function emitToolStart(
  getCallbacks: () => VoiceTurnCallbacks | undefined,
  toolName: string,
  toolUseId: string,
): void {
  getCallbacks()?.tool_use_start?.(toolName, { input: {}, toolUseId });
}

function emitToolResult(
  getCallbacks: () => VoiceTurnCallbacks | undefined,
  toolName: string,
  toolUseId: string,
  resultPreview = "ok",
): void {
  getCallbacks()?.tool_result?.({ toolName, toolUseId, resultPreview });
}

function emitTextDelta(
  getCallbacks: () => VoiceTurnCallbacks | undefined,
  text: string,
): void {
  getCallbacks()?.assistant_text_delta?.({
    type: "assistant_text_delta",
    text,
    conversationId: "conversation-123",
  });
}

function emitMessageComplete(
  getCallbacks: () => VoiceTurnCallbacks | undefined,
): void {
  getCallbacks()?.message_complete?.({
    type: "message_complete",
    conversationId: "conversation-123",
    messageId: "assistant-message-123",
  });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("LiveVoiceSession progress narration", () => {
  test("ops threshold: three tool ops speak exactly one narration with the accumulated activity", async () => {
    const inputs: VoiceProgressTextInput[] = [];
    const generateProgressText = mock(async (input: VoiceProgressTextInput) => {
      inputs.push(input);
      return GENERATED_NARRATION;
    });
    const { session, getCallbacks, ttsTexts } = createProgressHarness({
      frontModelConfig: progressConfig({ opsThreshold: 3, minGapMs: 10 }),
      frontDecider: makeProgressDecider(generateProgressText),
    });

    await startReleasedTurn(session, getCallbacks);
    emitToolStart(getCallbacks, "web_search", "tool-1");
    await waitFor(() => ttsTexts.length === 1);
    expect(ttsTexts).toEqual([EXPECTED_TOOL_ACK]);

    emitToolResult(getCallbacks, "web_search", "tool-1", "found 3 results");
    emitToolStart(getCallbacks, "file_read", "tool-2");
    emitToolResult(getCallbacks, "file_read", "tool-2", "file contents");
    // Let the ack's minGapMs spacing elapse before the threshold-crossing op.
    await sleep(30);
    emitToolStart(getCallbacks, "web_search", "tool-3");
    await waitFor(() => ttsTexts.length === 2);
    expect(ttsTexts).toEqual([EXPECTED_TOOL_ACK, GENERATED_NARRATION]);
    expect(generateProgressText).toHaveBeenCalledTimes(1);
    expect(inputs[0]).toMatchObject({
      transcriptSoFar: "hello",
      completedOps: [
        { toolName: "web_search", resultPreview: "found 3 results" },
        { toolName: "file_read", resultPreview: "file contents" },
      ],
      currentOp: { toolName: "web_search" },
      updateIndex: 1,
    });

    // The counter reset with the narration, so the trailing result stays
    // below the threshold: still exactly one narration.
    emitToolResult(getCallbacks, "web_search", "tool-3");
    await sleep(30);
    expect(ttsTexts).toEqual([EXPECTED_TOOL_ACK, GENERATED_NARRATION]);
    expect(generateProgressText).toHaveBeenCalledTimes(1);

    emitMessageComplete(getCallbacks);
  });

  test("idle trigger: dead air narrates with the decider text, audio-only", async () => {
    const inputs: VoiceProgressTextInput[] = [];
    const generateProgressText = mock(async (input: VoiceProgressTextInput) => {
      inputs.push(input);
      return GENERATED_NARRATION;
    });
    const { frames, session, getCallbacks, ttsTexts } = createProgressHarness({
      frontModelConfig: progressConfig({ idleIntervalMs: 40, maxPerTurn: 1 }),
      frontDecider: makeProgressDecider(generateProgressText),
    });

    await startReleasedTurn(session, getCallbacks);
    await waitFor(() => ttsTexts.length === 1);
    expect(ttsTexts).toEqual([GENERATED_NARRATION]);
    expect(inputs[0]).toMatchObject({
      transcriptSoFar: "hello",
      completedOps: [],
      currentOp: null,
      updateIndex: 1,
    });

    // Narration is audio-only: no caption frame carries it.
    expect(frames.some((frame) => frame.type === "assistant_text_delta")).toBe(
      false,
    );

    emitMessageComplete(getCallbacks);
  });

  test("idle trigger with a null decider result speaks the static fallback", async () => {
    const generateProgressText = mock(async () => null);
    const { session, getCallbacks, ttsTexts } = createProgressHarness({
      frontModelConfig: progressConfig({ idleIntervalMs: 40, maxPerTurn: 1 }),
      frontDecider: makeProgressDecider(generateProgressText),
    });

    await startReleasedTurn(session, getCallbacks);
    await waitFor(() => ttsTexts.length === 1);
    expect(ttsTexts).toEqual([EXPECTED_PROGRESS_FALLBACK]);
    expect(generateProgressText).toHaveBeenCalledTimes(1);

    emitMessageComplete(getCallbacks);
  });

  test("ops trigger with a null decider result stays silent and keeps the update budget", async () => {
    const generateProgressText = mock(async () => null);
    const { session, getCallbacks, ttsTexts } = createProgressHarness({
      frontModelConfig: progressConfig({
        opsThreshold: 1,
        idleIntervalMs: 120,
        minGapMs: 10,
      }),
      frontDecider: makeProgressDecider(generateProgressText),
    });

    await startReleasedTurn(session, getCallbacks);
    emitToolStart(getCallbacks, "web_search", "tool-1");
    await waitFor(() => ttsTexts.length === 1);
    expect(ttsTexts).toEqual([EXPECTED_TOOL_ACK]);

    // Past the ack gap, the ops trigger fires but generation returns null:
    // nothing speaks and no update is consumed.
    await sleep(30);
    emitToolResult(getCallbacks, "web_search", "tool-1");
    await waitFor(() => generateProgressText.mock.calls.length === 1);
    await sleep(10);
    expect(ttsTexts).toEqual([EXPECTED_TOOL_ACK]);

    // The idle trigger still has the full budget: its own null falls back to
    // the static phrase.
    await waitFor(() => ttsTexts.length === 2);
    expect(ttsTexts).toEqual([EXPECTED_TOOL_ACK, EXPECTED_PROGRESS_FALLBACK]);

    emitMessageComplete(getCallbacks);
  });

  test("minGapMs: a tool-start ack suppresses narration until the gap elapses", async () => {
    const generateProgressText = mock(async () => GENERATED_NARRATION);
    const { session, getCallbacks, ttsTexts } = createProgressHarness({
      frontModelConfig: progressConfig({ opsThreshold: 1, minGapMs: 150 }),
      frontDecider: makeProgressDecider(generateProgressText),
    });

    await startReleasedTurn(session, getCallbacks);
    emitToolStart(getCallbacks, "web_search", "tool-1");
    await waitFor(() => ttsTexts.length === 1);
    // Threshold already met, but the just-spoken ack holds the floor.
    emitToolResult(getCallbacks, "web_search", "tool-1");
    await sleep(30);
    expect(ttsTexts).toEqual([EXPECTED_TOOL_ACK]);
    expect(generateProgressText).not.toHaveBeenCalled();

    await sleep(150);
    emitToolStart(getCallbacks, "file_read", "tool-2");
    await waitFor(() => ttsTexts.length === 2);
    expect(ttsTexts).toEqual([EXPECTED_TOOL_ACK, GENERATED_NARRATION]);
    expect(generateProgressText).toHaveBeenCalledTimes(1);

    emitMessageComplete(getCallbacks);
  });

  test("maxPerTurn caps narration for the rest of the turn", async () => {
    const generateProgressText = mock(async () => GENERATED_NARRATION);
    const { session, getCallbacks, ttsTexts } = createProgressHarness({
      frontModelConfig: progressConfig({
        opsThreshold: 1,
        minGapMs: 1,
        maxPerTurn: 1,
      }),
      frontDecider: makeProgressDecider(generateProgressText),
    });

    await startReleasedTurn(session, getCallbacks);
    emitToolStart(getCallbacks, "web_search", "tool-1");
    await waitFor(() => ttsTexts.length === 1);
    await sleep(10);
    emitToolResult(getCallbacks, "web_search", "tool-1");
    await waitFor(() => ttsTexts.length === 2);
    expect(ttsTexts).toEqual([EXPECTED_TOOL_ACK, GENERATED_NARRATION]);

    await sleep(10);
    emitToolStart(getCallbacks, "file_read", "tool-2");
    emitToolResult(getCallbacks, "file_read", "tool-2");
    await sleep(30);
    expect(ttsTexts).toEqual([EXPECTED_TOOL_ACK, GENERATED_NARRATION]);
    expect(generateProgressText).toHaveBeenCalledTimes(1);

    emitMessageComplete(getCallbacks);
  });

  test("first delta stops the idle timer and discards an in-flight generation", async () => {
    const generation = deferred<string | null>();
    const generateProgressText = mock(() => generation.promise);
    const { frames, session, getCallbacks, ttsTexts } = createProgressHarness({
      frontModelConfig: progressConfig({
        opsThreshold: 1,
        idleIntervalMs: 40,
        minGapMs: 10,
      }),
      frontDecider: makeProgressDecider(generateProgressText),
    });

    await startReleasedTurn(session, getCallbacks);
    // The idle trigger starts a generation…
    await waitFor(() => generateProgressText.mock.calls.length === 1);
    // …then the brain's first delta arrives before it resolves.
    emitTextDelta(getCallbacks, "Hello there.");
    generation.resolve("Late narration.");
    await sleep(120);

    // The stale generation never speaks and the idle timer never re-fires.
    expect(generateProgressText).toHaveBeenCalledTimes(1);
    expect(ttsTexts).toEqual(["Hello there."]);

    emitMessageComplete(getCallbacks);
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));
    expect(ttsTexts).toEqual(["Hello there."]);
  });

  test("cancel clears the idle timer and an in-flight generation speaks nothing", async () => {
    const generation = deferred<string | null>();
    const generateProgressText = mock(() => generation.promise);
    const { session, getCallbacks, ttsTexts } = createProgressHarness({
      frontModelConfig: progressConfig({ idleIntervalMs: 40 }),
      frontDecider: makeProgressDecider(generateProgressText),
    });

    await startReleasedTurn(session, getCallbacks);
    await waitFor(() => generateProgressText.mock.calls.length === 1);

    await session.handleClientFrame({ type: "interrupt" });
    generation.resolve("Late narration.");
    await sleep(120);

    expect(generateProgressText).toHaveBeenCalledTimes(1);
    expect(ttsTexts).toEqual([]);
  });

  test("progress.enabled false: zero narrations and zero decider calls", async () => {
    const generateProgressText = mock(async () => GENERATED_NARRATION);
    const { session, getCallbacks, ttsTexts } = createProgressHarness({
      frontModelConfig: progressConfig({
        enabled: false,
        opsThreshold: 1,
        idleIntervalMs: 30,
        minGapMs: 1,
      }),
      frontDecider: makeProgressDecider(generateProgressText),
    });

    await startReleasedTurn(session, getCallbacks);
    emitToolStart(getCallbacks, "web_search", "tool-1");
    emitToolResult(getCallbacks, "web_search", "tool-1");
    emitToolStart(getCallbacks, "file_read", "tool-2");
    emitToolResult(getCallbacks, "file_read", "tool-2");
    await sleep(100);

    // Only the tool-start ack spoke; the decider was never consulted.
    expect(ttsTexts).toEqual([EXPECTED_TOOL_ACK]);
    expect(generateProgressText).not.toHaveBeenCalled();

    emitMessageComplete(getCallbacks);
  });
});
