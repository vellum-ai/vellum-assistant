import { describe, expect, mock, test } from "bun:test";

import { sanitizeForTts } from "../../calls/tts-text-sanitizer.js";
import type {
  VoiceTurnCallbacks,
  VoiceTurnOptions,
} from "../../calls/voice-session-bridge.js";
import { loadRawConfig, saveRawConfig } from "../../config/loader.js";
import type {
  LiveVoiceFrontModelConfig,
  LiveVoiceProgressConfig,
  LiveVoiceWorkingCueConfig,
} from "../../config/schemas/live-voice.js";
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
import type { LiveVoiceTtsOptions } from "../live-voice-tts.js";
import type {
  VoiceProgressNarrator,
  VoiceProgressTextInput,
} from "../progress-narration.js";
import {
  approvalPendingPhraseFor,
  pickProgressPhrase,
  PROGRESS_FALLBACK_PHRASES,
  PROGRESS_FALLBACK_PHRASES_BY_LANGUAGE,
} from "../progress-phrases.js";
import {
  createLiveVoiceServerFrameSequencer,
  type LiveVoiceClientStartFrame,
  type LiveVoiceServerFrame,
} from "../protocol.js";
import {
  DEFAULT_WORKING_CUE_SHAPE,
  renderWorkingCuePcm,
} from "../working-cue.js";

const START_FRAME = {
  type: "start",
  conversationId: "conversation-123",
  audio: {
    mimeType: "audio/pcm",
    sampleRate: 24_000,
    channels: 1,
  },
} as const satisfies LiveVoiceClientStartFrame;

const GENERATED_NARRATION = "Progress text.";
const EXPECTED_PROGRESS_FALLBACK = sanitizeForTts(pickProgressPhrase(0)).trim();

class MockStreamingTranscriber implements StreamingTranscriber {
  readonly providerId = "deepgram" as const;
  readonly boundaryId = "daemon-streaming" as const;
  private onEvent: ((event: SttStreamServerEvent) => void) | null = null;

  constructor(
    private readonly stopEvents: SttStreamServerEvent[] = [
      { type: "final", text: "hello" },
      { type: "closed" },
    ],
  ) {}

  async start(onEvent: (event: SttStreamServerEvent) => void): Promise<void> {
    this.onEvent = onEvent;
  }

  sendAudio(): void {}

