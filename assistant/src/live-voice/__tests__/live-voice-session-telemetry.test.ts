/**
 * Live-voice session telemetry: the started/ended funnel rows a session
 * records, and the attribution carried on its turns.
 *
 * The recorder is mocked: the outbox and its consent gate are covered by
 * `telemetry-events-outbox.test.ts`. What these tests pin is the wiring that
 * decides whether a row exists at all and what it says, which is where the
 * measurement can silently go wrong: a session that fails before `ready` still
 * has to count, a failed session still has to record an end, and a session's
 * turns have to carry its id or the turn count has nothing to group on.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { VoiceTurnOptions } from "../../calls/voice-session-bridge.js";
import type {
  StreamingTranscriber,
  SttStreamServerEvent,
} from "../../stt/types.js";

const recordLiveVoiceSessionStarted = mock(() => null);
const recordLiveVoiceSessionEnded = mock(() => null);

// Spread the real module rather than replacing it: other importers pull
// `recordActivationEvent` and friends out of it, and a bare replacement makes
// those imports fail to resolve.
const onboardingEventsStore =
  await import("../../onboarding/onboarding-events-store.js");
mock.module("../../onboarding/onboarding-events-store.js", () => ({
  ...onboardingEventsStore,
  recordLiveVoiceSessionStarted,
  recordLiveVoiceSessionEnded,
}));

// Types are erased, so they import statically regardless of the mock ordering
// the values below depend on.
import type { LiveVoiceCredentialReadiness } from "../live-voice-credential-preflight.js";
import type { LiveVoiceSessionFactoryContext } from "../live-voice-session-manager.js";
import type {
  LiveVoiceClientStartFrame,
  LiveVoiceServerFrame,
} from "../protocol.js";

// Values load after `mock.module` so the session picks up the mocked recorder.
const { LiveVoiceSession } = await import("../live-voice-session.js");
const { LiveVoiceSessionStartupError } =
  await import("../live-voice-session-manager.js");
const { createLiveVoiceServerFrameSequencer } = await import("../protocol.js");

const START_FRAME = {
  type: "start",
  conversationId: "conversation-123",
  audio: { mimeType: "audio/pcm", sampleRate: 24_000, channels: 1 },
} as const satisfies LiveVoiceClientStartFrame;

const NOT_READY: LiveVoiceCredentialReadiness = {
  status: "not-ready",
  missing: [
    {
      kind: "tts",
      providerId: "fish-audio",
      reason: 'TTS provider "fish-audio" is missing credentials',
    },
  ],
  userMessage: "Live voice is unavailable because it requires an API key.",
};

class MockStreamingTranscriber implements StreamingTranscriber {
  readonly providerId = "deepgram" as const;
  readonly boundaryId = "daemon-streaming" as const;
  private onEvent: ((event: SttStreamServerEvent) => void) | null = null;

  constructor(private readonly stopEvents: SttStreamServerEvent[] = []) {}

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

function createContext(
  startFrame: LiveVoiceClientStartFrame = START_FRAME,
): LiveVoiceSessionFactoryContext {
  const sequencer = createLiveVoiceServerFrameSequencer();
  const frames: LiveVoiceServerFrame[] = [];
  return {
    sessionId: "session-123",
    startFrame,
    sendFrame: mock(async (payload) => {
      const frame = sequencer.next(payload);
      frames.push(frame);
      return frame;
    }),
  };
}

function readySession(startFrame?: LiveVoiceClientStartFrame) {
  return new LiveVoiceSession(createContext(startFrame), {
    resolveTranscriber: mock(async () => new MockStreamingTranscriber()),
    resolveCredentialReadiness: mock(
      async (): Promise<LiveVoiceCredentialReadiness> => ({ status: "ready" }),
    ),
  });
}

describe("live-voice session telemetry", () => {
  beforeEach(() => {
    recordLiveVoiceSessionStarted.mockClear();
    recordLiveVoiceSessionEnded.mockClear();
  });

  test("records a started row for a session that reaches ready", async () => {
    const session = readySession();

    await session.start();

    expect(recordLiveVoiceSessionStarted).toHaveBeenCalledWith("session-123");

    await session.close("client_end");
  });

  test("records a started row even when the preflight rejects the session", async () => {
    const session = new LiveVoiceSession(createContext(), {
      resolveTranscriber: mock(async () => new MockStreamingTranscriber()),
      resolveCredentialReadiness: mock(async () => NOT_READY),
    });

    await expect(session.start()).rejects.toBeInstanceOf(
      LiveVoiceSessionStartupError,
    );

    // The denominator of the failure rate: a session rejected before `ready`
    // is exactly the one that must not go missing from the started count.
    expect(recordLiveVoiceSessionStarted).toHaveBeenCalledWith("session-123");
  });

  test("records the close reason and a completed outcome on a clean end", async () => {
    const session = readySession();
    await session.start();

    await session.close("client_end");

    // These sessions reach `ready` and are closed without ever sending audio,
    // so they are silent by construction and the reason says which layer
    // stopped short. See `telemetry/live-voice-funnel.ts`.
    expect(recordLiveVoiceSessionEnded).toHaveBeenCalledWith({
      sessionId: "session-123",
      screen: "ended_client_end:silent_no_audio",
      outcome: "completed",
    });
  });

  /**
   * Run one typed turn against a session with a real turn starter, then close.
   *
   * `readySession` wires none, so `handleTextTurn` returns before dispatching
   * and every silence assertion against it passes for the wrong reason.
   */
  async function endAfterTypedTurn(frame: {
    text: string;
    hidden?: boolean;
  }): Promise<void> {
    let started = false;
    const session = new LiveVoiceSession(createContext(), {
      resolveTranscriber: mock(async () => new MockStreamingTranscriber()),
      resolveCredentialReadiness: mock(
        async (): Promise<LiveVoiceCredentialReadiness> => ({
          status: "ready",
        }),
      ),
      startVoiceTurn: mock(async () => {
        started = true;
        return { turnId: "bridge-turn-1", abort: mock() };
      }),
      emitMetrics: false,
    });
    await session.start();
    await session.handleClientFrame({ type: "text", ...frame });
    for (let attempt = 0; attempt < 40 && !started; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (!started) {
      throw new Error("the typed turn never reached the bridge");
    }
    await session.close("client_end");
  }

  test("the greeting that opens a session does not spend its silence reason", async () => {
    // The classification answers "did anything come from the person?". A
    // session that greets and hears nothing back is silent, and counting the
    // greeting would retire the taxonomy for every greeted session.
    await endAfterTypedTurn({
      text: "this message is sent automatically",
      hidden: true,
    });

    expect(recordLiveVoiceSessionEnded).toHaveBeenCalledWith({
      sessionId: "session-123",
      screen: "ended_client_end:silent_no_audio",
      outcome: "completed",
    });
  });

  test("a turn the user really took clears the silence reason", async () => {
    // The other half, and what keeps the test above honest: the same path with
    // an ordinary typed turn is the person taking a turn, so the session is
    // not silent and carries no classification at all.
    await endAfterTypedTurn({ text: "typed by hand" });

    expect(recordLiveVoiceSessionEnded).toHaveBeenCalledWith({
      sessionId: "session-123",
      screen: "ended_client_end",
      outcome: "completed",
    });
  });

  test("a dropped socket ends as completed, not failed", async () => {
    const session = readySession();
    await session.start();

    await session.close("websocket_close");

    // The session ran and then stopped; only an error makes it `failed`, and
    // the reason on `screen` is what distinguishes a drop from a hangup.
    expect(recordLiveVoiceSessionEnded).toHaveBeenCalledWith({
      sessionId: "session-123",
      screen: "ended_websocket_close:silent_no_audio",
      outcome: "completed",
    });
  });

  test("a failed session records an ended row carrying the failure code", async () => {
    const session = new LiveVoiceSession(createContext(), {
      resolveTranscriber: mock(async () => new MockStreamingTranscriber()),
      resolveCredentialReadiness: mock(async () => NOT_READY),
    });
    await expect(session.start()).rejects.toBeInstanceOf(
      LiveVoiceSessionStartupError,
    );

    // What the manager does after a startup failure.
    await session.close("error");

    // A failed session suppresses the client-facing `metrics` frame; the end
    // row must not be suppressed with it.
    expect(recordLiveVoiceSessionEnded).toHaveBeenCalledWith({
      sessionId: "session-123",
      screen: "ended_error:credentials_unavailable",
      outcome: "failed",
    });
  });

  test("records exactly one ended row when close is called twice", async () => {
    const session = readySession();
    await session.start();

    await session.close("client_end");
    await session.close("websocket_close");

    expect(recordLiveVoiceSessionEnded).toHaveBeenCalledTimes(1);
  });
});

