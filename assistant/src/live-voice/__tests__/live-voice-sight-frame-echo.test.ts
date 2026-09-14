import { describe, expect, mock, spyOn, test } from "bun:test";

import {
  createMockProvider,
  textResponse,
} from "../../__tests__/helpers/mock-provider.js";
import { setConfig } from "../../__tests__/helpers/set-config.js";
import { waitFor } from "../../__tests__/helpers/wait-for.js";

setConfig("memory", { enabled: false });

import { UserMessageEchoEventSchema } from "../../api/events/user-message-echo.js";
import type { AssistantEventEnvelope } from "../../api/index.js";
import { Conversation } from "../../daemon/conversation.js";
import * as conversationMessaging from "../../daemon/conversation-messaging.js";
import {
  deleteConversation,
  setConversation,
} from "../../daemon/conversation-registry.js";
import { conversationMessagesSyncTag } from "../../daemon/message-types/sync.js";
import { uploadAttachment } from "../../persistence/attachments-store.js";
import * as conversationCrud from "../../persistence/conversation-crud.js";
import { initializeDb } from "../../persistence/db-init.js";
import { assistantEventHub } from "../../runtime/assistant-event-hub.js";
import {
  _drainFrameReclaimRechecksForTests,
  _pendingFrameReclaimCountForTests,
  persistAmbientSightFrame,
  persistLiveVoicePhoto,
} from "../live-voice-photo.js";
import { LiveVoiceSession } from "../live-voice-session.js";
import { createLiveVoiceServerFrameSequencer } from "../protocol.js";

await initializeDb();

function createHarness() {
  const row = conversationCrud.createConversation("Camera frame echo");
  const { provider } = createMockProvider([textResponse("")]);
  const conversation = new Conversation(
    row.id,
    provider,
    "system prompt",
    () => {},
    "/tmp",
    { maxTokens: 4096 },
  );
  conversation.setTrustContext({
    trustClass: "guardian",
    sourceChannel: "vellum",
  });
  setConversation(row.id, conversation);

  const sequencer = createLiveVoiceServerFrameSequencer();
  const startVoiceTurn = mock(async () => ({
    turnId: "turn-123",
    abort: mock(),
  }));
  const session = new LiveVoiceSession(
    {
      sessionId: "session-123",
      startFrame: {
        type: "start",
        conversationId: row.id,
        audio: { mimeType: "audio/pcm", sampleRate: 24_000, channels: 1 },
      },
      sendFrame: async (payload) => sequencer.next(payload),
    },
    {
      resolveTranscriber: async () => ({
        providerId: "deepgram",
        boundaryId: "daemon-streaming",
        async start() {},
        sendAudio() {},
        stop() {},
      }),
      startVoiceTurn,
      emitMetrics: false,
    },
  );
  const published: {
    event: AssistantEventEnvelope;
    persistedIds: string[];
    persistedSeq: number | null;
  }[] = [];
  const subscription = assistantEventHub.subscribe({
    type: "process",
    filter: { conversationId: row.id },
    callback: (event) => {
      if (
        (event.message.type === "user_message_echo" &&
          event.message.conversationId === row.id) ||
        (event.message.type === "sync_changed" &&
          event.message.tags.includes(conversationMessagesSyncTag(row.id)))
      ) {
        published.push({
          event,
          persistedIds: conversationCrud.getMessages(row.id).map((m) => m.id),
          persistedSeq: conversationCrud.getConversationPersistedSeq(row.id),
        });
      }
    },
  });

  return {
    conversationId: row.id,
    session,
    startVoiceTurn,
    published,
    async dispose() {
      subscription.dispose();
      await session.close("client_end");
      deleteConversation(row.id);
      conversation.dispose();
    },
  };
}

async function uploadFrame(): Promise<string> {
  const attachment = await uploadAttachment(
    "frame.png",
    "image/png",
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk",
  );
  return attachment.id;
}

