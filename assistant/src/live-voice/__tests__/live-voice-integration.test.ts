/**
 * Wired end-to-end tests for the duplex live-voice session: real
 * LiveVoiceIngest (with a mock streaming/batch transcriber via its deps
 * seam), real LiveVoiceCallTransport (with a fake TTS streamer), and the
 * real CallController + in-app VoiceControllerProfile. Only the outermost
 * boundaries are faked; the conversation pipeline is stubbed by
 * mock-moduling voice-session-bridge's startVoiceTurn.
 *
 * `mock.module` is process-global in Bun and leaks into sibling files in
 * the same `bun test` invocation, so the stub delegates to the real
 * implementation unless this file's tests are active (`wiredMocksActive`).
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import type {
  VoiceTurnHandle,
  VoiceTurnOptions,
} from "../../calls/voice-session-bridge.js";

// Silence controller lifecycle logging (registered before any module that
// captures a logger at import time).
mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

let wiredMocksActive = false;
const realBridgeModule = {
  ...(await import("../../calls/voice-session-bridge.js")),
};

// ── Scripted voice-turn stub (the conversation pipeline boundary) ────

interface FakeTurnScript {
  deltas: string[];
  /** When false, the turn stays in flight until aborted (barge-in). */
  autoComplete?: boolean;
}

let turnScripts: FakeTurnScript[] = [];
let voiceTurnCalls: VoiceTurnOptions[] = [];

async function fakeStartVoiceTurn(
  opts: VoiceTurnOptions,
): Promise<VoiceTurnHandle> {
  voiceTurnCalls.push(opts);
  const script = turnScripts[voiceTurnCalls.length - 1] ?? {
    deltas: ["Okay."],
  };

  if (opts.signal?.aborted) {
    const err = new Error("aborted");
    err.name = "AbortError";
    throw err;
  }
  for (const delta of script.deltas) {
    if (opts.signal?.aborted) {
      break;
    }
    opts.onTextDelta?.(delta);
  }
  if (script.autoComplete !== false && !opts.signal?.aborted) {
    opts.onComplete?.();
  }

  return { turnId: `bridge-turn-${voiceTurnCalls.length}`, abort: () => {} };
}

mock.module("../../calls/voice-session-bridge.js", () => ({
  ...realBridgeModule,
  startVoiceTurn: (opts: VoiceTurnOptions) =>
    wiredMocksActive
      ? fakeStartVoiceTurn(opts)
      : realBridgeModule.startVoiceTurn(opts),
}));

import type {
  BatchTranscriber,
  StreamingTranscriber,
  SttStreamServerEvent,
} from "../../stt/types.js";
import { LiveVoiceIngest } from "../live-voice-ingest.js";
import {
  createLiveVoiceSession,
  type LiveVoiceSession,
  type LiveVoiceSessionArchiveAudioInput,
  type LiveVoiceTtsStreamer,
} from "../live-voice-session.js";
import { LiveVoiceCallTransport } from "../live-voice-transport.js";
import type { LiveVoiceTtsOptions } from "../live-voice-tts.js";
import {
  createLiveVoiceServerFrameSequencer,
  type LiveVoiceClientStartFrame,
  type LiveVoiceServerFrame,
  type LiveVoiceSessionMode,
} from "../protocol.js";
import { makeArchiveResult } from "./live-voice-session-harness.js";

beforeAll(() => {
  wiredMocksActive = true;
});

afterAll(() => {
  wiredMocksActive = false;
});

// ── Outermost fakes ───────────────────────────────────────────────────

class MockStreamingTranscriber implements StreamingTranscriber {
  readonly providerId = "deepgram" as const;
  readonly boundaryId = "daemon-streaming" as const;
  readonly audioChunks: Buffer[] = [];
  private onEvent: ((event: SttStreamServerEvent) => void) | null = null;

  async start(onEvent: (event: SttStreamServerEvent) => void): Promise<void> {
    this.onEvent = onEvent;
  }

  sendAudio(audio: Buffer): void {
    this.audioChunks.push(Buffer.from(audio));
  }

  stop(): void {}

  emit(event: SttStreamServerEvent): void {
    this.onEvent?.(event);
  }
}

