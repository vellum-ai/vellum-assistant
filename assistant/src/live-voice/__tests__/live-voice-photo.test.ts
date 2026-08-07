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
  createConversation,
  getMessages,
} from "../../persistence/conversation-crud.js";
import { initializeDb } from "../../persistence/db-init.js";
import { assistantEventHub } from "../../runtime/assistant-event-hub.js";
import { persistLiveVoicePhoto } from "../live-voice-photo.js";

await initializeDb();

const IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk";

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
});
