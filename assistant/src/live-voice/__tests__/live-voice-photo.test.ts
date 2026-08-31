import { describe, expect, test } from "bun:test";

import {
  createMockProvider,
  textResponse,
} from "../../__tests__/helpers/mock-provider.js";
import { setConfig } from "../../__tests__/helpers/set-config.js";
import { waitFor } from "../../__tests__/helpers/wait-for.js";

setConfig("memory", { enabled: false });

import type { AssistantEvent } from "../../api/index.js";
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
  addMessage,
  createConversation,
  getMessages,
  selectSightFrameCaptureTimes,
} from "../../persistence/conversation-crud.js";
import { initializeDb } from "../../persistence/db-init.js";
import { assistantEventHub } from "../../runtime/assistant-event-hub.js";
import {
  persistLiveVoicePhoto,
  persistLiveVoiceSightFrame,
} from "../live-voice-photo.js";

await initializeDb();

const IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk";

/** A registered conversation the persist paths can reach, plus its teardown. */
function liveConversation(title: string) {
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
  return {
    id: conversation.id,
    activeConversation,
    dispose: () => {
      deleteConversation(conversation.id);
      activeConversation.dispose();
    },
  };
}

describe("persistLiveVoicePhoto", () => {
  test("persists and echoes the image with human-readable context", async () => {
    const conversation = createConversation("Live voice photo");
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
    const attachment = await uploadAttachment(
      "photo.png",
      "image/png",
      IMAGE_BASE64,
    );
    const published: AssistantEvent[] = [];
    const subscription = assistantEventHub.subscribe({
      type: "process",
      filter: { conversationId: conversation.id },
      callback: (event) => {
        published.push(event.message);
      },
    });

    try {
      const result = await persistLiveVoicePhoto(
        conversation.id,
        attachment.id,
      );
      expect(result.ok).toBe(true);

      await waitFor(
        () => published.some((event) => event.type === "user_message_echo"),
        { message: "Timed out waiting for live-voice photo echo" },
      );

      const [message] = getMessages(conversation.id);
      if (!message) {
        throw new Error("Live-voice photo message was not persisted");
      }
      expect(message.content.filter((block) => block.type === "text")).toEqual([
        { type: "text", text: "here's a photo:" },
      ]);
      expect(getAttachmentsForMessage(message.id)).toHaveLength(1);
      expect(
        published.find((event) => event.type === "user_message_echo"),
      ).toMatchObject({
        type: "user_message_echo",
        text: "here's a photo:",
        conversationId: conversation.id,
        messageId: message.id,
      });
    } finally {
      subscription.dispose();
      deleteConversation(conversation.id);
      activeConversation.dispose();
    }
  });

  test("leaves the photo untagged, so retention never ages it out", async () => {
    // A photo the user chose to take is not an ambient frame; the sight tag
    // would hand it to the pass that stubs frames out of the context.
    const live = liveConversation("Live voice photo untagged");
    try {
      const attachment = await uploadAttachment(
        "photo.png",
        "image/png",
        IMAGE_BASE64,
      );

      const result = await persistLiveVoicePhoto(live.id, attachment.id);
      expect(result.ok).toBe(true);

      expect(selectSightFrameCaptureTimes(live.id).size).toBe(0);
    } finally {
      live.dispose();
    }
  });
});

describe("persistLiveVoiceSightFrame", () => {
  test("tags the row with the attachment it carries", async () => {
    const live = liveConversation("Live voice sight frame");
    try {
      const attachment = await uploadAttachment(
        "frame.png",
        "image/png",
        IMAGE_BASE64,
      );

      const result = await persistLiveVoiceSightFrame(live.id, attachment.id);
      expect(result.ok).toBe(true);

      const [message] = getMessages(live.id);
      expect(message.content.filter((block) => block.type === "text")).toEqual([
        { type: "text", text: "(camera frame)" },
      ]);
      expect(getAttachmentsForMessage(message.id)).toHaveLength(1);
      // Readable by the retention pass, which is the whole point of the tag.
      expect([...selectSightFrameCaptureTimes(live.id).keys()]).toEqual([
        attachment.id,
      ]);
    } finally {
      live.dispose();
    }
  });

  test("reports a frame whose attachment does not resolve", async () => {
    const live = liveConversation("Live voice sight frame missing");
    try {
      expect(await persistLiveVoiceSightFrame(live.id, "att-missing")).toEqual({
        ok: false,
      });
      expect(getMessages(live.id)).toHaveLength(0);
    } finally {
      live.dispose();
    }
  });

  test("waits out an in-flight turn instead of splitting its rows", async () => {
    // A keep landing mid-reply must neither interrupt the reply nor land
    // between the rows the reply persists. The processing lock is what orders
    // them: the keep takes it only once the turn has let go.
    const live = liveConversation("Live voice sight frame interleave");
    try {
      const attachment = await uploadAttachment(
        "frame.png",
        "image/png",
        IMAGE_BASE64,
      );

      live.activeConversation.setProcessing(true);
      const pending = persistLiveVoiceSightFrame(live.id, attachment.id);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(getMessages(live.id)).toHaveLength(0);

      // The turn's own persist, while it still holds the lock.
      await addMessage(live.id, "assistant", "still looking");
      live.activeConversation.setProcessing(false);
      expect(await pending).toMatchObject({ ok: true });

      const rows = getMessages(live.id);
      expect(rows.map((row) => row.role)).toEqual(["assistant", "user"]);
    } finally {
      live.dispose();
    }
  });
});
