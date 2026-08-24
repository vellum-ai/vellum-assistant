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
      return { turnId: "bridge-turn-1", abort: mock() };
    }) as unknown as LiveVoiceTurnStarter);

  const resolveTranscriber = mock(async () => new MockStreamingTranscriber());
  const session = new LiveVoiceSession(context, {
    resolveTranscriber,
    startVoiceTurn,
    createTurnId: () => "live-turn-1",
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
