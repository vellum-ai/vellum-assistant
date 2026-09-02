/**
 * Typed user turns on the live-voice socket: text in, voice out.
 *
 * The seam these cover is narrow on purpose. A `text` frame is meant to join
 * the pipeline at exactly the point a finished transcript would have, so what
 * is worth pinning is not that a turn happens but that it is the *same* turn:
 * same dispatch, same spoken reply, and no interference with the capture cycle
 * a voice session is running alongside it.
 */

import { describe, expect, mock, test } from "bun:test";

import type { VoiceTurnOptions } from "../../calls/voice-session-bridge.js";
import type {
  StreamingTranscriber,
  SttStreamServerEvent,
} from "../../stt/types.js";
import type { LiveVoiceCredentialReadiness } from "../live-voice-credential-preflight.js";
import {
  LiveVoiceSession,
  type LiveVoiceTurnStarter,
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
  textInput: true,
  audio: {
    mimeType: "audio/pcm",
    sampleRate: 24_000,
    channels: 1,
  },
} as const satisfies LiveVoiceClientStartFrame;

const STT_ONLY_GAP: LiveVoiceCredentialReadiness = {
  status: "not-ready",
  missing: [
    {
      kind: "stt",
      providerId: "deepgram",
      reason: 'STT provider "deepgram" is missing credentials',
    },
  ],
  userMessage: "Live voice is unavailable because speech-to-text has no key.",
};

class MockStreamingTranscriber implements StreamingTranscriber {
  readonly providerId = "deepgram" as const;
  readonly boundaryId = "daemon-streaming" as const;
  private onEvent: ((event: SttStreamServerEvent) => void) | null = null;

  async start(onEvent: (event: SttStreamServerEvent) => void): Promise<void> {
    this.onEvent = onEvent;
  }

  sendAudio(): void {}

  stop(): void {}

  emit(event: SttStreamServerEvent): void {
    this.onEvent?.(event);
  }
}

function createHarness(
  options: {
    startFrame?: LiveVoiceClientStartFrame;
    resolveCredentialReadiness?: () => Promise<LiveVoiceCredentialReadiness>;
    startVoiceTurn?: LiveVoiceTurnStarter;
    /**
     * Complete each turn as soon as it starts. Needed by any test that runs a
     * second turn: the floor gate refuses one while a turn is still in flight,
     * so a turn that never finishes makes every later turn look refused for
     * the wrong reason.
     */
    autoCompleteTurns?: boolean;
    emitMetrics?: boolean;
  } = {},
) {
  const sequencer = createLiveVoiceServerFrameSequencer();
  const frames: LiveVoiceServerFrame[] = [];
  const context: LiveVoiceSessionFactoryContext = {
    sessionId: "session-123",
    startFrame: options.startFrame ?? START_FRAME,
    sendFrame: mock(async (payload) => {
      const frame = sequencer.next(payload);
      frames.push(frame);
      return frame;
    }),
  };

  const turnOptions: VoiceTurnOptions[] = [];
  const startVoiceTurn =
    options.startVoiceTurn ??
    (mock(async (opts: VoiceTurnOptions) => {
      turnOptions.push(opts);
      if (options.autoCompleteTurns) {
        opts.callbacks?.message_complete?.({
          type: "message_complete",
          conversationId: opts.conversationId,
          messageId: `assistant-message-${turnOptions.length}`,
        });
      }
      return { turnId: `bridge-turn-${turnOptions.length}`, abort: mock() };
    }) as unknown as LiveVoiceTurnStarter);

  const resolveTranscriber = mock(async () => new MockStreamingTranscriber());
  const session = new LiveVoiceSession(context, {
    resolveTranscriber,
    startVoiceTurn,
    createTurnId: () => "live-turn-1",
    emitMetrics: options.emitMetrics ?? false,
    ...(options.resolveCredentialReadiness
      ? { resolveCredentialReadiness: options.resolveCredentialReadiness }
      : {}),
  });

  return { frames, resolveTranscriber, session, startVoiceTurn, turnOptions };
}

async function waitFor(
  predicate: () => boolean,
  message = "Timed out waiting for a typed live-voice turn",
): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

function errorFrames(
  frames: LiveVoiceServerFrame[],
): Extract<LiveVoiceServerFrame, { type: "error" }>[] {
  return frames.filter(
    (frame): frame is Extract<LiveVoiceServerFrame, { type: "error" }> =>
      frame.type === "error",
  );
}

