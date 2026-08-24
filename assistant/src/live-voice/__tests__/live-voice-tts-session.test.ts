import { describe, expect, mock, test } from "bun:test";

import { sanitizeForTts } from "../../calls/tts-text-sanitizer.js";
import type {
  VoiceTurnCallbacks,
  VoiceTurnOptions,
} from "../../calls/voice-session-bridge.js";
import { ESCALATION_CONTINUATION_CONTENT } from "../../calls/voice-triage-escalate.js";
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
import { approvalPendingPhraseFor } from "../progress-phrases.js";
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
}) {
  const transcriber = new MockStreamingTranscriber();
  const { context, frames } = createContext();
  const session = new LiveVoiceSession(context, {
    resolveTranscriber: mock(async () => transcriber),
    startVoiceTurn: options.startVoiceTurn,
    streamTtsAudio: options.streamTtsAudio,
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
// synthesis overlap can be asserted deterministically. Aborting a call does
// not settle it, which is also how a provider that is slow to tear down on
// abort behaves.
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

// A TTS streamer that answers every segment with one chunk and settles at
// once. `synthesized` is what reached the provider, which on a held segment
// is deliberately a different set from what the client hears.
function createEchoTtsStreamer(): {
  streamTtsAudio: LiveVoiceTtsStreamer;
  synthesized: LiveVoiceTtsOptions[];
} {
  const synthesized: LiveVoiceTtsOptions[] = [];
  const streamTtsAudio = mock(async (options: LiveVoiceTtsOptions) => {
    synthesized.push(options);
    options.onAudioChunk(makeTtsChunk(`audio:${options.text}`));
    return makeTtsResult(options.text);
  });
  return { streamTtsAudio, synthesized };
}

function synthesizedTexts(synthesized: LiveVoiceTtsOptions[]): string[] {
  return synthesized.map((options) => options.text);
}

// The front-door leg's escalate verdict plus the bridge it speaks across the
// hand-off, and the sentences an escalated leg says while it works.
const ESCALATE_VERDICT_DELTA = "[1] Let me look into that.";
const BRIDGE_SENTENCE = "Let me look into that.";
const FIRST_COMMENTARY = "Checking your calendar now.";
const SECOND_COMMENTARY = "Now looking at tomorrow as well.";
const REPORT_SENTENCE = "You have two meetings tomorrow.";
const REPORT_QUESTION = "Which calendar should I check, work or personal?";

/**
 * Drive a turn through the escalate verdict and hand back the escalated leg's
 * bridge options, so a test can script that leg block by block: text deltas,
 * `tool_block_opened` for a tool block opening, and completion.
 */
async function startEscalatedTurn(
  streamTtsAudio: LiveVoiceTtsStreamer,
): Promise<{
  frames: LiveVoiceServerFrame[];
  session: LiveVoiceSession;
  escalated: VoiceTurnOptions;
}> {
  let frontDoor: VoiceTurnCallbacks | undefined;
  let escalated: VoiceTurnOptions | undefined;
  const startVoiceTurn = mock(async (options: VoiceTurnOptions) => {
    if (options.content === ESCALATION_CONTINUATION_CONTENT) {
      escalated = options;
      return { turnId: "bridge-escalated", abort: mock() };
    }
    frontDoor = options.callbacks;
    return { turnId: "bridge-front-door", abort: mock() };
  });
  const { frames, session } = createSessionHarness({
    startVoiceTurn,
    streamTtsAudio,
  });

  await startReleasedTurn(session);
  frontDoor?.assistant_text_delta?.(makeTextDelta(ESCALATE_VERDICT_DELTA));
  await waitFor(
    () => escalated !== undefined,
    "Timed out waiting for the escalated leg to start",
  );
  if (!escalated) {
    throw new Error("Escalated leg never started");
  }
  return { frames, session, escalated };
}

function assistantTranscript(frames: LiveVoiceServerFrame[]): string {
  return frames
    .flatMap((frame) =>
      frame.type === "assistant_text_delta" ? [frame.text] : [],
    )
    .join("");
}

// The slice of a TtsSegmentJob a held-segment selector can see. Kept
// structural so the test does not need the session's private job type.
interface HeldJobView {
  readonly text: string;
}

// The slice of the session's private turn state these tests read.
interface TurnView {
  readonly token: symbol;
  readonly ttsBuffer: string;
}

// Drives the private hold/promote/retract surface directly against the turn
// that `startReleasedTurn` left active, for the queue mechanics an escalated
// turn cannot script on its own (a segment held past completion, a provider
// that ignores its abort).
function heldTtsController(session: LiveVoiceSession): {
  enqueue: (text: string) => void;
  promote: (select: (job: HeldJobView) => boolean) => number;
  retract: (
    select: (job: HeldJobView) => boolean,
    options?: { discardPendingTail?: boolean },
  ) => number;
  pendingTail: () => string;
  audioIdle: () => boolean;
} {
  const internals = session as unknown as {
    activeAssistantTurn: TurnView | null;
    enqueueTtsSegment: (
      token: symbol,
      segment: string,
      options?: { held?: boolean },
    ) => void;
    promoteHeldTtsSegments: (
      token: symbol,
      select: (job: HeldJobView) => boolean,
    ) => number;
    retractHeldTtsSegments: (
      token: symbol,
      select: (job: HeldJobView) => boolean,
      options?: { discardPendingTail?: boolean },
    ) => number;
    turnAudioIdle: (turn: TurnView) => boolean;
  };
  const turn = internals.activeAssistantTurn;
  if (!turn) {
    throw new Error("No active assistant turn to hold TTS segments on");
  }
  const { token } = turn;
  return {
    enqueue: (text) => internals.enqueueTtsSegment(token, text, { held: true }),
    promote: (select) => internals.promoteHeldTtsSegments(token, select),
    retract: (select, options) =>
      internals.retractHeldTtsSegments(token, select, options),
    pendingTail: () => turn.ttsBuffer,
    audioIdle: () => internals.turnAudioIdle(turn),
  };
}

const HELD_SENTENCE = "The held answer is ready to speak.";
const OTHER_HELD_SENTENCE = "A second held sentence waits behind it.";
const THIRD_HELD_SENTENCE = "A third held sentence waits even further back.";
const FIRST_SENTENCE = "This is the first spoken sentence.";
const SECOND_SENTENCE = "Here comes the second spoken sentence.";
const THIRD_SENTENCE = "And now a third spoken sentence arrives.";
// No terminal punctuation, so it stays in the turn's buffer as an
// un-segmented tail instead of forming a job.
const PENDING_TAIL = "an unfinished clause with no boundary yet";

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

  test("a held segment synthesizes but forwards no audio until it is promoted", async () => {
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
    const held = heldTtsController(session);
    held.enqueue(HELD_SENTENCE);

    // Synthesis starts immediately: holding is about emission, not about
    // deferring the provider round trip.
    expect(events).toEqual([`start:${HELD_SENTENCE}`]);

    calls[0]?.options.onAudioChunk(makeTtsChunk("audio:held-1"));
    calls[0]?.finish();
    await flushAsyncCallbacks();
    expect(ttsAudioPayloads(frames)).toEqual([]);

    expect(held.promote((job) => job.text === HELD_SENTENCE)).toBe(1);
    await waitFor(() => ttsAudioPayloads(frames).length === 1);
    expect(ttsAudioPayloads(frames)).toEqual([b64("audio:held-1")]);

    callbacks?.message_complete?.(makeMessageComplete());
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));
    expect(frames.at(-1)).toMatchObject({
      type: "tts_done",
      turnId: "live-turn-1",
    });
  });

  test("a promoted held segment emits its buffered audio ahead of later segments", async () => {
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
    const held = heldTtsController(session);
    held.enqueue(HELD_SENTENCE);
    calls[0]?.options.onAudioChunk(makeTtsChunk("audio:held-1"));

    // Promotion happens before the next segment is enqueued, so the held job
    // is ahead of it on the emission chain.
    expect(held.promote(() => true)).toBe(1);
    callbacks?.assistant_text_delta?.(makeTextDelta(FIRST_SENTENCE));
    expect(calls).toHaveLength(2);

    // The later segment finishes first; ordering still follows the chain.
    calls[1]?.options.onAudioChunk(makeTtsChunk("audio:later-1"));
    calls[1]?.finish();
    await flushAsyncCallbacks();
    calls[0]?.options.onAudioChunk(makeTtsChunk("audio:held-2"));
    calls[0]?.finish();
    callbacks?.message_complete?.(makeMessageComplete());
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    expect(ttsAudioPayloads(frames)).toEqual([
      b64("audio:held-1"),
      b64("audio:held-2"),
      b64("audio:later-1"),
    ]);
  });

  test("a retracted held segment forwards nothing and aborts only its own synthesis", async () => {
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
    const held = heldTtsController(session);
    held.enqueue(HELD_SENTENCE);
    expect(calls).toHaveLength(2);
    calls[1]?.options.onAudioChunk(makeTtsChunk("audio:held-1"));

    expect(held.retract((job) => job.text === HELD_SENTENCE)).toBe(1);
    expect(calls[1]?.options.signal?.aborted).toBe(true);
    expect(calls[0]?.options.signal?.aborted).toBe(false);

    // Late provider chunks on a retracted job are dropped rather than
    // rebuffered, and the retraction never touched the live turn.
    calls[1]?.options.onAudioChunk(makeTtsChunk("audio:held-2"));
    calls[0]?.options.onAudioChunk(makeTtsChunk("audio:live-1"));
    calls[0]?.finish();
    callbacks?.message_complete?.(makeMessageComplete());
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    expect(abort).not.toHaveBeenCalled();
    expect(ttsAudioPayloads(frames)).toEqual([b64("audio:live-1")]);
    expect(frames.at(-1)).toMatchObject({
      type: "tts_done",
      turnId: "live-turn-1",
    });
  });

  test("held segments occupy at most one synthesis slot", async () => {
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
    const held = heldTtsController(session);
    held.enqueue(HELD_SENTENCE);
    held.enqueue(OTHER_HELD_SENTENCE);
    held.enqueue(THIRD_HELD_SENTENCE);

    // A second open slot exists, but held jobs may not take it: the block may
    // never be spoken, so only its first segment is worth synthesizing.
    expect(events).toEqual([`start:${HELD_SENTENCE}`]);

    // Promoting the first frees the held slot for the next one.
    expect(held.promote((job) => job.text === HELD_SENTENCE)).toBe(1);
    expect(events).toEqual([
      `start:${HELD_SENTENCE}`,
      `start:${OTHER_HELD_SENTENCE}`,
    ]);

    calls[0]?.options.onAudioChunk(makeTtsChunk("audio:held-1"));
    calls[0]?.finish();
    calls[1]?.finish();
    expect(held.retract(() => true)).toBe(2);
    callbacks?.message_complete?.(makeMessageComplete());
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    expect(ttsAudioPayloads(frames)).toEqual([b64("audio:held-1")]);
  });

  test("tts_done still fires on a turn holding one segment and retracting another", async () => {
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
    const held = heldTtsController(session);
    held.enqueue(HELD_SENTENCE);
    held.enqueue(OTHER_HELD_SENTENCE);

    // One job stays held forever and one is retracted; neither is on the
    // emission chain, so neither can stall the drain.
    expect(held.retract((job) => job.text === OTHER_HELD_SENTENCE)).toBe(1);

    calls[0]?.options.onAudioChunk(makeTtsChunk("audio:live-1"));
    calls[0]?.finish();
    callbacks?.message_complete?.(makeMessageComplete());
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    expect(ttsAudioPayloads(frames)).toEqual([b64("audio:live-1")]);
    expect(frames.at(-1)).toMatchObject({
      type: "tts_done",
      turnId: "live-turn-1",
    });
  });

  test("turn completion sweeps a held segment the caller never resolved", async () => {
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
    const held = heldTtsController(session);
    held.enqueue(HELD_SENTENCE);

    const strandedCall = calls.find(
      (call) => call.options.text === HELD_SENTENCE,
    );
    expect(strandedCall).toBeDefined();
    expect(strandedCall?.options.signal?.aborted).toBe(false);

    calls[0]?.options.onAudioChunk(makeTtsChunk("audio:live-1"));
    calls[0]?.finish();
    callbacks?.message_complete?.(makeMessageComplete());
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    // The stranded job's provider request is aborted rather than left running
    // into the next turn, and its audio is never spoken.
    expect(strandedCall?.options.signal?.aborted).toBe(true);
    expect(ttsAudioPayloads(frames)).toEqual([b64("audio:live-1")]);
  });

  test("a retracted segment holds its synthesis slot until the aborted stream settles", async () => {
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
    const held = heldTtsController(session);
    held.enqueue(HELD_SENTENCE);
    callbacks?.assistant_text_delta?.(makeTextDelta(SECOND_SENTENCE));

    // Both slots are open, so the third segment is waiting on one.
    expect(events).toEqual([
      `start:${FIRST_SENTENCE}`,
      `start:${HELD_SENTENCE}`,
    ]);

    // This provider ignores the abort, so the retracted stream is still open
    // and its slot is still taken.
    expect(held.retract((job) => job.text === HELD_SENTENCE)).toBe(1);
    await flushAsyncCallbacks();
    expect(events).toEqual([
      `start:${FIRST_SENTENCE}`,
      `start:${HELD_SENTENCE}`,
    ]);

    // Only the stream's own teardown releases it.
    calls[1]?.finish();
    await waitFor(() => events.includes(`start:${SECOND_SENTENCE}`));

    calls[0]?.options.onAudioChunk(makeTtsChunk("audio:first-1"));
    calls[0]?.finish();
    calls[2]?.options.onAudioChunk(makeTtsChunk("audio:second-1"));
    calls[2]?.finish();
    callbacks?.message_complete?.(makeMessageComplete());
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    expect(ttsAudioPayloads(frames)).toEqual([
      b64("audio:first-1"),
      b64("audio:second-1"),
    ]);
  });

  test("a held segment blocks audio idle and a retracted one does not", async () => {
    let callbacks: VoiceTurnCallbacks | undefined;
    const startVoiceTurn = mock(async (options: VoiceTurnOptions) => {
      callbacks = options.callbacks;
      return { turnId: "bridge-turn-1", abort: mock() };
    });
    const { streamTtsAudio } = createControlledTtsStreamer();
    const { frames, session } = createSessionHarness({
      startVoiceTurn,
      streamTtsAudio,
    });

    await startReleasedTurn(session);
    const held = heldTtsController(session);
    expect(held.audioIdle()).toBe(true);

    // Held audio is seconds from being spoken, so the turn is quiet, not idle.
    held.enqueue(HELD_SENTENCE);
    expect(held.audioIdle()).toBe(false);

    // Retraction makes it unhearable immediately, even though the provider is
    // still sitting on the aborted stream and the job has not settled.
    expect(held.retract(() => true)).toBe(1);
    expect(held.audioIdle()).toBe(true);

    callbacks?.message_complete?.(makeMessageComplete());
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));
    expect(ttsAudioPayloads(frames)).toEqual([]);
  });

  test("retraction discards the pending tail only when the caller owns it", async () => {
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
    const held = heldTtsController(session);
    held.enqueue(HELD_SENTENCE);
    callbacks?.assistant_text_delta?.(makeTextDelta(PENDING_TAIL));
    expect(held.pendingTail()).toBe(PENDING_TAIL);

    // A selective retraction that matches nothing owns no speech, so the
    // buffered tail survives it.
    expect(held.retract((job) => job.text === SECOND_SENTENCE)).toBe(0);
    expect(held.pendingTail()).toBe(PENDING_TAIL);

    // A caller retracting its whole block says so, and the tail goes with it.
    expect(held.retract(() => true, { discardPendingTail: true })).toBe(1);
    expect(held.pendingTail()).toBe("");

    calls[0]?.finish();
    callbacks?.message_complete?.(makeMessageComplete());
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));
    expect(ttsAudioPayloads(frames)).toEqual([]);
  });
});