/** Whether the fake TTS holds each synthesis job open until aborted. */
let ttsHoldUntilAbort = false;

const fakeStreamTtsAudio: LiveVoiceTtsStreamer = async (
  options: LiveVoiceTtsOptions,
) => {
  options.onAudioChunk({
    type: "tts_audio",
    contentType: "audio/pcm",
    sampleRate: options.sampleRate ?? 24_000,
    dataBase64: Buffer.from(`audio:${options.text}`).toString("base64"),
  });
  if (ttsHoldUntilAbort) {
    await new Promise<void>((resolve) => {
      if (options.signal?.aborted) {
        resolve();
        return;
      }
      options.signal?.addEventListener("abort", () => resolve(), {
        once: true,
      });
    });
  }
  return {
    provider: "fish-audio",
    contentType: "audio/pcm",
    sampleRate: options.sampleRate ?? 24_000,
    chunks: 1,
    bytes: 1,
  };
};

// ── Harness ───────────────────────────────────────────────────────────

/** A PCM16 chunk loud enough to trip the default 800 energy threshold. */
function loudChunk(samples = 480): Buffer {
  const chunk = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    chunk.writeInt16LE(8_000, i * 2);
  }
  return chunk;
}

interface WiredHarness {
  session: LiveVoiceSession;
  frames: LiveVoiceServerFrame[];
  transcriber: MockStreamingTranscriber;
  archiveAudio: ReturnType<typeof mock>;
}

const openSessions: LiveVoiceSession[] = [];

function createWiredHarness(
  options: {
    mode?: LiveVoiceSessionMode;
    /** Streaming resolver returns null so the ingest settles on batch. */
    batchTranscript?: string;
    silenceThresholdMs?: number;
  } = {},
): WiredHarness {
  const sequencer = createLiveVoiceServerFrameSequencer();
  const frames: LiveVoiceServerFrame[] = [];
  const startFrame: LiveVoiceClientStartFrame = {
    type: "start",
    conversationId: "conversation-123",
    audio: { mimeType: "audio/pcm", sampleRate: 24_000, channels: 1 },
    ...(options.mode ? { mode: options.mode } : {}),
  };
  const transcriber = new MockStreamingTranscriber();
  const batchTranscriber: BatchTranscriber = {
    providerId: "openai-whisper",
    boundaryId: "daemon-batch",
    transcribe: async () => ({ text: options.batchTranscript ?? "" }),
  };
  const archiveAudio = mock(async (input: LiveVoiceSessionArchiveAudioInput) =>
    makeArchiveResult(input),
  );
  let turnCounter = 0;

  const session = createLiveVoiceSession(
    {
      sessionId: "session-123",
      startFrame,
      sendFrame: async (payload) => {
        const frame = sequencer.next(payload);
        frames.push(frame);
        return frame;
      },
    },
    {
      createIngest: (config, callbacks) =>
        new LiveVoiceIngest(
          {
            ...config,
            vad: {
              ...config.vad,
              ...(options.silenceThresholdMs !== undefined
                ? { silenceThresholdMs: options.silenceThresholdMs }
                : {}),
            },
          },
          callbacks,
          {
            resolveStreamingTranscriber: async () =>
              options.batchTranscript !== undefined ? null : transcriber,
            resolveBatchTranscriber: async () => batchTranscriber,
          },
        ),
      createTransport: (deps) =>
        new LiveVoiceCallTransport({
          ...deps,
          streamTtsAudio: fakeStreamTtsAudio,
        }),
      credentialPreflight: async () => ({ status: "ready" }),
      archiveAudio,
      emitMetrics: true,
      createTurnId: () => `live-turn-${++turnCounter}`,
    },
  );
  openSessions.push(session);

  return { session, frames, transcriber, archiveAudio };
}

