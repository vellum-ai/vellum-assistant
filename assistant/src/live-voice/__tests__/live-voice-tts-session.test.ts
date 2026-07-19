import { afterEach, describe, expect, mock, test } from "bun:test";

import { sanitizeForTts } from "../../calls/tts-text-sanitizer.js";
import type {
  VoiceTurnCallbacks,
  VoiceTurnOptions,
} from "../../calls/voice-session-bridge.js";
import {
  FALLBACK_ESCALATION_BRIDGE,
  VOICE_TRIAGE_ESCALATE_FLAG,
} from "../../calls/voice-triage-escalate.js";
import {
  clearCachedOverrides,
  setCachedOverrides,
} from "../../config/feature-flag-cache.js";
import type { LiveVoiceFrontModelConfig } from "../../config/schemas/live-voice.js";
import type {
  StreamingTranscriber,
  SttStreamServerEvent,
} from "../../stt/types.js";
import { pickAckPhrase } from "../ack-phrases.js";
import type {
  VoiceAckTextInput,
  VoiceFrontDecider,
} from "../front-decision.js";
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

const START_FRAME = {
  type: "start",
  conversationId: "conversation-123",
  audio: {
    mimeType: "audio/pcm",
    sampleRate: 24_000,
    channels: 1,
  },
} as const satisfies LiveVoiceClientStartFrame;

