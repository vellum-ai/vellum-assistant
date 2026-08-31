/**
 * Session-start gating on the live-voice credential preflight.
 *
 * The preflight resolver is injected as a stub — the resolver's own
 * readiness logic is covered in live-voice-credential-preflight.test.ts.
 * These tests pin the wiring: a not-ready verdict rejects the session at
 * the start frame with a `credentials_unavailable` error frame carrying
 * the preflight's user message, before any transcriber is resolved, and
 * leaves the session manager free for a retry.
 *
 * They also pin the one exception to that rule: a client that declared
 * `textInput` opens text-only when the *only* thing missing is the
 * speech-to-text leg, because a session it can type into beats no session.
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

const START_FRAME_TEXT_INPUT = {
  ...START_FRAME,
  textInput: true,
} as const satisfies LiveVoiceClientStartFrame;

const STT_GAP = {
  kind: "stt",
  providerId: "deepgram",
  reason: 'STT provider "deepgram" is missing credentials (Deepgram API Key)',
} as const;

const NOT_READY_STT_ONLY: LiveVoiceCredentialReadiness = {
  status: "not-ready",
  missing: [STT_GAP],
  userMessage:
    'Live voice is unavailable because it requires an API key for the speech-to-text provider "deepgram" (Deepgram API Key).',
};

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

  test("ready preflight leaves audioInput off the ready frame", async () => {
    // Absent means "the microphone leg is live", which is what every session
    // that passes the preflight has. Only a downgraded session says otherwise.
    const { context, frames } = createContext();
    const session = new LiveVoiceSession(context, {
      resolveTranscriber: mock(async () => new MockStreamingTranscriber()),
      resolveCredentialReadiness: mock(
        async (): Promise<LiveVoiceCredentialReadiness> => ({
          status: "ready",
        }),
      ),
    });

    await session.start();

    expect(frames[0]).toMatchObject({ type: "ready", textInput: true });
    expect("audioInput" in (frames[0] ?? {})).toBe(false);

    await session.close("websocket_close");
  });

  test("a text-input client opens text-only when only the STT leg is missing", async () => {
    const { context, frames } = createContext(START_FRAME_TEXT_INPUT);
    const resolveTranscriber = mock(async () => new MockStreamingTranscriber());
    const session = new LiveVoiceSession(context, {
      resolveTranscriber,
      resolveCredentialReadiness: mock(async () => NOT_READY_STT_ONLY),
    });

    await session.start();

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      type: "ready",
      sessionId: "session-123",
      conversationId: "conversation-123",
      textInput: true,
      audioInput: false,
    });
    // Nothing may arm: resolving a transcriber the preflight just said has no
    // credential is what would fail the session through armUtterance.
    expect(resolveTranscriber).not.toHaveBeenCalled();

    await session.close("websocket_close");
  });

  test("a client without textInput is still rejected on a missing STT leg", async () => {
    // The downgrade is only safe for a client that can take a turn some other
    // way. Opening a mute, deaf session for one that cannot is worse than
    // failing, because nothing in it can ever work.
    const { context, frames } = createContext();
    const session = new LiveVoiceSession(context, {
      resolveTranscriber: mock(async () => new MockStreamingTranscriber()),
      resolveCredentialReadiness: mock(async () => NOT_READY_STT_ONLY),
    });

    await expect(session.start()).rejects.toBeInstanceOf(
      LiveVoiceSessionStartupError,
    );

    expect(frames).toEqual([
      {
        type: "error",
        seq: 1,
        code: "credentials_unavailable",
        message: NOT_READY_STT_ONLY.userMessage,
      },
    ]);
  });

  test("a text-input client is still rejected when the TTS leg is missing", async () => {
    // Text in, voice out: without the out half there is nothing to downgrade
    // to, so this fails exactly as it would for any other client.
    const { context, frames } = createContext(START_FRAME_TEXT_INPUT);
    const session = new LiveVoiceSession(context, {
      resolveTranscriber: mock(async () => new MockStreamingTranscriber()),
      resolveCredentialReadiness: mock(async () => NOT_READY),
    });

    await expect(session.start()).rejects.toBeInstanceOf(
      LiveVoiceSessionStartupError,
    );

    expect(frames[0]).toMatchObject({ code: "credentials_unavailable" });
  });

  test("a text-input client is still rejected when both legs are missing", async () => {
    const { context } = createContext(START_FRAME_TEXT_INPUT);
    const session = new LiveVoiceSession(context, {
      resolveTranscriber: mock(async () => new MockStreamingTranscriber()),
      resolveCredentialReadiness: mock(
        async (): Promise<LiveVoiceCredentialReadiness> => ({
          ...NOT_READY,
          missing: [...NOT_READY.missing, STT_GAP],
        }),
      ),
    });

    await expect(session.start()).rejects.toBeInstanceOf(
      LiveVoiceSessionStartupError,
    );
  });

  test("a text-input client is still rejected when not-ready names no gap", async () => {
    // A verdict that says not-ready and lists nothing is a resolver bug. It
    // must not be read as "only STT is missing" and quietly opened half-working
    // on the strength of a vacuously true check.
    const { context } = createContext(START_FRAME_TEXT_INPUT);
    const session = new LiveVoiceSession(context, {
      resolveTranscriber: mock(async () => new MockStreamingTranscriber()),
      resolveCredentialReadiness: mock(
        async (): Promise<LiveVoiceCredentialReadiness> => ({
          status: "not-ready",
          missing: [],
          userMessage: "Live voice is unavailable.",
        }),
      ),
    });

    await expect(session.start()).rejects.toBeInstanceOf(
      LiveVoiceSessionStartupError,
    );
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