  stop(): void {
    for (const event of this.stopEvents) {
      this.onEvent?.(event);
    }
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
  approvalPending: (requestId: string) => void;
} {
  let callbacks: VoiceTurnCallbacks | undefined;
  let onApprovalPending: VoiceTurnOptions["onApprovalPending"];
  const startVoiceTurn = mock(async (options: VoiceTurnOptions) => {
    callbacks = options.callbacks;
    onApprovalPending = options.onApprovalPending;
    return { turnId: "bridge-turn-1", abort: mock() };
  });
  return {
    startVoiceTurn,
    getCallbacks: () => callbacks,
    approvalPending: (requestId) => onApprovalPending?.(requestId),
  };
}

function createRecordingTtsStreamer(
  // Per-segment synthesis stall: a non-null promise keeps that segment's TTS
  // job unsettled (audio still emitting) until it resolves.
  gateTtsText?: (text: string) => Promise<void> | null,
  // Emit this much silent PCM per segment. Without it the mock produces no
  // audio at all, so the session's client playback-tail estimate never moves
  // and every turn reads as instantly silent.
  emitChunkMs?: number,
): {
  streamTtsAudio: LiveVoiceTtsStreamer;
  ttsTexts: string[];
  ttsCalls: LiveVoiceTtsOptions[];
} {
  const ttsTexts: string[] = [];
  const ttsCalls: LiveVoiceTtsOptions[] = [];
  const streamTtsAudio = mock(async (options: LiveVoiceTtsOptions) => {
    ttsTexts.push(options.text);
    ttsCalls.push(options);
    if (emitChunkMs !== undefined) {
      options.onAudioChunk({
        type: "tts_audio",
        contentType: "audio/pcm",
        sampleRate: START_FRAME.audio.sampleRate,
        dataBase64: Buffer.alloc(
          Math.round((START_FRAME.audio.sampleRate * emitChunkMs) / 1_000) * 2,
        ).toString("base64"),
      });
    }
    await gateTtsText?.(options.text);
    return {
      provider: "fish-audio" as const,
      contentType: "audio/pcm",
      sampleRate: 24_000,
      chunks: 1,
      bytes: Buffer.byteLength(options.text),
    };
  });
  return { streamTtsAudio, ttsTexts, ttsCalls };
}

function makeProgressNarrator(
  generateProgressText: VoiceProgressNarrator["generateProgressText"],
): VoiceProgressNarrator {
  return {
    generateProgressText,
  };
}

function progressConfig(
  overrides: Partial<LiveVoiceProgressConfig> = {},
): Partial<LiveVoiceFrontModelConfig> {
  const idleIntervalMs = overrides.idleIntervalMs ?? 60_000;
  return {
    progress: {
      enabled: true,
      opsThreshold: 3,
      idleIntervalMs,
      // The schema floors the heartbeat at the tick interval; sitting exactly
      // on that floor makes every dead-air tick heartbeat-eligible, and tests
      // that assert the new-activity gate raise it out of reach.
      maxSilenceMs: idleIntervalMs,
      longOpMs: 15_000,
      minGapMs: 10,
      generationTimeoutMs: 1_500,
      ...overrides,
    },
  };
}

function createProgressHarness(options: {
  frontModelConfig: Partial<LiveVoiceFrontModelConfig>;
  progressNarrator: VoiceProgressNarrator;
  // The cue and spoken narration are alternatives, so a narration test turns
  // the cue off. Cue tests pass their own config.
  workingCueConfig?: Partial<LiveVoiceWorkingCueConfig>;
  emitMetrics?: boolean;
  gateTtsText?: (text: string) => Promise<void> | null;
  emitChunkMs?: number;
  // Events the transcriber flushes at utterance release; defaults to a plain
  // untagged "hello" final.
  sttStopEvents?: SttStreamServerEvent[];
}) {
  const { startVoiceTurn, getCallbacks, approvalPending } =
    createCapturingTurnStarter();
  const { streamTtsAudio, ttsTexts, ttsCalls } = createRecordingTtsStreamer(
    options.gateTtsText,
    options.emitChunkMs,
  );
  const { context, frames } = createContext();
  const session = new LiveVoiceSession(context, {
    resolveTranscriber: mock(
      async () => new MockStreamingTranscriber(options.sttStopEvents),
    ),
    startVoiceTurn,
    streamTtsAudio,
    frontModelConfig: options.frontModelConfig,
    workingCueConfig: options.workingCueConfig ?? { enabled: false },
    progressNarrator: options.progressNarrator,
    createTurnId: () => "live-turn-1",
    emitMetrics: options.emitMetrics ?? false,
  });

  return {
    frames,
    session,
    getCallbacks,
    approvalPending,
    ttsTexts,
    ttsCalls,
  };
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
  test("the escalated leg re-arms idle narration into post-bridge dead air", async () => {
    const generateProgressText = mock(
      async () => "Still working through your calendar.",
    );
    const { session, getCallbacks, ttsTexts } = createProgressHarness({
      frontModelConfig: progressConfig({ idleIntervalMs: 40 }),
      progressNarrator: makeProgressNarrator(generateProgressText),
    });
    await startReleasedTurn(session, getCallbacks);

    // Bare escalate verdict: the canned bridge speaks and the escalated
    // leg takes over. Its strong-model thinking + tool loops are the
    // longest dead air in the system — narration must cover it once the
    // bridge audio has drained, where it used to be suppressed for the
    // rest of the turn.
    emitTextDelta(getCallbacks, "[1]");
    emitMessageComplete(getCallbacks);
    await waitFor(() => ttsTexts.length === 1);

    await waitFor(() => generateProgressText.mock.calls.length >= 1);
    await waitFor(() => ttsTexts.length >= 2);
    expect(ttsTexts[1]).toContain("Still working");
  });

  test("ops threshold: three tool ops speak exactly one narration with the accumulated activity", async () => {
    const inputs: VoiceProgressTextInput[] = [];
    const generateProgressText = mock(async (input: VoiceProgressTextInput) => {
      inputs.push(input);
      return GENERATED_NARRATION;
    });
    const { session, getCallbacks, ttsTexts } = createProgressHarness({
      frontModelConfig: progressConfig({ opsThreshold: 3, minGapMs: 10 }),
      progressNarrator: makeProgressNarrator(generateProgressText),
    });

    await startReleasedTurn(session, getCallbacks);
    emitToolStart(getCallbacks, "web_search", "tool-1");

    emitToolResult(getCallbacks, "web_search", "tool-1", "found 3 results");
    emitToolStart(getCallbacks, "file_read", "tool-2");
    emitToolResult(getCallbacks, "file_read", "tool-2", "file contents");
    emitToolStart(getCallbacks, "web_search", "tool-3");
    await waitFor(() => ttsTexts.length === 1);
    expect(ttsTexts).toEqual([GENERATED_NARRATION]);
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
    expect(ttsTexts).toEqual([GENERATED_NARRATION]);
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
      progressNarrator: makeProgressNarrator(generateProgressText),
    });

    await startReleasedTurn(session, getCallbacks);
    emitToolStart(getCallbacks, "web_search", "tool-1");

    // Name-only result: no toolUseId to correlate by.
    getCallbacks()?.tool_result?.({
      toolName: "web_search",
      resultPreview: "found it",
    });
    emitToolStart(getCallbacks, "file_read", "tool-2");
    emitToolStart(getCallbacks, "bash", "tool-3");
    await waitFor(() => ttsTexts.length === 1);
    expect(ttsTexts).toEqual([GENERATED_NARRATION]);

    // The name fallback completed the web_search op: it reports as completed
    // (with its preview) rather than lingering incomplete.
    expect(inputs[0]?.completedOps).toEqual([
      { toolName: "web_search", resultPreview: "found it" },
    ]);
    expect(inputs[0]?.currentOp?.toolName).toBe("bash");

    emitMessageComplete(getCallbacks);
  });

  test("completedOps reach the narrator in completion order, not start order", async () => {
    const inputs: VoiceProgressTextInput[] = [];
    const generateProgressText = mock(async (input: VoiceProgressTextInput) => {
      inputs.push(input);
      return GENERATED_NARRATION;
    });
    const { session, getCallbacks, ttsTexts } = createProgressHarness({
      frontModelConfig: progressConfig({ opsThreshold: 3, minGapMs: 10 }),
      progressNarrator: makeProgressNarrator(generateProgressText),
    });

    await startReleasedTurn(session, getCallbacks);
    // Two parallel tools start in one order…
    emitToolStart(getCallbacks, "web_search", "tool-1");
    emitToolStart(getCallbacks, "file_read", "tool-2");
    // They complete in the other order. The sleep separates their completion
    // timestamps on the millisecond clock.
    emitToolResult(getCallbacks, "file_read", "tool-2", "file contents");
    await sleep(30);
    emitToolResult(getCallbacks, "web_search", "tool-1", "found 3 results");
    emitToolStart(getCallbacks, "bash", "tool-3");
    await waitFor(() => ttsTexts.length === 1);

    expect(inputs[0]?.completedOps).toEqual([
      { toolName: "file_read", resultPreview: "file contents" },
      { toolName: "web_search", resultPreview: "found 3 results" },
    ]);

    emitMessageComplete(getCallbacks);
  });

  test("idle trigger: dead air narrates with generated text, audio-only", async () => {
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
      progressNarrator: makeProgressNarrator(generateProgressText),
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

  test("idle trigger with a null narrator result speaks the static fallback", async () => {
    const generateProgressText = mock(async () => null);
    const { session, getCallbacks, ttsTexts } = createProgressHarness({
      frontModelConfig: progressConfig({
        idleIntervalMs: 40,
        minGapMs: 60_000,
      }),
      progressNarrator: makeProgressNarrator(generateProgressText),
    });

    await startReleasedTurn(session, getCallbacks);
    await waitFor(() => ttsTexts.length === 1);
    expect(ttsTexts).toEqual([EXPECTED_PROGRESS_FALLBACK]);
    expect(generateProgressText).toHaveBeenCalledTimes(1);

    emitMessageComplete(getCallbacks);
  });

  test("no-ops idle fallback stays neutral: no phrase claims tool activity", async () => {
    // List invariant: the fallback can speak on a slow turn with zero tool
    // activity, so no phrase may claim tools or tasks are running. Every
    // language's list carries the invariant; the regex names the English
    // activity words, which no list may borrow.
    for (const phrases of Object.values(
      PROGRESS_FALLBACK_PHRASES_BY_LANGUAGE,
    )) {
      for (const phrase of phrases) {
        expect(phrase.toLowerCase()).not.toMatch(
          /\b(run|runs|running|tool|tools|thing|things|task|tasks|check|checking|look|looking|search|searching)\b/,
        );
      }
    }

    // Behavior: a slow turn with no tool events falls back to that list.
    const generateProgressText = mock(async () => null);
    const { session, getCallbacks, ttsTexts } = createProgressHarness({
      frontModelConfig: progressConfig({
        idleIntervalMs: 40,
        minGapMs: 60_000,
      }),
      progressNarrator: makeProgressNarrator(generateProgressText),
    });

    await startReleasedTurn(session, getCallbacks);
    await waitFor(() => ttsTexts.length === 1);
    expect(
      PROGRESS_FALLBACK_PHRASES.map((phrase) => sanitizeForTts(phrase).trim()),
    ).toContain(ttsTexts[0]);

    emitMessageComplete(getCallbacks);
  });

  test("a Hindi turn's idle fallback speaks the Hindi phrase and hints the narrator", async () => {
    const inputs: VoiceProgressTextInput[] = [];
    const generateProgressText = mock(async (input: VoiceProgressTextInput) => {
      inputs.push(input);
      return null;
    });
    const { session, getCallbacks, ttsTexts } = createProgressHarness({
      frontModelConfig: progressConfig({
        idleIntervalMs: 40,
        minGapMs: 60_000,
      }),
      progressNarrator: makeProgressNarrator(generateProgressText),
      sttStopEvents: [
        { type: "final", text: "नमस्ते", languages: ["hi"] },
        { type: "closed" },
      ],
    });

    await startReleasedTurn(session, getCallbacks);
    await waitFor(() => ttsTexts.length === 1);

    // The static fallback rotates through the caller's language's list, not
    // the English default, and the narrator was told the language too.
    expect(pickProgressPhrase(0, "hi")).toBe(
      PROGRESS_FALLBACK_PHRASES_BY_LANGUAGE.hi![0]!,
    );
    expect(ttsTexts).toEqual([
      sanitizeForTts(pickProgressPhrase(0, "hi")).trim(),
    ]);
    expect(inputs[0]?.languageHint).toBe("hi");

    emitMessageComplete(getCallbacks);
  });

  test("an out-of-roster pinned turn speaks the English fallback with an 'en' hint while model speech keeps the pin", async () => {
    // "ar" is an accepted monolingual services.stt.language pin but has no
    // entry in the localized phrase tables, so the idle fallback is English
    // text. The filler segment must carry an "en" hint rather than the
    // turn's "ar" (an enforcing TTS provider would otherwise render English
    // words as Arabic). Model speech stays on the turn's language.
    const originalRaw = loadRawConfig();
    const rawServices = (originalRaw.services ?? {}) as Record<string, unknown>;
    saveRawConfig({
      ...originalRaw,
      services: {
        ...rawServices,
        stt: {
          ...((rawServices.stt ?? {}) as Record<string, unknown>),
          provider: "deepgram",
          language: "ar",
        },
      },
    });
    const generateProgressText = mock(async () => null);
    const { session, getCallbacks, ttsTexts, ttsCalls } = createProgressHarness(
      {
        frontModelConfig: progressConfig({
          idleIntervalMs: 40,
          minGapMs: 60_000,
        }),
        progressNarrator: makeProgressNarrator(generateProgressText),
      },
    );

    try {
      await startReleasedTurn(session, getCallbacks);
      await waitFor(() => ttsTexts.length === 1);

      expect(ttsTexts[0]).toBe(EXPECTED_PROGRESS_FALLBACK);
      expect(ttsCalls[0]?.language).toBe("en");

      emitTextDelta(getCallbacks, "Okay.");
      emitMessageComplete(getCallbacks);
      await waitFor(() => ttsCalls.length >= 2);

      expect(ttsCalls[1]?.text).toBe("Okay.");
      expect(ttsCalls[1]?.language).toBe("ar");
    } finally {
      await session.close("websocket_close");
      saveRawConfig(originalRaw);
    }
  });

  test("with no detected language the narrator gets no hint and fallback stays English", async () => {
    const inputs: VoiceProgressTextInput[] = [];
    const progressNarrator: VoiceProgressNarrator = {
      generateProgressText: async (input) => {
        inputs.push(input);
        return null;
      },
    };
    const { session, getCallbacks, ttsTexts } = createProgressHarness({
      frontModelConfig: progressConfig({ idleIntervalMs: 40, minGapMs: 10 }),
      progressNarrator,
    });

    await startReleasedTurn(session, getCallbacks);
    emitToolStart(getCallbacks, "web_search", "tool-1");
    await waitFor(() => ttsTexts.length === 1);

    // Language unknown: the input has no languageHint key and the static
    // fallback comes from the English list.
    expect(inputs[0]).not.toHaveProperty("languageHint");
    expect(ttsTexts).toEqual([EXPECTED_PROGRESS_FALLBACK]);

    emitMessageComplete(getCallbacks);
  });

  test("ops trigger with a null narrator result stays silent and keeps the update budget", async () => {
    const generateProgressText = mock(async () => null);
    const { session, getCallbacks, ttsTexts } = createProgressHarness({
      frontModelConfig: progressConfig({
        opsThreshold: 1,
        idleIntervalMs: 120,
        minGapMs: 10,
      }),
      progressNarrator: makeProgressNarrator(generateProgressText),
    });

    await startReleasedTurn(session, getCallbacks);
    emitToolStart(getCallbacks, "web_search", "tool-1");
    await waitFor(() => generateProgressText.mock.calls.length === 1);
    await sleep(10);
    expect(ttsTexts).toEqual([]);

    // The idle trigger still has the full budget: its own null falls back to
    // the static phrase.
    await waitFor(() => ttsTexts.length === 1);
    expect(ttsTexts).toEqual([EXPECTED_PROGRESS_FALLBACK]);

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
      progressNarrator: makeProgressNarrator(generateProgressText),
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
      progressNarrator: makeProgressNarrator(generateProgressText),
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
      progressNarrator: makeProgressNarrator(generateProgressText),
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
      progressNarrator: makeProgressNarrator(generateProgressText),
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
      progressNarrator: makeProgressNarrator(generateProgressText),
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

  test("progress.enabled false: zero narrations and zero narrator calls", async () => {
    const generateProgressText = mock(async () => GENERATED_NARRATION);
    const { session, getCallbacks, ttsTexts } = createProgressHarness({
      frontModelConfig: progressConfig({
        enabled: false,
        opsThreshold: 1,
        idleIntervalMs: 30,
        minGapMs: 1,
      }),
      progressNarrator: makeProgressNarrator(generateProgressText),
    });

    await startReleasedTurn(session, getCallbacks);
    emitToolStart(getCallbacks, "web_search", "tool-1");
    emitToolResult(getCallbacks, "web_search", "tool-1");
    emitToolStart(getCallbacks, "file_read", "tool-2");
    emitToolResult(getCallbacks, "file_read", "tool-2");
    await sleep(100);

    expect(ttsTexts).toEqual([]);
    expect(generateProgressText).not.toHaveBeenCalled();

    emitMessageComplete(getCallbacks);
  });

  test("idle ticks stay silent with nothing new, until the maxSilenceMs heartbeat", async () => {
    const generateProgressText = mock(async () => GENERATED_NARRATION);
    const { session, getCallbacks, ttsTexts } = createProgressHarness({
      frontModelConfig: progressConfig({
        idleIntervalMs: 20,
        maxSilenceMs: 150,
      }),
      progressNarrator: makeProgressNarrator(generateProgressText),
    });

    await startReleasedTurn(session, getCallbacks);
    // Several ticks pass over a turn that has done nothing observable: the
    // cadence follows the work, so none of them speak.
    await sleep(70);
    expect(generateProgressText).not.toHaveBeenCalled();

    // The heartbeat ceiling is the one thing that speaks without news — a
    // turn with no observable activity still has to prove it is alive.
    await waitFor(() => ttsTexts.length === 1);
    expect(ttsTexts).toEqual([GENERATED_NARRATION]);

    emitMessageComplete(getCallbacks);
  });

  test("new tool activity narrates once; later ticks over the same state stay silent", async () => {
    const generateProgressText = mock(async () => GENERATED_NARRATION);
    const { session, getCallbacks, ttsTexts } = createProgressHarness({
      frontModelConfig: progressConfig({
        // Only the idle trigger is in play: the ops threshold is out of reach
        // and the heartbeat is far beyond the test's lifetime.
        opsThreshold: 99,
        idleIntervalMs: 20,
        maxSilenceMs: 600_000,
      }),
      progressNarrator: makeProgressNarrator(generateProgressText),
    });

    await startReleasedTurn(session, getCallbacks);
    await sleep(60);
    expect(generateProgressText).not.toHaveBeenCalled();

    // A tool starting is news: the next tick narrates it.
    emitToolStart(getCallbacks, "web_search", "tool-1");
    await waitFor(() => ttsTexts.length === 1);
    expect(ttsTexts).toEqual([GENERATED_NARRATION]);

    // Nothing has happened since, so the ticks that follow stay quiet
    // instead of repeating the same update on a clock.
    await sleep(80);
    expect(generateProgressText).toHaveBeenCalledTimes(1);
    expect(ttsTexts).toEqual([GENERATED_NARRATION]);

    emitMessageComplete(getCallbacks);
  });

  test("op_complete: a long-running op narrates as it finishes, without the ops threshold", async () => {
    const inputs: VoiceProgressTextInput[] = [];
    const generateProgressText = mock(async (input: VoiceProgressTextInput) => {
      inputs.push(input);
      return GENERATED_NARRATION;
    });
    const { session, getCallbacks, ttsTexts } = createProgressHarness({
      frontModelConfig: progressConfig({
        // Neither the ops threshold nor an idle tick can fire: the completion
        // beat is the only thing that can speak here.
        opsThreshold: 99,
        idleIntervalMs: 60_000,
        longOpMs: 25,
      }),
      progressNarrator: makeProgressNarrator(generateProgressText),
    });

    await startReleasedTurn(session, getCallbacks);
    emitToolStart(getCallbacks, "web_search", "tool-1");
    await sleep(40);

    emitToolResult(getCallbacks, "web_search", "tool-1");
    await waitFor(() => ttsTexts.length === 1);
    expect(ttsTexts).toEqual([GENERATED_NARRATION]);
    expect(inputs[0]?.completedOps).toEqual([
      { toolName: "web_search", resultPreview: "ok" },
    ]);

    emitMessageComplete(getCallbacks);
  });

  test("a quick op finishing does not earn the completion beat", async () => {
    const generateProgressText = mock(async () => GENERATED_NARRATION);
    const { session, getCallbacks, ttsTexts } = createProgressHarness({
      frontModelConfig: progressConfig({
        opsThreshold: 99,
        idleIntervalMs: 60_000,
        longOpMs: 60_000,
      }),
      progressNarrator: makeProgressNarrator(generateProgressText),
    });

    await startReleasedTurn(session, getCallbacks);
    emitToolStart(getCallbacks, "web_search", "tool-1");
    emitToolResult(getCallbacks, "web_search", "tool-1");
    await sleep(60);

    // Narrating every quick lookup is the chatter the cadence avoids.
    expect(generateProgressText).not.toHaveBeenCalled();
    expect(ttsTexts).toEqual([]);

    emitMessageComplete(getCallbacks);
  });

  test("activity during a generation is still news for the next tick", async () => {
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
        opsThreshold: 99,
        idleIntervalMs: 20,
        maxSilenceMs: 600_000,
      }),
      progressNarrator: makeProgressNarrator(generateProgressText),
    });

    await startReleasedTurn(session, getCallbacks);
    emitToolStart(getCallbacks, "web_search", "tool-1");
    await waitFor(() => generateProgressText.mock.calls.length === 1);

    // The op completes while the update describing its start is still being
    // generated: that text cannot carry the news, so the update marks the
    // state it described, not the state it enqueues into.
    emitToolResult(getCallbacks, "web_search", "tool-1");
    generation.resolve("First narration.");
    await waitFor(() => ttsTexts.includes("First narration."));

    await waitFor(() => ttsTexts.includes("Second narration."));
    expect(generateProgressText).toHaveBeenCalledTimes(2);

    emitMessageComplete(getCallbacks);
  });
});

