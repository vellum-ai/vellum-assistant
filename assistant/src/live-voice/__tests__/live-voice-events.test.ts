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
  LiveVoiceSession,
  type LiveVoiceSessionArchiveAudioInput,
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

function makeClock(): () => number {
  let now = 1_000;
  return () => {
    now += 10;
    return now;
  };
}

function createSessionHarness(options: {
  archiveAudio: LiveVoiceSessionAudioArchiver;
  startVoiceTurn: LiveVoiceTurnStarter;
  streamTtsAudio?: LiveVoiceTtsStreamer | null;
}) {
  const transcriber = new MockStreamingTranscriber();
  const { context, frames } = createContext();
  const session = new LiveVoiceSession(context, {
    resolveTranscriber: mock(async () => transcriber),
    startVoiceTurn: options.startVoiceTurn,
    streamTtsAudio: options.streamTtsAudio ?? null,
    archiveAudio: options.archiveAudio,
    emitMetrics: true,
    metricsClock: makeClock(),
    createTurnId: () => "live-turn-1",
  });

  return { frames, session, transcriber };
}

async function startReleasedTurn(
  session: LiveVoiceSession,
  userAudio = "user audio bytes",
): Promise<void> {
  await session.start();
  await session.handleClientFrame({
    type: "audio",
    dataBase64: Buffer.from(userAudio).toString("base64"),
  });
  await session.handleClientFrame({ type: "ptt_release" });
}

async function waitFor(
  predicate: () => boolean,
  message = "Timed out waiting for live voice event test condition",
): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
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

function frameTypes(frames: LiveVoiceServerFrame[]): string[] {
  return frames.map((frame) => frame.type);
}

