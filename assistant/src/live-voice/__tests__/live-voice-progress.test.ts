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
import {
  pickAckPhrase,
  pickProgressPhrase,
  PROGRESS_FALLBACK_PHRASES,
} from "../ack-phrases.js";
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

function createRecordingTtsStreamer(
  // Per-segment synthesis stall: a non-null promise keeps that segment's TTS
  // job unsettled (audio still emitting) until it resolves.
  gateTtsText?: (text: string) => Promise<void> | null,
): {
  streamTtsAudio: LiveVoiceTtsStreamer;
  ttsTexts: string[];
} {
  const ttsTexts: string[] = [];
  const streamTtsAudio = mock(async (options: LiveVoiceTtsOptions) => {
    ttsTexts.push(options.text);
    await gateTtsText?.(options.text);
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
      generationTimeoutMs: 1_500,
      ...overrides,
    },
  };
}

function createProgressHarness(options: {
  frontModelConfig: Partial<LiveVoiceFrontModelConfig>;
  frontDecider: VoiceFrontDecider;
  emitMetrics?: boolean;
  gateTtsText?: (text: string) => Promise<void> | null;
}) {
  const { startVoiceTurn, getCallbacks } = createCapturingTurnStarter();
  const { streamTtsAudio, ttsTexts } = createRecordingTtsStreamer(
    options.gateTtsText,
  );
  const { context, frames } = createContext();
  const session = new LiveVoiceSession(context, {
    resolveTranscriber: mock(async () => new MockStreamingTranscriber()),
    startVoiceTurn,
    streamTtsAudio,
    frontModelConfig: options.frontModelConfig,
    frontDecider: options.frontDecider,
    createTurnId: () => "live-turn-1",
    emitMetrics: options.emitMetrics ?? false,
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
  getCallbacks()?.tool_use_start?.(toolName, { toolUseId });
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

  test("tool_result without a toolUseId completes the op via the name fallback", async () => {
    // Prod tool_result events may omit toolUseId (optional on the wire), so
    // correlation must succeed on the tool name alone.
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

    // Name-only result: no toolUseId to correlate by.
    getCallbacks()?.tool_result?.({
      toolName: "web_search",
      resultPreview: "found it",
    });
    emitToolStart(getCallbacks, "file_read", "tool-2");
    // Let the ack's minGapMs spacing elapse before the threshold-crossing op.
    await sleep(30);
    emitToolStart(getCallbacks, "bash", "tool-3");
    await waitFor(() => ttsTexts.length === 2);
    expect(ttsTexts).toEqual([EXPECTED_TOOL_ACK, GENERATED_NARRATION]);

    // The name fallback completed the web_search op: it reports as completed
    // (with its preview) rather than lingering incomplete.
    expect(inputs[0]?.completedOps).toEqual([
      { toolName: "web_search", resultPreview: "found it" },
    ]);
    expect(inputs[0]?.currentOp?.toolName).toBe("bash");

    emitMessageComplete(getCallbacks);
  });

  test("completedOps reach the decider in completion order, not start order", async () => {
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
    // Two parallel tools start in one order…
    emitToolStart(getCallbacks, "web_search", "tool-1");
    await waitFor(() => ttsTexts.length === 1);
    emitToolStart(getCallbacks, "file_read", "tool-2");
    // …and complete in the other. The sleep separates the completion
    // timestamps (millisecond clock) and lets the ack's minGapMs elapse.
    emitToolResult(getCallbacks, "file_read", "tool-2", "file contents");
    await sleep(30);
    emitToolResult(getCallbacks, "web_search", "tool-1", "found 3 results");
    emitToolStart(getCallbacks, "bash", "tool-3");
    await waitFor(() => ttsTexts.length === 2);

    expect(inputs[0]?.completedOps).toEqual([
      { toolName: "file_read", resultPreview: "file contents" },
      { toolName: "web_search", resultPreview: "found 3 results" },
    ]);

    emitMessageComplete(getCallbacks);
  });

  test("idle trigger: dead air narrates with the decider text, audio-only", async () => {
    const inputs: VoiceProgressTextInput[] = [];
    const generateProgressText = mock(async (input: VoiceProgressTextInput) => {
      inputs.push(input);
      return GENERATED_NARRATION;
    });
    const { frames, session, getCallbacks, ttsTexts } = createProgressHarness({
      frontModelConfig: progressConfig({
        idleIntervalMs: 40,
        minGapMs: 60_000,
      }),
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
      frontModelConfig: progressConfig({
        idleIntervalMs: 40,
        minGapMs: 60_000,
      }),
      frontDecider: makeProgressDecider(generateProgressText),
    });

    await startReleasedTurn(session, getCallbacks);
    await waitFor(() => ttsTexts.length === 1);
    expect(ttsTexts).toEqual([EXPECTED_PROGRESS_FALLBACK]);
    expect(generateProgressText).toHaveBeenCalledTimes(1);

    emitMessageComplete(getCallbacks);
  });

  test("no-ops idle fallback stays neutral: no phrase claims tool activity", async () => {
    // List invariant: the fallback can speak on a slow turn with zero tool
    // activity, so no phrase may claim tools or tasks are running.
    for (const phrase of PROGRESS_FALLBACK_PHRASES) {
      expect(phrase.toLowerCase()).not.toMatch(
        /\b(run|runs|running|tool|tools|thing|things|task|tasks|check|checking|look|looking|search|searching)\b/,
      );
    }

    // Behavior: a slow turn with no tool events falls back to that list.
    const generateProgressText = mock(async () => null);
    const { session, getCallbacks, ttsTexts } = createProgressHarness({
      frontModelConfig: progressConfig({
        idleIntervalMs: 40,
        minGapMs: 60_000,
      }),
      frontDecider: makeProgressDecider(generateProgressText),
    });

    await startReleasedTurn(session, getCallbacks);
    await waitFor(() => ttsTexts.length === 1);
    expect(
      PROGRESS_FALLBACK_PHRASES.map((phrase) => sanitizeForTts(phrase).trim()),
    ).toContain(ttsTexts[0]);

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

  test("llmAckText: no narration generation launches while an ack generation is pending", async () => {
    const ackGeneration = deferred<string | null>();
    const generateAckText = mock(() => ackGeneration.promise);
    const generateProgressText = mock(async () => GENERATED_NARRATION);
    const frontDecider: VoiceFrontDecider = {
      decideEndpoint: async () => ({ action: "release" }),
      generateAckText,
      generateProgressText,
    };
    const { session, getCallbacks, ttsTexts } = createProgressHarness({
      frontModelConfig: {
        llmAckText: true,
        ...progressConfig({ opsThreshold: 1, minGapMs: 150 }),
      },
      frontDecider,
    });

    await startReleasedTurn(session, getCallbacks);
    // The tool start speaks a generated ack (generation still pending) and
    // simultaneously crosses the ops threshold; the entry guard must stand
    // down instead of launching a narration generation whose result the
    // post-await re-check would only discard.
    emitToolStart(getCallbacks, "web_search", "tool-1");
    await sleep(30);
    expect(generateProgressText).not.toHaveBeenCalled();
    expect(ttsTexts).toEqual([]);

    ackGeneration.resolve("Generated ack.");
    await waitFor(() => ttsTexts.length === 1);
    expect(ttsTexts).toEqual(["Generated ack."]);

    // Inside the ack's minGapMs window nothing else speaks even as tool
    // activity continues.
    emitToolResult(getCallbacks, "web_search", "tool-1");
    await sleep(30);
    expect(generateProgressText).not.toHaveBeenCalled();
    expect(ttsTexts).toEqual(["Generated ack."]);

    // The stand-down preserved the update budget: once the gap elapses, the
    // next ops trigger narrates normally.
    await sleep(150);
    emitToolStart(getCallbacks, "file_read", "tool-2");
    await waitFor(() => ttsTexts.length === 2);
    expect(ttsTexts).toEqual(["Generated ack.", GENERATED_NARRATION]);
    expect(generateProgressText).toHaveBeenCalledTimes(1);

    emitMessageComplete(getCallbacks);
  });

  test("no per-turn cap: narration keeps pacing a long silence", async () => {
    const inputs: VoiceProgressTextInput[] = [];
    const generateProgressText = mock(async (input: VoiceProgressTextInput) => {
      inputs.push(input);
      return GENERATED_NARRATION;
    });
    const { session, getCallbacks, ttsTexts } = createProgressHarness({
      frontModelConfig: progressConfig({ idleIntervalMs: 30, minGapMs: 1 }),
      frontDecider: makeProgressDecider(generateProgressText),
    });

    await startReleasedTurn(session, getCallbacks);
    // Well past the historical 3-per-turn cap: updates keep coming for as
    // long as the silence lasts — going quiet deep into a long turn is the
    // failure mode narration exists to prevent.
    await waitFor(() => ttsTexts.length >= 4);
    expect(ttsTexts.slice(0, 4)).toEqual([
      GENERATED_NARRATION,
      GENERATED_NARRATION,
      GENERATED_NARRATION,
      GENERATED_NARRATION,
    ]);
    expect(inputs[3]?.updateIndex).toBe(4);

    emitMessageComplete(getCallbacks);
  });

  test("a delta mid-generation discards it; the idle timer re-narrates the next silence", async () => {
    const generation = deferred<string | null>();
    let generationCalls = 0;
    const generateProgressText = mock((): Promise<string | null> => {
      generationCalls += 1;
      return generationCalls === 1
        ? generation.promise
        : Promise.resolve("Second narration.");
    });
    const { session, getCallbacks, ttsTexts } = createProgressHarness({
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
    // …then the brain's first delta arrives before it resolves: the text is
    // stale (deltaEpoch moved), so it must never speak — even though the
    // sentence's audio has already drained by the time it resolves.
    emitTextDelta(getCallbacks, "Hello there.");
    generation.resolve("Late narration.");
    await sleep(60);
    expect(ttsTexts).not.toContain("Late narration.");

    // The timer survived the delta: dead air is mostly mid-turn, so once the
    // spoken sentence drains and the silence stretches another interval,
    // narration fires again.
    await waitFor(() => ttsTexts.includes("Second narration."));
    expect(ttsTexts[0]).toBe("Hello there.");
    expect(ttsTexts).not.toContain("Late narration.");

    emitMessageComplete(getCallbacks);
  });

  test("no narration while a TTS segment is still emitting; the countdown restarts once it drains", async () => {
    const ttsGate = deferred<void>();
    const generateProgressText = mock(async () => GENERATED_NARRATION);
    const { session, getCallbacks, ttsTexts } = createProgressHarness({
      frontModelConfig: progressConfig({
        idleIntervalMs: 40,
        minGapMs: 60_000,
      }),
      frontDecider: makeProgressDecider(generateProgressText),
      gateTtsText: (text) => (text === "Hello there." ? ttsGate.promise : null),
    });

    await startReleasedTurn(session, getCallbacks);
    // The model speaks immediately, and its segment's synthesis stalls: the
    // turn is not audibly silent, so idle ticks must not narrate over it.
    emitTextDelta(getCallbacks, "Hello there.");
    await waitFor(() => ttsTexts.length === 1);
    await sleep(120);
    expect(generateProgressText).not.toHaveBeenCalled();

    // Once the segment drains, a fresh full interval of silence narrates.
    ttsGate.resolve();
    await waitFor(() => ttsTexts.length === 2);
    expect(ttsTexts).toEqual(["Hello there.", GENERATED_NARRATION]);

    emitMessageComplete(getCallbacks);
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

  test("a spoken narration lands progressUpdatesSpoken on the turn's metrics frame", async () => {
    const generateProgressText = mock(async () => GENERATED_NARRATION);
    const { frames, session, getCallbacks, ttsTexts } = createProgressHarness({
      frontModelConfig: progressConfig({
        idleIntervalMs: 40,
        minGapMs: 60_000,
      }),
      frontDecider: makeProgressDecider(generateProgressText),
      emitMetrics: true,
    });

    await startReleasedTurn(session, getCallbacks);
    await waitFor(() => ttsTexts.length === 1);
    expect(ttsTexts).toEqual([GENERATED_NARRATION]);

    emitMessageComplete(getCallbacks);
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
      progressUpdatesSpoken: 1,
    });
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
