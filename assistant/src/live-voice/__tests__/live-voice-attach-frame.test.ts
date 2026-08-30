/**
 * Ambient camera frames sent mid-call (`attach_frame`).
 *
 * The behaviour under test is the parking rule: a frame dispatches nothing of
 * its own. It waits on the session and rides the next spoken turn's own user
 * message, so the picture and the words about it are one message, and a frame
 * nobody ever speaks over leaves no trace in the conversation.
 *
 * The contrast with `attach_image` is deliberate and is pinned here too: a
 * deliberate snap persists immediately as its own message and parks nothing
 * (`live-voice-attach-image.test.ts`).
 */

import { Buffer } from "node:buffer";
import { describe, expect, mock, test } from "bun:test";

import type {
  VoiceTurnCallbacks,
  VoiceTurnOptions,
} from "../../calls/voice-session-bridge.js";
import {
  getAttachmentById,
  linkAttachmentToMessage,
  uploadAttachment,
} from "../../persistence/attachments-store.js";
import {
  addMessage,
  createConversation,
} from "../../persistence/conversation-crud.js";
import { initializeDb } from "../../persistence/db-init.js";
import type {
  StreamingTranscriber,
  SttStreamServerEvent,
} from "../../stt/types.js";
import {
  createLiveVoiceSession,
  type LiveVoiceSession,
  type LiveVoiceTurnStarter,
} from "../live-voice-session.js";
import type { LiveVoiceSessionFactoryContext } from "../live-voice-session-manager.js";
import type {
  LiveVoiceTtsOptions,
  LiveVoiceTtsResult,
} from "../live-voice-tts.js";
import {
  createLiveVoiceServerFrameSequencer,
  type LiveVoiceClientStartFrame,
  type LiveVoiceServerFrame,
  validateLiveVoiceClientFrame,
} from "../protocol.js";

await initializeDb();

const IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk";

const START_FRAME = {
  type: "start",
  conversationId: "conversation-123",
  audio: { mimeType: "audio/pcm", sampleRate: 24_000, channels: 1 },
  turnDetection: "server_vad",
} as const satisfies LiveVoiceClientStartFrame;

/** A real attachment row, so the park-time existence check has one to find. */
async function uploadFrame(): Promise<string> {
  const attachment = await uploadAttachment(
    "frame.png",
    "image/png",
    IMAGE_BASE64,
  );
  return attachment.id;
}

/** True while the attachment's row is still in the store. */
function frameStored(attachmentId: string): boolean {
  return getAttachmentById(attachmentId) !== null;
}

function loudPcmChunk(amplitude: number, sampleCount = 240): Uint8Array {
  const buffer = Buffer.alloc(sampleCount * 2);
  for (let index = 0; index < sampleCount; index += 1) {
    buffer.writeInt16LE(amplitude, index * 2);
  }
  return new Uint8Array(buffer);
}

/** One fresh transcriber per utterance; `stop()` flushes its transcript. */
class FakeStreamingTranscriber implements StreamingTranscriber {
  readonly providerId = "deepgram" as const;
  readonly boundaryId = "daemon-streaming" as const;
  private onEvent: ((event: SttStreamServerEvent) => void) | null = null;

  constructor(private readonly transcript: string) {}

  async start(onEvent: (event: SttStreamServerEvent) => void): Promise<void> {
    this.onEvent = onEvent;
  }

  sendAudio(): void {
    this.onEvent?.({ type: "partial", text: "wha" });
  }