class MockStreamingTranscriber implements StreamingTranscriber {
  readonly providerId = "deepgram" as const;
  readonly boundaryId = "daemon-streaming" as const;
  stopped = false;
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
    this.stopped = true;
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

function createSessionHarness(options: {
  startVoiceTurn: LiveVoiceTurnStarter;
  streamTtsAudio: LiveVoiceTtsStreamer | null;
  frontModelConfig?: Partial<LiveVoiceFrontModelConfig>;
  frontDecider?: VoiceFrontDecider | null;
}) {
  const transcriber = new MockStreamingTranscriber();
  const { context, frames } = createContext();
  const session = new LiveVoiceSession(context, {
    resolveTranscriber: mock(async () => transcriber),
    startVoiceTurn: options.startVoiceTurn,
    streamTtsAudio: options.streamTtsAudio,
    ...(options.frontModelConfig
      ? { frontModelConfig: options.frontModelConfig }
      : {}),
    ...(options.frontDecider !== undefined
      ? { frontDecider: options.frontDecider }
      : {}),
    createTurnId: () => "live-turn-1",
  });

  return { frames, session, transcriber };
}

async function startReleasedTurn(session: LiveVoiceSession): Promise<void> {
  await session.start();
  await session.handleClientFrame({ type: "ptt_release" });
}

async function waitFor(
  predicate: () => boolean,
  message = "Timed out waiting for live voice test condition",
): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

async function flushAsyncCallbacks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function makeTtsChunk(
  text: string,
  contentType = "audio/pcm",
): LiveVoiceTtsAudioChunk {
  return {
    type: "tts_audio",
    contentType,
    sampleRate: 24_000,
    dataBase64: Buffer.from(text).toString("base64"),
  };
}

function makeTtsResult(
  text: string,
  contentType = "audio/pcm",
): LiveVoiceTtsResult {
  return {
    provider: "fish-audio",
    contentType,
    sampleRate: 24_000,
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

function b64(text: string): string {
  return Buffer.from(text).toString("base64");
}

function ttsAudioPayloads(frames: LiveVoiceServerFrame[]): string[] {
  return frames.flatMap((frame) =>
    frame.type === "tts_audio" ? [frame.dataBase64] : [],
  );
}

interface ControlledSynthesis {
  options: LiveVoiceTtsOptions;
  finish: () => void;
  fail: (err: Error) => void;
}

// A TTS streamer whose per-call completion is driven by the test: chunks are
// injected via `calls[n].options.onAudioChunk` and the provider promise
// settles on `finish`/`fail`. `events` records call starts and settles so
// synthesis overlap can be asserted deterministically.
function createControlledTtsStreamer(): {
  streamTtsAudio: LiveVoiceTtsStreamer;
  calls: ControlledSynthesis[];
  events: string[];
} {
  const calls: ControlledSynthesis[] = [];
  const events: string[] = [];
  const streamTtsAudio = mock((options: LiveVoiceTtsOptions) => {
    events.push(`start:${options.text}`);
    return new Promise<LiveVoiceTtsResult>((resolve, reject) => {
      calls.push({
        options,
        finish: () => {
          events.push(`end:${options.text}`);
          resolve(makeTtsResult(options.text));
        },
        fail: (err) => {
          events.push(`fail:${options.text}`);
          reject(err);
        },
      });
    });
  });
  return { streamTtsAudio, calls, events };
}

const FIRST_SENTENCE = "This is the first spoken sentence.";
const SECOND_SENTENCE = "Here comes the second spoken sentence.";
const THIRD_SENTENCE = "And now a third spoken sentence arrives.";

describe("LiveVoiceSession TTS", () => {
  test("starts streaming TTS audio before the assistant message completes at a segment boundary", async () => {
    let callbacks: VoiceTurnCallbacks | undefined;
    const ttsTexts: string[] = [];
    const startVoiceTurn = mock(async (options: VoiceTurnOptions) => {
      callbacks = options.callbacks;
      return { turnId: "bridge-turn-1", abort: mock() };
    });
    const streamTtsAudio = mock(async (options: LiveVoiceTtsOptions) => {
      ttsTexts.push(options.text);
      options.onAudioChunk(makeTtsChunk(`audio:${options.text}`));
      return makeTtsResult(options.text);
    });
    const { frames, session } = createSessionHarness({
      startVoiceTurn,
      streamTtsAudio,
    });

    await startReleasedTurn(session);
    callbacks?.assistant_text_delta?.(makeTextDelta("Hello there."));
    await waitFor(() => frames.some((frame) => frame.type === "tts_audio"));

    expect(ttsTexts).toEqual(["Hello there."]);
    expect(frames.map((frame) => frame.type)).toContain("assistant_text_delta");
    expect(frames.map((frame) => frame.type)).toContain("tts_audio");
    expect(frames.some((frame) => frame.type === "tts_done")).toBe(false);

    callbacks?.assistant_text_delta?.(makeTextDelta(" Still listening"));
    callbacks?.message_complete?.(makeMessageComplete());
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    expect(ttsTexts).toEqual(["Hello there.", "Still listening"]);
    expect(frames.filter((frame) => frame.type === "tts_audio")).toHaveLength(
      2,
    );
    expect(frames.at(-1)).toMatchObject({
      type: "tts_done",
      turnId: "live-turn-1",
    });
  });

  test("flushes the first segment of a turn eagerly at a clause boundary", async () => {
    let callbacks: VoiceTurnCallbacks | undefined;
    const ttsTexts: string[] = [];
    const startVoiceTurn = mock(async (options: VoiceTurnOptions) => {
      callbacks = options.callbacks;
      return { turnId: "bridge-turn-1", abort: mock() };
    });
    const streamTtsAudio = mock(async (options: LiveVoiceTtsOptions) => {
      ttsTexts.push(options.text);
      options.onAudioChunk(makeTtsChunk(`audio:${options.text}`));
      return makeTtsResult(options.text);
    });
    const { frames, session } = createSessionHarness({
      startVoiceTurn,
      streamTtsAudio,
    });

    await startReleasedTurn(session);
    callbacks?.assistant_text_delta?.(
      makeTextDelta(
        "Sure, I can help with that, and here is more text to say.",
      ),
    );
    await waitFor(() => frames.some((frame) => frame.type === "tts_audio"));

    // The opening clause flushes at the comma past the prefix floor instead
    // of waiting for the sentence; the remainder follows sentence rules.
    expect(ttsTexts).toEqual([
      "Sure, I can help with that,",
      "and here is more text to say.",
    ]);

    // Subsequent text in the same turn is not eagerly clause-split.
    callbacks?.assistant_text_delta?.(
      makeTextDelta(" Later we can dig into the details, if you want more"),
    );
    callbacks?.message_complete?.(makeMessageComplete());
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    expect(ttsTexts).toEqual([
      "Sure, I can help with that,",
      "and here is more text to say.",
      "Later we can dig into the details, if you want more",
    ]);
  });

  test("forwards non-PCM TTS chunk content type unchanged", async () => {
    let callbacks: VoiceTurnCallbacks | undefined;
    const startVoiceTurn = mock(async (options: VoiceTurnOptions) => {
      callbacks = options.callbacks;
      return { turnId: "bridge-turn-1", abort: mock() };
    });
    const streamTtsAudio = mock(async (options: LiveVoiceTtsOptions) => {
      options.onAudioChunk(makeTtsChunk("wav audio", "audio/wav"));
      return makeTtsResult("wav audio", "audio/wav");
    });
    const { frames, session } = createSessionHarness({
      startVoiceTurn,
      streamTtsAudio,
    });

    await startReleasedTurn(session);
    callbacks?.assistant_text_delta?.(makeTextDelta("Hello there."));
    await waitFor(() => frames.some((frame) => frame.type === "tts_audio"));

    expect(frames.find((frame) => frame.type === "tts_audio")).toMatchObject({
      type: "tts_audio",
      mimeType: "audio/wav",
      dataBase64: Buffer.from("wav audio").toString("base64"),
    });
  });

  test("flushes long unpunctuated assistant text before completion at the eager threshold", async () => {
    let callbacks: VoiceTurnCallbacks | undefined;
    const ttsTexts: string[] = [];
    const startVoiceTurn = mock(async (options: VoiceTurnOptions) => {
      callbacks = options.callbacks;
      return { turnId: "bridge-turn-1", abort: mock() };
    });
    const streamTtsAudio = mock(async (options: LiveVoiceTtsOptions) => {
      ttsTexts.push(options.text);
      options.onAudioChunk(makeTtsChunk(`audio:${options.text}`));
      return makeTtsResult(options.text);
    });
    const { frames, session } = createSessionHarness({
      startVoiceTurn,
      streamTtsAudio,
    });

    await startReleasedTurn(session);
    callbacks?.assistant_text_delta?.(makeTextDelta("steady ".repeat(32)));
    await waitFor(() => frames.some((frame) => frame.type === "tts_audio"));

    // The turn's first segment splits at the eager threshold; the rest stays
    // buffered under sentence rules until more text or completion arrives.
    expect(ttsTexts).toHaveLength(1);
    expect(ttsTexts[0]?.length).toBeGreaterThan(30);
    expect(ttsTexts[0]?.length).toBeLessThanOrEqual(60);
    expect(frames.some((frame) => frame.type === "tts_done")).toBe(false);
  });

  test("reports TTS errors without cancelling the persisted assistant text turn", async () => {
    let callbacks: VoiceTurnCallbacks | undefined;
    const abort = mock();
    const startVoiceTurn = mock(async (options: VoiceTurnOptions) => {
      callbacks = options.callbacks;
      return { turnId: "bridge-turn-1", abort };
    });
    const streamTtsAudio = mock(async () => {
      throw new Error("provider unavailable");
    });
    const { frames, session } = createSessionHarness({
      startVoiceTurn,
      streamTtsAudio,
    });

    await startReleasedTurn(session);
    callbacks?.assistant_text_delta?.(makeTextDelta("This should persist."));
    await waitFor(() => frames.some((frame) => frame.type === "error"));
    callbacks?.message_complete?.(makeMessageComplete());
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    expect(abort).not.toHaveBeenCalled();
    expect(
      frames.some(
        (frame) =>
          frame.type === "assistant_text_delta" &&
          frame.text === "This should persist.",
      ),
    ).toBe(true);
    expect(frames.find((frame) => frame.type === "error")).toMatchObject({
      type: "error",
      message: expect.stringContaining("provider unavailable"),
      recoverable: true,
    });
    expect(frames.at(-1)).toMatchObject({
      type: "tts_done",
      turnId: "live-turn-1",
    });
  });

  test("sanitizes markdown spanning deltas before TTS while deltas stay raw", async () => {
    let callbacks: VoiceTurnCallbacks | undefined;
    const ttsTexts: string[] = [];
    const startVoiceTurn = mock(async (options: VoiceTurnOptions) => {
      callbacks = options.callbacks;
      return { turnId: "bridge-turn-1", abort: mock() };
    });
    const streamTtsAudio = mock(async (options: LiveVoiceTtsOptions) => {
      ttsTexts.push(options.text);
      options.onAudioChunk(makeTtsChunk(`audio:${options.text}`));
      return makeTtsResult(options.text);
    });
    const { frames, session } = createSessionHarness({
      startVoiceTurn,
      streamTtsAudio,
    });

    await startReleasedTurn(session);
    callbacks?.assistant_text_delta?.(makeTextDelta("Use **bo"));
    callbacks?.assistant_text_delta?.(makeTextDelta("ld** and `code` now. 🎉"));
    callbacks?.message_complete?.(makeMessageComplete());
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    expect(ttsTexts).toEqual(["Use bold and code now."]);
    expect(
      frames.flatMap((frame) =>
        frame.type === "assistant_text_delta" ? [frame.text] : [],
      ),
    ).toEqual(["Use **bo", "ld** and `code` now. 🎉"]);
  });

  test("skips synthesis entirely for segments that sanitize to nothing", async () => {
    let callbacks: VoiceTurnCallbacks | undefined;
    const startVoiceTurn = mock(async (options: VoiceTurnOptions) => {
      callbacks = options.callbacks;
      return { turnId: "bridge-turn-1", abort: mock() };
    });
    const streamTtsAudio = mock(async (options: LiveVoiceTtsOptions) => {
      options.onAudioChunk(makeTtsChunk(`audio:${options.text}`));
      return makeTtsResult(options.text);
    });
    const { frames, session } = createSessionHarness({
      startVoiceTurn,
      streamTtsAudio,
    });

    await startReleasedTurn(session);
    callbacks?.assistant_text_delta?.(makeTextDelta("### 🎉👍"));
    callbacks?.message_complete?.(makeMessageComplete());
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    expect(streamTtsAudio).not.toHaveBeenCalled();
    expect(frames.some((frame) => frame.type === "tts_audio")).toBe(false);
    expect(frames.at(-1)).toMatchObject({
      type: "tts_done",
      turnId: "live-turn-1",
    });
  });

  test("interrupt prevents late TTS chunks from reaching the socket", async () => {
    let callbacks: VoiceTurnCallbacks | undefined;
    let ttsOptions: LiveVoiceTtsOptions | undefined;
    let resolveTts: ((result: LiveVoiceTtsResult) => void) | undefined;
    const abort = mock();
    const startVoiceTurn = mock(async (options: VoiceTurnOptions) => {
      callbacks = options.callbacks;
      return { turnId: "bridge-turn-1", abort };
    });
    const streamTtsAudio = mock(
      (options: LiveVoiceTtsOptions) =>
        new Promise<LiveVoiceTtsResult>((resolve) => {
          ttsOptions = options;
          resolveTts = resolve;
        }),
    );
    const { frames, session } = createSessionHarness({
      startVoiceTurn,
      streamTtsAudio,
    });

    await startReleasedTurn(session);
    callbacks?.assistant_text_delta?.(makeTextDelta("Please speak now."));
    await waitFor(() => ttsOptions !== undefined);

    await session.handleClientFrame({ type: "interrupt" });
    const frameCountAfterInterrupt = frames.length;
    ttsOptions?.onAudioChunk(makeTtsChunk("late audio"));
    resolveTts?.(makeTtsResult("late audio"));
    await flushAsyncCallbacks();

    expect(ttsOptions?.signal?.aborted).toBe(true);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(frames).toHaveLength(frameCountAfterInterrupt);
    expect(frames.some((frame) => frame.type === "tts_audio")).toBe(false);
    expect(frames.some((frame) => frame.type === "tts_done")).toBe(false);
  });

  test("prefetches the next segment while the current one streams and emits frames strictly in order", async () => {
    let callbacks: VoiceTurnCallbacks | undefined;
    const startVoiceTurn = mock(async (options: VoiceTurnOptions) => {
      callbacks = options.callbacks;
      return { turnId: "bridge-turn-1", abort: mock() };
    });
    const { streamTtsAudio, calls, events } = createControlledTtsStreamer();
    const { frames, session } = createSessionHarness({
      startVoiceTurn,
      streamTtsAudio,
    });

    await startReleasedTurn(session);
    callbacks?.assistant_text_delta?.(makeTextDelta(FIRST_SENTENCE));
    callbacks?.assistant_text_delta?.(makeTextDelta(` ${SECOND_SENTENCE}`));

    // Both provider calls are in flight before either stream settles.
    expect(events).toEqual([
      `start:${FIRST_SENTENCE}`,
      `start:${SECOND_SENTENCE}`,
    ]);

    // A chunk from the prefetching second segment buffers instead of
    // jumping ahead of the still-streaming first segment.
    calls[1]?.options.onAudioChunk(makeTtsChunk("audio:second-1"));
    await flushAsyncCallbacks();
    expect(ttsAudioPayloads(frames)).toEqual([]);

    calls[0]?.options.onAudioChunk(makeTtsChunk("audio:first-1"));
    calls[0]?.options.onAudioChunk(makeTtsChunk("audio:first-2"));
    calls[0]?.finish();
    await waitFor(() =>
      frames.some(
        (frame) =>
          frame.type === "tts_audio" &&
          frame.dataBase64 === b64("audio:second-1"),
      ),
    );

    calls[1]?.options.onAudioChunk(makeTtsChunk("audio:second-2"));
    calls[1]?.finish();
    callbacks?.message_complete?.(makeMessageComplete());
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    expect(streamTtsAudio).toHaveBeenCalledTimes(2);
    expect(ttsAudioPayloads(frames)).toEqual([
      b64("audio:first-1"),
      b64("audio:first-2"),
      b64("audio:second-1"),
      b64("audio:second-2"),
    ]);
    expect(frames.at(-1)).toMatchObject({
      type: "tts_done",
      turnId: "live-turn-1",
    });
  });

  test("holds further segments as text until a slot frees and defers tts_done until every job drains", async () => {
    let callbacks: VoiceTurnCallbacks | undefined;
    const startVoiceTurn = mock(async (options: VoiceTurnOptions) => {
      callbacks = options.callbacks;
      return { turnId: "bridge-turn-1", abort: mock() };
    });
    const { streamTtsAudio, calls } = createControlledTtsStreamer();
    const { frames, session } = createSessionHarness({
      startVoiceTurn,
      streamTtsAudio,
    });

    await startReleasedTurn(session);
    callbacks?.assistant_text_delta?.(makeTextDelta(FIRST_SENTENCE));
    callbacks?.assistant_text_delta?.(makeTextDelta(` ${SECOND_SENTENCE}`));
    callbacks?.assistant_text_delta?.(makeTextDelta(` ${THIRD_SENTENCE}`));
    callbacks?.message_complete?.(makeMessageComplete());

    // Two lookahead slots: the third segment stays queued as text.
    expect(calls).toHaveLength(2);

    calls[0]?.options.onAudioChunk(makeTtsChunk("audio:one"));
    calls[0]?.finish();
    await waitFor(() => calls.length === 3);
    expect(frames.some((frame) => frame.type === "tts_done")).toBe(false);

    calls[1]?.options.onAudioChunk(makeTtsChunk("audio:two"));
    calls[1]?.finish();
    await flushAsyncCallbacks();
    expect(frames.some((frame) => frame.type === "tts_done")).toBe(false);

    calls[2]?.options.onAudioChunk(makeTtsChunk("audio:three"));
    calls[2]?.finish();
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    expect(ttsAudioPayloads(frames)).toEqual([
      b64("audio:one"),
      b64("audio:two"),
      b64("audio:three"),
    ]);
    expect(frames.at(-1)).toMatchObject({
      type: "tts_done",
      turnId: "live-turn-1",
    });
  });

  test("overlapped synthesis finishes two delayed segments in about one delay, not two", async () => {
    const synthesisDelayMs = 150;
    let callbacks: VoiceTurnCallbacks | undefined;
    const startVoiceTurn = mock(async (options: VoiceTurnOptions) => {
      callbacks = options.callbacks;
      return { turnId: "bridge-turn-1", abort: mock() };
    });
    const events: string[] = [];
    const streamTtsAudio = mock(async (options: LiveVoiceTtsOptions) => {
      events.push(`start:${options.text}`);
      await new Promise((resolve) => setTimeout(resolve, synthesisDelayMs));
      options.onAudioChunk(makeTtsChunk(`audio:${options.text}`));
      events.push(`end:${options.text}`);
      return makeTtsResult(options.text);
    });
    const { frames, session } = createSessionHarness({
      startVoiceTurn,
      streamTtsAudio,
    });

    await startReleasedTurn(session);
    const startedAt = performance.now();
    callbacks?.assistant_text_delta?.(makeTextDelta(FIRST_SENTENCE));
    callbacks?.assistant_text_delta?.(makeTextDelta(` ${SECOND_SENTENCE}`));
    callbacks?.message_complete?.(makeMessageComplete());
    const deadline = startedAt + synthesisDelayMs * 4;
    while (
      !frames.some((frame) => frame.type === "tts_done") &&
      performance.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const elapsedMs = performance.now() - startedAt;

    // Both provider calls start before either finishes, so the two
    // first-chunk delays overlap instead of stacking.
    expect(events.slice(0, 2)).toEqual([
      `start:${FIRST_SENTENCE}`,
      `start:${SECOND_SENTENCE}`,
    ]);
    expect(elapsedMs).toBeLessThan(synthesisDelayMs * 2);
    expect(ttsAudioPayloads(frames)).toEqual([
      b64(`audio:${FIRST_SENTENCE}`),
      b64(`audio:${SECOND_SENTENCE}`),
    ]);
    expect(frames.at(-1)).toMatchObject({
      type: "tts_done",
      turnId: "live-turn-1",
    });
  });

  test("drops buffered prefetch audio when the turn is cancelled mid-prefetch", async () => {
    let callbacks: VoiceTurnCallbacks | undefined;
    const abort = mock();
    const startVoiceTurn = mock(async (options: VoiceTurnOptions) => {
      callbacks = options.callbacks;
      return { turnId: "bridge-turn-1", abort };
    });
    const { streamTtsAudio, calls } = createControlledTtsStreamer();
    const { frames, session } = createSessionHarness({
      startVoiceTurn,
      streamTtsAudio,
    });

    await startReleasedTurn(session);
    callbacks?.assistant_text_delta?.(makeTextDelta(FIRST_SENTENCE));
    callbacks?.assistant_text_delta?.(makeTextDelta(` ${SECOND_SENTENCE}`));
    calls[0]?.options.onAudioChunk(makeTtsChunk("audio:first-1"));
    calls[1]?.options.onAudioChunk(makeTtsChunk("audio:second-1"));
    await waitFor(() => frames.some((frame) => frame.type === "tts_audio"));

    // Cancellation runs the same abort path as a VAD barge-in: the shared
    // turn signal aborts both in-flight provider streams at once.
    await session.handleClientFrame({ type: "interrupt" });
    const frameCountAfterInterrupt = frames.length;
    expect(calls[0]?.options.signal?.aborted).toBe(true);
    expect(calls[1]?.options.signal?.aborted).toBe(true);

    calls[1]?.options.onAudioChunk(makeTtsChunk("audio:second-2"));
    calls[0]?.finish();
    calls[1]?.finish();
    await flushAsyncCallbacks();

    expect(frames).toHaveLength(frameCountAfterInterrupt);
    expect(ttsAudioPayloads(frames)).toEqual([b64("audio:first-1")]);
    expect(frames.some((frame) => frame.type === "tts_done")).toBe(false);
  });

  test("emits a recoverable error for a failed prefetch and keeps later segments in order", async () => {
    let callbacks: VoiceTurnCallbacks | undefined;
    const abort = mock();
    const startVoiceTurn = mock(async (options: VoiceTurnOptions) => {
      callbacks = options.callbacks;
      return { turnId: "bridge-turn-1", abort };
    });
    const { streamTtsAudio, calls } = createControlledTtsStreamer();
    const { frames, session } = createSessionHarness({
      startVoiceTurn,
      streamTtsAudio,
    });

    await startReleasedTurn(session);
    callbacks?.assistant_text_delta?.(makeTextDelta(FIRST_SENTENCE));
    callbacks?.assistant_text_delta?.(makeTextDelta(` ${SECOND_SENTENCE}`));
    callbacks?.assistant_text_delta?.(makeTextDelta(` ${THIRD_SENTENCE}`));
    callbacks?.message_complete?.(makeMessageComplete());

    // The prefetch fails while the first segment is still streaming.
    calls[1]?.fail(new Error("prefetch exploded"));
    calls[0]?.options.onAudioChunk(makeTtsChunk("audio:one"));
    calls[0]?.finish();
    await waitFor(() => calls.length === 3);
    calls[2]?.options.onAudioChunk(makeTtsChunk("audio:three"));
    calls[2]?.finish();
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    expect(abort).not.toHaveBeenCalled();
    expect(ttsAudioPayloads(frames)).toEqual([
      b64("audio:one"),
      b64("audio:three"),
    ]);
    const firstAudioIndex = frames.findIndex(
      (frame) =>
        frame.type === "tts_audio" && frame.dataBase64 === b64("audio:one"),
    );
    const errorIndex = frames.findIndex((frame) => frame.type === "error");
    const thirdAudioIndex = frames.findIndex(
      (frame) =>
        frame.type === "tts_audio" && frame.dataBase64 === b64("audio:three"),
    );
    expect(frames[errorIndex]).toMatchObject({
      type: "error",
      message: expect.stringContaining("prefetch exploded"),
      recoverable: true,
    });
    expect(firstAudioIndex).toBeLessThan(errorIndex);
    expect(errorIndex).toBeLessThan(thirdAudioIndex);
    expect(frames.at(-1)).toMatchObject({
      type: "tts_done",
      turnId: "live-turn-1",
    });
  });
});

describe("LiveVoiceSession spoken ack (voice-front-model)", () => {
  afterEach(() => clearCachedOverrides());

  const ACK_TIMEOUT_MS = 40;
  // The ack passes through the same TTS sanitizer as regular segments.
  const EXPECTED_ACK = sanitizeForTts(pickAckPhrase("first_delta", 0)).trim();

  function enableFrontModel(): void {
    setCachedOverrides({ "voice-front-model": true }, { fromGateway: true });
  }

  const EXPECTED_BRIDGE = sanitizeForTts(FALLBACK_ESCALATION_BRIDGE).trim();

  function enableFrontModelWithEscalation(): void {
    setCachedOverrides(
      {
        "voice-front-model": true,
        "voice-mode": true,
        [VOICE_TRIAGE_ESCALATE_FLAG]: true,
      },
      { fromGateway: true },
    );
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
      options.onAudioChunk(makeTtsChunk(`audio:${options.text}`));
      return makeTtsResult(options.text);
    });
    return { streamTtsAudio, ttsTexts };
  }

  test("speaks exactly one audio-only ack before agent audio on a slow first delta", async () => {
    enableFrontModel();
    const { startVoiceTurn, getCallbacks } = createCapturingTurnStarter();
    const { streamTtsAudio, ttsTexts } = createRecordingTtsStreamer();
    const { frames, session } = createSessionHarness({
      startVoiceTurn,
      streamTtsAudio,
      frontModelConfig: { ackFirstDeltaTimeoutMs: ACK_TIMEOUT_MS },
    });

    await startReleasedTurn(session);
    await waitFor(() =>
      frames.some(
        (frame) =>
          frame.type === "tts_audio" &&
          frame.dataBase64 === b64(`audio:${EXPECTED_ACK}`),
      ),
    );

    // Audio-only: no caption frame carries the ack text, and the turn is
    // still open (no tts_done).
    expect(ttsTexts).toEqual([EXPECTED_ACK]);
    expect(frames.some((frame) => frame.type === "assistant_text_delta")).toBe(
      false,
    );
    expect(frames.some((frame) => frame.type === "tts_done")).toBe(false);

    getCallbacks()?.assistant_text_delta?.(makeTextDelta("Hello there."));
    getCallbacks()?.message_complete?.(makeMessageComplete());
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    expect(ttsTexts).toEqual([EXPECTED_ACK, "Hello there."]);
    expect(ttsAudioPayloads(frames)).toEqual([
      b64(`audio:${EXPECTED_ACK}`),
      b64("audio:Hello there."),
    ]);
    expect(frames.filter((frame) => frame.type === "tts_done")).toHaveLength(1);
    expect(frames.at(-1)).toMatchObject({
      type: "tts_done",
      turnId: "live-turn-1",
    });
  });

  test("speaks no ack when the first delta beats the timeout", async () => {
    enableFrontModel();
    const { startVoiceTurn, getCallbacks } = createCapturingTurnStarter();
    const { streamTtsAudio, ttsTexts } = createRecordingTtsStreamer();
    const { frames, session } = createSessionHarness({
      startVoiceTurn,
      streamTtsAudio,
      frontModelConfig: { ackFirstDeltaTimeoutMs: ACK_TIMEOUT_MS },
    });

    await startReleasedTurn(session);
    getCallbacks()?.assistant_text_delta?.(makeTextDelta("Hello there."));
    getCallbacks()?.message_complete?.(makeMessageComplete());
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));
    await new Promise((resolve) => setTimeout(resolve, ACK_TIMEOUT_MS + 40));

    expect(ttsTexts).toEqual(["Hello there."]);
    expect(ttsAudioPayloads(frames)).toEqual([b64("audio:Hello there.")]);
  });

  test("interrupt before the timeout clears the timer and speaks no ack", async () => {
    enableFrontModel();
    const { startVoiceTurn } = createCapturingTurnStarter();
    const { streamTtsAudio, ttsTexts } = createRecordingTtsStreamer();
    const { frames, session } = createSessionHarness({
      startVoiceTurn,
      streamTtsAudio,
      frontModelConfig: { ackFirstDeltaTimeoutMs: ACK_TIMEOUT_MS },
    });

    await startReleasedTurn(session);
    await session.handleClientFrame({ type: "interrupt" });
    await new Promise((resolve) => setTimeout(resolve, ACK_TIMEOUT_MS + 40));

    expect(ttsTexts).toEqual([]);
    expect(frames.some((frame) => frame.type === "tts_audio")).toBe(false);
  });

  test("arms no ack when the flag is off", async () => {
    const { startVoiceTurn, getCallbacks } = createCapturingTurnStarter();
    const { streamTtsAudio, ttsTexts } = createRecordingTtsStreamer();
    const { frames, session } = createSessionHarness({
      startVoiceTurn,
      streamTtsAudio,
      frontModelConfig: { ackFirstDeltaTimeoutMs: ACK_TIMEOUT_MS },
    });

    await startReleasedTurn(session);
    await new Promise((resolve) => setTimeout(resolve, ACK_TIMEOUT_MS + 40));
    expect(ttsTexts).toEqual([]);

    getCallbacks()?.assistant_text_delta?.(makeTextDelta("Hello there."));
    getCallbacks()?.message_complete?.(makeMessageComplete());
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));
    expect(ttsTexts).toEqual(["Hello there."]);
  });

  test("arms no ack without a TTS streamer", async () => {
    enableFrontModel();
    const { startVoiceTurn, getCallbacks } = createCapturingTurnStarter();
    const { frames, session } = createSessionHarness({
      startVoiceTurn,
      streamTtsAudio: null,
      frontModelConfig: { ackFirstDeltaTimeoutMs: ACK_TIMEOUT_MS },
    });

    await startReleasedTurn(session);
    await new Promise((resolve) => setTimeout(resolve, ACK_TIMEOUT_MS + 40));
    expect(frames.some((frame) => frame.type === "tts_audio")).toBe(false);

    getCallbacks()?.assistant_text_delta?.(makeTextDelta("Hello there."));
    getCallbacks()?.message_complete?.(makeMessageComplete());
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));
    expect(frames.some((frame) => frame.type === "tts_audio")).toBe(false);
  });

  test("keeps the eager first-clause flush for the model's first segment after an ack", async () => {
    enableFrontModel();
    const { startVoiceTurn, getCallbacks } = createCapturingTurnStarter();
    const { streamTtsAudio, ttsTexts } = createRecordingTtsStreamer();
    const { frames, session } = createSessionHarness({
      startVoiceTurn,
      streamTtsAudio,
      frontModelConfig: { ackFirstDeltaTimeoutMs: ACK_TIMEOUT_MS },
    });

    await startReleasedTurn(session);
    await waitFor(() => ttsTexts.length === 1);
    expect(ttsTexts).toEqual([EXPECTED_ACK]);

    getCallbacks()?.assistant_text_delta?.(
      makeTextDelta(
        "Sure, I can help with that, and here is more text to say.",
      ),
    );
    await waitFor(() => ttsTexts.length === 3);

    // The ack did not consume the eager first-segment flush: the model's
    // opening clause still splits at the comma instead of buffering to a
    // full sentence.
    expect(ttsTexts).toEqual([
      EXPECTED_ACK,
      "Sure, I can help with that,",
      "and here is more text to say.",
    ]);

    getCallbacks()?.message_complete?.(makeMessageComplete());
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));
    expect(frames.at(-1)).toMatchObject({
      type: "tts_done",
      turnId: "live-turn-1",
    });
  });

  function makeStubFrontDecider(
    generateAckText: VoiceFrontDecider["generateAckText"],
  ): VoiceFrontDecider {
    return {
      decideEndpoint: async () => ({ action: "release" }),
      generateAckText,
    };
  }

  test("llmAckText on: speaks the front-model-phrased ack", async () => {
    enableFrontModel();
    const GENERATED = "Sure — one moment.";
    // The generated text passes through the same TTS sanitizer as the
    // static phrase.
    const EXPECTED_GENERATED = sanitizeForTts(GENERATED).trim();
    const generateAckText = mock(async (ackInput: VoiceAckTextInput) => {
      expect(ackInput.transcriptSoFar).toBe("hello");
      return GENERATED;
    });
    const { startVoiceTurn, getCallbacks } = createCapturingTurnStarter();
    const { streamTtsAudio, ttsTexts } = createRecordingTtsStreamer();
    const { frames, session } = createSessionHarness({
      startVoiceTurn,
      streamTtsAudio,
      frontModelConfig: {
        ackFirstDeltaTimeoutMs: ACK_TIMEOUT_MS,
        llmAckText: true,
      },
      frontDecider: makeStubFrontDecider(generateAckText),
    });

    await startReleasedTurn(session);
    await waitFor(() => ttsTexts.length === 1);
    expect(ttsTexts).toEqual([EXPECTED_GENERATED]);
    expect(generateAckText).toHaveBeenCalledTimes(1);

    getCallbacks()?.assistant_text_delta?.(makeTextDelta("Hello there."));
    getCallbacks()?.message_complete?.(makeMessageComplete());
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));
    expect(ttsTexts).toEqual([EXPECTED_GENERATED, "Hello there."]);
  });

  test("llmAckText on: null generation falls back to the static phrase", async () => {
    enableFrontModel();
    const generateAckText = mock(async () => null);
    const { startVoiceTurn, getCallbacks } = createCapturingTurnStarter();
    const { streamTtsAudio, ttsTexts } = createRecordingTtsStreamer();
    const { frames, session } = createSessionHarness({
      startVoiceTurn,
      streamTtsAudio,
      frontModelConfig: {
        ackFirstDeltaTimeoutMs: ACK_TIMEOUT_MS,
        llmAckText: true,
      },
      frontDecider: makeStubFrontDecider(generateAckText),
    });

    await startReleasedTurn(session);
    await waitFor(() => ttsTexts.length === 1);
    expect(ttsTexts).toEqual([EXPECTED_ACK]);
    expect(generateAckText).toHaveBeenCalledTimes(1);

    getCallbacks()?.assistant_text_delta?.(makeTextDelta("Hello there."));
    getCallbacks()?.message_complete?.(makeMessageComplete());
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));
  });

  test("llmAckText off (default): the decider is never consulted", async () => {
    enableFrontModel();
    const generateAckText = mock(async () => "Never spoken.");
    const { startVoiceTurn, getCallbacks } = createCapturingTurnStarter();
    const { streamTtsAudio, ttsTexts } = createRecordingTtsStreamer();
    const { frames, session } = createSessionHarness({
      startVoiceTurn,
      streamTtsAudio,
      frontModelConfig: { ackFirstDeltaTimeoutMs: ACK_TIMEOUT_MS },
      frontDecider: makeStubFrontDecider(generateAckText),
    });

    await startReleasedTurn(session);
    await waitFor(() => ttsTexts.length === 1);
    expect(ttsTexts).toEqual([EXPECTED_ACK]);
    expect(generateAckText).not.toHaveBeenCalled();

    getCallbacks()?.assistant_text_delta?.(makeTextDelta("Hello there."));
    getCallbacks()?.message_complete?.(makeMessageComplete());
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));
  });

  test("llmAckText on: a generation resolving around turn completion speaks no ack", async () => {
    enableFrontModel();
    let resolveGeneration!: (text: string | null) => void;
    const generateAckText = mock(
      () =>
        new Promise<string | null>((resolve) => {
          resolveGeneration = resolve;
        }),
    );
    const { startVoiceTurn, getCallbacks } = createCapturingTurnStarter();
    const { streamTtsAudio, ttsTexts } = createRecordingTtsStreamer();
    const { frames, session } = createSessionHarness({
      startVoiceTurn,
      streamTtsAudio,
      frontModelConfig: {
        ackFirstDeltaTimeoutMs: ACK_TIMEOUT_MS,
        llmAckText: true,
      },
      frontDecider: makeStubFrontDecider(generateAckText),
    });

    await startReleasedTurn(session);
    await waitFor(() => generateAckText.mock.calls.length === 1);

    // A tool-only/no-text turn completes while the ack text is still
    // generating: the resolving generation must not become the turn's only
    // audible output (nor enqueue behind the finale).
    resolveGeneration("Too late to say this.");
    getCallbacks()?.message_complete?.(makeMessageComplete());
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));
    await flushAsyncCallbacks();

    // No ack synthesized or sent — and since the ack-spoken metric only
    // records on an actual enqueue, no phantom ack metric either.
    expect(ttsTexts).toEqual([]);
    expect(frames.some((frame) => frame.type === "tts_audio")).toBe(false);
  });

  test("llmAckText on: a tool-use ack passes the tool name to the decider", async () => {
    enableFrontModel();
    const GENERATED = "Let me search for that.";
    const generateAckText = mock(
      async (_input: VoiceAckTextInput) => GENERATED,
    );
    const { startVoiceTurn, getCallbacks } = createCapturingTurnStarter();
    const { streamTtsAudio, ttsTexts } = createRecordingTtsStreamer();
    const { frames, session } = createSessionHarness({
      startVoiceTurn,
      streamTtsAudio,
      // Long first-delta budget so only the tool-use trigger can speak.
      frontModelConfig: { ackFirstDeltaTimeoutMs: 5_000, llmAckText: true },
      frontDecider: makeStubFrontDecider(generateAckText),
    });

    await startReleasedTurn(session);
    getCallbacks()?.tool_use_start?.("web_search");
    await waitFor(() => ttsTexts.length === 1);

    expect(generateAckText).toHaveBeenCalledTimes(1);
    expect(generateAckText.mock.calls[0]?.[0]).toEqual({
      transcriptSoFar: "hello",
      toolName: "web_search",
    });
    expect(ttsTexts).toEqual([sanitizeForTts(GENERATED).trim()]);

    getCallbacks()?.assistant_text_delta?.(makeTextDelta("Hello there."));
    getCallbacks()?.message_complete?.(makeMessageComplete());
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));
  });

  test("llmAckText on: a generation resolving after escalation hand-off speaks no ack", async () => {
    enableFrontModelWithEscalation();
    let resolveGeneration!: (text: string | null) => void;
    const generateAckText = mock(
      () =>
        new Promise<string | null>((resolve) => {
          resolveGeneration = resolve;
        }),
    );
    const { startVoiceTurn, getCallbacks } = createCapturingTurnStarter();
    const { streamTtsAudio, ttsTexts } = createRecordingTtsStreamer();
    const { frames, session } = createSessionHarness({
      startVoiceTurn,
      streamTtsAudio,
      frontModelConfig: {
        ackFirstDeltaTimeoutMs: ACK_TIMEOUT_MS,
        llmAckText: true,
      },
      frontDecider: makeStubFrontDecider(generateAckText),
    });

    await startReleasedTurn(session);
    await waitFor(() => generateAckText.mock.calls.length === 1);

    // The front-door leg escalates with no holding phrase of its own, so the
    // canned bridge is enqueued — exactly the case where a late-resolving
    // generation would stack a second filler on top of it.
    getCallbacks()?.assistant_text_delta?.(makeTextDelta("[ESCALATE]"));
    await waitFor(() => ttsTexts.length === 1);
    expect(ttsTexts).toEqual([EXPECTED_BRIDGE]);

    resolveGeneration("Stacked filler.");
    await flushAsyncCallbacks();
    expect(ttsTexts).toEqual([EXPECTED_BRIDGE]);

    // The escalated leg (whose callbacks the capturing starter now holds)
    // finishes the turn normally.
    getCallbacks()?.assistant_text_delta?.(
      makeTextDelta("Here is the careful answer."),
    );
    getCallbacks()?.message_complete?.(makeMessageComplete());
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));
    expect(ttsTexts).toEqual([EXPECTED_BRIDGE, "Here is the careful answer."]);
  });

  test("static ack: a tool started on the escalated leg speaks nothing past the bridge", async () => {
    enableFrontModelWithEscalation();
    const { startVoiceTurn, getCallbacks } = createCapturingTurnStarter();
    const { streamTtsAudio, ttsTexts } = createRecordingTtsStreamer();
    const { frames, session } = createSessionHarness({
      startVoiceTurn,
      streamTtsAudio,
      // Long first-delta budget so only the tool-use trigger could speak.
      frontModelConfig: { ackFirstDeltaTimeoutMs: 5_000 },
    });

    await startReleasedTurn(session);
    // A bare hand-off enqueues the canned bridge, which holds the floor.
    getCallbacks()?.assistant_text_delta?.(makeTextDelta("[ESCALATE]"));
    await waitFor(() => ttsTexts.length === 1);
    expect(ttsTexts).toEqual([EXPECTED_BRIDGE]);

    // The escalated leg starts a tool before its first delta: no static ack
    // may stack on the bridge.
    getCallbacks()?.tool_use_start?.("web_search");
    await flushAsyncCallbacks();
    expect(ttsTexts).toEqual([EXPECTED_BRIDGE]);

    getCallbacks()?.assistant_text_delta?.(
      makeTextDelta("Here is the careful answer."),
    );
    getCallbacks()?.message_complete?.(makeMessageComplete());
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));
    expect(ttsTexts).toEqual([EXPECTED_BRIDGE, "Here is the careful answer."]);
  });

  test("llmAckText on: tools started on the escalated leg trigger no ack generation", async () => {
    enableFrontModelWithEscalation();
    const generateAckText = mock(async () => "Never spoken.");
    const { startVoiceTurn, getCallbacks } = createCapturingTurnStarter();
    const { streamTtsAudio, ttsTexts } = createRecordingTtsStreamer();
    const { frames, session } = createSessionHarness({
      startVoiceTurn,
      streamTtsAudio,
      // Long first-delta budget so only the tool-use trigger could generate.
      frontModelConfig: { ackFirstDeltaTimeoutMs: 5_000, llmAckText: true },
      frontDecider: makeStubFrontDecider(generateAckText),
    });

    await startReleasedTurn(session);
    getCallbacks()?.assistant_text_delta?.(makeTextDelta("[ESCALATE]"));
    await waitFor(() => ttsTexts.length === 1);
    expect(ttsTexts).toEqual([EXPECTED_BRIDGE]);

    // Post-handoff tool starts must not each burn a generation call whose
    // result is always discarded.
    getCallbacks()?.tool_use_start?.("web_search");
    getCallbacks()?.tool_use_start?.("file_read");
    await flushAsyncCallbacks();
    expect(generateAckText).not.toHaveBeenCalled();
    expect(ttsTexts).toEqual([EXPECTED_BRIDGE]);

    getCallbacks()?.assistant_text_delta?.(
      makeTextDelta("Here is the careful answer."),
    );
    getCallbacks()?.message_complete?.(makeMessageComplete());
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));
    expect(ttsTexts).toEqual([EXPECTED_BRIDGE, "Here is the careful answer."]);
  });

  test("llmAckText on: a first delta during generation skips the ack entirely", async () => {
    enableFrontModel();
    let resolveGeneration!: (text: string | null) => void;
    const generateAckText = mock(
      () =>
        new Promise<string | null>((resolve) => {
          resolveGeneration = resolve;
        }),
    );
    const { startVoiceTurn, getCallbacks } = createCapturingTurnStarter();
    const { streamTtsAudio, ttsTexts } = createRecordingTtsStreamer();
    const { frames, session } = createSessionHarness({
      startVoiceTurn,
      streamTtsAudio,
      frontModelConfig: {
        ackFirstDeltaTimeoutMs: ACK_TIMEOUT_MS,
        llmAckText: true,
      },
      frontDecider: makeStubFrontDecider(generateAckText),
    });

    await startReleasedTurn(session);
    await waitFor(() => generateAckText.mock.calls.length === 1);

    // The brain's first delta lands while the ack text is still generating —
    // a late generation must not speak over real output.
    getCallbacks()?.assistant_text_delta?.(makeTextDelta("Hello there."));
    resolveGeneration("Too late to say this.");
    getCallbacks()?.message_complete?.(makeMessageComplete());
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    expect(ttsTexts).toEqual(["Hello there."]);
    expect(ttsAudioPayloads(frames)).toEqual([b64("audio:Hello there.")]);
  });
});
