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

import { describe, expect, mock, spyOn, test } from "bun:test";

import {
  createMockProvider,
  textResponse,
} from "../../__tests__/helpers/mock-provider.js";
import { setConfig } from "../../__tests__/helpers/set-config.js";
import { waitFor } from "../../__tests__/helpers/wait-for.js";

setConfig("memory", { enabled: false });

import type {
  VoiceTurnHandle,
  VoiceTurnOptions,
} from "../../calls/voice-session-bridge.js";
import { Conversation } from "../../daemon/conversation.js";
import {
  deleteConversation,
  findConversation,
  setConversation,
} from "../../daemon/conversation-registry.js";
import {
  evictConversationsForReload,
  getOrCreateConversation,
} from "../../daemon/conversation-store.js";
import {
  attachmentExists,
  getAttachmentsForMessage,
  uploadAttachment,
} from "../../persistence/attachments-store.js";
import {
  createConversation,
  getMessages,
  selectSightFrameCaptureTimes,
} from "../../persistence/conversation-crud.js";
import { getConversationModeSession } from "../../persistence/conversation-mode-sessions.js";
import { sightFrameAttachmentIdsFromMetadata } from "../../persistence/conversation-types.js";
import { initializeDb } from "../../persistence/db-init.js";
import type {
  StreamingTranscriber,
  SttStreamServerEvent,
} from "../../stt/types.js";
import {
  LiveVoiceSession,
  type LiveVoiceSessionOptions,
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
function createSessionHarness(
  title: string,
  options?: {
    acquireResidency?: boolean;
    acquireModeSessionResidency?: NonNullable<
      LiveVoiceSessionOptions["acquireModeSessionResidency"]
    >;
    startVoiceTurn?: LiveVoiceTurnStarter;
  },
) {
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

  const startVoiceTurn = mock(
    options?.startVoiceTurn ??
      (async (_options: VoiceTurnOptions) => ({
        turnId: "bridge-turn-1",
        abort: mock(() => {
          const requestId = _options.preacceptedModeSession?.requestId;
          if (requestId) {
            activeConversation.modeSessions.releaseTurn(requestId);
          }
        }),
      })),
  ) satisfies LiveVoiceTurnStarter;

  const session = new LiveVoiceSession(context, {
    resolveTranscriber: mock(async () => new MockStreamingTranscriber()),
    startVoiceTurn,
    createTurnId: () => "live-turn-1",
    emitMetrics: false,
    acquireModeSessionResidency:
      options?.acquireModeSessionResidency ??
      (async () => ({
        coordinator: activeConversation.modeSessions,
        release: options?.acquireResidency
          ? activeConversation.acquireLiveVoiceResidency()
          : () => {},
      })),
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
  test("accepts camera lifecycle start, frame, and end", () => {
    expect(
      validateLiveVoiceClientFrame({
        type: "sight_start",
        cameraEpoch: 7,
        source: "ambient",
      }),
    ).toEqual({
      ok: true,
      frame: { type: "sight_start", cameraEpoch: 7, source: "ambient" },
    });
    expect(
      validateLiveVoiceClientFrame({
        type: "sight_frame",
        attachmentId: "att-1",
        cameraEpoch: 7,
        source: "ambient",
      }),
    ).toEqual({
      ok: true,
      frame: {
        type: "sight_frame",
        attachmentId: "att-1",
        cameraEpoch: 7,
        source: "ambient",
      },
    });
    expect(
      validateLiveVoiceClientFrame({ type: "sight_end", cameraEpoch: 7 }),
    ).toEqual({
      ok: true,
      frame: { type: "sight_end", cameraEpoch: 7 },
    });
  });

  test("rejects invalid epochs, sources, and source without an epoch", () => {
    for (const frame of [
      { type: "sight_start", cameraEpoch: 0 },
      { type: "sight_start", cameraEpoch: 1.5 },
      { type: "sight_start", cameraEpoch: 1, source: "screen" },
      { type: "sight_end", cameraEpoch: Number.MAX_SAFE_INTEGER + 1 },
      { type: "sight_frame", attachmentId: "att-1", source: "live" },
    ]) {
      expect(validateLiveVoiceClientFrame(frame).ok).toBe(false);
    }
  });

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

  test("carries the client's timing through as sent", () => {
    const timing = {
      reason: "forced",
      armToKeepMs: 40,
      keepToEncodedMs: 30,
      encodedToUploadedMs: 200,
      uploadedToSentMs: 0,
      bytes: 12345,
    };
    const result = validateLiveVoiceClientFrame({
      type: "sight_frame",
      attachmentId: "att-1",
      timing,
    });
    expect(result).toEqual({
      ok: true,
      frame: { type: "sight_frame", attachmentId: "att-1", timing },
    });
  });

  test("an ambient keep's timing has no arm", () => {
    const timing = {
      reason: "novel",
      keepToEncodedMs: 30,
      encodedToUploadedMs: 200,
      uploadedToSentMs: 12,
      bytes: 12345,
    };
    const result = validateLiveVoiceClientFrame({
      type: "sight_frame",
      attachmentId: "att-1",
      timing,
    });
    expect(result).toEqual({
      ok: true,
      frame: { type: "sight_frame", attachmentId: "att-1", timing },
    });
  });

  test("rejects a timing with a negative or fractional duration, naming the field", () => {
    for (const bad of [
      { keepToEncodedMs: -1 },
      { encodedToUploadedMs: 1.5 },
      { uploadedToSentMs: "0" },
      { armToKeepMs: -5 },
      { bytes: null },
      { reason: "" },
    ]) {
      const result = validateLiveVoiceClientFrame({
        type: "sight_frame",
        attachmentId: "att-1",
        timing: {
          reason: "novel",
          keepToEncodedMs: 30,
          encodedToUploadedMs: 200,
          uploadedToSentMs: 0,
          bytes: 1,
          ...bad,
        },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("invalid_field");
        expect(result.error.field).toBe("timing");
        expect(result.error.frameType).toBe("sight_frame");
      }
    }
  });

  test("rejects a timing that is not an object", () => {
    const result = validateLiveVoiceClientFrame({
      type: "sight_frame",
      attachmentId: "att-1",
      timing: "fast",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.field).toBe("timing");
    }
  });
});

describe("live-voice camera frames kept mid-call", () => {
  test("keeps one canonical conversation across reload and camera restarts", async () => {
    const harness = createSessionHarness("Sight residency across reload", {
      acquireResidency: true,
    });
    try {
      await harness.session.start();
      await harness.session.handleClientFrame({
        type: "sight_start",
        cameraEpoch: 41,
        source: "live",
      });
      const firstAttachmentId = await uploadFrame();
      await harness.session.handleClientFrame({
        type: "sight_frame",
        attachmentId: firstAttachmentId,
        cameraEpoch: 41,
        source: "live",
      });
      await waitFor(() => getMessages(harness.conversationId).length === 1);
      const firstMetadata = JSON.parse(
        getMessages(harness.conversationId)[0]!.metadata ?? "{}",
      ) as { modeSession?: { id: string } };

      evictConversationsForReload();
      await harness.session.handleClientFrame({
        type: "sight_end",
        cameraEpoch: 41,
      });
      await waitFor(
        () =>
          getConversationModeSession(
            harness.conversationId,
            firstMetadata.modeSession!.id,
          )?.status === "completed",
      );

      expect(await getOrCreateConversation(harness.conversationId)).toBe(
        harness.activeConversation,
      );

      await harness.session.handleClientFrame({
        type: "sight_start",
        cameraEpoch: 42,
        source: "ambient",
      });
      const secondAttachmentId = await uploadFrame();
      await harness.session.handleClientFrame({
        type: "sight_frame",
        attachmentId: secondAttachmentId,
        cameraEpoch: 42,
        source: "ambient",
      });
      await waitFor(() => getMessages(harness.conversationId).length === 2);
      const secondMetadata = JSON.parse(
        getMessages(harness.conversationId)[1]!.metadata ?? "{}",
      ) as { modeSession?: { id: string; mode: string } };
      expect(secondMetadata.modeSession).toMatchObject({ mode: "ambient" });
      expect(secondMetadata.modeSession?.id).not.toBe(
        firstMetadata.modeSession?.id,
      );

      await harness.session.handleClientFrame({
        type: "text",
        text: "Describe the current view.",
      });
      await waitFor(() => harness.startVoiceTurn.mock.calls.length === 1);
      expect(
        harness.startVoiceTurn.mock.calls[0]![0].preacceptedModeSession?.source
          .id,
      ).toBe(secondMetadata.modeSession?.id);

      await harness.session.handleClientFrame({
        type: "sight_end",
        cameraEpoch: 42,
      });
      await harness.session.close("client_end");
      evictConversationsForReload();
      expect(findConversation(harness.conversationId)).toBeUndefined();
    } finally {
      harness.dispose();
    }
  });

  test("keeps an accepted voice owner when the camera stops during bridge admission", async () => {
    let resolveTurn!: (handle: VoiceTurnHandle) => void;
    const bridgeTurn = new Promise<VoiceTurnHandle>((resolve) => {
      resolveTurn = resolve;
    });
    const harness = createSessionHarness("Sight stop during admission", {
      startVoiceTurn: async () => bridgeTurn,
    });
    try {
      await harness.session.start();
      await harness.session.handleClientFrame({
        type: "sight_start",
        cameraEpoch: 31,
        source: "live",
      });
      const speaking = harness.session.handleClientFrame({
        type: "text",
        text: "What is in view?",
      });
      await waitFor(() => harness.startVoiceTurn.mock.calls.length > 0);
      const accepted =
        harness.startVoiceTurn.mock.calls[0]![0].preacceptedModeSession!;

      await harness.session.handleClientFrame({
        type: "sight_end",
        cameraEpoch: 31,
      });

      expect(
        harness.activeConversation.modeSessions.getTurnOwner(
          accepted.requestId,
        ),
      ).toEqual({ id: accepted.source.id, mode: accepted.source.mode });
      resolveTurn({ turnId: "bridge-turn-1", abort: mock() });
      await speaking;
      harness.activeConversation.modeSessions.releaseTurn(accepted.requestId);
    } finally {
      await harness.session.close("client_end");
      harness.dispose();
    }
  });

  test("keeps an accepted voice owner when a new camera run replaces it during admission", async () => {
    let resolveTurn!: (handle: VoiceTurnHandle) => void;
    const bridgeTurn = new Promise<VoiceTurnHandle>((resolve) => {
      resolveTurn = resolve;
    });
    const harness = createSessionHarness("Sight replacement during admission", {
      startVoiceTurn: async () => bridgeTurn,
    });
    try {
      await harness.session.start();
      await harness.session.handleClientFrame({
        type: "sight_start",
        cameraEpoch: 32,
        source: "live",
      });
      const speaking = harness.session.handleClientFrame({
        type: "text",
        text: "What is in view?",
      });
      await waitFor(() => harness.startVoiceTurn.mock.calls.length > 0);
      const accepted =
        harness.startVoiceTurn.mock.calls[0]![0].preacceptedModeSession!;

      await harness.session.handleClientFrame({
        type: "sight_start",
        cameraEpoch: 33,
        source: "ambient",
      });

      expect(accepted.source.generation).toBe(32);
      expect(
        harness.activeConversation.modeSessions.getTurnOwner(
          accepted.requestId,
        ),
      ).toEqual({ id: accepted.source.id, mode: accepted.source.mode });
      resolveTurn({ turnId: "bridge-turn-1", abort: mock() });
      await speaking;
      harness.activeConversation.modeSessions.releaseTurn(accepted.requestId);
    } finally {
      await harness.session.close("client_end");
      harness.dispose();
    }
  });

  test("orders sight_end behind deferred camera-session preparation", async () => {
    let resolvePreparation!: (value: Conversation["modeSessions"]) => void;
    const preparation = new Promise<Conversation["modeSessions"]>((resolve) => {
      resolvePreparation = resolve;
    });
    const harness = createSessionHarness("Deferred sight end", {
      acquireModeSessionResidency: async () => ({
        coordinator: await preparation,
        release: () => {},
      }),
    });
    try {
      await harness.session.start();
      const starting = harness.session.handleClientFrame({
        type: "sight_start",
        cameraEpoch: 21,
        source: "live",
      });
      const ending = harness.session.handleClientFrame({
        type: "sight_end",
        cameraEpoch: 21,
      });

      resolvePreparation(harness.activeConversation.modeSessions);
      await Promise.all([starting, ending]);
      await harness.session.handleClientFrame({
        type: "text",
        text: "Is the camera still active?",
      });
      await waitFor(() => harness.startVoiceTurn.mock.calls.length > 0);

      expect(
        harness.startVoiceTurn.mock.calls[0]![0].modeSessionSource,
      ).toBeUndefined();
    } finally {
      await harness.session.close("client_end");
      harness.dispose();
    }
  });

  test("orders a kept frame behind deferred camera-session preparation", async () => {
    let resolvePreparation!: (value: Conversation["modeSessions"]) => void;
    const preparation = new Promise<Conversation["modeSessions"]>((resolve) => {
      resolvePreparation = resolve;
    });
    const harness = createSessionHarness("Deferred sight frame", {
      acquireModeSessionResidency: async () => ({
        coordinator: await preparation,
        release: () => {},
      }),
    });
    try {
      await harness.session.start();
      const attachmentId = await uploadFrame();
      const starting = harness.session.handleClientFrame({
        type: "sight_start",
        cameraEpoch: 22,
        source: "ambient",
      });
      const keeping = harness.session.handleClientFrame({
        type: "sight_frame",
        attachmentId,
        cameraEpoch: 22,
        source: "ambient",
      });

      resolvePreparation(harness.activeConversation.modeSessions);
      await Promise.all([starting, keeping]);
      await waitFor(() => getMessages(harness.conversationId).length > 0);

      const row = getMessages(harness.conversationId)[0]!;
      const metadata = JSON.parse(row.metadata ?? "{}") as {
        modeSession?: { id: string; mode: string };
      };
      expect(metadata.modeSession?.mode).toBe("ambient");
      expect(
        harness.frames.filter((frame) => frame.type === "error"),
      ).toHaveLength(0);
    } finally {
      await harness.session.close("client_end");
      harness.dispose();
    }
  });

  test("does not activate a deferred camera start after session close", async () => {
    let resolvePreparation!: (value: Conversation["modeSessions"]) => void;
    const preparation = new Promise<Conversation["modeSessions"]>((resolve) => {
      resolvePreparation = resolve;
    });
    const release = mock(() => {});
    const acquire = mock(async () => ({
      coordinator: await preparation,
      release,
    }));
    const harness = createSessionHarness("Deferred sight close", {
      acquireModeSessionResidency: acquire,
    });
    const activateSource = spyOn(
      harness.activeConversation.modeSessions,
      "activateSource",
    );
    try {
      await harness.session.start();
      const starting = harness.session.handleClientFrame({
        type: "sight_start",
        cameraEpoch: 23,
        source: "live",
      });
      await waitFor(() => acquire.mock.calls.length === 1);
      const closing = harness.session.close("websocket_close");

      resolvePreparation(harness.activeConversation.modeSessions);
      await Promise.all([starting, closing]);

      expect(activateSource).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledTimes(1);
      await harness.session.close("client_end");
      expect(release).toHaveBeenCalledTimes(1);
    } finally {
      activateSource.mockRestore();
      harness.dispose();
    }
  });

  test("captures the active camera owner for a typed voice turn", async () => {
    const harness = createSessionHarness("Sight-owned voice turn");
    try {
      await harness.session.start();
      await harness.session.handleClientFrame({
        type: "sight_start",
        cameraEpoch: 11,
        source: "ambient",
      });
      await harness.session.handleClientFrame({
        type: "text",
        text: "What do you see?",
      });
      await waitFor(() => harness.startVoiceTurn.mock.calls.length > 0, {
        message: "Timed out waiting for typed voice turn",
      });

      const options = harness.startVoiceTurn.mock.calls[0]![0];
      expect(options.preacceptedModeSession?.source).toMatchObject({
        generation: 11,
        mode: "ambient",
      });
    } finally {
      await harness.session.close("client_end");
      harness.dispose();
    }
  });

  test("dispatches voice ungrouped when the first delivery claim throws", async () => {
    const harness = createSessionHarness("Sight voice first claim failure");
    const coordinator = harness.activeConversation.modeSessions;
    const originalClaimTurn = coordinator.claimTurn.bind(coordinator);
    let attemptedRequestId: string | undefined;
    const claimTurn = spyOn(coordinator, "claimTurn").mockImplementation(
      (turnId, source, at) => {
        const owner = originalClaimTurn(turnId, source, at);
        if (!turnId.startsWith("live-voice-camera:")) {
          attemptedRequestId = turnId;
          throw new Error("session tracking unavailable");
        }
        return owner;
      },
    );
    try {
      await harness.session.start();
      await harness.session.handleClientFrame({
        type: "sight_start",
        cameraEpoch: 54,
        source: "live",
      });
      await harness.session.handleClientFrame({
        type: "text",
        text: "What is here?",
      });
      await waitFor(() => harness.startVoiceTurn.mock.calls.length === 1);

      expect(
        harness.startVoiceTurn.mock.calls[0]![0].preacceptedModeSession,
      ).toBeUndefined();
      expect(attemptedRequestId).toBeDefined();
      expect(coordinator.getTurnOwner(attemptedRequestId!)).toBeUndefined();
    } finally {
      claimTurn.mockRestore();
      await harness.session.close("client_end");
      harness.dispose();
    }
  });

  test("releases a mismatched first delivery claim before ungrouped dispatch", async () => {
    const harness = createSessionHarness("Sight voice first claim mismatch");
    const coordinator = harness.activeConversation.modeSessions;
    const originalClaimTurn = coordinator.claimTurn.bind(coordinator);
    let attemptedRequestId: string | undefined;
    const claimTurn = spyOn(coordinator, "claimTurn").mockImplementation(
      (turnId, source, at) => {
        const owner = originalClaimTurn(turnId, source, at);
        if (!turnId.startsWith("live-voice-camera:") && owner) {
          attemptedRequestId = turnId;
          return { id: "different-session", mode: owner.mode };
        }
        return owner;
      },
    );
    try {
      await harness.session.start();
      await harness.session.handleClientFrame({
        type: "sight_start",
        cameraEpoch: 57,
        source: "ambient",
      });
      await harness.session.handleClientFrame({
        type: "text",
        text: "What is here?",
      });
      await waitFor(() => harness.startVoiceTurn.mock.calls.length === 1);

      expect(
        harness.startVoiceTurn.mock.calls[0]![0].preacceptedModeSession,
      ).toBeUndefined();
      expect(attemptedRequestId).toBeDefined();
      expect(coordinator.getTurnOwner(attemptedRequestId!)).toBeUndefined();
    } finally {
      claimTurn.mockRestore();
      await harness.session.close("client_end");
      harness.dispose();
    }
  });

  test("releases every delivery claim when a later admission throws", async () => {
    const harness = createSessionHarness("Sight voice later claim failure");
    const coordinator = harness.activeConversation.modeSessions;
    const originalClaimTurn = coordinator.claimTurn.bind(coordinator);
    const attemptedRequestIds: string[] = [];
    const claimTurn = spyOn(coordinator, "claimTurn").mockImplementation(
      (turnId, source, at) => {
        const owner = originalClaimTurn(turnId, source, at);
        if (!turnId.startsWith("live-voice-camera:")) {
          attemptedRequestIds.push(turnId);
          if (attemptedRequestIds.length === 3) {
            throw new Error("session tracking unavailable");
          }
        }
        return owner;
      },
    );
    try {
      await harness.session.start();
      await harness.session.handleClientFrame({
        type: "sight_start",
        cameraEpoch: 55,
        source: "ambient",
      });
      await harness.session.handleClientFrame({
        type: "text",
        text: "What is here?",
      });
      await waitFor(() => harness.startVoiceTurn.mock.calls.length === 1);

      expect(attemptedRequestIds).toHaveLength(3);
      expect(
        harness.startVoiceTurn.mock.calls[0]![0].preacceptedModeSession,
      ).toBeUndefined();
      expect(
        attemptedRequestIds.map((id) => coordinator.getTurnOwner(id)),
      ).toEqual([undefined, undefined, undefined]);
    } finally {
      claimTurn.mockRestore();
      await harness.session.close("client_end");
      harness.dispose();
    }
  });

  test("keeps a stopped camera session active until voice delivery settles", async () => {
    const harness = createSessionHarness("Sight voice delivery barrier");
    try {
      await harness.session.start();
      await harness.session.handleClientFrame({
        type: "sight_start",
        cameraEpoch: 12,
        source: "live",
      });
      await harness.session.handleClientFrame({
        type: "text",
        text: "Describe this.",
      });
      await waitFor(() => harness.startVoiceTurn.mock.calls.length > 0);

      const options = harness.startVoiceTurn.mock.calls[0]![0];
      const sessionId = options.preacceptedModeSession!.source.id;
      await harness.session.handleClientFrame({
        type: "sight_end",
        cameraEpoch: 12,
      });
      expect(
        getConversationModeSession(harness.conversationId, sessionId)?.status,
      ).toBe("active");

      options.callbacks?.message_complete?.({
        type: "message_complete",
        conversationId: harness.conversationId,
        messageId: "assistant-message-1",
      });
      harness.activeConversation.modeSessions.releaseTurn(
        options.preacceptedModeSession!.requestId,
      );
      await waitFor(
        () =>
          getConversationModeSession(harness.conversationId, sessionId)
            ?.status === "completed",
        { message: "Timed out waiting for voice delivery settlement" },
      );
      expect(harness.frames.some((frame) => frame.type === "tts_done")).toBe(
        true,
      );
    } finally {
      await harness.session.close("client_end");
      harness.dispose();
    }
  });

  test("releases remaining delivery claims when one release throws", async () => {
    const harness = createSessionHarness("Sight voice release failure");
    const coordinator = harness.activeConversation.modeSessions;
    const originalClaimTurn = coordinator.claimTurn.bind(coordinator);
    const claimedRequestIds: string[] = [];
    const claimTurn = spyOn(coordinator, "claimTurn").mockImplementation(
      (turnId, source, at) => {
        const owner = originalClaimTurn(turnId, source, at);
        if (!turnId.startsWith("live-voice-camera:")) {
          claimedRequestIds.push(turnId);
        }
        return owner;
      },
    );
    const originalReleaseTurn = coordinator.releaseTurn.bind(coordinator);
    const releasedRequestIds: string[] = [];
    let injectedFailure = false;
    const releaseTurn = spyOn(coordinator, "releaseTurn").mockImplementation(
      (turnId) => {
        const released = originalReleaseTurn(turnId);
        if (!turnId.startsWith("live-voice-camera:")) {
          releasedRequestIds.push(turnId);
          if (!injectedFailure) {
            injectedFailure = true;
            throw new Error("session tracking unavailable");
          }
        }
        return released;
      },
    );
    try {
      await harness.session.start();
      await harness.session.handleClientFrame({
        type: "sight_start",
        cameraEpoch: 56,
        source: "live",
      });
      await harness.session.handleClientFrame({
        type: "text",
        text: "Describe this.",
      });
      await waitFor(() => harness.startVoiceTurn.mock.calls.length === 1);
      const options = harness.startVoiceTurn.mock.calls[0]![0];

      options.callbacks?.message_complete?.({
        type: "message_complete",
        conversationId: harness.conversationId,
        messageId: "assistant-message-release-failure",
      });
      await waitFor(() =>
        harness.frames.some((frame) => frame.type === "tts_done"),
      );

      expect(claimedRequestIds).toHaveLength(3);
      expect(releasedRequestIds).toContain(claimedRequestIds[1]!);
      expect(releasedRequestIds).toContain(claimedRequestIds[2]!);
      expect(coordinator.getTurnOwner(claimedRequestIds[1]!)).toBeUndefined();
      expect(coordinator.getTurnOwner(claimedRequestIds[2]!)).toBeUndefined();
    } finally {
      releaseTurn.mockRestore();
      claimTurn.mockRestore();
      await harness.session.close("client_end");
      harness.dispose();
    }
  });

  test("socket loss interrupts a camera run after cancelling its voice hold", async () => {
    const harness = createSessionHarness("Sight socket loss");
    try {
      await harness.session.start();
      await harness.session.handleClientFrame({
        type: "sight_start",
        cameraEpoch: 13,
        source: "ambient",
      });
      await harness.session.handleClientFrame({
        type: "text",
        text: "What is here?",
      });
      await waitFor(() => harness.startVoiceTurn.mock.calls.length > 0);
      const sessionId =
        harness.startVoiceTurn.mock.calls[0]![0].preacceptedModeSession!.source
          .id;

      await harness.session.close("websocket_close");

      await waitFor(
        () =>
          getConversationModeSession(harness.conversationId, sessionId)
            ?.status === "interrupted",
        { message: "Timed out waiting for interrupted camera session" },
      );
      expect(
        getConversationModeSession(harness.conversationId, sessionId)
          ?.endReason,
      ).toBe("camera_websocket_close");
    } finally {
      harness.dispose();
    }
  });

  test("releases a reserved voice owner when close rejects deferred admission", async () => {
    const startVoiceTurn: LiveVoiceTurnStarter = async (options) => {
      await new Promise<void>((_resolve, reject) => {
        const rejectAdmission = () => reject(new Error("admission cancelled"));
        if (options.signal?.aborted) {
          rejectAdmission();
          return;
        }
        options.signal?.addEventListener("abort", rejectAdmission, {
          once: true,
        });
      });
      return { turnId: "unreachable", abort: mock() };
    };
    const harness = createSessionHarness("Sight deferred admission close", {
      startVoiceTurn,
    });
    try {
      await harness.session.start();
      await harness.session.handleClientFrame({
        type: "sight_start",
        cameraEpoch: 14,
        source: "live",
      });
      const speaking = harness.session.handleClientFrame({
        type: "text",
        text: "What is here?",
      });
      await waitFor(() => harness.startVoiceTurn.mock.calls.length === 1);
      const accepted =
        harness.startVoiceTurn.mock.calls[0]![0].preacceptedModeSession!;

      await harness.session.close("websocket_close");
      await speaking;

      await waitFor(
        () =>
          getConversationModeSession(harness.conversationId, accepted.source.id)
            ?.status === "interrupted",
      );
      expect(
        harness.activeConversation.modeSessions.getTurnOwner(
          accepted.requestId,
        ),
      ).toBeUndefined();
    } finally {
      harness.dispose();
    }
  });

  test("stamps negotiated keeps and finalizes the run on sight_end", async () => {
    const harness = createSessionHarness("Sight session lifecycle");
    try {
      await harness.session.start();
      await harness.session.handleClientFrame({
        type: "sight_start",
        cameraEpoch: 1,
        source: "live",
      });
      const attachmentId = await uploadFrame();
      await harness.session.handleClientFrame({
        type: "sight_frame",
        attachmentId,
        cameraEpoch: 1,
        source: "live",
      });
      await waitFor(() => getMessages(harness.conversationId).length > 0, {
        message: "Timed out waiting for grouped camera frame",
      });

      const row = getMessages(harness.conversationId)[0]!;
      const metadata = JSON.parse(row.metadata ?? "{}") as {
        modeSession?: { id: string; mode: string };
      };
      expect(metadata.modeSession?.mode).toBe("live_vision");
      await harness.session.handleClientFrame({
        type: "sight_end",
        cameraEpoch: 1,
      });

      await waitFor(
        () =>
          getConversationModeSession(
            harness.conversationId,
            metadata.modeSession!.id,
          )?.status === "completed",
        { message: "Timed out waiting for camera session finalization" },
      );
    } finally {
      harness.dispose();
    }
  });

  test("saves an admitted frame after stop while rejecting a frame delivered after stop", async () => {
    const harness = createSessionHarness("Sight admitted frame drain", {
      acquireResidency: true,
    });
    const processing = harness.activeConversation.acquireProcessing();
    expect(processing).not.toBeNull();
    try {
      await harness.session.start();
      await harness.session.handleClientFrame({
        type: "sight_start",
        cameraEpoch: 61,
        source: "live",
      });
      const accepted = await uploadFrame();
      await harness.session.handleClientFrame({
        type: "sight_frame",
        attachmentId: accepted,
        cameraEpoch: 61,
        source: "live",
      });
      await harness.session.handleClientFrame({
        type: "sight_end",
        cameraEpoch: 61,
      });
      const late = await uploadFrame();
      await harness.session.handleClientFrame({
        type: "sight_frame",
        attachmentId: late,
        cameraEpoch: 61,
        source: "live",
      });
      expect(attachmentExists(late)).toBe(false);
      expect(getMessages(harness.conversationId)).toHaveLength(0);
      expect(harness.activeConversation.modeSessions.hasResidentWork()).toBe(
        true,
      );
      await harness.session.close("client_end");
      expect(harness.activeConversation.hasInFlightWork()).toBe(true);
      harness.activeConversation.releaseProcessing(processing!);
      await waitFor(
        () =>
          getMessages(harness.conversationId).length === 1 &&
          !harness.activeConversation.hasInFlightWork(),
      );
      const row = getMessages(harness.conversationId)[0]!;
      const stamp = JSON.parse(row.metadata ?? "{}").modeSession;
      expect(
        getConversationModeSession(harness.conversationId, stamp.id)?.status,
      ).toBe("completed");
      expect(getAttachmentsForMessage(row.id)).toHaveLength(1);
      expect(attachmentExists(accepted)).toBe(true);
      expect(
        harness.frames.filter((frame) => frame.type === "error"),
      ).toMatchObject([{ frameType: "sight_frame", attachmentId: late }]);
    } finally {
      harness.activeConversation.releaseProcessing(processing!);
      await harness.session.close("client_end");
      harness.dispose();
    }
  });

  test.each([false, true])(
    "persists an accepted camera frame when its claim throws (partial: %s)",
    async (partial) => {
      const harness = createSessionHarness("Sight frame ownership failure");
      const coordinator = harness.activeConversation.modeSessions;
      const originalClaimTurn = coordinator.claimTurn.bind(coordinator);
      let failedSessionId: string | undefined;
      const claimTurn = spyOn(coordinator, "claimTurn").mockImplementation(
        (turnId, source, at) => {
          if (!turnId.startsWith("live-voice-camera:")) {
            if (partial) {
              originalClaimTurn(turnId, source, at);
            }
            throw new Error("session tracking unavailable");
          }
          const owner = originalClaimTurn(turnId, source, at);
          failedSessionId = owner?.id;
          return owner;
        },
      );
      try {
        await harness.session.start();
        await harness.session.handleClientFrame({
          type: "sight_start",
          cameraEpoch: 52,
          source: "ambient",
        });
        const attachmentId = await uploadFrame();
        const keeping = harness.session.handleClientFrame({
          type: "sight_frame",
          attachmentId,
          cameraEpoch: 52,
          source: "ambient",
        });
        const ending = harness.session.handleClientFrame({
          type: "sight_end",
          cameraEpoch: 52,
        });
        await Promise.all([keeping, ending]);

        await waitFor(
          () =>
            failedSessionId !== undefined &&
            getConversationModeSession(harness.conversationId, failedSessionId)
              ?.status === "completed" &&
            getMessages(harness.conversationId).length === 1 &&
            !coordinator.hasResidentWork(),
          { message: "Timed out waiting for the accepted frame to settle" },
        );
        expect(attachmentExists(attachmentId)).toBe(true);
        const row = getMessages(harness.conversationId)[0]!;
        expect(getAttachmentsForMessage(row.id)).toHaveLength(1);
        expect(
          harness.frames.filter((frame) => frame.type === "error"),
        ).toHaveLength(0);
      } finally {
        claimTurn.mockRestore();
        await harness.session.close("client_end");
        harness.dispose();
      }
    },
  );

  test("releases acquired residency after a refused camera start and accepts ordinary frames", async () => {
    const harness = createSessionHarness("Sight start tracking failure", {
      acquireResidency: true,
    });
    const claim = spyOn(
      harness.activeConversation.modeSessions,
      "claimTurn",
    ).mockImplementation(() => {
      throw new Error("tracking unavailable");
    });
    try {
      await harness.session.start();
      await harness.session.handleClientFrame({
        type: "sight_start",
        cameraEpoch: 1,
        source: "live",
      });
      expect(
        harness.frames.find((frame) => frame.type === "error"),
      ).toMatchObject({ frameType: "sight_start" });
      expect(harness.activeConversation.modeSessions.hasResidentWork()).toBe(
        false,
      );
      expect(harness.activeConversation.hasInFlightWork()).toBe(false);
      const attachmentId = await uploadFrame();
      await harness.session.handleClientFrame({
        type: "sight_frame",
        attachmentId,
      });
      await waitFor(() => getMessages(harness.conversationId).length === 1);
      expect(
        JSON.parse(getMessages(harness.conversationId)[0]!.metadata ?? "{}")
          .modeSession,
      ).toBeUndefined();
      expect(attachmentExists(attachmentId)).toBe(true);
    } finally {
      claim.mockRestore();
      await harness.session.close("client_end");
      harness.dispose();
    }
  });

  test("keeps a persisted frame successful when bookkeeping and ownership release throw", async () => {
    const harness = createSessionHarness("Sight frame release failure");
    const coordinator = harness.activeConversation.modeSessions;
    const originalReleaseTurn = coordinator.releaseTurn.bind(coordinator);
    const releaseTurn = spyOn(coordinator, "releaseTurn").mockImplementation(
      (turnId) => {
        originalReleaseTurn(turnId);
        if (!turnId.startsWith("live-voice-camera:")) {
          throw new Error("session tracking unavailable");
        }
      },
    );
    const originalTrackRow = coordinator.trackPersistedRow.bind(coordinator);
    const trackPersistedRow = spyOn(
      coordinator,
      "trackPersistedRow",
    ).mockImplementation((turnId, messageId, at, options) => {
      originalTrackRow(turnId, messageId, at, options);
      if (turnId.startsWith("live-voice-camera:")) {
        throw new Error("tracking unavailable after persistence");
      }
    });
    try {
      await harness.session.start();
      await harness.session.handleClientFrame({
        type: "sight_start",
        cameraEpoch: 53,
        source: "live",
      });
      const attachmentId = await uploadFrame();
      const before = harness.frames.length;
      await harness.session.handleClientFrame({
        type: "sight_frame",
        attachmentId,
        cameraEpoch: 53,
        source: "live",
      });
      await waitFor(() => getMessages(harness.conversationId).length === 1);
      const row = getMessages(harness.conversationId)[0]!;

      await harness.session.handleClientFrame({
        type: "sight_end",
        cameraEpoch: 53,
      });
      const metadata = JSON.parse(row.metadata ?? "{}") as {
        modeSession?: { id: string };
      };
      await waitFor(
        () =>
          getConversationModeSession(
            harness.conversationId,
            metadata.modeSession!.id,
          )?.status === "completed",
      );

      expect(attachmentExists(attachmentId)).toBe(true);
      expect(getAttachmentsForMessage(row.id)).toHaveLength(1);
      expect(
        trackPersistedRow.mock.calls.some(
          ([turnId, messageId]) =>
            turnId.startsWith("live-voice-camera:") && messageId === row.id,
        ),
      ).toBe(true);
      expect(
        harness.frames.slice(before).filter((frame) => frame.type === "error"),
      ).toHaveLength(0);
    } finally {
      trackPersistedRow.mockRestore();
      releaseTurn.mockRestore();
      await harness.session.close("client_end");
      harness.dispose();
    }
  });

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
