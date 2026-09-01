/**
 * Ambient camera frames kept mid-call (`sight_frame`).
 *
 * The behaviour under test is the keep-stream rule: a kept frame persists
 * immediately as its own tagged user message and dispatches no turn, so the
 * transcript is the record of what the assistant saw and the model correlates
 * a frame with speech by adjacency.
 *
 * The two neighbouring contracts are pinned by their own suites: a deliberate
 * snap persists standalone and untagged (`live-voice-attach-image.test.ts`), a
 * parked frame persists nothing and rides the next turn
 * (`live-voice-attach-frame.test.ts`). One photo case does live here, because
 * it pins the edge of something this suite owns: the refusal's attachment
 * echo, which is the keep stream's alone.
 */

import { describe, expect, mock, test } from "bun:test";

import {
  createMockProvider,
  textResponse,
} from "../../__tests__/helpers/mock-provider.js";
import { setConfig } from "../../__tests__/helpers/set-config.js";
import { waitFor } from "../../__tests__/helpers/wait-for.js";

setConfig("memory", { enabled: false });

import type { VoiceTurnOptions } from "../../calls/voice-session-bridge.js";
import { Conversation } from "../../daemon/conversation.js";
import {
  deleteConversation,
  setConversation,
} from "../../daemon/conversation-registry.js";
import {
  getAttachmentsForMessage,
  uploadAttachment,
} from "../../persistence/attachments-store.js";
import {
  createConversation,
  getMessages,
  selectSightFrameCaptureTimes,
} from "../../persistence/conversation-crud.js";
import { sightFrameAttachmentIdsFromMetadata } from "../../persistence/conversation-types.js";
import { initializeDb } from "../../persistence/db-init.js";
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
  type LiveVoiceServerFrame,
  validateLiveVoiceClientFrame,
} from "../protocol.js";

await initializeDb();

const IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk";

class MockStreamingTranscriber implements StreamingTranscriber {
  readonly providerId = "deepgram" as const;
  readonly boundaryId = "daemon-streaming" as const;
  private onEvent: ((event: SttStreamServerEvent) => void) | null = null;

  async start(onEvent: (event: SttStreamServerEvent) => void): Promise<void> {
    this.onEvent = onEvent;
  }

  sendAudio(): void {}

  stop(): void {
    this.onEvent?.({ type: "closed" });
  }
}

/** A real attachment row, so the arrival-time existence check has one to find. */
async function uploadFrame(): Promise<string> {
  const attachment = await uploadAttachment(
    "frame.png",
    "image/png",
    IMAGE_BASE64,
  );
  return attachment.id;
}

/**
 * A session bound to a live conversation, so a kept frame has somewhere real
 * to land. Returns a `dispose` that unregisters it.
 */
function createSessionHarness(title: string) {
  const conversation = createConversation(title);
  const { provider } = createMockProvider([textResponse("")]);
  const activeConversation = new Conversation(
    conversation.id,
    provider,
    "system prompt",
    () => {},
    "/tmp",
    { maxTokens: 4096 },
  );
  activeConversation.setTrustContext({
    trustClass: "guardian",
    sourceChannel: "vellum",
  });
  setConversation(conversation.id, activeConversation);

  const sequencer = createLiveVoiceServerFrameSequencer();
  const frames: LiveVoiceServerFrame[] = [];
  const context: LiveVoiceSessionFactoryContext = {
    sessionId: "session-sight-frame",
    startFrame: {
      type: "start",
      conversationId: conversation.id,
      audio: { mimeType: "audio/pcm", sampleRate: 24_000, channels: 1 },
    },
    sendFrame: mock(async (payload) => {
      const frame = sequencer.next(payload);
      frames.push(frame);
      return frame;
    }),
  };

  const startVoiceTurn: LiveVoiceTurnStarter = mock(
    async (_options: VoiceTurnOptions) => ({
      turnId: "bridge-turn-1",
      abort: mock(),
    }),
  );

  const session = new LiveVoiceSession(context, {
    resolveTranscriber: mock(async () => new MockStreamingTranscriber()),
    startVoiceTurn,
    createTurnId: () => "live-turn-1",
    emitMetrics: false,
  });

  return {
    activeConversation,
    conversationId: conversation.id,
    frames,
    session,
    startVoiceTurn,
    dispose: () => {
      deleteConversation(conversation.id);
      activeConversation.dispose();
    },
  };
}