  stop(): void {
    this.onEvent?.({ type: "final", text: this.transcript });
    this.onEvent?.({ type: "closed" });
  }
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

function makeTtsResult(text: string): LiveVoiceTtsResult {
  return {
    provider: "fish-audio",
    contentType: "audio/pcm",
    sampleRate: 24_000,
    chunks: 1,
    bytes: Buffer.byteLength(text),
  };
}

function createSessionHarness(startVoiceTurn: LiveVoiceTurnStarter) {
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

  let utterances = 0;
  const session = createLiveVoiceSession(context, {
    // Credential-free harness: every leg is injected, so skip the preflight.
    resolveCredentialReadiness: null,
    // One discrete mic chunk per utterance; keep the adaptive playback
    // classifier out of the cycle timing.
    echoBargeInMargin: 1,
    resolveTranscriber: mock(async () => {
      utterances += 1;
      return new FakeStreamingTranscriber(`utterance ${utterances}`);
    }),
    startVoiceTurn,
    streamTtsAudio: mock(async (options: LiveVoiceTtsOptions) =>
      makeTtsResult(options.text),
    ),
    createTurnId: () => `live-turn-${utterances}`,
    emitMetrics: false,
  });

  return { frames, session };
}

async function waitFor(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

/** Drive one utterance through to its dispatched assistant turn. */
async function speakAndRelease(
  session: LiveVoiceSession,
  seen: () => number,
  amplitude: number,
): Promise<void> {
  const before = seen();
  await session.handleBinaryAudio(loudPcmChunk(amplitude));
  await session.handleClientFrame({ type: "ptt_release" });
  await waitFor(
    () => seen() > before,
    "Timed out waiting for the live-voice turn to dispatch",
  );
}

function parkedFrameId(session: LiveVoiceSession): string | null {
  return (session as unknown as { pendingTurnAttachmentId: string | null })
    .pendingTurnAttachmentId;
}

describe("live-voice attach_frame frame", () => {
  test("accepts a well-formed frame", () => {
    const result = validateLiveVoiceClientFrame({
      type: "attach_frame",
      attachmentId: "att-1",
    });
    expect(result).toEqual({
      ok: true,
      frame: { type: "attach_frame", attachmentId: "att-1" },
    });
  });

  test("accepts a null attachmentId, which unparks", () => {
    const result = validateLiveVoiceClientFrame({
      type: "attach_frame",
      attachmentId: null,
    });
    expect(result).toEqual({
      ok: true,
      frame: { type: "attach_frame", attachmentId: null },
    });
  });

  test("rejects a missing attachmentId, naming the frame", () => {
    // A missing field is not an unpark. A client that means to clear the slot
    // says so with an explicit null; an absent field is a malformed frame.
    const result = validateLiveVoiceClientFrame({ type: "attach_frame" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("missing_required_field");
      expect(result.error.field).toBe("attachmentId");
      expect(result.error.frameType).toBe("attach_frame");
    }
  });

  test("rejects an empty attachmentId", () => {
    const result = validateLiveVoiceClientFrame({
      type: "attach_frame",
      attachmentId: "",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid_field");
      expect(result.error.frameType).toBe("attach_frame");
    }
  });
});

describe("live-voice camera frames parked for the next turn", () => {
  test("a parked frame rides the next turn's user message", async () => {
    const attachmentId = await uploadFrame();
    const turns: VoiceTurnOptions[] = [];
    const startVoiceTurn: LiveVoiceTurnStarter = mock(
      async (options: VoiceTurnOptions) => {
        turns.push(options);
        options.callbacks?.message_complete?.(makeMessageComplete());
        return { turnId: `bridge-turn-${turns.length}`, abort: mock() };
      },
    );
    const { session } = createSessionHarness(startVoiceTurn);
    await session.start();

    await session.handleClientFrame({ type: "attach_frame", attachmentId });
    // Nothing is dispatched for the frame itself; it waits for words.
    expect(turns).toHaveLength(0);
    expect(parkedFrameId(session)).toBe(attachmentId);

    await speakAndRelease(session, () => turns.length, 8_000);

    expect(turns[0]?.content).toBe("utterance 1");
    expect(turns[0]?.attachments).toEqual([attachmentId]);
    // Drained by the turn that took it, so it cannot ride a second one.
    expect(parkedFrameId(session)).toBeNull();

    await session.close("websocket_close");
  });

  test("the newest frame replaces the one before it", async () => {
    const stale = await uploadFrame();
    const current = await uploadFrame();
    const turns: VoiceTurnOptions[] = [];
    const startVoiceTurn: LiveVoiceTurnStarter = mock(
      async (options: VoiceTurnOptions) => {
        turns.push(options);
        options.callbacks?.message_complete?.(makeMessageComplete());
        return { turnId: `bridge-turn-${turns.length}`, abort: mock() };
      },
    );
    const { session } = createSessionHarness(startVoiceTurn);
    await session.start();

    await session.handleClientFrame({
      type: "attach_frame",
      attachmentId: stale,
    });
    await session.handleClientFrame({
      type: "attach_frame",
      attachmentId: current,
    });

    // A client shooting the camera on a timer parks one of these every few
    // seconds. Nothing else ever collects them, so the displaced one is given
    // up here or its row and bytes stay for good.
    expect(frameStored(stale)).toBe(false);
    expect(frameStored(current)).toBe(true);

    await speakAndRelease(session, () => turns.length, 8_000);

    expect(turns[0]?.attachments).toEqual([current]);

    await session.close("websocket_close");
  });

  test("displacing a frame that already rode a message leaves it alone", async () => {
    // The reclaim is link-aware, which is what makes it safe to run on an id
    // the client may have sent before: a frame that reached a message is that
    // message's, and re-sending its id must not delete it out from under the
    // transcript.
    const conversation = createConversation("Live voice frame reuse");
    const message = await addMessage(conversation.id, "user", "what is this");
    const sent = await uploadFrame();
    linkAttachmentToMessage(message.id, sent, 0);
    const replacement = await uploadFrame();
    const startVoiceTurn: LiveVoiceTurnStarter = mock(
      async (options: VoiceTurnOptions) => {
        options.callbacks?.message_complete?.(makeMessageComplete());
        return { turnId: "bridge-turn-1", abort: mock() };
      },
    );
    const { session } = createSessionHarness(startVoiceTurn);
    await session.start();

    await session.handleClientFrame({
      type: "attach_frame",
      attachmentId: sent,
    });
    await session.handleClientFrame({
      type: "attach_frame",
      attachmentId: replacement,
    });

    expect(frameStored(sent)).toBe(true);
    expect(parkedFrameId(session)).toBe(replacement);

    await session.close("websocket_close");
  });

  test("a frame that arrives mid-turn rides the turn after it", async () => {
    const first = await uploadFrame();
    const second = await uploadFrame();
    const turns: VoiceTurnOptions[] = [];
    const sessionRef: { current: LiveVoiceSession | null } = { current: null };
    const startVoiceTurn: LiveVoiceTurnStarter = mock(
      async (options: VoiceTurnOptions) => {
        turns.push(options);
        if (turns.length === 1) {
          // The camera keeps shooting while the assistant answers. This frame
          // belongs to whatever the user says next, not to the turn in flight.
          await sessionRef.current?.handleClientFrame({
            type: "attach_frame",
            attachmentId: second,
          });
        }
        options.callbacks?.message_complete?.(makeMessageComplete());
        return { turnId: `bridge-turn-${turns.length}`, abort: mock() };
      },
    );
    const { session } = createSessionHarness(startVoiceTurn);
    sessionRef.current = session;
    await session.start();

    await session.handleClientFrame({
      type: "attach_frame",
      attachmentId: first,
    });
    await speakAndRelease(session, () => turns.length, 8_000);
    await speakAndRelease(session, () => turns.length, 9_000);

    expect(turns[0]?.attachments).toEqual([first]);
    expect(turns[1]?.attachments).toEqual([second]);

    await session.close("websocket_close");
  });

  test("unparking clears the slot and gives the frame up", async () => {
    // The client's viewfinder closed. Nothing should still be staged for a
    // turn that would show a view the user can no longer see.
    const attachmentId = await uploadFrame();
    const turns: VoiceTurnOptions[] = [];
    const startVoiceTurn: LiveVoiceTurnStarter = mock(
      async (options: VoiceTurnOptions) => {
        turns.push(options);
        options.callbacks?.message_complete?.(makeMessageComplete());
        return { turnId: `bridge-turn-${turns.length}`, abort: mock() };
      },
    );
    const { frames, session } = createSessionHarness(startVoiceTurn);
    await session.start();

    await session.handleClientFrame({ type: "attach_frame", attachmentId });
    expect(parkedFrameId(session)).toBe(attachmentId);
    const before = frames.length;

    await session.handleClientFrame({
      type: "attach_frame",
      attachmentId: null,
    });

    expect(parkedFrameId(session)).toBeNull();
    expect(frameStored(attachmentId)).toBe(false);
    // Nothing is answered for an unpark: it is the client tidying up after
    // itself, not a request that can fail.
    expect(frames.slice(before)).toEqual([]);

    await speakAndRelease(session, () => turns.length, 8_000);
    expect(turns[0]?.attachments).toBeUndefined();

    await session.close("websocket_close");
  });

  test("unparking an empty slot does nothing", async () => {
    const startVoiceTurn: LiveVoiceTurnStarter = mock(
      async (options: VoiceTurnOptions) => {
        options.callbacks?.message_complete?.(makeMessageComplete());
        return { turnId: "bridge-turn-1", abort: mock() };
      },
    );
    const { frames, session } = createSessionHarness(startVoiceTurn);
    await session.start();
    const before = frames.length;

    await session.handleClientFrame({
      type: "attach_frame",
      attachmentId: null,
    });

    expect(parkedFrameId(session)).toBeNull();
    expect(frames.slice(before)).toEqual([]);

    await session.close("websocket_close");
  });

  test("unparking leaves a frame that already rode a message alone", async () => {
    // Same link-awareness the displacement path relies on: an unpark arriving
    // after the turn drained the slot finds it empty, and the frame the
    // transcript is showing is not this call's to collect.
    const conversation = createConversation("Live voice frame unpark");
    const message = await addMessage(conversation.id, "user", "what is this");
    const sent = await uploadFrame();
    linkAttachmentToMessage(message.id, sent, 0);
    const startVoiceTurn: LiveVoiceTurnStarter = mock(
      async (options: VoiceTurnOptions) => {
        options.callbacks?.message_complete?.(makeMessageComplete());
        return { turnId: "bridge-turn-1", abort: mock() };
      },
    );
    const { session } = createSessionHarness(startVoiceTurn);
    await session.start();

    await session.handleClientFrame({
      type: "attach_frame",
      attachmentId: sent,
    });
    await session.handleClientFrame({
      type: "attach_frame",
      attachmentId: null,
    });

    expect(parkedFrameId(session)).toBeNull();
    expect(frameStored(sent)).toBe(true);

    await session.close("websocket_close");
  });

  test("ending the session drops the parked frame", async () => {
    const attachmentId = await uploadFrame();
    const startVoiceTurn: LiveVoiceTurnStarter = mock(
      async (options: VoiceTurnOptions) => {
        options.callbacks?.message_complete?.(makeMessageComplete());
        return { turnId: "bridge-turn-1", abort: mock() };
      },
    );
    const { session } = createSessionHarness(startVoiceTurn);
    await session.start();

    await session.handleClientFrame({ type: "attach_frame", attachmentId });
    expect(parkedFrameId(session)).toBe(attachmentId);

    await session.close("websocket_close");

    // A frame is only good for the call it was shot on, so the staged row
    // goes with the call rather than outliving it.
    expect(parkedFrameId(session)).toBeNull();
    expect(frameStored(attachmentId)).toBe(false);
  });

  test("a rolled-back turn hands the frame back for the replay", async () => {
    // A turn that never reached the bridge (and a speculative one the hold
    // verdict unwinds) must not take the frame down with it: the utterance is
    // about to be sent again, and the user is still holding the thing up.
    // The other half of this, that the rollback leaves the attachment itself
    // alive, is `voice-session-bridge.test.ts`'s discard suite.
    const attachmentId = await uploadFrame();
    const turns: VoiceTurnOptions[] = [];
    let dispatches = 0;
    const startVoiceTurn: LiveVoiceTurnStarter = mock(
      async (options: VoiceTurnOptions) => {
        dispatches += 1;
        if (dispatches === 1) {
          throw new Error("bridge unavailable");
        }
        turns.push(options);
        options.callbacks?.message_complete?.(makeMessageComplete());
        return { turnId: `bridge-turn-${turns.length}`, abort: mock() };
      },
    );
    const { session } = createSessionHarness(startVoiceTurn);
    await session.start();

    await session.handleClientFrame({ type: "attach_frame", attachmentId });
    await speakAndRelease(session, () => dispatches, 8_000);

    // Claimed by the failed turn, then handed straight back.
    expect(parkedFrameId(session)).toBe(attachmentId);

    await speakAndRelease(session, () => dispatches, 9_000);

    expect(turns[0]?.attachments).toEqual([attachmentId]);

    await session.close("websocket_close");
  });

  test("a rollback keeps the newer frame and gives up the one it replaced", async () => {
    // The camera kept shooting while the doomed turn was in flight, so the
    // frame coming back off it is already out of date. Latest still wins, and
    // the one that loses is nobody's to send: it goes.
    const claimed = await uploadFrame();
    const newer = await uploadFrame();
    const turns: VoiceTurnOptions[] = [];
    let dispatches = 0;
    const sessionRef: { current: LiveVoiceSession | null } = { current: null };
    const startVoiceTurn: LiveVoiceTurnStarter = mock(
      async (options: VoiceTurnOptions) => {
        dispatches += 1;
        if (dispatches === 1) {
          await sessionRef.current?.handleClientFrame({
            type: "attach_frame",
            attachmentId: newer,
          });
          throw new Error("bridge unavailable");
        }
        turns.push(options);
        options.callbacks?.message_complete?.(makeMessageComplete());
        return { turnId: `bridge-turn-${turns.length}`, abort: mock() };
      },
    );
    const { session } = createSessionHarness(startVoiceTurn);
    sessionRef.current = session;
    await session.start();

    await session.handleClientFrame({
      type: "attach_frame",
      attachmentId: claimed,
    });
    await speakAndRelease(session, () => dispatches, 8_000);

    expect(parkedFrameId(session)).toBe(newer);
    expect(frameStored(claimed)).toBe(false);

    await speakAndRelease(session, () => dispatches, 9_000);

    expect(turns[0]?.attachments).toEqual([newer]);

    await session.close("websocket_close");
  });

  test("a retransmitted id is the same frame, not a newer one", async () => {
    // A client that re-sends the id it already sent, while the turn holding it
    // is in flight, has parked the SAME frame. Reading that as a displacement
    // would collect the very frame the slot is pointing at, and the replay
    // would speak without the picture with nothing said.
    const attachmentId = await uploadFrame();
    const turns: VoiceTurnOptions[] = [];
    let dispatches = 0;
    const sessionRef: { current: LiveVoiceSession | null } = { current: null };
    const startVoiceTurn: LiveVoiceTurnStarter = mock(
      async (options: VoiceTurnOptions) => {
        dispatches += 1;
        if (dispatches === 1) {
          await sessionRef.current?.handleClientFrame({
            type: "attach_frame",
            attachmentId,
          });
          throw new Error("bridge unavailable");
        }
        turns.push(options);
        options.callbacks?.message_complete?.(makeMessageComplete());
        return { turnId: `bridge-turn-${turns.length}`, abort: mock() };
      },
    );
    const { session } = createSessionHarness(startVoiceTurn);
    sessionRef.current = session;
    await session.start();

    await session.handleClientFrame({ type: "attach_frame", attachmentId });
    await speakAndRelease(session, () => dispatches, 8_000);

    expect(parkedFrameId(session)).toBe(attachmentId);
    expect(frameStored(attachmentId)).toBe(true);

    await speakAndRelease(session, () => dispatches, 9_000);

    expect(turns[0]?.attachments).toEqual([attachmentId]);

    await session.close("websocket_close");
  });

  test("an unknown attachment id is refused and nothing is parked", async () => {
    const turns: VoiceTurnOptions[] = [];
    const startVoiceTurn: LiveVoiceTurnStarter = mock(
      async (options: VoiceTurnOptions) => {
        turns.push(options);
        options.callbacks?.message_complete?.(makeMessageComplete());
        return { turnId: `bridge-turn-${turns.length}`, abort: mock() };
      },
    );
    const { frames, session } = createSessionHarness(startVoiceTurn);
    await session.start();
    const before = frames.length;

    await session.handleClientFrame({
      type: "attach_frame",
      attachmentId: "att-missing",
    });
    await waitFor(
      () => frames.length > before,
      "Timed out waiting for the rejected camera frame's error",
    );

    // Attributed to the frame it is about, so the client can retract the
    // preview it already showed instead of filing this with the transient
    // transcriber and TTS blips that share `recoverable`.
    expect(
      frames.slice(before).find((frame) => frame.type === "error"),
    ).toMatchObject({
      type: "error",
      frameType: "attach_frame",
      recoverable: true,
    });
    expect(parkedFrameId(session)).toBeNull();

    await speakAndRelease(session, () => turns.length, 8_000);
    expect(turns[0]?.attachments).toBeUndefined();

    await session.close("websocket_close");
  });

  test("attach_image parks nothing", async () => {
    // A deliberate snap persists as its own message; the spoken turn that
    // follows carries no attachments and reaches it through history.
    const turns: VoiceTurnOptions[] = [];
    const startVoiceTurn: LiveVoiceTurnStarter = mock(
      async (options: VoiceTurnOptions) => {
        turns.push(options);
        options.callbacks?.message_complete?.(makeMessageComplete());
        return { turnId: `bridge-turn-${turns.length}`, abort: mock() };
      },
    );
    const { session } = createSessionHarness(startVoiceTurn);
    await session.start();

    await session.handleClientFrame({
      type: "attach_image",
      attachmentId: "att-missing",
    });
    expect(parkedFrameId(session)).toBeNull();

    await speakAndRelease(session, () => turns.length, 8_000);
    expect(turns[0]?.attachments).toBeUndefined();

    await session.close("websocket_close");
  });
});