const CUE_INTERVAL_MS = 40;

// A one-clause answer, so it survives sanitizeForTts unchanged and the text
// the TTS mock records is the text emitted here.
const ANSWER_TEXT = "Here is the answer.";

const WORKING_CUE_CONFIG = {
  enabled: true,
  intervalMs: CUE_INTERVAL_MS,
  // A cue leaves a playback-tail estimate behind, and that tail is part of
  // the silence the next tick waits out. Shortening the tone keeps the
  // silence-to-silence cadence close to the interval so these tests finish in
  // a few hundred milliseconds.
  durationMs: 20,
} as const;

// The cue the session renders for this start frame and config. Comparing
// frames against the renderer's own output is what ties the emitted bytes to
// the configured shape rather than to "some audio came out".
const CUE_PCM = renderWorkingCuePcm(START_FRAME.audio.sampleRate, {
  ...DEFAULT_WORKING_CUE_SHAPE,
  durationMs: WORKING_CUE_CONFIG.durationMs,
});
const CUE_BASE64 = CUE_PCM.toString("base64");

function cueFrames(
  frames: LiveVoiceServerFrame[],
): Extract<LiveVoiceServerFrame, { type: "tts_audio" }>[] {
  return frames.filter(
    (frame): frame is Extract<LiveVoiceServerFrame, { type: "tts_audio" }> =>
      frame.type === "tts_audio" && frame.dataBase64 === CUE_BASE64,
  );
}