async function expectAnnouncement(
  harness: ReturnType<typeof createHarness>,
  cameraFrame: boolean,
): Promise<void> {
  await waitFor(() => harness.published.length >= 2);
  expect(harness.published.map(({ event }) => event.message.type)).toEqual([
    "user_message_echo",
    "sync_changed",
  ]);
  const [echo, sync] = harness.published;
  const message = UserMessageEchoEventSchema.parse(echo.event.message);
  const rows = conversationCrud.getMessages(harness.conversationId);
  expect(rows).toHaveLength(1);
  expect(message.messageId).toBe(rows[0].id);
  expect(echo.persistedIds).toEqual([rows[0].id]);
  expect(echo.event.seq).toBeNumber();
  expect(sync.persistedSeq).toBe(echo.event.seq!);
  expect(message.text).toBe(cameraFrame ? "(camera frame)" : "here's a photo:");
  if (cameraFrame) {
    expect(message.cameraFrame).toBe(true);
  } else {
    expect(echo.event.message).not.toHaveProperty("cameraFrame");
  }
  expect(harness.startVoiceTurn).not.toHaveBeenCalled();
}

describe("standalone image echoes", () => {
  test.each(["sight_frame", "attach_image"] as const)(
    "%s emits one committed row before the history invalidation",
    async (type) => {
      const harness = createHarness();
      try {
        await harness.session.start();
        const attachmentId = await uploadFrame();
        await harness.session.handleClientFrame({ type, attachmentId });
        await expectAnnouncement(harness, type === "sight_frame");
      } finally {
        await harness.dispose();
      }
    },
  );

  test.each([
    { kind: "sight_frame", deferred: false },
    { kind: "photo", deferred: false },
    { kind: "sight_frame", deferred: true },
  ] as const)(
    "$kind preserves its echo marker when a committed write throws (deferred: $deferred)",
    async ({ kind, deferred }) => {
      const harness = createHarness();
      const realPersist = conversationMessaging.persistQueuedMessageBody;
      const realGetMessage = conversationCrud.getMessageById;
      let committed = false;
      const persist = spyOn(
        conversationMessaging,
        "persistQueuedMessageBody",
      ).mockImplementation(async (...args) => {
        await realPersist(...args);
        committed = true;
        throw new Error("Post-insert write failed");
      });
      const read = spyOn(conversationCrud, "getMessageById").mockImplementation(
        (...args) => {
          if (deferred && committed) {
            throw new Error("Store temporarily unreadable");
          }
          return realGetMessage(...args);
        },
      );
      try {
        const attachmentId = await uploadFrame();
        const result =
          kind === "sight_frame"
            ? await persistAmbientSightFrame(
                harness.conversationId,
                attachmentId,
                "voice",
              )
            : await persistLiveVoicePhoto(harness.conversationId, attachmentId);
        expect(result.ok).toBe(!deferred);
        if (deferred) {
          expect(harness.published).toHaveLength(0);
          expect(_pendingFrameReclaimCountForTests()).toBe(1);
          _drainFrameReclaimRechecksForTests();
          expect(_pendingFrameReclaimCountForTests()).toBe(1);
          read.mockRestore();
          _drainFrameReclaimRechecksForTests();
          _drainFrameReclaimRechecksForTests();
          expect(_pendingFrameReclaimCountForTests()).toBe(0);
        }
        await expectAnnouncement(harness, kind === "sight_frame");
      } finally {
        persist.mockRestore();
        read.mockRestore();
        _drainFrameReclaimRechecksForTests();
        await harness.dispose();
      }
    },
  );

  test("the strict echo schema accepts only a true camera marker", () => {
    const echo = { type: "user_message_echo", text: "(camera frame)" };
    expect(
      UserMessageEchoEventSchema.safeParse({ ...echo, cameraFrame: false })
        .success,
    ).toBe(false);
    expect(
      UserMessageEchoEventSchema.safeParse({ ...echo, unexpected: true })
        .success,
    ).toBe(false);
  });
});