describe("live-voice sight_frame frame", () => {
  test("accepts a well-formed frame", () => {
    const result = validateLiveVoiceClientFrame({
      type: "sight_frame",
      attachmentId: "att-1",
    });
    expect(result).toEqual({
      ok: true,
      frame: { type: "sight_frame", attachmentId: "att-1" },
    });
  });

  test("rejects a missing attachmentId, naming the frame", () => {
    const result = validateLiveVoiceClientFrame({ type: "sight_frame" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("missing_required_field");
      expect(result.error.field).toBe("attachmentId");
      expect(result.error.frameType).toBe("sight_frame");
    }
  });

  test("rejects an empty attachmentId, distinctly from a missing one", () => {
    const result = validateLiveVoiceClientFrame({
      type: "sight_frame",
      attachmentId: "",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid_field");
      expect(result.error.field).toBe("attachmentId");
      expect(result.error.frameType).toBe("sight_frame");
    }
  });

  test("rejects a null attachmentId", () => {
    // `attach_frame` reads null as an unpark. A keep has nothing staged to
    // give up, so null is simply malformed here.
    const result = validateLiveVoiceClientFrame({
      type: "sight_frame",
      attachmentId: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid_field");
      expect(result.error.frameType).toBe("sight_frame");
    }
  });

  test("rejects a non-string attachmentId", () => {
    const result = validateLiveVoiceClientFrame({
      type: "sight_frame",
      attachmentId: 7,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid_field");
      expect(result.error.frameType).toBe("sight_frame");
    }
  });
});

describe("live-voice camera frames kept mid-call", () => {
  test("a kept frame persists as its own tagged message and runs no turn", async () => {
    const harness = createSessionHarness("Sight keep stream");
    try {
      await harness.session.start();
      const attachmentId = await uploadFrame();

      await harness.session.handleClientFrame({
        type: "sight_frame",
        attachmentId,
      });
      await waitFor(() => getMessages(harness.conversationId).length > 0, {
        message: "Timed out waiting for the kept frame to persist",
      });

      const rows = getMessages(harness.conversationId);
      expect(rows).toHaveLength(1);
      const [row] = rows;
      expect(row.role).toBe("user");
      expect(getAttachmentsForMessage(row.id)).toHaveLength(1);

      // The tag names the attachment on the row that carries it, which is what
      // retention reads to decide what a later turn still sends in full.
      const metadata = JSON.parse(row.metadata ?? "{}") as Record<
        string,
        unknown
      >;
      expect(sightFrameAttachmentIdsFromMetadata(metadata)).toEqual([
        attachmentId,
      ]);
      expect(
        selectSightFrameCaptureTimes(harness.conversationId).has(attachmentId),
      ).toBe(true);

      // Nothing is dispatched for the frame itself: answering a picture the
      // user never asked about would talk over whatever they are saying.
      expect(harness.startVoiceTurn).not.toHaveBeenCalled();
      expect(
        harness.frames.filter((frame) => frame.type === "error"),
      ).toHaveLength(0);
    } finally {
      harness.dispose();
    }
  });

  test("an unknown attachment id is refused, recoverably and attributably", async () => {
    const harness = createSessionHarness("Sight keep unknown id");
    try {
      await harness.session.start();
      const before = harness.frames.length;

      await harness.session.handleClientFrame({
        type: "sight_frame",
        attachmentId: "att-missing",
      });
      await waitFor(() => harness.frames.length > before, {
        message: "Timed out waiting for the rejected camera frame's error",
      });

      expect(
        harness.frames.slice(before).find((frame) => frame.type === "error"),
      ).toMatchObject({
        type: "error",
        frameType: "sight_frame",
        // The id it refused, so the client retires that keep rather than
        // guessing among the sends it has not heard back on.
        attachmentId: "att-missing",
        recoverable: true,
      });
      // Nothing landed and the call carries on.
      expect(getMessages(harness.conversationId)).toHaveLength(0);
      expect(harness.startVoiceTurn).not.toHaveBeenCalled();
    } finally {
      harness.dispose();
    }
  });

  test("each refused keep names its own attachment", async () => {
    // The point of the echo: keeps overlap, so a shared `frameType` cannot
    // tell two outstanding sends apart.
    const harness = createSessionHarness("Sight keep two refusals");
    try {
      await harness.session.start();
      const before = harness.frames.length;

      await harness.session.handleClientFrame({
        type: "sight_frame",
        attachmentId: "att-missing-1",
      });
      await harness.session.handleClientFrame({
        type: "sight_frame",
        attachmentId: "att-missing-2",
      });
      await waitFor(
        () =>
          harness.frames.slice(before).filter((frame) => frame.type === "error")
            .length === 2,
        { message: "Timed out waiting for both refusals" },
      );

      const refused = harness.frames
        .slice(before)
        .filter((frame) => frame.type === "error")
        .map((frame) => frame.attachmentId);
      expect(refused.sort()).toEqual(["att-missing-1", "att-missing-2"]);
    } finally {
      harness.dispose();
    }
  });

  test("a photo that cannot be stored names no attachment", async () => {
    // Scope pin: the echo is the keep stream's, where sends overlap. A photo
    // is one deliberate snap at a time, and its receipt strip already knows
    // which one it is waiting on.
    const harness = createSessionHarness("Sight keep photo scope");
    try {
      await harness.session.start();
      const before = harness.frames.length;

      await harness.session.handleClientFrame({
        type: "attach_image",
        attachmentId: "att-missing",
      });
      await waitFor(() => harness.frames.length > before, {
        message: "Timed out waiting for the rejected photo's error",
      });

      const error = harness.frames
        .slice(before)
        .find((frame) => frame.type === "error");
      expect(error).toMatchObject({
        type: "error",
        frameType: "attach_image",
        recoverable: true,
      });
      expect(error?.attachmentId).toBeUndefined();
    } finally {
      harness.dispose();
    }
  });

  test("refuses an unknown id while a turn is running, without waiting it out", async () => {
    // The id is checked before the persist is scheduled. Behind the persist it
    // would be answered only once the turn released the lock, long after the
    // client could still retract the preview it showed.
    const harness = createSessionHarness("Sight keep unknown id mid-turn");
    try {
      await harness.session.start();
      harness.activeConversation.setProcessing(true);
      const before = harness.frames.length;

      await harness.session.handleClientFrame({
        type: "sight_frame",
        attachmentId: "att-missing",
      });
      await waitFor(() => harness.frames.length > before, {
        message: "Timed out waiting for the mid-turn rejection",
      });

      expect(
        harness.frames.slice(before).find((frame) => frame.type === "error"),
      ).toMatchObject({ type: "error", frameType: "sight_frame" });
    } finally {
      harness.activeConversation.setProcessing(false);
      harness.dispose();
    }
  });

  test("keeps persist one message each", async () => {
    // One message per keep, no batching: the gate's rate floor separates them,
    // so there is no natural batch to form.
    const harness = createSessionHarness("Sight keep stream repeated");
    try {
      await harness.session.start();
      const first = await uploadFrame();
      const second = await uploadFrame();

      await harness.session.handleClientFrame({
        type: "sight_frame",
        attachmentId: first,
      });
      await waitFor(() => getMessages(harness.conversationId).length === 1, {
        message: "Timed out waiting for the first kept frame",
      });
      await harness.session.handleClientFrame({
        type: "sight_frame",
        attachmentId: second,
      });
      await waitFor(() => getMessages(harness.conversationId).length === 2, {
        message: "Timed out waiting for the second kept frame",
      });

      const captureTimes = selectSightFrameCaptureTimes(harness.conversationId);
      expect([...captureTimes.keys()].sort()).toEqual([first, second].sort());
      expect(harness.startVoiceTurn).not.toHaveBeenCalled();
    } finally {
      harness.dispose();
    }
  });
});