async function waitFor(
  predicate: () => boolean,
  message = "Timed out waiting for wired live voice condition",
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

function typedFrames<T extends LiveVoiceServerFrame["type"]>(
  frames: LiveVoiceServerFrame[],
  type: T,
): Array<Extract<LiveVoiceServerFrame, { type: T }>> {
  return frames.filter(
    (frame): frame is Extract<LiveVoiceServerFrame, { type: T }> =>
      frame.type === type,
  );
}

beforeEach(() => {
  turnScripts = [];
  voiceTurnCalls = [];
  ttsHoldUntilAbort = false;
});

afterEach(async () => {
  for (const session of openSessions.splice(0)) {
    await session.close("manager_shutdown");
  }
});

describe("LiveVoiceSession wired duplex integration", () => {
  test("runs two full turns over one session with strictly increasing seq", async () => {
    turnScripts = [
      { deltas: ["Hello ", "there."] },
      { deltas: ["Second answer."] },
    ];
    const { session, frames, transcriber, archiveAudio } = createWiredHarness();

    await session.start();
    await session.handleBinaryAudio(loudChunk());
    await session.handleBinaryAudio(loudChunk());
    await waitFor(() => transcriber.audioChunks.length >= 2);
    transcriber.emit({ type: "partial", text: "first utt" });
    await session.handleClientFrame({ type: "ptt_release" });
    await waitFor(() => frames.some((frame) => frame.type === "turn_boundary"));
    transcriber.emit({ type: "final", text: "first utterance" });
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    // Second turn over the same session: audio after tts_done is accepted
    // (regression on the removed V1 terminal-ptt_release behavior).
    await session.handleBinaryAudio(loudChunk());
    await waitFor(() => transcriber.audioChunks.length >= 3);
    await session.handleClientFrame({ type: "ptt_release" });
    transcriber.emit({ type: "final", text: "second utterance" });
    await waitFor(
      () => typedFrames(frames, "tts_done").length === 2,
      "Timed out waiting for the second turn's tts_done",
    );

    expect(voiceTurnCalls).toHaveLength(2);
    expect(voiceTurnCalls[0]).toMatchObject({
      conversationId: "conversation-123",
      callSessionId: "session-123",
      content: "first utterance",
      approvalMode: "local-live-voice",
      userMessageChannel: "vellum",
      assistantMessageChannel: "vellum",
      userMessageInterface: "macos",
      assistantMessageInterface: "macos",
      isInbound: true,
      task: null,
      skipDisclosure: true,
    });
    expect(voiceTurnCalls[0]?.voiceControlPrompt).toContain(
      "VOICE SESSION RULES",
    );
    expect(voiceTurnCalls[1]).toMatchObject({ content: "second utterance" });

    const thinkingFrames = typedFrames(frames, "thinking");
    expect(thinkingFrames.map((frame) => frame.turnId)).toEqual([
      "live-turn-1",
      "live-turn-2",
    ]);
    expect(
      typedFrames(frames, "tts_done").map((frame) => frame.turnId),
    ).toEqual(["live-turn-1", "live-turn-2"]);
    expect(
      typedFrames(frames, "assistant_text_delta").map((frame) => frame.text),
    ).toEqual(["Hello ", "there.", "Second answer."]);
    expect(typedFrames(frames, "stt_partial")).toHaveLength(1);
    expect(typedFrames(frames, "tts_audio").length).toBeGreaterThanOrEqual(2);
    expect(
      typedFrames(frames, "metrics").filter(
        (frame) => frame.event === "turn_completed",
      ),
    ).toHaveLength(2);
    // Per-turn archives: user + assistant for each turn.
    expect(archiveAudio.mock.calls.map((call) => call[0].turnId)).toEqual([
      "live-turn-1",
      "live-turn-1",
      "live-turn-2",
      "live-turn-2",
    ]);
    expect(frames.filter((frame) => frame.type === "error")).toEqual([]);

    const seqs = frames.map((frame) => frame.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  test("server-VAD barge-in interrupts mid-speech and the next utterance opens a new turn", async () => {
    turnScripts = [
      {
        deltas: ["This is a long answer. It keeps going for quite a while."],
        autoComplete: false,
      },
      { deltas: ["Sure thing."] },
    ];
    ttsHoldUntilAbort = true;
    const { session, frames, transcriber } = createWiredHarness();

    await session.start();
    await session.handleBinaryAudio(loudChunk());
    await waitFor(() => transcriber.audioChunks.length >= 1);
    await session.handleClientFrame({ type: "ptt_release" });
    transcriber.emit({ type: "final", text: "question one" });
    // The first synthesized chunk fires the transport's audio-start
    // callback, flipping the controller to `speaking`.
    await waitFor(() => frames.some((frame) => frame.type === "tts_audio"));

    // User starts speaking over the assistant: server-VAD speech onset.
    await session.handleBinaryAudio(loudChunk());
    await waitFor(() => frames.some((frame) => frame.type === "interrupted"));
    expect(frames.find((frame) => frame.type === "interrupted")).toMatchObject({
      type: "interrupted",
      turnId: "live-turn-1",
    });

    // No further audio from the aborted turn, and its unwind tts_done is
    // suppressed.
    const ttsAudioAfterInterrupt = typedFrames(frames, "tts_audio").length;
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(typedFrames(frames, "tts_audio")).toHaveLength(
      ttsAudioAfterInterrupt,
    );
    expect(frames.some((frame) => frame.type === "tts_done")).toBe(false);

    // The interrupted utterance transcribes and produces a fresh turn.
    ttsHoldUntilAbort = false;
    await session.handleClientFrame({ type: "ptt_release" });
    transcriber.emit({ type: "final", text: "question two" });
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    expect(voiceTurnCalls.map((call) => call.content)).toEqual([
      "question one",
      "question two",
    ]);
    expect(
      typedFrames(frames, "thinking").map((frame) => frame.turnId),
    ).toEqual(["live-turn-1", "live-turn-2"]);
    expect(
      typedFrames(frames, "tts_done").map((frame) => frame.turnId),
    ).toEqual(["live-turn-2"]);
    const metricsEvents = typedFrames(frames, "metrics").map(
      (frame) => `${frame.event}:${frame.turnId}`,
    );
    expect(metricsEvents).toContain("turn_cancelled:live-turn-1");
    expect(metricsEvents).toContain("turn_completed:live-turn-2");
    expect(frames.filter((frame) => frame.type === "error")).toEqual([]);
  });

  test("open-mic mode ends the turn from silence detection without ptt_release", async () => {
    turnScripts = [{ deltas: ["Heard you loud and clear."] }];
    const { session, frames } = createWiredHarness({
      mode: "open-mic",
      batchTranscript: "open mic utterance",
      silenceThresholdMs: 40,
    });

    await session.start();
    await session.handleBinaryAudio(loudChunk());
    await session.handleBinaryAudio(loudChunk());
    // No ptt_release: the VAD's silence window ends the turn on its own.
    await waitFor(
      () => frames.some((frame) => frame.type === "turn_boundary"),
      "Timed out waiting for the silence-detected turn boundary",
    );
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    expect(voiceTurnCalls).toHaveLength(1);
    expect(voiceTurnCalls[0]).toMatchObject({ content: "open mic utterance" });
    expect(frames.some((frame) => frame.type === "stt_final")).toBe(true);
    expect(frames.filter((frame) => frame.type === "error")).toEqual([]);
  });

  test("[END_CALL] ends the session gracefully with a final metrics frame", async () => {
    turnScripts = [{ deltas: ["Goodbye! [END_CALL]"] }];
    const { session, frames, transcriber } = createWiredHarness();

    await session.start();
    await session.handleBinaryAudio(loudChunk());
    await waitFor(() => transcriber.audioChunks.length >= 1);
    await session.handleClientFrame({ type: "ptt_release" });
    transcriber.emit({ type: "final", text: "that's all, thanks" });
    await waitFor(
      () =>
        frames.some(
          (frame) =>
            frame.type === "metrics" && frame.event === "session_ended",
        ),
      "Timed out waiting for the session_ended metrics frame",
    );

    // The control marker never reaches the client.
    const deltas = typedFrames(frames, "assistant_text_delta").map(
      (frame) => frame.text,
    );
    expect(deltas.join("")).toContain("Goodbye!");
    expect(deltas.join("")).not.toContain("[END_CALL]");
    expect(frames.filter((frame) => frame.type === "error")).toEqual([]);

    // The session is closed: further audio is ignored.
    const pushedBefore = transcriber.audioChunks.length;
    await session.handleBinaryAudio(loudChunk());
    expect(transcriber.audioChunks).toHaveLength(pushedBefore);
  });
});