// Session state the cue's contract is written against but no frame exposes.
type TurnView = { ttsSegmentEnqueued: boolean; ttsAudioStarted: boolean };

function turnInternals(session: LiveVoiceSession): {
  ttsSegmentEnqueued: () => boolean | undefined;
  ttsAudioStarted: () => boolean | undefined;
  firstTtsAudioAtMs: () => number | null | undefined;
  echoReference: () => Buffer;
  audioIdle: () => boolean;
} {
  const internals = session as unknown as {
    activeAssistantTurn: TurnView | null;
    echoReferenceAudio: Buffer;
    turnAudioIdle: (turn: TurnView) => boolean;
    metrics: {
      getSnapshot: () => {
        activeTurn: { timestamps: { firstTtsAudioAtMs: number | null } } | null;
      };
    };
  };
  return {
    ttsSegmentEnqueued: () => internals.activeAssistantTurn?.ttsSegmentEnqueued,
    ttsAudioStarted: () => internals.activeAssistantTurn?.ttsAudioStarted,
    firstTtsAudioAtMs: () =>
      internals.metrics.getSnapshot().activeTurn?.timestamps.firstTtsAudioAtMs,
    echoReference: () => internals.echoReferenceAudio,
    audioIdle: () => {
      const turn = internals.activeAssistantTurn;
      return turn !== null && internals.turnAudioIdle(turn);
    },
  };
}