describe("LiveVoiceSession escalated-turn speech", () => {
  test("no commentary is ever audible on an escalated turn", async () => {
    const { streamTtsAudio, synthesized } = createEchoTtsStreamer();
    const { frames, escalated } = await startEscalatedTurn(streamTtsAudio);
    const legs = escalated.callbacks;

    // Two working blocks, each closed by a tool-use block opening, then the
    // block nothing follows: the turn's report back.
    legs?.assistant_text_delta?.(makeTextDelta(`${FIRST_COMMENTARY} `));
    legs?.tool_block_opened?.("calendar_read", "toolu-1");
    legs?.assistant_text_delta?.(makeTextDelta(`${SECOND_COMMENTARY} `));
    legs?.tool_block_opened?.("calendar_read", "toolu-2");
    legs?.assistant_text_delta?.(makeTextDelta(REPORT_SENTENCE));
    legs?.message_complete?.(makeMessageComplete());
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    // The hard guarantee: the caller hears the hand-off bridge and the
    // report, and no part of the play-by-play in between.
    expect(ttsAudioPayloads(frames)).toEqual([
      b64(`audio:${BRIDGE_SENTENCE}`),
      b64(`audio:${REPORT_SENTENCE}`),
    ]);
    // The commentary was synthesized (that is what makes a promotion
    // instant), it just never reached the client.
    expect(synthesizedTexts(synthesized)).toContain(FIRST_COMMENTARY);
    // Holding is a TTS-only concern: the transcript still carries every word.
    const transcript = assistantTranscript(frames);
    expect(transcript).toContain(FIRST_COMMENTARY);
    expect(transcript).toContain(SECOND_COMMENTARY);
    expect(transcript).toContain(REPORT_SENTENCE);
  });

  test("a provider-native tool closes a block like any other", async () => {
    // Web search and friends arrive as server_tool_start rather than a
    // preview event. The bridge routes both to tool_block_opened, so from
    // here a provider-native tool is not a special case at all: this asserts
    // the session treats that boundary like any other. That the bridge
    // actually routes it is asserted in voice-session-bridge.test.ts.
    const { streamTtsAudio, synthesized } = createEchoTtsStreamer();
    const { frames, escalated } = await startEscalatedTurn(streamTtsAudio);
    const legs = escalated.callbacks;

    legs?.assistant_text_delta?.(makeTextDelta(`${FIRST_COMMENTARY} `));
    legs?.tool_block_opened?.("web_search", "srvtoolu-1");
    legs?.assistant_text_delta?.(makeTextDelta(REPORT_SENTENCE));
    legs?.message_complete?.(makeMessageComplete());
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    expect(ttsAudioPayloads(frames)).toEqual([
      b64(`audio:${BRIDGE_SENTENCE}`),
      b64(`audio:${REPORT_SENTENCE}`),
    ]);
    expect(synthesizedTexts(synthesized)).toContain(FIRST_COMMENTARY);
    // Holding is a TTS-only concern here too: the transcript keeps every word.
    expect(assistantTranscript(frames)).toContain(FIRST_COMMENTARY);
  });

  test("a direct front-door answer is unchanged", async () => {
    let callbacks: VoiceTurnCallbacks | undefined;
    const startVoiceTurn = mock(async (options: VoiceTurnOptions) => {
      callbacks = options.callbacks;
      return { turnId: "bridge-turn-1", abort: mock() };
    });
    const { streamTtsAudio } = createEchoTtsStreamer();
    const { frames, session } = createSessionHarness({
      startVoiceTurn,
      streamTtsAudio,
    });

    await startReleasedTurn(session);
    callbacks?.assistant_text_delta?.(
      makeTextDelta("Sure, I can help with that, and here is the rest."),
    );

    // A front-door answer is never held, so the eager first-clause flush
    // still speaks before the message completes.
    await waitFor(() => frames.some((frame) => frame.type === "tts_audio"));
    expect(ttsAudioPayloads(frames)[0]).toBe(
      b64("audio:Sure, I can help with that,"),
    );
    expect(frames.some((frame) => frame.type === "tts_done")).toBe(false);

    callbacks?.message_complete?.(makeMessageComplete());
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));
    expect(ttsAudioPayloads(frames)).toEqual([
      b64("audio:Sure, I can help with that,"),
      b64("audio:and here is the rest."),
    ]);
  });

  test("the report's first segment is pre-synthesized", async () => {
    const { streamTtsAudio, synthesized } = createEchoTtsStreamer();
    const { frames, escalated } = await startEscalatedTurn(streamTtsAudio);
    const legs = escalated.callbacks;

    legs?.assistant_text_delta?.(makeTextDelta(`${FIRST_COMMENTARY} `));
    legs?.tool_block_opened?.("calendar_read", "toolu-1");
    await flushAsyncCallbacks();
    legs?.assistant_text_delta?.(makeTextDelta(REPORT_SENTENCE));
    await waitFor(() =>
      synthesizedTexts(synthesized).includes(REPORT_SENTENCE),
    );

    // Synthesis of the report runs while the leg is still streaming; only
    // its emission waits for completion.
    expect(ttsAudioPayloads(frames)).toEqual([b64(`audio:${BRIDGE_SENTENCE}`)]);

    legs?.message_complete?.(makeMessageComplete());
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    expect(ttsAudioPayloads(frames)).toEqual([
      b64(`audio:${BRIDGE_SENTENCE}`),
      b64(`audio:${REPORT_SENTENCE}`),
    ]);
    // Promotion emits the audio it already has rather than re-synthesizing.
    expect(
      synthesizedTexts(synthesized).filter((text) => text === REPORT_SENTENCE),
    ).toHaveLength(1);
  });

  test("a mid-turn question is spoken like an answer", async () => {
    const { streamTtsAudio } = createEchoTtsStreamer();
    const { frames, escalated } = await startEscalatedTurn(streamTtsAudio);
    const legs = escalated.callbacks;

    legs?.assistant_text_delta?.(makeTextDelta(`${FIRST_COMMENTARY} `));
    legs?.tool_block_opened?.("calendar_read", "toolu-1");
    legs?.assistant_text_delta?.(makeTextDelta(REPORT_QUESTION));
    legs?.message_complete?.(makeMessageComplete());
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    // Coming back with a question the turn needs answered is a report back
    // like any other: nothing followed it, so it is spoken.
    expect(ttsAudioPayloads(frames)).toEqual([
      b64(`audio:${BRIDGE_SENTENCE}`),
      b64(`audio:${REPORT_QUESTION}`),
    ]);
  });

  test("the approval-pending phrase is never held", async () => {
    const { streamTtsAudio } = createEchoTtsStreamer();
    const { frames, escalated } = await startEscalatedTurn(streamTtsAudio);
    const legs = escalated.callbacks;
    const approvalPhrase = sanitizeForTts(approvalPendingPhraseFor()).trim();

    legs?.assistant_text_delta?.(makeTextDelta(`${FIRST_COMMENTARY} `));
    escalated.onApprovalPending?.("approval-request-1");

    // The line exists to be heard during the wait, so it speaks straight
    // away while the block beside it is still held.
    await waitFor(() =>
      ttsAudioPayloads(frames).includes(b64(`audio:${approvalPhrase}`)),
    );
    expect(ttsAudioPayloads(frames)).toEqual([
      b64(`audio:${BRIDGE_SENTENCE}`),
      b64(`audio:${approvalPhrase}`),
    ]);

    legs?.tool_block_opened?.("send_email", "toolu-1");
    legs?.assistant_text_delta?.(makeTextDelta(REPORT_SENTENCE));
    legs?.message_complete?.(makeMessageComplete());
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    // The retraction that dropped the commentary left the phrase alone.
    expect(ttsAudioPayloads(frames)).toEqual([
      b64(`audio:${BRIDGE_SENTENCE}`),
      b64(`audio:${approvalPhrase}`),
      b64(`audio:${REPORT_SENTENCE}`),
    ]);
  });

  test("a held escalated block blocks the idle gate and its retraction clears it", async () => {
    const { streamTtsAudio, calls } = createControlledTtsStreamer();
    const { frames, session, escalated } =
      await startEscalatedTurn(streamTtsAudio);
    const legs = escalated.callbacks;
    const held = heldTtsController(session);

    // The bridge settles without ever producing a chunk, so no playback-tail
    // estimate stands between the turn and the idle gate.
    calls[0]?.finish();
    await waitFor(() => held.audioIdle());

    // A held block is seconds from being spoken, so the turn is quiet rather
    // than idle and the working cue must not talk over it.
    legs?.assistant_text_delta?.(makeTextDelta(`${FIRST_COMMENTARY} `));
    expect(held.audioIdle()).toBe(false);

    // Retracting it makes it unhearable at once, even though the provider is
    // still sitting on the aborted stream, so the tool phase reads idle.
    legs?.tool_block_opened?.("calendar_read", "toolu-1");
    expect(held.audioIdle()).toBe(true);

    legs?.assistant_text_delta?.(makeTextDelta(REPORT_SENTENCE));
    expect(held.audioIdle()).toBe(false);

    legs?.message_complete?.(makeMessageComplete());
    await waitFor(() => calls.length >= 3);
    calls[2]?.finish();
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));
    expect(ttsAudioPayloads(frames)).toEqual([]);
  });

  test("the escalation bridge is never held or retracted", async () => {
    const { streamTtsAudio, synthesized } = createEchoTtsStreamer();
    const { frames, escalated } = await startEscalatedTurn(streamTtsAudio);
    const legs = escalated.callbacks;

    // The bridge is spoken during the tool phase, which is the whole point
    // of it: it covers the silence the escalated leg is about to create.
    await waitFor(() =>
      ttsAudioPayloads(frames).includes(b64(`audio:${BRIDGE_SENTENCE}`)),
    );

    legs?.assistant_text_delta?.(makeTextDelta(`${FIRST_COMMENTARY} `));
    legs?.tool_block_opened?.("calendar_read", "toolu-1");
    await flushAsyncCallbacks();

    const bridgeCall = synthesized.find(
      (options) => options.text === BRIDGE_SENTENCE,
    );
    expect(bridgeCall?.signal?.aborted).toBe(false);
    expect(ttsAudioPayloads(frames)).toEqual([b64(`audio:${BRIDGE_SENTENCE}`)]);

    legs?.assistant_text_delta?.(makeTextDelta(REPORT_SENTENCE));
    legs?.message_complete?.(makeMessageComplete());
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));
    expect(ttsAudioPayloads(frames)).toEqual([
      b64(`audio:${BRIDGE_SENTENCE}`),
      b64(`audio:${REPORT_SENTENCE}`),
    ]);
  });

  test("a cancelled escalated turn speaks nothing", async () => {
    const { streamTtsAudio, calls } = createControlledTtsStreamer();
    const { frames, escalated } = await startEscalatedTurn(streamTtsAudio);
    const legs = escalated.callbacks;

    // The bridge settles silently, so nothing at all has been heard yet.
    calls[0]?.finish();
    legs?.assistant_text_delta?.(makeTextDelta(`${FIRST_COMMENTARY} `));
    await waitFor(() => calls.length >= 2);

    legs?.message_complete?.({
      type: "generation_cancelled",
      conversationId: "conversation-123",
    });
    await flushAsyncCallbacks();

    // The held block dies with the turn: nothing is promoted, and its
    // provider stream is torn down rather than left running.
    expect(calls[1]?.options.signal?.aborted).toBe(true);
    expect(ttsAudioPayloads(frames)).toEqual([]);
    expect(frames.some((frame) => frame.type === "tts_done")).toBe(false);
  });

  test("an escalated turn with no tool calls speaks its single block", async () => {
    const { streamTtsAudio } = createEchoTtsStreamer();
    const { frames, escalated } = await startEscalatedTurn(streamTtsAudio);
    const legs = escalated.callbacks;

    legs?.assistant_text_delta?.(makeTextDelta(REPORT_SENTENCE));
    legs?.message_complete?.(makeMessageComplete());
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    expect(ttsAudioPayloads(frames)).toEqual([
      b64(`audio:${BRIDGE_SENTENCE}`),
      b64(`audio:${REPORT_SENTENCE}`),
    ]);
  });
});
