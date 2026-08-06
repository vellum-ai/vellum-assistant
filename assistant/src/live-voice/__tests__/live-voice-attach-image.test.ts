/**
 * Photos taken mid-call (the voice room's camera).
 *
 * The behaviour under test is the parking rule: an `attach_image` frame does
 * not dispatch anything, it waits for the next turn and rides that turn's own
 * user message. That is what makes a bare "what's this?" resolve against the
 * picture instead of producing one turn about the image racing another about
 * the words.
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
  test("a photo taken before speaking rides that turn's user message", async () => {
    const harness = createSessionHarness();
    await harness.session.start();

    await harness.session.handleClientFrame({
      type: "attach_image",
      attachmentId: "att-1",
    });
    // Parking, not dispatching: nothing runs until the user actually says
    // something.
    expect(harness.startVoiceTurn).not.toHaveBeenCalled();

    await speakAndRelease(harness, "what's this");

    expect(harness.startVoiceTurn).toHaveBeenCalledTimes(1);
    expect(turnOptionsAt(harness.startVoiceTurn, 0)).toMatchObject({
      content: "what's this",
      attachmentIds: ["att-1"],
    });
  });

  test("a photo is claimed once, so the next turn does not re-attach it", async () => {
    const harness = createSessionHarness();
    await harness.session.start();

    await harness.session.handleClientFrame({
      type: "attach_image",
      attachmentId: "att-1",
    });
    await speakAndRelease(harness, "what's this");
    expect(turnOptionsAt(harness.startVoiceTurn, 0)?.attachmentIds).toEqual([
      "att-1",
    ]);

    (harness.startVoiceTurn as ReturnType<typeof mock>).mockClear();
    await speakAndRelease(harness, "and now");

    // The second turn carries no attachments at all, rather than the first
    // turn's photo a second time — showing the model the same image twice
    // would make it answer about a picture the user has moved on from.
    expect(
      turnOptionsAt(harness.startVoiceTurn, 0)?.attachmentIds,
    ).toBeUndefined();
  });

  test("several photos taken before one sentence all ride it, in order", async () => {
    const harness = createSessionHarness();
    await harness.session.start();

    for (const attachmentId of ["att-1", "att-2", "att-3"]) {
      await harness.session.handleClientFrame({
        type: "attach_image",
        attachmentId,
      });
    }
    await speakAndRelease(harness, "compare these");

    expect(turnOptionsAt(harness.startVoiceTurn, 0)?.attachmentIds).toEqual([
      "att-1",
      "att-2",
      "att-3",
    ]);
  });

  test("a duplicate id is ignored", async () => {
    const harness = createSessionHarness();
    await harness.session.start();

    await harness.session.handleClientFrame({
      type: "attach_image",
      attachmentId: "att-1",
    });
    await harness.session.handleClientFrame({
      type: "attach_image",
      attachmentId: "att-1",
    });
    await speakAndRelease(harness, "what's this");

    expect(turnOptionsAt(harness.startVoiceTurn, 0)?.attachmentIds).toEqual([
      "att-1",
    ]);
  });

  test("a burst past the cap keeps the newest photos", async () => {
    const harness = createSessionHarness();
    await harness.session.start();

    for (let index = 0; index < 10; index += 1) {
      await harness.session.handleClientFrame({
        type: "attach_image",
        attachmentId: `att-${index}`,
      });
    }
    await speakAndRelease(harness, "what are these");

    // MAX_PENDING_ATTACHMENTS is 6, and the newest survive: they are the ones
    // the sentence that follows is about.
    expect(turnOptionsAt(harness.startVoiceTurn, 0)?.attachmentIds).toEqual([
      "att-4",
      "att-5",
      "att-6",
      "att-7",
      "att-8",
      "att-9",
    ]);
  });

  test("a rolled-back speculative turn gives its photos back", async () => {
    // The hold-verdict path: a turn dispatched before the endpoint decision
    // is unwound when the user turns out to have been mid-thought, and the
    // utterance is re-sent later. The photo has to travel with it — otherwise
    // a picture taken just before a pause vanishes from the sentence it
    // belongs to.
    const harness = createSessionHarness();
    await harness.session.start();

    await harness.session.handleClientFrame({
      type: "attach_image",
      attachmentId: "att-1",
    });
    await speakAndRelease(harness, "what's this");

    const turn = (
      harness.session as unknown as {
        activeAssistantTurn: {
          attachmentsClaimed: boolean;
          claimedAttachmentIds: string[];
        } | null;
      }
    ).activeAssistantTurn;
    expect(turn?.claimedAttachmentIds).toEqual(["att-1"]);

    // The real rollback entry point, not just the restore helper — the wiring
    // into `discardSpeculativeTurn` is the part that was missing.
    (
      harness.session as unknown as {
        discardSpeculativeTurn: (t: unknown, reason: string) => void;
      }
    ).discardSpeculativeTurn(turn, "hold_verdict");

    // Back in the queue, and the latch released so the replacement turn can
    // claim it.
    expect(turn?.attachmentsClaimed).toBe(false);
    expect(
      (harness.session as unknown as { pendingAttachmentIds: string[] })
        .pendingAttachmentIds,
    ).toEqual(["att-1"]);
  });

  test("a turn with no photo carries no attachmentIds", async () => {
    const harness = createSessionHarness();
    await harness.session.start();

    await speakAndRelease(harness, "just talking");

    expect(
      turnOptionsAt(harness.startVoiceTurn, 0)?.attachmentIds,
    ).toBeUndefined();
  });
});
