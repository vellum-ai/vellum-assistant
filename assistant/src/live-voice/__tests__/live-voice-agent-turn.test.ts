import { afterEach, describe, expect, mock, test } from "bun:test";

import { sanitizeForTts } from "../../calls/tts-text-sanitizer.js";
import type {
  VoiceTurnCallbacks,
  VoiceTurnOptions,
} from "../../calls/voice-session-bridge.js";
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

class MockStreamingTranscriber implements StreamingTranscriber {
  readonly providerId = "deepgram" as const;
  readonly boundaryId = "daemon-streaming" as const;
  stopped = false;
  private onEvent: ((event: SttStreamServerEvent) => void) | null = null;

  constructor(private readonly stopEvents: SttStreamServerEvent[] = []) {}

  async start(onEvent: (event: SttStreamServerEvent) => void): Promise<void> {
    this.onEvent = onEvent;
  }

  sendAudio(): void {}

  stop(): void {
    this.stopped = true;
    for (const event of this.stopEvents) {
      this.emit(event);
    }
  }

  emit(event: SttStreamServerEvent): void {
    this.onEvent?.(event);
  }
}

function createContext(startFrame: LiveVoiceClientStartFrame = START_FRAME): {
  context: LiveVoiceSessionFactoryContext;
  frames: LiveVoiceServerFrame[];
} {
  const sequencer = createLiveVoiceServerFrameSequencer();
  const frames: LiveVoiceServerFrame[] = [];

  return {
    frames,
    context: {
      sessionId: "session-123",
      startFrame,
      sendFrame: mock(async (payload) => {
        const frame = sequencer.next(payload);
        frames.push(frame);
        return frame;
      }),
    },
  };
}

function createStartFrameWithoutConversationId(): LiveVoiceClientStartFrame {
  return {
    type: "start",
    audio: START_FRAME.audio,
  };
}

function createSessionHarness(
  options: {
    startFrame?: LiveVoiceClientStartFrame;
    transcriber?: MockStreamingTranscriber;
    startVoiceTurn?: LiveVoiceTurnStarter;
    createTurnId?: () => string;
    emitMetrics?: boolean;
    streamTtsAudio?: LiveVoiceTtsStreamer;
    frontModelConfig?: Partial<LiveVoiceFrontModelConfig>;
  } = {},
) {
  const transcriber =
    options.transcriber ??
    new MockStreamingTranscriber([
      { type: "final", text: "world" },
      { type: "closed" },
    ]);
  const { context, frames } = createContext(options.startFrame);
  const startVoiceTurn =
    options.startVoiceTurn ??
    mock(async () => ({ turnId: "bridge-turn-1", abort: mock() }));

  const session = new LiveVoiceSession(context, {
    resolveTranscriber: mock(async () => transcriber),
    startVoiceTurn,
    createTurnId: options.createTurnId ?? (() => "live-turn-1"),
    emitMetrics: options.emitMetrics ?? false,
    ...(options.streamTtsAudio
      ? { streamTtsAudio: options.streamTtsAudio }
      : {}),
    ...(options.frontModelConfig
      ? { frontModelConfig: options.frontModelConfig }
      : {}),
  });

  return { frames, session, startVoiceTurn, transcriber };
}