// Escalates the turn so it is in the working phase the cue exists for: the
// canned bridge speaks, then the strong leg works in silence.
async function startEscalatedProgressTurn(
  session: LiveVoiceSession,
  getCallbacks: () => VoiceTurnCallbacks | undefined,
  ttsTexts: string[],
): Promise<void> {
  await startReleasedTurn(session, getCallbacks);
  emitTextDelta(getCallbacks, "[1]");
  emitMessageComplete(getCallbacks);
  await waitFor(() => ttsTexts.length === 1);
}

describe("LiveVoiceSession working cue", () => {
  test("an idle escalated turn plays the cue and speaks no narration", async () => {
    const generateProgressText = mock(async () => GENERATED_NARRATION);
    const { frames, session, getCallbacks, ttsTexts } = createProgressHarness({
      // A narrator is wired up and would happily produce text, so what keeps
      // the turn wordless is the config rather than a missing dependency.
      frontModelConfig: progressConfig({
        enabled: false,
        idleIntervalMs: CUE_INTERVAL_MS,
      }),
      workingCueConfig: WORKING_CUE_CONFIG,
      progressNarrator: makeProgressNarrator(generateProgressText),
    });
    await startEscalatedProgressTurn(session, getCallbacks, ttsTexts);

    await waitFor(() => cueFrames(frames).length >= 1);
    const cue = cueFrames(frames)[0];
    // audio/pcm at the session rate: the contract appendEchoReference reads.
    expect(cue?.mimeType).toBe("audio/pcm");
    expect(cue?.sampleRate).toBe(START_FRAME.audio.sampleRate);

    // The bridge is the only thing the turn spoke, and the narrator was never
    // asked for a line to add to it.
    expect(ttsTexts).toHaveLength(1);
    expect(generateProgressText).not.toHaveBeenCalled();
  });

  test("the cue repeats on its interval while the silence lasts", async () => {
    const { frames, session, getCallbacks, ttsTexts } = createProgressHarness({
      frontModelConfig: progressConfig({ enabled: false }),
      workingCueConfig: WORKING_CUE_CONFIG,
      progressNarrator: makeProgressNarrator(async () => GENERATED_NARRATION),
    });
    await startEscalatedProgressTurn(session, getCallbacks, ttsTexts);

    await waitFor(() => cueFrames(frames).length >= 1);
    const afterFirstCueMs = Date.now();
    await waitFor(() => cueFrames(frames).length >= 3);

    // Two further cues cost two further intervals: the cadence is the
    // configured one, not a burst. Timers never fire early, so the lower
    // bound is the reliable half of the assertion.
    expect(Date.now() - afterFirstCueMs).toBeGreaterThanOrEqual(
      2 * CUE_INTERVAL_MS,
    );
    // Every cue is the same rendered audio.
    for (const frame of cueFrames(frames)) {
      expect(frame.dataBase64).toBe(CUE_BASE64);
    }
  });

  test("narration's minGap does not slow the cue's own cadence", async () => {
    // minGapMs is narration's spacing guard, tuned for spoken filler. The cue
    // is spaced by its own intervalMs, so a large narration gap must not veto
    // it: the two tunables live in separate config sections precisely so a
    // workspace can tune one without silently retuning the other.
    const { frames, session, getCallbacks, ttsTexts } = createProgressHarness({
      frontModelConfig: progressConfig({
        enabled: false,
        minGapMs: 60_000,
      }),
      workingCueConfig: WORKING_CUE_CONFIG,
      progressNarrator: makeProgressNarrator(async () => GENERATED_NARRATION),
    });
    await startEscalatedProgressTurn(session, getCallbacks, ttsTexts);

    // A minGap 1500x the cue interval would pin this at one cue forever if the
    // gap applied to the cue.
    await waitFor(() => cueFrames(frames).length >= 3);
    expect(cueFrames(frames).length).toBeGreaterThanOrEqual(3);
  });

  test("a turn whose speech is still playing waits it out before the cue", async () => {
    const speechMs = 150;
    const { frames, session, getCallbacks, ttsTexts } = createProgressHarness({
      frontModelConfig: progressConfig({ enabled: false }),
      workingCueConfig: WORKING_CUE_CONFIG,
      progressNarrator: makeProgressNarrator(async () => GENERATED_NARRATION),
      // The bridge is real audio now, so the turn is audibly busy for
      // `speechMs` after the frame goes out even though its job has settled.
      emitChunkMs: speechMs,
    });
    await startEscalatedProgressTurn(session, getCallbacks, ttsTexts);
    await waitFor(() => frames.some((frame) => frame.type === "tts_audio"));
    const bridgeSentAtMs = Date.now();

    await waitFor(() => cueFrames(frames).length >= 1);

    // Several idle ticks fall inside the bridge's playback, and every one of
    // them stays quiet: a cue over the assistant's own voice is the chatter
    // this design removes, not a reassurance.
    expect(Date.now() - bridgeSentAtMs).toBeGreaterThanOrEqual(speechMs);
  });

  test("tool activity alone plays no cue; only silence does", async () => {
    const { frames, session, getCallbacks, ttsTexts } = createProgressHarness({
      frontModelConfig: progressConfig({ enabled: false, opsThreshold: 1 }),
      // Far longer than this test runs, so nothing here can reach the cue
      // through the idle tick and any cue that appears came from a tool event.
      workingCueConfig: { ...WORKING_CUE_CONFIG, intervalMs: 60_000 },
      progressNarrator: makeProgressNarrator(async () => GENERATED_NARRATION),
    });
    await startEscalatedProgressTurn(session, getCallbacks, ttsTexts);
    // The bridge has to have drained first: a turn that is still speaking has
    // its own reason to stay quiet, and this test is about the trigger.
    await waitFor(() => turnInternals(session).audioIdle());

    emitToolStart(getCallbacks, "web_search", "tool-1");
    emitToolResult(getCallbacks, "web_search", "tool-1", "found it");
    emitToolStart(getCallbacks, "file_read", "tool-2");
    await sleep(CUE_INTERVAL_MS * 3);

    // A tone carries nothing about which tool ran, so a tool starting or
    // finishing is not news it can deliver. Only the silence is.
    expect(cueFrames(frames)).toHaveLength(0);
  });

  test("with both off the working turn stays silent", async () => {
    const generateProgressText = mock(async () => GENERATED_NARRATION);
    const { frames, session, getCallbacks, ttsTexts } = createProgressHarness({
      frontModelConfig: progressConfig({ enabled: false }),
      workingCueConfig: { enabled: false },
      progressNarrator: makeProgressNarrator(generateProgressText),
    });
    await startEscalatedProgressTurn(session, getCallbacks, ttsTexts);

    await sleep(CUE_INTERVAL_MS * 3);
    expect(cueFrames(frames)).toHaveLength(0);
    expect(generateProgressText).not.toHaveBeenCalled();
    expect(ttsTexts).toHaveLength(1);
  });

  test("a pending approval suppresses the cue and still speaks its phrase", async () => {
    const approvalPhrase = sanitizeForTts(approvalPendingPhraseFor()).trim();
    const { frames, session, getCallbacks, approvalPending, ttsTexts } =
      createProgressHarness({
        frontModelConfig: progressConfig({ enabled: false }),
        workingCueConfig: WORKING_CUE_CONFIG,
        progressNarrator: makeProgressNarrator(async () => GENERATED_NARRATION),
      });
    await startEscalatedProgressTurn(session, getCallbacks, ttsTexts);

    approvalPending("approval-request-1");
    await waitFor(() => ttsTexts.includes(approvalPhrase));

    // Nothing is in flight while the call waits on a person, so the cue's
    // claim that work is happening would be false. The turn said so once and
    // then goes quiet.
    await sleep(CUE_INTERVAL_MS * 3);
    expect(cueFrames(frames)).toHaveLength(0);
  });

  test("explicitly enabled narration outranks the cue", async () => {
    const generateProgressText = mock(async () => GENERATED_NARRATION);
    const { frames, session, getCallbacks, ttsTexts } = createProgressHarness({
      // Progress narration defaults to off, so `enabled: true` can only have
      // come from a workspace asking for words. The cue is on as well, and
      // loses.
      frontModelConfig: progressConfig({
        enabled: true,
        idleIntervalMs: CUE_INTERVAL_MS,
      }),
      workingCueConfig: WORKING_CUE_CONFIG,
      progressNarrator: makeProgressNarrator(generateProgressText),
    });
    await startEscalatedProgressTurn(session, getCallbacks, ttsTexts);

    await waitFor(() => ttsTexts.includes(GENERATED_NARRATION));
    // A workspace that asked to be narrated at gets narration only, not
    // narration punctuated by a tone it never configured.
    expect(cueFrames(frames)).toHaveLength(0);
  });

  test("the cue does not anchor the turn's first-TTS metrics", async () => {
    // The answer's synthesis stalls open, so the turn is still active (and its
    // metrics still the live turn's) while the assertions below run.
    const answerSpoken = deferred<void>();
    const { frames, session, getCallbacks, ttsTexts } = createProgressHarness({
      frontModelConfig: progressConfig({ enabled: false }),
      workingCueConfig: WORKING_CUE_CONFIG,
      progressNarrator: makeProgressNarrator(async () => GENERATED_NARRATION),
      gateTtsText: (text) =>
        text === ANSWER_TEXT ? answerSpoken.promise : null,
      // Real bytes per synthesized segment, so the speech below actually
      // reaches forwardTtsChunk and can latch.
      emitChunkMs: 10,
    });
    // A plain turn, so the cue is the first audio of any kind the turn emits.
    await startReleasedTurn(session, getCallbacks);

    await waitFor(() => cueFrames(frames).length >= 1);
    // dispatchToFirstTtsAudioMs, roundTripMs, and
    // firstAssistantDeltaToFirstTtsAudioMs all measure to this mark. Setting
    // it here would report the hum's timing as the turn's speech latency on
    // exactly the long working turns the cue exists for.
    expect(turnInternals(session).ttsAudioStarted()).toBe(false);
    expect(turnInternals(session).firstTtsAudioAtMs()).toBeNull();

    emitTextDelta(getCallbacks, ANSWER_TEXT);
    emitMessageComplete(getCallbacks);
    await waitFor(() => ttsTexts.includes(ANSWER_TEXT));

    // The first real speech still latches: the cue skips the mark, it does not
    // consume it.
    await waitFor(() => turnInternals(session).ttsAudioStarted() === true);
    expect(turnInternals(session).firstTtsAudioAtMs()).not.toBeNull();
    answerSpoken.resolve(undefined);
  });

  test("the cue does not spend the eager first-segment latch", async () => {
    const { frames, session, getCallbacks } = createProgressHarness({
      frontModelConfig: progressConfig({ enabled: false }),
      workingCueConfig: WORKING_CUE_CONFIG,
      progressNarrator: makeProgressNarrator(async () => GENERATED_NARRATION),
    });
    // A plain turn: nothing has been spoken, so the eager first-clause flush
    // is still unspent when the cue plays.
    await startReleasedTurn(session, getCallbacks);

    await waitFor(() => cueFrames(frames).length >= 1);
    expect(turnInternals(session).ttsSegmentEnqueued()).toBe(false);
  });

  test("the cue's chunk enters the echo reference", async () => {
    const { frames, session, getCallbacks } = createProgressHarness({
      frontModelConfig: progressConfig({ enabled: false }),
      workingCueConfig: WORKING_CUE_CONFIG,
      progressNarrator: makeProgressNarrator(async () => GENERATED_NARRATION),
    });
    await startReleasedTurn(session, getCallbacks);

    await waitFor(() => cueFrames(frames).length >= 1);
    // Without this the canceller has no record that the hum was the assistant,
    // and the cue becomes a periodic barge-in trigger.
    const reference = turnInternals(session).echoReference();
    expect(reference.byteLength).toBeGreaterThanOrEqual(CUE_PCM.byteLength);
    expect(reference.subarray(0, CUE_PCM.byteLength).equals(CUE_PCM)).toBe(
      true,
    );
  });
});
