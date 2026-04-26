import { describe, expect, mock, test } from "bun:test";

import type {
  VoiceTurnCallbacks,
  VoiceTurnOptions,
} from "../../calls/voice-session-bridge.js";
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
  streamTtsAudio: LiveVoiceTtsStreamer;
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
    if (predicate()) return;
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
    seq: 0,
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

  test("flushes long assistant text as a conservative TTS segment before completion", async () => {
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

    expect(ttsTexts).toHaveLength(1);
    expect(ttsTexts[0]?.length).toBeGreaterThan(100);
    expect(ttsTexts[0]?.length).toBeLessThanOrEqual(181);
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
    });
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
});