describe("live-voice turn attribution", () => {
  /** Drives one push-to-talk turn and returns the options the bridge saw. */
  async function captureTurnOptions(
    startFrame: LiveVoiceClientStartFrame,
  ): Promise<VoiceTurnOptions> {
    let captured: VoiceTurnOptions | undefined;
    const startVoiceTurn = mock(async (options: VoiceTurnOptions) => {
      captured = options;
      return { turnId: "bridge-turn-1", abort: mock() };
    });
    const session = new LiveVoiceSession(createContext(startFrame), {
      resolveTranscriber: mock(
        async () =>
          new MockStreamingTranscriber([
            { type: "final", text: "hello" },
            { type: "closed" },
          ]),
      ),
      startVoiceTurn,
      emitMetrics: false,
    });

    await session.start();
    await session.handleClientFrame({ type: "ptt_release" });
    for (let attempt = 0; attempt < 40 && !captured; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await session.close("client_end");

    if (!captured) {
      throw new Error("the live-voice session never started a bridge turn");
    }
    return captured;
  }

  test("carries the session id and originating client onto the turn", async () => {
    const options = await captureTurnOptions({ ...START_FRAME, client: "ios" });

    expect(options.voiceTelemetry).toEqual({
      sessionId: "session-123",
      client: "ios",
    });
  });

  test("leaves the turn's interface id alone while attributing the client", async () => {
    const options = await captureTurnOptions({ ...START_FRAME, client: "ios" });

    // The load-bearing half of the attribution fix. `userMessageInterface`
    // resolves the turn's channel capabilities, where `macos` is what grants a
    // live-voice turn its dynamic surfaces; reporting the true client here
    // would strip them from every iOS session. Attribution rides
    // `voiceTelemetry` precisely so this can stay put.
    expect(options.userMessageInterface).toBe("macos");
    expect(options.assistantMessageInterface).toBe("macos");
  });

  test("omits the client when the start frame declares none", async () => {
    const options = await captureTurnOptions(START_FRAME);

    expect(options.voiceTelemetry).toEqual({ sessionId: "session-123" });
  });
});