async function waitForFrameCount(
  frames: LiveVoiceServerFrame[],
  count: number,
): Promise<void> {
  for (let attempt = 0; attempt < 20 && frames.length < count; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function flushAsyncCallbacks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(
  predicate: () => boolean,
  message = "Timed out waiting for live voice assistant turn condition",
): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

describe("LiveVoiceSession assistant turn", () => {
  test("runs final transcripts through the voice bridge and forwards ordered assistant events", async () => {
    const startVoiceTurn = mock(async (options: VoiceTurnOptions) => {
      options.callbacks?.assistant_text_delta?.({
        type: "assistant_text_delta",
        text: "Hello ",
        conversationId: options.conversationId,
      });
      options.callbacks?.assistant_text_delta?.({
        type: "assistant_text_delta",
        text: "there",
        conversationId: options.conversationId,
      });
      options.callbacks?.message_complete?.({
        type: "message_complete",
        conversationId: options.conversationId,
        messageId: "assistant-message-123",
      });
      return { turnId: "bridge-turn-1", abort: mock() };
    });
    const { frames, session, transcriber } = createSessionHarness({
      startVoiceTurn,
    });

    await session.start();
    transcriber.emit({ type: "final", text: "hello" });
    await session.handleClientFrame({ type: "ptt_release" });
    await waitForFrameCount(frames, 7);

    expect(startVoiceTurn).toHaveBeenCalledTimes(1);
    const voiceTurnOptions = startVoiceTurn.mock.calls[0]?.[0];
    expect(voiceTurnOptions).toMatchObject({
      conversationId: "conversation-123",
      voiceSessionId: "session-123",
      userMessageChannel: "vellum",
      assistantMessageChannel: "vellum",
      userMessageInterface: "macos",
      assistantMessageInterface: "macos",
      content: "hello world",
      isInbound: true,
    });
    expect(voiceTurnOptions?.signal).toBeInstanceOf(AbortSignal);
    expect(frames.map((frame) => frame.type)).toEqual([
      "ready",
      "stt_final",
      "stt_final",
      "thinking",
      "assistant_text_delta",
      "assistant_text_delta",
      "tts_done",
    ]);
    expect(frames[3]).toMatchObject({
      type: "thinking",
      turnId: "live-turn-1",
    });
    expect(frames[4]).toMatchObject({
      type: "assistant_text_delta",
      text: "Hello ",
    });
    expect(frames[5]).toMatchObject({
      type: "assistant_text_delta",
      text: "there",
    });
    expect(frames[6]).toMatchObject({
      type: "tts_done",
      turnId: "live-turn-1",
    });
  });

  test("waits for transcriber closed before starting an assistant turn after release", async () => {
    const transcriber = new MockStreamingTranscriber();
    const startVoiceTurn = mock(async (_options: VoiceTurnOptions) => ({
      turnId: "bridge-turn-1",
      abort: mock(),
    }));
    const { frames, session } = createSessionHarness({
      transcriber,
      startVoiceTurn,
    });

    await session.start();
    transcriber.emit({ type: "final", text: "hello" });
    await waitForFrameCount(frames, 2);

    await session.handleClientFrame({ type: "ptt_release" });
    expect(transcriber.stopped).toBe(true);
    expect(startVoiceTurn).not.toHaveBeenCalled();

    transcriber.emit({ type: "final", text: "after release" });
    await waitForFrameCount(frames, 3);
    expect(startVoiceTurn).not.toHaveBeenCalled();

    transcriber.emit({ type: "closed" });
    await waitForFrameCount(frames, 4);

    expect(startVoiceTurn).toHaveBeenCalledTimes(1);
    expect(startVoiceTurn.mock.calls[0]?.[0]).toMatchObject({
      content: "hello after release",
    });
    expect(frames.map((frame) => frame.type)).toEqual([
      "ready",
      "stt_final",
      "stt_final",
      "thinking",
    ]);
  });

  test("empty transcripts finalize only after the transcriber closes", async () => {
    const transcriber = new MockStreamingTranscriber();
    const startVoiceTurn = mock(async (_options: VoiceTurnOptions) => ({
      turnId: "bridge-turn-1",
      abort: mock(),
    }));
    const { frames, session } = createSessionHarness({
      transcriber,
      startVoiceTurn,
      emitMetrics: true,
    });

    await session.start();
    await session.handleClientFrame({
      type: "audio",
      dataBase64: Buffer.from("user audio").toString("base64"),
    });
    await session.handleClientFrame({ type: "ptt_release" });

    transcriber.emit({ type: "final", text: "   \n\t  " });
    await waitForFrameCount(frames, 2);

    expect(startVoiceTurn).not.toHaveBeenCalled();
    expect(
      frames.some(
        (frame) => frame.type === "metrics" && frame.event === "turn_cancelled",
      ),
    ).toBe(false);

    transcriber.emit({ type: "closed" });
    await waitFor(() =>
      frames.some(
        (frame) => frame.type === "metrics" && frame.event === "turn_cancelled",
      ),
    );

    expect(startVoiceTurn).not.toHaveBeenCalled();
    expect(frames.map((frame) => frame.type)).toEqual([
      "ready",
      "stt_final",
      "metrics",
    ]);
  });

  test("does not start an assistant turn for whitespace-only final transcripts", async () => {
    const transcriber = new MockStreamingTranscriber([
      { type: "final", text: "   \n\t  " },
      { type: "closed" },
    ]);
    const startVoiceTurn = mock(async (_options: VoiceTurnOptions) => ({
      turnId: "bridge-turn-1",
      abort: mock(),
    }));
    const { frames, session } = createSessionHarness({
      transcriber,
      startVoiceTurn,
    });

    await session.start();
    await session.handleClientFrame({ type: "ptt_release" });
    await waitForFrameCount(frames, 2);

    expect(startVoiceTurn).not.toHaveBeenCalled();
    expect(frames.map((frame) => frame.type)).toEqual(["ready", "stt_final"]);
  });

  test("falls back to the session id when start omits a conversation id", async () => {
    const startVoiceTurn = mock(async (_options: VoiceTurnOptions) => ({
      turnId: "bridge-turn-1",
      abort: mock(),
    }));
    const { frames, session } = createSessionHarness({
      startFrame: createStartFrameWithoutConversationId(),
      startVoiceTurn,
    });

    await session.start();
    await session.handleClientFrame({ type: "ptt_release" });
    await waitForFrameCount(frames, 3);

    expect(frames[0]).toMatchObject({
      type: "ready",
      conversationId: "session-123",
    });
    expect(startVoiceTurn.mock.calls[0]?.[0]).toMatchObject({
      conversationId: "session-123",
    });
  });

  test("rejects audio while an assistant turn is in flight", async () => {
    const startVoiceTurn = mock(async (_options: VoiceTurnOptions) => ({
      turnId: "bridge-turn-1",
      abort: mock(),
    }));
    const { frames, session } = createSessionHarness({ startVoiceTurn });

    await session.start();
    await session.handleClientFrame({ type: "ptt_release" });
    await waitForFrameCount(frames, 3);
    expect(frames.map((frame) => frame.type)).toEqual([
      "ready",
      "stt_final",
      "thinking",
    ]);

    await session.handleBinaryAudio(new Uint8Array([7]));

    expect(startVoiceTurn).toHaveBeenCalledTimes(1);
    expect(frames.at(-1)).toMatchObject({
      type: "error",
      code: "invalid_audio_payload",
      message: "Live voice audio received after push-to-talk release.",
    });
  });

  test("records tool_use_start on the active turn without emitting frames", async () => {
    let callbacks: VoiceTurnCallbacks | undefined;
    const startVoiceTurn = mock(async (options: VoiceTurnOptions) => {
      callbacks = options.callbacks;
      return { turnId: "bridge-turn-1", abort: mock() };
    });
    const { frames, session } = createSessionHarness({ startVoiceTurn });

    await session.start();
    await session.handleClientFrame({ type: "ptt_release" });
    await waitForFrameCount(frames, 3);
    expect(frames.map((frame) => frame.type)).toEqual([
      "ready",
      "stt_final",
      "thinking",
    ]);

    const frameCountBefore = frames.length;
    callbacks?.tool_use_start?.("some_tool");
    await flushAsyncCallbacks();

    const activeTurn = (
      session as unknown as {
        activeAssistantTurn: { toolUseStarted: boolean } | null;
      }
    ).activeAssistantTurn;
    expect(activeTurn?.toolUseStarted).toBe(true);
    expect(frames).toHaveLength(frameCountBefore);

    callbacks?.message_complete?.({
      type: "message_complete",
      conversationId: "conversation-123",
      messageId: "assistant-message-123",
    });
    await waitForFrameCount(frames, 4);
    expect(frames.map((frame) => frame.type)).toEqual([
      "ready",
      "stt_final",
      "thinking",
      "tts_done",
    ]);
  });

  test("interrupt aborts the in-flight turn and ignores late bridge events", async () => {
    let callbacks: VoiceTurnCallbacks | undefined;
    let signal: AbortSignal | undefined;
    const abort = mock();
    const startVoiceTurn = mock(async (options: VoiceTurnOptions) => {
      callbacks = options.callbacks;
      signal = options.signal;
      return { turnId: "bridge-turn-1", abort };
    });
    const { frames, session } = createSessionHarness({ startVoiceTurn });

    await session.start();
    await session.handleClientFrame({ type: "ptt_release" });
    await waitForFrameCount(frames, 3);

    await session.handleClientFrame({ type: "interrupt" });
    const frameCountAfterInterrupt = frames.length;
    callbacks?.assistant_text_delta?.({
      type: "assistant_text_delta",
      text: "late",
      conversationId: "conversation-123",
    });
    callbacks?.message_complete?.({
      type: "message_complete",
      conversationId: "conversation-123",
      messageId: "assistant-message-late",
    });
    await flushAsyncCallbacks();

    expect(signal?.aborted).toBe(true);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(frames).toHaveLength(frameCountAfterInterrupt);
    expect(frames.map((frame) => frame.type)).toEqual([
      "ready",
      "stt_final",
      "thinking",
    ]);
  });
});

describe("LiveVoiceSession tool-use spoken ack (voice-front-model)", () => {
  afterEach(() => clearCachedOverrides());

  const ACK_TIMEOUT_MS = 40;
  // Acks pass through the same TTS sanitizer as regular segments; each fresh
  // session's phrase counter starts at 0.
  const EXPECTED_TOOL_ACK = sanitizeForTts(pickAckPhrase("tool_use", 0)).trim();
  const EXPECTED_FIRST_DELTA_ACK = sanitizeForTts(
    pickAckPhrase("first_delta", 0),
  ).trim();

  function enableFrontModel(): void {
    setCachedOverrides({ "voice-front-model": true }, { fromGateway: true });
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

  function createAckHarness() {
    const { startVoiceTurn, getCallbacks } = createCapturingTurnStarter();
    const { streamTtsAudio, ttsTexts } = createRecordingTtsStreamer();
    const harness = createSessionHarness({
      startVoiceTurn,
      streamTtsAudio,
      frontModelConfig: { ackFirstDeltaTimeoutMs: ACK_TIMEOUT_MS },
    });
    return { ...harness, getCallbacks, ttsTexts };
  }

  async function startReleasedTurn(
    session: LiveVoiceSession,
    getCallbacks: () => VoiceTurnCallbacks | undefined,
  ): Promise<void> {
    await session.start();
    await session.handleClientFrame({ type: "ptt_release" });
    await waitFor(() => getCallbacks() !== undefined);
  }

  test("tool_use_start before any delta speaks an immediate tool ack and cancels the timer", async () => {
    enableFrontModel();
    const { frames, session, getCallbacks, ttsTexts } = createAckHarness();

    await startReleasedTurn(session, getCallbacks);
    getCallbacks()?.tool_use_start?.("web_search");
    await waitFor(() => ttsTexts.length === 1);
    expect(ttsTexts).toEqual([EXPECTED_TOOL_ACK]);

    // The pending first-delta timer was cancelled: letting its budget elapse
    // speaks no second ack.
    await new Promise((resolve) => setTimeout(resolve, ACK_TIMEOUT_MS + 40));
    expect(ttsTexts).toEqual([EXPECTED_TOOL_ACK]);

    // The ack is audio-only — no caption frame carries it.
    expect(frames.some((frame) => frame.type === "assistant_text_delta")).toBe(
      false,
    );

    emitTextDelta(getCallbacks, "Hello there.");
    emitMessageComplete(getCallbacks);
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));
    expect(ttsTexts).toEqual([EXPECTED_TOOL_ACK, "Hello there."]);
  });

  test("tool_use_start after the first delta speaks no ack", async () => {
    enableFrontModel();
    const { frames, session, getCallbacks, ttsTexts } = createAckHarness();

    await startReleasedTurn(session, getCallbacks);
    emitTextDelta(getCallbacks, "Hello there.");
    getCallbacks()?.tool_use_start?.("web_search");
    emitMessageComplete(getCallbacks);
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));
    await new Promise((resolve) => setTimeout(resolve, ACK_TIMEOUT_MS + 40));

    expect(ttsTexts).toEqual(["Hello there."]);
  });

  test("tool_use_start after a first-delta ack already spoke adds no second ack", async () => {
    enableFrontModel();
    const { frames, session, getCallbacks, ttsTexts } = createAckHarness();

    await startReleasedTurn(session, getCallbacks);
    // Let the slow-first-delta timer speak the turn's one ack first.
    await waitFor(() => ttsTexts.length === 1);
    expect(ttsTexts).toEqual([EXPECTED_FIRST_DELTA_ACK]);

    getCallbacks()?.tool_use_start?.("web_search");
    await flushAsyncCallbacks();
    expect(ttsTexts).toEqual([EXPECTED_FIRST_DELTA_ACK]);

    emitTextDelta(getCallbacks, "Hello there.");
    emitMessageComplete(getCallbacks);
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));
    expect(ttsTexts).toEqual([EXPECTED_FIRST_DELTA_ACK, "Hello there."]);
  });

  test("tool_use_start speaks no ack when the flag is off", async () => {
    const { frames, session, getCallbacks, ttsTexts } = createAckHarness();

    await startReleasedTurn(session, getCallbacks);
    getCallbacks()?.tool_use_start?.("web_search");
    await new Promise((resolve) => setTimeout(resolve, ACK_TIMEOUT_MS + 40));
    expect(ttsTexts).toEqual([]);

    emitTextDelta(getCallbacks, "Hello there.");
    emitMessageComplete(getCallbacks);
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));
    expect(ttsTexts).toEqual(["Hello there."]);
  });
});
