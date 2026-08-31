/**
 * Photos taken mid-call (the voice room's camera).
 *
 * The behaviour under test is that an `attach_image` frame stands alone: it
 * persists the photo as its own user message the moment it arrives and
 * dispatches no turn, so the spoken turn that follows carries no attachments
 * of its own and reaches the picture through conversation history. That is
 * what makes shutter-then-speak and speak-then-shutter answer the same way.
 *
 * The parking rule belongs to `attach_frame` instead
 * (`live-voice-attach-frame.test.ts`), which carries ambient camera frames.
 */

import { describe, expect, mock, test } from "bun:test";

import type { VoiceTurnOptions } from "../../calls/voice-session-bridge.js";
import type {
  StreamingTranscriber,
  SttStreamServerEvent,
} from "../../stt/types.js";
import {
  LiveVoiceSession,
  type LiveVoiceTurnStarter,
} from "../live-voice-session.js";
import type { LiveVoiceSessionFactoryContext } from "../live-voice-session-manager.js";
import {
  createLiveVoiceServerFrameSequencer,
  type LiveVoiceClientStartFrame,
  type LiveVoiceServerFrame,
  validateLiveVoiceClientFrame,
} from "../protocol.js";

const START_FRAME = {
  type: "start",
  conversationId: "conversation-123",
  audio: { mimeType: "audio/pcm", sampleRate: 24_000, channels: 1 },
} as const satisfies LiveVoiceClientStartFrame;

class MockStreamingTranscriber implements StreamingTranscriber {
  readonly providerId = "deepgram" as const;
  readonly boundaryId = "daemon-streaming" as const;
  private onEvent: ((event: SttStreamServerEvent) => void) | null = null;

  async start(onEvent: (event: SttStreamServerEvent) => void): Promise<void> {
    this.onEvent = onEvent;
  }

  sendAudio(): void {}

  stop(): void {
    this.emit({ type: "closed" });
  }

  emit(event: SttStreamServerEvent): void {
    this.onEvent?.(event);
  }
}

function createSessionHarness() {
  const sequencer = createLiveVoiceServerFrameSequencer();
  const frames: LiveVoiceServerFrame[] = [];
  const context: LiveVoiceSessionFactoryContext = {
    sessionId: "session-123",
    startFrame: START_FRAME,
    sendFrame: mock(async (payload) => {
      const frame = sequencer.next(payload);
      frames.push(frame);
      return frame;
    }),
  };

  const transcriber = new MockStreamingTranscriber();
  const startVoiceTurn: LiveVoiceTurnStarter = mock(
    async (_options: VoiceTurnOptions) => ({
      turnId: "bridge-turn-1",
      abort: mock(),
    }),
  );

  const session = new LiveVoiceSession(context, {
    resolveTranscriber: mock(async () => transcriber),
    startVoiceTurn,
    createTurnId: () => "live-turn-1",
    emitMetrics: false,
  });

  return { frames, session, startVoiceTurn, transcriber };
}

/** Drive one utterance to a dispatched assistant turn. */
async function speakAndRelease(
  harness: Awaited<ReturnType<typeof createSessionHarness>>,
  text: string,
): Promise<void> {
  harness.transcriber.emit({ type: "final", text });
  await harness.session.handleClientFrame({ type: "ptt_release" });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (
      (harness.startVoiceTurn as ReturnType<typeof mock>).mock.calls.length > 0
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function turnOptionsAt(
  startVoiceTurn: LiveVoiceTurnStarter,
  index: number,
): VoiceTurnOptions | undefined {
  return (startVoiceTurn as ReturnType<typeof mock>).mock.calls[index]?.[0] as
    | VoiceTurnOptions
    | undefined;
}

describe("live-voice attach_image frame", () => {
  test("accepts a well-formed frame", () => {
    const result = validateLiveVoiceClientFrame({
      type: "attach_image",
      attachmentId: "att-1",
    });
    expect(result).toEqual({
      ok: true,
      frame: { type: "attach_image", attachmentId: "att-1" },
    });
  });

  test("rejects a missing attachmentId", () => {
    const result = validateLiveVoiceClientFrame({ type: "attach_image" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("missing_required_field");
      expect(result.error.field).toBe("attachmentId");
    }
  });

  test("rejects an empty attachmentId", () => {
    const result = validateLiveVoiceClientFrame({
      type: "attach_image",
      attachmentId: "",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid_field");
    }
  });
});

describe("live-voice photos taken mid-call", () => {
  test("a photo does not dispatch a turn of its own", async () => {
    // The photo becomes its own user message via `persistLiveVoicePhoto`; no
    // assistant turn runs for it. Dispatching one would answer the picture
    // while the user is still saying the sentence it belongs to.
    const harness = createSessionHarness();
    await harness.session.start();

    await harness.session.handleClientFrame({
      type: "attach_image",
      attachmentId: "att-1",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(harness.startVoiceTurn).not.toHaveBeenCalled();
  });

  test("a spoken turn carries no attachments of its own", async () => {
    // Photos reach the model through conversation history, not through the
    // turn's options, which is what makes shutter-then-speak and
    // speak-then-shutter behave identically.
    const harness = createSessionHarness();
    await harness.session.start();

    await harness.session.handleClientFrame({
      type: "attach_image",
      attachmentId: "att-1",
    });
    await speakAndRelease(harness, "what's this");

    const options = turnOptionsAt(harness.startVoiceTurn, 0) as
      | (VoiceTurnOptions & { attachmentIds?: string[] })
      | undefined;
    expect(options?.content).toBe("what's this");
    expect(options?.attachmentIds).toBeUndefined();
  });

  test("a photo that cannot be stored is reported to the client", async () => {
    // `att-missing` resolves to nothing (no attachment row in this harness),
    // so the persist fails. Silence would leave the user believing the
    // assistant can see something it never received.
    const harness = createSessionHarness();
    await harness.session.start();
    const before = harness.frames.length;

    await harness.session.handleClientFrame({
      type: "attach_image",
      attachmentId: "att-missing",
    });
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (harness.frames.length > before) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const error = harness.frames
      .slice(before)
      .find((frame) => frame.type === "error");
    expect(error).toMatchObject({ type: "error", recoverable: true });
    // The session survives it: one failed photo is not a failed call.
    expect(harness.startVoiceTurn).not.toHaveBeenCalled();
  });
});