describe("LiveVoiceSession archive and metrics events", () => {
  test("archives user and assistant audio and emits completion and session metrics", async () => {
    let callbacks: VoiceTurnCallbacks | undefined;
    const archiveAudio = mock(
      async (input: LiveVoiceSessionArchiveAudioInput) =>
        makeArchiveResult(input),
    );
    const startVoiceTurn = mock(async (options: VoiceTurnOptions) => {
      callbacks = options.callbacks;
      options.callbacks?.persisted_user_message_id?.("user-message-123");
      return { turnId: "bridge-turn-1", abort: mock() };
    });
    const streamTtsAudio = mock(async (options: LiveVoiceTtsOptions) => {
      options.onAudioChunk(makeTtsChunk("assistant audio bytes"));
      return makeTtsResult("assistant audio bytes");
    });
    const { frames, session } = createSessionHarness({
      archiveAudio,
      startVoiceTurn,
      streamTtsAudio,
    });

    await startReleasedTurn(session);
    expect(startVoiceTurn.mock.calls[0]?.[0]).toMatchObject({
      approvalMode: "local-live-voice",
    });
    callbacks?.assistant_text_delta?.(makeTextDelta("Hello there."));
    callbacks?.message_complete?.(makeMessageComplete());
    await waitFor(() =>
      frames.some(
        (frame) => frame.type === "metrics" && frame.event === "turn_completed",
      ),
    );
    await session.close("client_end");

    expect(frameTypes(frames)).toContain("tts_done");
    expect(archiveAudio).toHaveBeenCalledTimes(2);
    expect(archiveAudio.mock.calls.map((call) => call[0].role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(archiveAudio.mock.calls[0]?.[0]).toMatchObject({
      messageId: "user-message-123",
      sessionId: "session-123",
      turnId: "live-turn-1",
      role: "user",
    });
    expect(archiveAudio.mock.calls[1]?.[0]).toMatchObject({
      messageId: "assistant-message-123",
      sessionId: "session-123",
      turnId: "live-turn-1",
      role: "assistant",
    });
    expect(
      Buffer.from(
        archiveAudio.mock.calls[0]![0].audio.dataBase64,
        "base64",
      ).toString(),
    ).toBe("user audio bytes");
    expect(
      Buffer.from(
        archiveAudio.mock.calls[1]![0].audio.dataBase64,
        "base64",
      ).toString(),
    ).toBe("assistant audio bytes");

    const archivedFrames = frames.filter((frame) => frame.type === "archived");
    expect(archivedFrames).toHaveLength(2);
    expect(archivedFrames.map((frame) => frame.attachmentIds)).toEqual([
      ["user-attachment-123"],
      ["assistant-attachment-123"],
    ]);

    const completedMetrics = frames.find(
      (frame) => frame.type === "metrics" && frame.event === "turn_completed",
    );
    expect(completedMetrics).toMatchObject({
      type: "metrics",
      sessionId: "session-123",
      conversationId: "conversation-123",
      turnId: "live-turn-1",
      sttMs: 10,
      llmFirstDeltaMs: 10,
      ttsFirstAudioMs: 10,
      totalMs: 60,
      metrics: {
        summary: {
          completedTurnCount: 1,
          cancelledTurnCount: 0,
        },
      },
    });
    expect(frames.at(-1)).toMatchObject({
      type: "metrics",
      event: "session_ended",
      sessionId: "session-123",
    });
    expect(
      (
        session as unknown as {
          currentUserAudioChunks: Buffer[];
          activeAssistantTurn: unknown;
        }
      ).currentUserAudioChunks,
    ).toHaveLength(0);
    expect(
      (
        session as unknown as {
          activeAssistantTurn: unknown;
        }
      ).activeAssistantTurn,
    ).toBeNull();
  });

  test("uses the TTS chunk content type for socket frames and archive metadata", async () => {
    let callbacks: VoiceTurnCallbacks | undefined;
    const archiveAudio = mock(
      async (input: LiveVoiceSessionArchiveAudioInput) =>
        makeArchiveResult(input),
    );
    const startVoiceTurn = mock(async (options: VoiceTurnOptions) => {
      callbacks = options.callbacks;
      options.callbacks?.persisted_user_message_id?.("user-message-123");
      return { turnId: "bridge-turn-1", abort: mock() };
    });
    const streamTtsAudio = mock(async (options: LiveVoiceTtsOptions) => {
      options.onAudioChunk(makeTtsChunk("assistant wav bytes", "audio/wav"));
      return makeTtsResult("assistant wav bytes", "audio/wav");
    });
    const { frames, session } = createSessionHarness({
      archiveAudio,
      startVoiceTurn,
      streamTtsAudio,
    });

    await startReleasedTurn(session);
    callbacks?.assistant_text_delta?.(makeTextDelta("Hello there."));
    callbacks?.message_complete?.(makeMessageComplete());
    await waitFor(() =>
      frames.some(
        (frame) => frame.type === "archived" && frame.role === "assistant",
      ),
    );

    expect(frames.find((frame) => frame.type === "tts_audio")).toMatchObject({
      type: "tts_audio",
      mimeType: "audio/wav",
      dataBase64: Buffer.from("assistant wav bytes").toString("base64"),
    });
    expect(
      archiveAudio.mock.calls.find((call) => call[0].role === "assistant")?.[0],
    ).toMatchObject({
      role: "assistant",
      mimeType: "audio/wav",
    });
  });

  test("emits cancelled metrics and releases buffers when interrupted", async () => {
    const abort = mock();
    const archiveAudio = mock(
      async (input: LiveVoiceSessionArchiveAudioInput) =>
        makeArchiveResult(input),
    );
    const startVoiceTurn = mock(async (options: VoiceTurnOptions) => {
      options.callbacks?.persisted_user_message_id?.("user-message-123");
      return { turnId: "bridge-turn-1", abort };
    });
    const { frames, session } = createSessionHarness({
      archiveAudio,
      startVoiceTurn,
    });

    await startReleasedTurn(session);
    await session.handleClientFrame({ type: "interrupt" });

    expect(abort).toHaveBeenCalledTimes(1);
    expect(frames.some((frame) => frame.type === "tts_done")).toBe(false);
    expect(frames.find((frame) => frame.type === "archived")).toMatchObject({
      type: "archived",
      role: "user",
      attachmentIds: ["user-attachment-123"],
    });
    expect(frames.find((frame) => frame.type === "metrics")).toMatchObject({
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
    expect(
      (
        session as unknown as {
          currentUserAudioChunks: Buffer[];
        }
      ).currentUserAudioChunks,
    ).toHaveLength(0);
  });

  test("emits warning archive frames and error-turn metrics without throwing", async () => {
    const archiveAudio = mock(async () => {
      throw new Error("archive store unavailable");
    });
    const startVoiceTurn = mock(async () => {
      throw new Error("assistant turn failed");
    });
    const { frames, session } = createSessionHarness({
      archiveAudio,
      startVoiceTurn,
    });

    await startReleasedTurn(session);
    await waitFor(() =>
      frames.some(
        (frame) => frame.type === "metrics" && frame.event === "turn_cancelled",
      ),
    );

    expect(frames.find((frame) => frame.type === "error")).toMatchObject({
      type: "error",
      message: expect.stringContaining("assistant turn failed"),
    });
    expect(frames.find((frame) => frame.type === "archived")).toMatchObject({
      type: "archived",
      role: "user",
      warning: {
        code: "archive_failed",
        message: expect.stringContaining("archive store unavailable"),
      },
    });
    expect(frames.find((frame) => frame.type === "metrics")).toMatchObject({
      type: "metrics",
      event: "turn_cancelled",
      turnId: "live-turn-1",
      metrics: {
        summary: {
          cancelledTurnCount: 1,
        },
      },
    });
    expect(
      (
        session as unknown as {
          currentUserAudioChunks: Buffer[];
        }
      ).currentUserAudioChunks,
    ).toHaveLength(0);
  });
});