describe("typed live-voice turns", () => {
  test("a text frame dispatches a turn carrying the typed text", async () => {
    const { session, startVoiceTurn, turnOptions } = createHarness();
    await session.start();

    await session.handleClientFrame({
      type: "text",
      text: "what is on my calendar",
    });

    await waitFor(() => turnOptions.length > 0);
    expect(startVoiceTurn).toHaveBeenCalledTimes(1);
    expect(turnOptions[0]?.content).toContain("what is on my calendar");

    await session.close("websocket_close");
  });

  test("a hidden text frame runs the turn as an internal instruction", async () => {
    // The greeting that opens a voice session is a machine signal, not
    // something the user typed. It must still drive the turn and still reach
    // the model, so it persists, but `hiddenSyntheticPrompt` is what keeps it
    // out of the transcript (no echo, filtered from `/messages`).
    const { session, turnOptions } = createHarness();
    await session.start();

    await session.handleClientFrame({
      type: "text",
      text: "this message is sent automatically",
      hidden: true,
    });

    await waitFor(() => turnOptions.length > 0);
    expect(turnOptions[0]?.hiddenSyntheticPrompt).toBe(true);
    expect(turnOptions[0]?.content).toContain(
      "this message is sent automatically",
    );

    await session.close("websocket_close");
  });

  test("an ordinary typed turn stays visible", async () => {
    // A turn the user actually typed is a real message and must render like
    // one, so the flag is never set by default.
    const { session, turnOptions } = createHarness();
    await session.start();

    await session.handleClientFrame({ type: "text", text: "typed by hand" });

    await waitFor(() => turnOptions.length > 0);
    expect(turnOptions[0]?.hiddenSyntheticPrompt).toBeUndefined();

    await session.close("websocket_close");
  });

  test("a typed turn emits the same thinking frame a spoken one does", async () => {
    // The client draws its working state off `thinking`. A typed turn that
    // skipped it would leave the room idle while the assistant worked.
    const { frames, session } = createHarness();
    await session.start();

    await session.handleClientFrame({ type: "text", text: "hello" });

    await waitFor(() => frames.some((frame) => frame.type === "thinking"));

    await session.close("websocket_close");
  });

  test("a typed turn leaves the capture cycle alone", async () => {
    // `currentUtterance` belongs to the microphone loop. A typed turn that
    // installed its own carrier there would discard whatever the user was
    // part-way through saying.
    const { session } = createHarness();
    await session.start();
    await waitFor(() => session.finalTranscriptText === "");

    await session.handleClientFrame({ type: "text", text: "typed" });

    // The armed cycle still holds its own (empty) transcript rather than the
    // typed text, which rode a carrier of its own.
    expect(session.finalTranscriptText).toBe("");

    await session.close("websocket_close");
  });

  test("a manual session takes a typed turn after the microphone has streamed", async () => {
    // Manual capture forwards from the moment the microphone opens, not from a
    // push-to-talk press, so the first chunk of silence latches
    // `manualAudioCaptured` on the armed cycle. A manual cycle only completes
    // on release, so treating that flag as "user is mid-utterance" would
    // refuse every typed turn a few milliseconds into the session.
    const { frames, session, turnOptions } = createHarness();
    await session.start();

    await session.handleClientFrame({
      type: "audio",
      dataBase64: Buffer.alloc(960).toString("base64"),
    });

    await session.handleClientFrame({ type: "text", text: "typed anyway" });

    await waitFor(() => turnOptions.length === 1);
    expect(turnOptions[0]?.content).toContain("typed anyway");
    expect(errorFrames(frames)).toHaveLength(0);

    await session.close("websocket_close");
  });

  test("a typed turn arriving mid-turn is refused recoverably", async () => {
    const { frames, session, startVoiceTurn } = createHarness();
    await session.start();

    await session.handleClientFrame({ type: "text", text: "first" });
    await waitFor(() => frames.some((frame) => frame.type === "thinking"));

    await session.handleClientFrame({ type: "text", text: "second" });

    const errors = errorFrames(frames);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      frameType: "text",
      recoverable: true,
    });
    // Refused, not queued: the second turn must not run behind the first.
    expect(startVoiceTurn).toHaveBeenCalledTimes(1);

    await session.close("websocket_close");
  });

  test("a text-only session runs a typed turn without ever arming a transcriber", async () => {
    const { frames, resolveTranscriber, session, turnOptions } = createHarness({
      resolveCredentialReadiness: async () => STT_ONLY_GAP,
    });

    await session.start();

    expect(frames[0]).toMatchObject({ type: "ready", audioInput: false });

    await session.handleClientFrame({ type: "text", text: "still works" });

    await waitFor(() => turnOptions.length > 0);
    expect(turnOptions[0]?.content).toContain("still works");
    expect(resolveTranscriber).not.toHaveBeenCalled();

    await session.close("websocket_close");
  });

  test("a text-only server_vad session survives more than one typed turn", async () => {
    // The post-turn re-arm is skipped when there is no turn detector, and a
    // session that asked for server_vad has one even with the microphone leg
    // dead. Without a guard on the arm itself, the re-arm after the first
    // typed turn resolves a transcriber the preflight already rejected, fails
    // the session, and closes it: the first turn works and the second never
    // gets the chance.
    const { frames, resolveTranscriber, session, turnOptions } = createHarness({
      startFrame: { ...START_FRAME, turnDetection: "server_vad" },
      resolveCredentialReadiness: async () => STT_ONLY_GAP,
      autoCompleteTurns: true,
    });
    await session.start();

    expect(frames[0]).toMatchObject({ type: "ready", audioInput: false });

    await session.handleClientFrame({ type: "text", text: "first turn" });
    await waitFor(() => turnOptions.length === 1);

    // Let the post-turn re-arm run before asking for the second turn.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(errorFrames(frames)).toHaveLength(0);
    expect(resolveTranscriber).not.toHaveBeenCalled();

    await session.handleClientFrame({ type: "text", text: "second turn" });
    await waitFor(() => turnOptions.length === 2);
    expect(turnOptions[1]?.content).toContain("second turn");

    await session.close("websocket_close");
  });

  test("a typed turn stamps the end-of-input anchor a round trip needs", async () => {
    // roundTripMs measures end-of-user-input to first audio, anchored on
    // utteranceEnd ?? pttRelease. A typed turn travels neither, so without an
    // anchor of its own every typed turn reports null. That does not merely
    // lose rows: it biases the voice latency numbers toward spoken turns while
    // still looking healthy.
    //
    // Asserted on the anchor rather than on roundTripMs itself, because the
    // far end of that duration is the first TTS chunk actually reaching the
    // client, which this harness does not drive.
    const { frames, session, turnOptions } = createHarness({
      autoCompleteTurns: true,
      emitMetrics: true,
    });
    await session.start();

    await session.handleClientFrame({ type: "text", text: "how long is this" });
    await waitFor(() => turnOptions.length === 1);
    await waitFor(() => frames.some((frame) => frame.type === "metrics"));

    const metrics = frames.find(
      (frame): frame is Extract<LiveVoiceServerFrame, { type: "metrics" }> =>
        frame.type === "metrics",
    );
    const turn = (
      metrics?.metrics as {
        recentTurns?: {
          timestamps: Record<string, number | null>;
        }[];
      }
    )?.recentTurns?.[0];

    expect(turn?.timestamps.utteranceEndAtMs).not.toBeNull();
    // Nothing was transcribed, and stamping a transcript mark would invent a
    // measurement rather than report one.
    expect(turn?.timestamps.finalTranscriptAtMs).toBeNull();
    expect(turn?.timestamps.speechStartAtMs).toBeNull();

    await session.close("websocket_close");
  });

  test("a text-only session drops audio instead of failing on it", async () => {
    // A client that has not caught up with `audioInput: false` may keep
    // streaming. There is nothing to route it into, and ending the session
    // over it would undo the point of opening one.
    const { frames, resolveTranscriber, session } = createHarness({
      resolveCredentialReadiness: async () => STT_ONLY_GAP,
    });
    await session.start();

    await session.handleClientFrame({
      type: "audio",
      dataBase64: Buffer.alloc(960).toString("base64"),
    });

    expect(errorFrames(frames)).toHaveLength(0);
    expect(resolveTranscriber).not.toHaveBeenCalled();

    // Still able to take the turn it was opened for.
    await session.handleClientFrame({ type: "text", text: "typed anyway" });
    await waitFor(() => frames.some((frame) => frame.type === "thinking"));

    await session.close("websocket_close");
  });
});
