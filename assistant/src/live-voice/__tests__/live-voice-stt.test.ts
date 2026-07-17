import { readFileSync } from "node:fs";
import { describe, expect, mock, test } from "bun:test";

import type { VoiceTurnOptions } from "../../calls/voice-session-bridge.js";
import type {
  StreamingTranscriber,
  SttStreamServerEvent,
} from "../../stt/types.js";
import {
  LiveVoiceSession,
  type LiveVoiceStreamingTranscriberResolver,
} from "../live-voice-session.js";
import type { LiveVoiceSessionFactoryContext } from "../live-voice-session-manager.js";
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
  readonly audioChunks: Buffer[] = [];
  readonly mimeTypes: string[] = [];
  started = false;
  stopped = false;
  private onEvent: ((event: SttStreamServerEvent) => void) | null = null;

  async start(onEvent: (event: SttStreamServerEvent) => void): Promise<void> {
    this.started = true;
    this.onEvent = onEvent;
  }

  sendAudio(audio: Buffer, mimeType: string): void {
    this.audioChunks.push(audio);
    this.mimeTypes.push(mimeType);
    this.onEvent?.({
      type: "partial",
      text: `partial-${this.audioChunks.length}`,
    });
  }

  stop(): void {
    this.stopped = true;
    this.onEvent?.({ type: "final", text: "final transcript" });
    this.onEvent?.({ type: "closed" });
  }

  emit(event: SttStreamServerEvent): void {
    this.onEvent?.(event);
  }
}

// Finalize-capable fake: with server_vad this flips the session into
// persistent mode (one shared stream across utterance cycles). Each
// finalize flushes "utterance <n>" as a final followed by finalized.
class FinalizingMockStreamingTranscriber extends MockStreamingTranscriber {
  startCalls = 0;
  stopCalls = 0;
  finalizeCalls = 0;
  // When false the flush never arrives, exercising the grace-timeout path.
  respondToFinalize = true;

  override async start(
    onEvent: (event: SttStreamServerEvent) => void,
  ): Promise<void> {
    this.startCalls += 1;
    await super.start(onEvent);
  }

  override stop(): void {
    this.stopCalls += 1;
    super.stop();
  }

  finalizeUtterance(): void {
    this.finalizeCalls += 1;
    if (!this.respondToFinalize) {
      return;
    }
    this.emit({
      type: "final",
      text: `utterance ${this.finalizeCalls}`,
      fromFinalize: true,
    });
    this.emit({ type: "finalized" });
  }
}

// A transcriber whose start() (the provider WS handshake) resolves only when
// the test releases it, holding the session in the ready→arm gap.
function createGatedStartTranscriber(): {
  transcriber: MockStreamingTranscriber;
  releaseStart: () => void;
} {
  let releaseStart: () => void = () => {};
  const startGate = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  class GatedStartTranscriber extends MockStreamingTranscriber {
    override async start(
      onEvent: (event: SttStreamServerEvent) => void,
    ): Promise<void> {
      await startGate;
      await super.start(onEvent);
    }
  }
  return { transcriber: new GatedStartTranscriber(), releaseStart };
}

function completingVoiceTurnStarter() {
  return mock(async (options: VoiceTurnOptions) => {
    options.callbacks?.message_complete?.({
      type: "message_complete",
      conversationId: options.conversationId,
      messageId: "assistant-message-123",
    });
    return { turnId: "bridge-turn-1", abort: mock() };
  });
}

