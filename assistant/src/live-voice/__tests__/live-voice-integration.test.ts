import { describe, expect, mock, test } from "bun:test";

import type {
  VoiceTurnCallbacks,
  VoiceTurnOptions,
} from "../../calls/voice-session-bridge.js";
import type {
  StreamingTranscriber,
  SttStreamServerEvent,
} from "../../stt/types.js";
import type { LiveVoiceAudioArchiveResult } from "../live-voice-archive.js";
import {
  createLiveVoiceSession,
  type LiveVoiceSessionArchiveAudioInput,
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

class FakeStreamingTranscriber implements StreamingTranscriber {
  readonly providerId = "deepgram" as const;
  readonly boundaryId = "daemon-streaming" as const;
  readonly audioChunks: Buffer[] = [];
  stopped = false;
  private onEvent: ((event: SttStreamServerEvent) => void) | null = null;

  async start(onEvent: (event: SttStreamServerEvent) => void): Promise<void> {
    this.onEvent = onEvent;
  }

  sendAudio(audio: Buffer): void {
    this.audioChunks.push(Buffer.from(audio));
    this.emit({ type: "partial", text: "hel" });
  }

  stop(): void {
    this.stopped = true;
    this.emit({ type: "final", text: "hello from live voice" });
    this.emit({ type: "closed" });
  }

  private emit(event: SttStreamServerEvent): void {
    this.onEvent?.(event);
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

function createClock(): () => number {
  let now = 1_000;
  return () => {
    now += 25;
    return now;
  };
}

function makeArchiveResult(
  input: LiveVoiceSessionArchiveAudioInput,
): LiveVoiceAudioArchiveResult {
  const attachmentId = `${input.role}-attachment-123`;
  return {
    type: "archived",
    artifact: {
      source: "live-voice",
      archiveKey: `live-voice:${input.sessionId}:${input.turnId}:${input.role}`,
      attachmentId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      role: input.role,
      mimeType: input.mimeType,
      ...(input.sampleRate !== undefined
        ? { sampleRate: input.sampleRate }
        : {}),
      ...(input.durationMs !== undefined
        ? { durationMs: input.durationMs }
        : {}),
      sizeBytes: Buffer.byteLength(input.audio.dataBase64, "base64"),
      filename: `${attachmentId}.pcm`,
      archivedAt: 1_234,
    },
    idempotent: false,
  };
}

function makeTtsChunk(text: string): LiveVoiceTtsAudioChunk {
  return {
    type: "tts_audio",
    contentType: "audio/pcm",
    sampleRate: 24_000,
    dataBase64: Buffer.from(text).toString("base64"),
  };
}

function makeTtsResult(text: string): LiveVoiceTtsResult {
  return {
    provider: "fish-audio",
    contentType: "audio/pcm",
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

async function waitFor(
  predicate: () => boolean,
  message = "Timed out waiting for live voice integration condition",
): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

function frameTypes(frames: LiveVoiceServerFrame[]): string[] {
  return frames.map((frame) => frame.type);
}

describe("LiveVoiceSession integration smoke harness", () => {
  test("runs a full credential-free live voice turn through STT, bridge, TTS, archive, and metrics", async () => {
    const transcriber = new FakeStreamingTranscriber();
    const archiveAudio = mock(
      async (input: LiveVoiceSessionArchiveAudioInput) =>
        makeArchiveResult(input),
    );
    const startVoiceTurn = mock(async (options: VoiceTurnOptions) => {
      options.callbacks?.persisted_user_message_id?.("user-message-123");
      options.callbacks?.assistant_text_delta?.(
        makeTextDelta("Hello from the assistant."),
      );
      options.callbacks?.message_complete?.(makeMessageComplete());
      return { turnId: "bridge-turn-1", abort: mock() };
    });
    const streamTtsAudio = mock(async (options: LiveVoiceTtsOptions) => {
      options.onAudioChunk(makeTtsChunk(`audio:${options.text}`));
      return makeTtsResult(options.text);
    });
    const { context, frames } = createContext();
    const session = createLiveVoiceSession(context, {
      resolveTranscriber: mock(async () => transcriber),
      startVoiceTurn,
      streamTtsAudio,
      archiveAudio,
      metricsClock: createClock(),
      createTurnId: () => "live-turn-1",
    });

    await session.start();
    await session.handleBinaryAudio(new Uint8Array([1, 2, 3, 4]));
    await session.handleClientFrame({ type: "ptt_release" });
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    expect(transcriber.audioChunks).toHaveLength(1);
    expect(transcriber.audioChunks[0]).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(transcriber.stopped).toBe(true);
    expect(startVoiceTurn).toHaveBeenCalledTimes(1);
    expect(startVoiceTurn.mock.calls[0]?.[0]).toMatchObject({
      conversationId: "conversation-123",
      voiceSessionId: "session-123",
      userMessageChannel: "vellum",
      assistantMessageChannel: "vellum",
      userMessageInterface: "macos",
      assistantMessageInterface: "macos",
      content: "hello from live voice",
      isInbound: true,
    });
    expect(streamTtsAudio).toHaveBeenCalledTimes(1);
    expect(streamTtsAudio.mock.calls[0]?.[0]).toMatchObject({
      text: "Hello from the assistant.",
      outputFormat: "pcm",
      sampleRate: 24_000,
    });
    expect(archiveAudio.mock.calls.map((call) => call[0].role)).toEqual([
      "user",
      "assistant",
    ]);

    expect(frameTypes(frames)).toEqual([
      "ready",
      "stt_partial",
      "stt_final",
      "thinking",
      "assistant_text_delta",
      "tts_audio",
      "archived",
      "archived",
      "metrics",
      "tts_done",
    ]);
    expect(frames[5]).toMatchObject({
      type: "tts_audio",
      dataBase64: Buffer.from("audio:Hello from the assistant.").toString(
        "base64",
      ),
    });
    expect(frames[6]).toMatchObject({
      type: "archived",
      role: "user",
      attachmentIds: ["user-attachment-123"],
    });
    expect(frames[7]).toMatchObject({
      type: "archived",
      role: "assistant",
      attachmentIds: ["assistant-attachment-123"],
    });
    expect(frames[8]).toMatchObject({
      type: "metrics",
      event: "turn_completed",
      sessionId: "session-123",
      conversationId: "conversation-123",
      turnId: "live-turn-1",
      metrics: {
        summary: {
          completedTurnCount: 1,
          cancelledTurnCount: 0,
        },
      },
    });
    expect(frames[9]).toMatchObject({
      type: "tts_done",
      turnId: "live-turn-1",
    });
  });

  test("emits archive and cancelled metrics for an interrupted live voice turn", async () => {
    const transcriber = new FakeStreamingTranscriber();
    const abort = mock();
    const archiveAudio = mock(
      async (input: LiveVoiceSessionArchiveAudioInput) =>
        makeArchiveResult(input),
    );
    const startVoiceTurn: LiveVoiceTurnStarter = mock(
      async (options: VoiceTurnOptions) => {
        options.callbacks?.persisted_user_message_id?.("user-message-123");
        return { turnId: "bridge-turn-1", abort };
      },
    );
    const streamTtsAudio: LiveVoiceTtsStreamer = mock(
      async (options: LiveVoiceTtsOptions) => {
        options.onAudioChunk(makeTtsChunk("late audio"));
        return makeTtsResult("late audio");
      },
    );
    const { context, frames } = createContext();
    const session = createLiveVoiceSession(context, {
      resolveTranscriber: mock(async () => transcriber),
      startVoiceTurn,
      streamTtsAudio,
      archiveAudio,
      metricsClock: createClock(),
      createTurnId: () => "live-turn-1",
    });

    await session.start();
    await session.handleBinaryAudio(new Uint8Array([9, 8, 7, 6]));
    await session.handleClientFrame({ type: "ptt_release" });
    await waitFor(() => frames.some((frame) => frame.type === "thinking"));

    await session.handleClientFrame({ type: "interrupt" });
    await waitFor(() =>
      frames.some(
        (frame) => frame.type === "metrics" && frame.event === "turn_cancelled",
      ),
    );

    expect(abort).toHaveBeenCalledTimes(1);
    expect(streamTtsAudio).not.toHaveBeenCalled();
    expect(archiveAudio).toHaveBeenCalledTimes(1);
    expect(archiveAudio.mock.calls[0]?.[0]).toMatchObject({
      role: "user",
      messageId: "user-message-123",
      sessionId: "session-123",
      turnId: "live-turn-1",
    });
    expect(frameTypes(frames)).toEqual([
      "ready",
      "stt_partial",
      "stt_final",
      "thinking",
      "archived",
      "metrics",
    ]);
    expect(frames[4]).toMatchObject({
      type: "archived",
      role: "user",
      attachmentIds: ["user-attachment-123"],
    });
    expect(frames[5]).toMatchObject({
      type: "metrics",
      event: "turn_cancelled",
      turnId: "live-turn-1",
      metrics: {
        summary: {
          completedTurnCount: 0,
          cancelledTurnCount: 1,
        },
      },
    });
  });
});
