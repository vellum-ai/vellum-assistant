/**
 * Session-start gating on the live-voice credential preflight.
 *
 * The preflight resolver is injected as a stub — the resolver's own
 * readiness logic is covered in live-voice-credential-preflight.test.ts.
 * These tests pin the wiring: a not-ready verdict rejects the session at
 * the start frame with a `credentials_unavailable` error frame carrying
 * the preflight's user message, before any transcriber is resolved, and
 * leaves the session manager free for a retry.
 */

import { describe, expect, mock, test } from "bun:test";

import type { StreamingTranscriber } from "../../stt/types.js";
import type { LiveVoiceCredentialReadiness } from "../live-voice-credential-preflight.js";
import { LiveVoiceSession } from "../live-voice-session.js";
import {
  type LiveVoiceSessionFactoryContext,
  LiveVoiceSessionManager,
  LiveVoiceSessionStartupError,
} from "../live-voice-session-manager.js";
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

const NOT_READY: LiveVoiceCredentialReadiness = {
  status: "not-ready",
  missing: [
    {
      kind: "tts",
      providerId: "fish-audio",
      reason:
        'TTS provider "fish-audio" is missing credentials (Fish Audio API Key)',
    },
  ],
  userMessage:
    'Live voice is unavailable because it requires an API key for the text-to-speech provider "fish-audio" (Fish Audio API Key).',
};

class MockStreamingTranscriber implements StreamingTranscriber {
  readonly providerId = "deepgram" as const;
  readonly boundaryId = "daemon-streaming" as const;

  async start(): Promise<void> {}

  sendAudio(): void {}

  stop(): void {}
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

describe("live-voice session credential preflight gating", () => {
  test("not-ready preflight rejects the start frame before resolving a transcriber", async () => {
    const { context, frames } = createContext();
    const resolveTranscriber = mock(async () => new MockStreamingTranscriber());
    const session = new LiveVoiceSession(context, {
      resolveTranscriber,
      resolveCredentialReadiness: mock(async () => NOT_READY),
    });

    await expect(session.start()).rejects.toBeInstanceOf(
      LiveVoiceSessionStartupError,
    );

    expect(resolveTranscriber).not.toHaveBeenCalled();
    expect(frames).toEqual([
      {
        type: "error",
        seq: 1,
        code: "credentials_unavailable",
        message: NOT_READY.userMessage,
      },
    ]);
  });

  test("ready preflight proceeds to the normal ready frame", async () => {
    const { context, frames } = createContext();
    const resolveCredentialReadiness = mock(
      async (): Promise<LiveVoiceCredentialReadiness> => ({ status: "ready" }),
    );
    const session = new LiveVoiceSession(context, {
      resolveTranscriber: mock(async () => new MockStreamingTranscriber()),
      resolveCredentialReadiness,
    });

    await session.start();

    expect(resolveCredentialReadiness).toHaveBeenCalledTimes(1);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      type: "ready",
      sessionId: "session-123",
      conversationId: "conversation-123",
    });

    await session.close("websocket_close");
  });

  test("a rejected start frees the manager slot for a retry", async () => {
    const manager = new LiveVoiceSessionManager({
      createSession: (context) =>
        new LiveVoiceSession(context, {
          resolveTranscriber: mock(async () => new MockStreamingTranscriber()),
          resolveCredentialReadiness: mock(async () => NOT_READY),
        }),
    });
    const frames: LiveVoiceServerFrame[] = [];

    const result = await manager.startSession(START_FRAME, {
      sendFrame: (frame) => {
        frames.push(frame);
      },
    });

    expect(result.status).toBe("failed");
    expect(manager.activeSessionId).toBeNull();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      type: "error",
      code: "credentials_unavailable",
      message: NOT_READY.userMessage,
    });
  });
});