function createContext(overrides: Partial<LiveVoiceClientStartFrame> = {}): {
  context: LiveVoiceSessionFactoryContext;
  frames: LiveVoiceServerFrame[];
} {
  const sequencer = createLiveVoiceServerFrameSequencer();
  const frames: LiveVoiceServerFrame[] = [];
  const startFrame = {
    ...START_FRAME,
    ...overrides,
  } as LiveVoiceClientStartFrame;

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

function loudPcmChunk(amplitude = 8_000, sampleCount = 240): Uint8Array {
  const buffer = Buffer.alloc(sampleCount * 2);
  for (let index = 0; index < sampleCount; index += 1) {
    buffer.writeInt16LE(amplitude, index * 2);
  }
  return new Uint8Array(buffer);
}

function createSessionWithTranscriber(
  transcriber = new MockStreamingTranscriber(),
) {
  const { context, frames } = createContext();
  const resolver = mock(async () => transcriber);
  const session = new LiveVoiceSession(context, {
    resolveTranscriber: resolver,
  });
  return { frames, resolver, session, transcriber };
}

async function waitFor(
  predicate: () => boolean,
  message = "Timed out waiting for live voice STT test condition",
): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

describe("LiveVoiceSession STT", () => {
  test("resolves streaming STT through the injected resolver and sends ready", async () => {
    const { frames, resolver, session, transcriber } =
      createSessionWithTranscriber();

    await session.start();

    expect(resolver).toHaveBeenCalledWith({ sampleRate: 24_000 });
    expect(transcriber.started).toBe(true);
    expect(frames).toEqual([
      {
        type: "ready",
        seq: 1,
        sessionId: "session-123",
        conversationId: "conversation-123",
        turnDetection: "manual",
      },
    ]);
  });

  test("marks transient transcriber errors recoverable while the session continues", async () => {
    const { frames, session, transcriber } = createSessionWithTranscriber();

    await session.start();
    transcriber.emit({
      type: "error",
      category: "provider-error",
      message: "whisper poll failed",
    });
    await waitFor(() => frames.some((frame) => frame.type === "error"));

    expect(frames.find((frame) => frame.type === "error")).toMatchObject({
      type: "error",
      code: "invalid_field",
      message: "whisper poll failed",
      recoverable: true,
    });

    // The session is still live: audio keeps streaming to the transcriber.
    await session.handleBinaryAudio(new Uint8Array([1, 2, 3]));
    expect(transcriber.audioChunks.map((chunk) => [...chunk])).toEqual([
      [1, 2, 3],
    ]);
  });

  test("marks timeout transcriber errors recoverable", async () => {
    const { frames, session, transcriber } = createSessionWithTranscriber();

    await session.start();
    transcriber.emit({
      type: "error",
      category: "timeout",
      message: "request timed out",
    });
    await waitFor(() => frames.some((frame) => frame.type === "error"));

    expect(frames.find((frame) => frame.type === "error")).toMatchObject({
      type: "error",
      message: "request timed out",
      recoverable: true,
    });
  });

  test("marks terminal transcriber errors non-recoverable", async () => {
    const { frames, session, transcriber } = createSessionWithTranscriber();

    await session.start();
    transcriber.emit({
      type: "error",
      category: "auth",
      message: "invalid credentials",
    });
    transcriber.emit({
      type: "error",
      category: "rate-limit",
      message: "rate limited",
    });
    transcriber.emit({
      type: "error",
      category: "invalid-audio",
      message: "unsupported audio",
    });
    await waitFor(
      () => frames.filter((frame) => frame.type === "error").length === 3,
    );

    const errorFrames = frames.flatMap((frame) =>
      frame.type === "error" ? [frame] : [],
    );
    expect(errorFrames.map((frame) => frame.message)).toEqual([
      "invalid credentials",
      "rate limited",
      "unsupported audio",
    ]);
    for (const frame of errorFrames) {
      expect(frame).not.toHaveProperty("recoverable");
    }
  });

  test("forwards binary audio to the transcriber and emits STT frames", async () => {
    const { frames, session, transcriber } = createSessionWithTranscriber();

    await session.start();
    await session.handleBinaryAudio(new Uint8Array([1, 2, 3]));
    transcriber.emit({ type: "final", text: "hello world" });
    await session.handleClientFrame({ type: "ptt_release" });

    expect(transcriber.audioChunks.map((chunk) => [...chunk])).toEqual([
      [1, 2, 3],
    ]);
    expect(transcriber.mimeTypes).toEqual(["audio/pcm"]);
    expect(frames.map((frame) => frame.type)).toEqual([
      "ready",
      "stt_partial",
      "stt_final",
      "stt_final",
    ]);
    expect(frames[1]).toMatchObject({
      type: "stt_partial",
      seq: 2,
      text: "partial-1",
    });
    expect(frames[2]).toMatchObject({
      type: "stt_final",
      seq: 3,
      text: "hello world",
    });
    expect(session.finalTranscriptText).toBe("hello world final transcript");
  });

  test("treats ptt_release as end-of-utterance and rejects later audio", async () => {
    const { frames, session, transcriber } = createSessionWithTranscriber();

    await session.start();
    await session.handleBinaryAudio(new Uint8Array([1]));
    await session.handleClientFrame({ type: "ptt_release" });
    await session.handleBinaryAudio(new Uint8Array([2]));
    await session.handleClientFrame({
      type: "audio",
      dataBase64: Buffer.from([3]).toString("base64"),
    });

    expect(transcriber.stopped).toBe(true);
    expect(transcriber.audioChunks.map((chunk) => [...chunk])).toEqual([[1]]);
    expect(frames.filter((frame) => frame.type === "error")).toEqual([
      {
        type: "error",
        seq: 4,
        code: "invalid_audio_payload",
        message: "Live voice audio received after push-to-talk release.",
      },
      {
        type: "error",
        seq: 5,
        code: "invalid_audio_payload",
        message: "Live voice audio received after push-to-talk release.",
      },
    ]);
  });

  test("manual mode does not re-arm after a completed turn and rejects later audio", async () => {
    const transcribers: MockStreamingTranscriber[] = [];
    const resolver = mock(async () => {
      const transcriber = new MockStreamingTranscriber();
      transcribers.push(transcriber);
      return transcriber;
    });
    const startVoiceTurn = mock(async (options: VoiceTurnOptions) => {
      options.callbacks?.message_complete?.({
        type: "message_complete",
        conversationId: options.conversationId,
        messageId: "assistant-message-123",
      });
      return { turnId: "bridge-turn-1", abort: mock() };
    });
    const { context, frames } = createContext();
    const session = new LiveVoiceSession(context, {
      resolveTranscriber: resolver,
      startVoiceTurn,
    });

    await session.start();
    await session.handleBinaryAudio(new Uint8Array([1]));
    await session.handleClientFrame({ type: "ptt_release" });
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));
    // Give any stray speculative re-arm a chance to run.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(startVoiceTurn).toHaveBeenCalledTimes(1);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(transcribers).toHaveLength(1);

    await session.handleBinaryAudio(new Uint8Array([2]));

    expect(transcribers[0]?.audioChunks.map((chunk) => [...chunk])).toEqual([
      [1],
    ]);
    const errors = frames.filter((frame) => frame.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      code: "invalid_audio_payload",
      message: "Live voice audio received after push-to-talk release.",
    });
  });

  test("sends tts_done even when the next transcriber's startup never resolves (server_vad)", async () => {
    const firstTranscriber = new MockStreamingTranscriber();
    let resolverCalls = 0;
    const resolver: LiveVoiceStreamingTranscriberResolver = mock(async () => {
      resolverCalls += 1;
      if (resolverCalls === 1) return firstTranscriber;
      return new Promise<StreamingTranscriber | null>(() => {});
    });
    const startVoiceTurn = mock(async (options: VoiceTurnOptions) => {
      options.callbacks?.message_complete?.({
        type: "message_complete",
        conversationId: options.conversationId,
        messageId: "assistant-message-123",
      });
      return { turnId: "bridge-turn-1", abort: mock() };
    });
    const { context, frames } = createContext({ turnDetection: "server_vad" });
    const session = new LiveVoiceSession(context, {
      resolveTranscriber: resolver,
      startVoiceTurn,
    });

    await session.start();
    // No detector turn is open, so ptt_release releases the utterance
    // directly; the mock transcriber's stop() supplies the transcript.
    await session.handleClientFrame({ type: "ptt_release" });
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));
    await waitFor(() => resolverCalls === 2);

    expect(frames.filter((frame) => frame.type === "error")).toEqual([]);

    // Speech ahead of the still-starting transcriber buffers instead of erroring.
    await session.handleBinaryAudio(loudPcmChunk());

    expect(frames.filter((frame) => frame.type === "error")).toEqual([]);
    expect(firstTranscriber.audioChunks).toEqual([]);
  });

  test("surfaces a re-arm startup failure after tts_done without failing the completed turn (server_vad)", async () => {
    let resolverCalls = 0;
    const resolver: LiveVoiceStreamingTranscriberResolver = mock(async () => {
      resolverCalls += 1;
      if (resolverCalls === 1) return new MockStreamingTranscriber();
      throw new Error("next stt unavailable");
    });
    const startVoiceTurn = mock(async (options: VoiceTurnOptions) => {
      options.callbacks?.message_complete?.({
        type: "message_complete",
        conversationId: options.conversationId,
        messageId: "assistant-message-123",
      });
      return { turnId: "bridge-turn-1", abort: mock() };
    });
    const { context, frames } = createContext({ turnDetection: "server_vad" });
    const session = new LiveVoiceSession(context, {
      resolveTranscriber: resolver,
      startVoiceTurn,
      emitMetrics: true,
    });

    await session.start();
    await session.handleClientFrame({ type: "ptt_release" });
    await waitFor(() => frames.some((frame) => frame.type === "error"));

    const frameTypes = frames.map((frame) => frame.type);
    expect(frameTypes.indexOf("tts_done")).toBeGreaterThanOrEqual(0);
    expect(frameTypes.indexOf("tts_done")).toBeLessThan(
      frameTypes.indexOf("error"),
    );
    const errorFrame = frames.find((frame) => frame.type === "error");
    if (errorFrame?.type !== "error") {
      throw new Error("Expected a live voice error frame");
    }
    expect(errorFrame.message).toContain("next stt unavailable");
    expect(
      frames.some(
        (frame) => frame.type === "metrics" && frame.event === "turn_completed",
      ),
    ).toBe(true);
    expect(
      frames.some(
        (frame) => frame.type === "metrics" && frame.event === "turn_cancelled",
      ),
    ).toBe(false);
  });

  test("stops the late transcriber when the session closes during re-arm (server_vad)", async () => {
    const secondTranscriber = new MockStreamingTranscriber();
    let resolveSecond:
      | ((transcriber: StreamingTranscriber | null) => void)
      | undefined;
    let resolverCalls = 0;
    const resolver: LiveVoiceStreamingTranscriberResolver = mock(() => {
      resolverCalls += 1;
      if (resolverCalls === 1) {
        return Promise.resolve(new MockStreamingTranscriber());
      }
      return new Promise<StreamingTranscriber | null>((resolve) => {
        resolveSecond = resolve;
      });
    });
    const startVoiceTurn = mock(async (options: VoiceTurnOptions) => {
      options.callbacks?.message_complete?.({
        type: "message_complete",
        conversationId: options.conversationId,
        messageId: "assistant-message-123",
      });
      return { turnId: "bridge-turn-1", abort: mock() };
    });
    const { context, frames } = createContext({ turnDetection: "server_vad" });
    const session = new LiveVoiceSession(context, {
      resolveTranscriber: resolver,
      startVoiceTurn,
    });

    await session.start();
    await session.handleClientFrame({ type: "ptt_release" });
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));
    await waitFor(() => resolveSecond !== undefined);

    await session.close("websocket_close");
    resolveSecond?.(secondTranscriber);
    await waitFor(() => secondTranscriber.stopped);

    expect(secondTranscriber.started).toBe(false);
    expect(secondTranscriber.stopped).toBe(true);
    expect(frames.filter((frame) => frame.type === "error")).toEqual([]);
  });

  test("sends ready before the transcriber arm completes and transcribes gap audio after arm (server_vad)", async () => {
    const { transcriber, releaseStart } = createGatedStartTranscriber();
    const { context, frames } = createContext({ turnDetection: "server_vad" });
    const session = new LiveVoiceSession(context, {
      resolveTranscriber: mock(async () => transcriber),
    });

    await session.start();

    // Ready went out while the STT provider handshake is still in flight.
    expect(transcriber.started).toBe(false);
    expect(frames).toEqual([
      {
        type: "ready",
        seq: 1,
        sessionId: "session-123",
        conversationId: "conversation-123",
        turnDetection: "server_vad",
      },
    ]);

    // Speech in the ready→arm gap buffers instead of dropping or erroring.
    await session.handleBinaryAudio(loudPcmChunk());
    expect(transcriber.audioChunks).toEqual([]);
    expect(frames.filter((frame) => frame.type === "error")).toEqual([]);

    releaseStart();
    await waitFor(() => transcriber.audioChunks.length === 1);

    expect(transcriber.started).toBe(true);
    expect(transcriber.audioChunks.map((chunk) => [...chunk])).toEqual([
      [...loudPcmChunk()],
    ]);
    expect(frames.filter((frame) => frame.type === "error")).toEqual([]);
  });

  test("buffers manual-mode audio sent in the ready→arm gap and flushes it on arm", async () => {
    const { transcriber, releaseStart } = createGatedStartTranscriber();
    const { frames, session } = createSessionWithTranscriber(transcriber);

    await session.start();

    expect(transcriber.started).toBe(false);
    expect(frames.map((frame) => frame.type)).toEqual(["ready"]);

    await session.handleBinaryAudio(new Uint8Array([1, 2]));
    await session.handleBinaryAudio(new Uint8Array([3]));
    expect(transcriber.audioChunks).toEqual([]);

    releaseStart();
    await waitFor(() => transcriber.audioChunks.length === 2);

    expect(transcriber.audioChunks.map((chunk) => [...chunk])).toEqual([
      [1, 2],
      [3],
    ]);
    expect(frames.filter((frame) => frame.type === "error")).toEqual([]);
  });

  test("sends ready then a non-recoverable error frame when streaming STT is unavailable", async () => {
    const { context, frames } = createContext();
    const resolver = mock(async () => null);
    const session = new LiveVoiceSession(context, {
      resolveTranscriber: resolver,
    });

    await session.start();
    await waitFor(() => frames.some((frame) => frame.type === "error"));

    expect(frames[0]).toMatchObject({ type: "ready", seq: 1 });
    const errorFrame = frames.find((frame) => frame.type === "error");
    if (errorFrame?.type !== "error") {
      throw new Error("Expected a live voice error frame");
    }
    expect(errorFrame.code).toBe("credentials_unavailable");
    expect(errorFrame.message).toContain(
      "Live voice transcription is unavailable",
    );
    expect(errorFrame.message).toContain("credentials configured");
    expect(errorFrame).not.toHaveProperty("recoverable");

    // The failed session ignores further frames instead of silently hanging.
    const frameCount = frames.length;
    await session.handleBinaryAudio(new Uint8Array([1]));
    await session.handleClientFrame({ type: "ptt_release" });
    expect(frames).toHaveLength(frameCount);
  });

  test("sends ready then a non-recoverable error frame when provider setup throws", async () => {
    const { context, frames } = createContext();
    const resolver: LiveVoiceStreamingTranscriberResolver = mock(async () => {
      throw new Error("provider credentials rejected");
    });
    const session = new LiveVoiceSession(context, {
      resolveTranscriber: resolver,
    });

    await session.start();
    await waitFor(() => frames.some((frame) => frame.type === "error"));

    expect(frames).toEqual([
      {
        type: "ready",
        seq: 1,
        sessionId: "session-123",
        conversationId: "conversation-123",
        turnDetection: "manual",
      },
      {
        type: "error",
        seq: 2,
        code: "invalid_field",
        message:
          "Live voice transcription could not be started: provider credentials rejected",
      },
    ]);
  });

  test("retains transcriber handle when stop() throws so close() can clean up", async () => {
    class ThrowingStopTranscriber extends MockStreamingTranscriber {
      stopCalls = 0;
      override stop(): void {
        this.stopCalls += 1;
        if (this.stopCalls === 1) {
          throw new Error("stop failed");
        }
      }
    }

    const transcriber = new ThrowingStopTranscriber();
    const { frames, session } = createSessionWithTranscriber(transcriber);

    await session.start();
    await session.handleClientFrame({ type: "ptt_release" });

    expect(transcriber.stopCalls).toBe(1);
    expect(
      frames.some(
        (frame) =>
          frame.type === "error" &&
          frame.message.includes(
            "Live voice transcription could not be stopped",
          ),
      ),
    ).toBe(true);

    await session.close("websocket_close");

    expect(transcriber.stopCalls).toBe(2);
  });

  test("retains transcriber handle when stop() throws so interrupt() can clean up", async () => {
    class ThrowingStopTranscriber extends MockStreamingTranscriber {
      stopCalls = 0;
      override stop(): void {
        this.stopCalls += 1;
        if (this.stopCalls === 1) {
          throw new Error("stop failed");
        }
      }
    }

    const transcriber = new ThrowingStopTranscriber();
    const { session } = createSessionWithTranscriber(transcriber);

    await session.start();
    await session.handleClientFrame({ type: "ptt_release" });

    expect(transcriber.stopCalls).toBe(1);

    await session.handleClientFrame({ type: "interrupt" });

    expect(transcriber.stopCalls).toBe(2);
  });

  test("reuses one streaming transcriber across server_vad cycles without stop or reconnect", async () => {
    const transcriber = new FinalizingMockStreamingTranscriber();
    const resolver = mock(async () => transcriber);
    const startVoiceTurn = completingVoiceTurnStarter();
    const { context, frames } = createContext({ turnDetection: "server_vad" });
    const session = new LiveVoiceSession(context, {
      resolveTranscriber: resolver,
      startVoiceTurn,
    });

    await session.start();
    await session.handleBinaryAudio(loudPcmChunk());
    await session.handleClientFrame({ type: "ptt_release" });
    await waitFor(
      () => frames.filter((frame) => frame.type === "tts_done").length === 1,
    );

    await session.handleBinaryAudio(loudPcmChunk());
    await session.handleClientFrame({ type: "ptt_release" });
    await waitFor(
      () => frames.filter((frame) => frame.type === "tts_done").length === 2,
    );

    expect(resolver).toHaveBeenCalledTimes(1);
    expect(transcriber.startCalls).toBe(1);
    // The turn starts on the finalized flush — the stream is never torn
    // down between cycles.
    expect(transcriber.stopCalls).toBe(0);
    expect(transcriber.finalizeCalls).toBe(2);
    expect(startVoiceTurn.mock.calls.map((call) => call[0].content)).toEqual([
      "utterance 1",
      "utterance 2",
    ]);
    expect(
      frames.flatMap((frame) =>
        frame.type === "stt_final" ? [frame.text] : [],
      ),
    ).toEqual(["utterance 1", "utterance 2"]);

    await session.close("websocket_close");
    expect(transcriber.stopCalls).toBe(1);
  });

  test("grace timeout starts the turn with collected segments when the finalize flush never arrives", async () => {
    const transcriber = new FinalizingMockStreamingTranscriber();
    transcriber.respondToFinalize = false;
    const startVoiceTurn = completingVoiceTurnStarter();
    const { context, frames } = createContext({ turnDetection: "server_vad" });
    const session = new LiveVoiceSession(context, {
      resolveTranscriber: mock(async () => transcriber),
      startVoiceTurn,
      finalizeGraceMs: 25,
    });

    await session.start();
    await session.handleBinaryAudio(loudPcmChunk());
    transcriber.emit({ type: "final", text: "collected before release" });
    await session.handleClientFrame({ type: "ptt_release" });
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    expect(transcriber.finalizeCalls).toBe(1);
    expect(transcriber.stopCalls).toBe(0);
    expect(startVoiceTurn).toHaveBeenCalledTimes(1);
    expect(startVoiceTurn.mock.calls[0]?.[0]).toMatchObject({
      content: "collected before release",
    });

    // A flush landing after the grace-timeout fallback must not mutate the
    // dispatched transcript.
    transcriber.emit({ type: "final", text: "late flush", fromFinalize: true });
    transcriber.emit({ type: "finalized" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(startVoiceTurn).toHaveBeenCalledTimes(1);
    expect(
      frames.flatMap((frame) =>
        frame.type === "stt_final" ? [frame.text] : [],
      ),
    ).toEqual(["collected before release"]);
  });

  test("speech after a grace-timeout dispatch routes to the next cycle, not the timed-out one", async () => {
    const transcriber = new FinalizingMockStreamingTranscriber();
    transcriber.respondToFinalize = false;
    const startVoiceTurn = completingVoiceTurnStarter();
    const { context, frames } = createContext({ turnDetection: "server_vad" });
    const session = new LiveVoiceSession(context, {
      resolveTranscriber: mock(async () => transcriber),
      startVoiceTurn,
      finalizeGraceMs: 25,
    });

    await session.start();
    await session.handleBinaryAudio(loudPcmChunk());
    transcriber.emit({ type: "final", text: "first utterance" });
    await session.handleClientFrame({ type: "ptt_release" });
    await waitFor(
      () => frames.filter((frame) => frame.type === "tts_done").length === 1,
    );

    // The user speaks again while the timed-out cycle's finalize slot is
    // still pending (the provider never flushed). The new speech must
    // reach the new cycle — not be dropped against the dead one.
    await session.handleBinaryAudio(loudPcmChunk());
    transcriber.emit({ type: "final", text: "second utterance" });
    // The stale flush pair finally arrives: the flagged flush is dropped,
    // the finalized signal clears the slot.
    transcriber.emit({ type: "final", text: "stale tail", fromFinalize: true });
    transcriber.emit({ type: "finalized" });

    transcriber.respondToFinalize = true;
    await session.handleClientFrame({ type: "ptt_release" });
    await waitFor(
      () => frames.filter((frame) => frame.type === "tts_done").length === 2,
    );

    expect(startVoiceTurn).toHaveBeenCalledTimes(2);
    const secondContent = startVoiceTurn.mock.calls[1]?.[0]?.content ?? "";
    expect(secondContent).toContain("second utterance");
    expect(secondContent).not.toContain("stale tail");
    expect(secondContent).not.toContain("first utterance");
  });

  test("a stale flush arriving after the next cycle released is dropped, not absorbed", async () => {
    const transcriber = new FinalizingMockStreamingTranscriber();
    transcriber.respondToFinalize = false;
    const startVoiceTurn = completingVoiceTurnStarter();
    const { context, frames } = createContext({ turnDetection: "server_vad" });
    const session = new LiveVoiceSession(context, {
      resolveTranscriber: mock(async () => transcriber),
      startVoiceTurn,
      finalizeGraceMs: 25,
    });

    // Cycle A: dispatched by grace timeout, its flush still outstanding.
    await session.start();
    await session.handleBinaryAudio(loudPcmChunk());
    transcriber.emit({ type: "final", text: "first utterance" });
    await session.handleClientFrame({ type: "ptt_release" });
    await waitFor(
      () => frames.filter((frame) => frame.type === "tts_done").length === 1,
    );

    // Cycle B releases while A's request is still open (two queued
    // requests). A's stale flush then arrives — it must be attributed to
    // A's request (and dropped), never appended to B.
    await session.handleBinaryAudio(loudPcmChunk());
    transcriber.emit({ type: "final", text: "second utterance" });
    await session.handleClientFrame({ type: "ptt_release" });
    transcriber.emit({
      type: "final",
      text: "stale first flush",
      fromFinalize: true,
    });
    transcriber.emit({ type: "finalized" });
    // B's own flush completes its request.
    transcriber.emit({ type: "final", text: "flush b", fromFinalize: true });
    transcriber.emit({ type: "finalized" });
    await waitFor(
      () => frames.filter((frame) => frame.type === "tts_done").length === 2,
    );

    expect(startVoiceTurn).toHaveBeenCalledTimes(2);
    const secondContent = startVoiceTurn.mock.calls[1]?.[0]?.content ?? "";
    expect(secondContent).toContain("second utterance");
    expect(secondContent).toContain("flush b");
    expect(secondContent).not.toContain("stale first flush");
    expect(secondContent).not.toContain("first utterance");
  });

  test("holds the next finalize request until the outstanding one settles", async () => {
    const transcriber = new FinalizingMockStreamingTranscriber();
    transcriber.respondToFinalize = false;
    const startVoiceTurn = completingVoiceTurnStarter();
    const { context, frames } = createContext({ turnDetection: "server_vad" });
    const session = new LiveVoiceSession(context, {
      resolveTranscriber: mock(async () => transcriber),
      startVoiceTurn,
      finalizeGraceMs: 25,
    });

    // Cycle A: released, the provider stays silent, the grace timeout
    // seals and dispatches it with A's request still outstanding.
    await session.start();
    await session.handleBinaryAudio(loudPcmChunk());
    transcriber.emit({ type: "final", text: "first utterance" });
    await session.handleClientFrame({ type: "ptt_release" });
    await waitFor(
      () => frames.filter((frame) => frame.type === "tts_done").length === 1,
    );
    expect(transcriber.finalizeCalls).toBe(1);

    // Cycle B releases while A's request is outstanding: B's request must
    // wait — two in-flight requests can be answered by a single flush and
    // desync the queue permanently.
    await session.handleBinaryAudio(loudPcmChunk());
    transcriber.emit({ type: "final", text: "second utterance" });
    await session.handleClientFrame({ type: "ptt_release" });
    expect(transcriber.finalizeCalls).toBe(1);

    // A's answer finally arrives: its stale flush is dropped against A,
    // and B's request goes out on the pump (the fake answers it
    // synchronously with "utterance 2").
    transcriber.emit({ type: "final", text: "stale tail", fromFinalize: true });
    transcriber.respondToFinalize = true;
    transcriber.emit({ type: "finalized" });
    await waitFor(
      () => frames.filter((frame) => frame.type === "tts_done").length === 2,
    );

    expect(transcriber.finalizeCalls).toBe(2);
    expect(startVoiceTurn).toHaveBeenCalledTimes(2);
    const secondContent = startVoiceTurn.mock.calls[1]?.[0]?.content ?? "";
    expect(secondContent).toContain("second utterance");
    expect(secondContent).toContain("utterance 2");
    expect(secondContent).not.toContain("stale tail");
    expect(secondContent).not.toContain("first utterance");
  });

  test("drops a sealed never-requested cycle when the outstanding finalize settles", async () => {
    const transcriber = new FinalizingMockStreamingTranscriber();
    transcriber.respondToFinalize = false;
    const startVoiceTurn = completingVoiceTurnStarter();
    const { context, frames } = createContext({ turnDetection: "server_vad" });
    const session = new LiveVoiceSession(context, {
      resolveTranscriber: mock(async () => transcriber),
      startVoiceTurn,
      finalizeGraceMs: 25,
    });

    // Cycle A: released, silent provider, grace-sealed and dispatched with
    // its request outstanding.
    await session.start();
    await session.handleBinaryAudio(loudPcmChunk());
    transcriber.emit({ type: "final", text: "first utterance" });
    await session.handleClientFrame({ type: "ptt_release" });
    await waitFor(
      () => frames.filter((frame) => frame.type === "tts_done").length === 1,
    );

    // Cycle B: releases while A is outstanding (its request never sent),
    // then its own grace timeout seals and dispatches it too.
    await session.handleBinaryAudio(loudPcmChunk());
    transcriber.emit({ type: "final", text: "second utterance" });
    await session.handleClientFrame({ type: "ptt_release" });
    await waitFor(
      () => frames.filter((frame) => frame.type === "tts_done").length === 2,
    );
    expect(transcriber.finalizeCalls).toBe(1);

    // A's finalized arrives. B is sealed and never sent a request — no
    // finalized will ever answer it, so the pump drains it without
    // sending a request for an already-dispatched transcript.
    transcriber.emit({ type: "finalized" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(transcriber.finalizeCalls).toBe(1);

    // Cycle C: the request slot is free again — C's request goes out and
    // its flush is attributed to C.
    transcriber.respondToFinalize = true;
    await session.handleBinaryAudio(loudPcmChunk());
    await session.handleClientFrame({ type: "ptt_release" });
    await waitFor(
      () => frames.filter((frame) => frame.type === "tts_done").length === 3,
    );

    expect(transcriber.finalizeCalls).toBe(2);
    expect(startVoiceTurn).toHaveBeenCalledTimes(3);
    const thirdContent = startVoiceTurn.mock.calls[2]?.[0]?.content ?? "";
    expect(thirdContent).toContain("utterance 2");
    expect(thirdContent).not.toContain("first utterance");
    expect(thirdContent).not.toContain("second utterance");
  });

  test("falls back to a fresh transcriber when the shared stream closes unexpectedly", async () => {
    const transcribers: FinalizingMockStreamingTranscriber[] = [];
    const resolver = mock(async () => {
      const transcriber = new FinalizingMockStreamingTranscriber();
      transcribers.push(transcriber);
      return transcriber;
    });
    const startVoiceTurn = completingVoiceTurnStarter();
    const { context, frames } = createContext({ turnDetection: "server_vad" });
    const session = new LiveVoiceSession(context, {
      resolveTranscriber: resolver,
      startVoiceTurn,
    });

    await session.start();
    await session.handleBinaryAudio(loudPcmChunk());
    await session.handleClientFrame({ type: "ptt_release" });
    await waitFor(
      () => frames.filter((frame) => frame.type === "tts_done").length === 1,
    );

    // Provider drops the shared stream between utterances.
    transcribers[0]?.emit({ type: "closed" });
    await session.handleBinaryAudio(loudPcmChunk());
    await waitFor(() => transcribers.length === 2);
    await session.handleClientFrame({ type: "ptt_release" });
    await waitFor(
      () => frames.filter((frame) => frame.type === "tts_done").length === 2,
    );

    expect(resolver).toHaveBeenCalledTimes(2);
    expect(transcribers[1]?.startCalls).toBe(1);
    expect(startVoiceTurn.mock.calls.map((call) => call[0].content)).toEqual([
      "utterance 1",
      "utterance 1",
    ]);
  });

  test("uses the production streaming transcriber resolver by default", () => {
    const source = readFileSync(
      new URL("../live-voice-session.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain("resolveStreamingTranscriber");
    expect(source).not.toMatch(/from\s+["']@anthropic-ai\/sdk/);
    expect(source).not.toMatch(/from\s+["']openai/);
    expect(source).not.toMatch(/from\s+["']@google\/genai/);
    expect(source).not.toMatch(/fetch\(/);
  });
});
