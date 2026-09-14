import { beforeEach, describe, expect, test } from "bun:test";

import { setConfig } from "./helpers/set-config.js";

setConfig("memory", { enabled: false });

import {
  type ConversationMessage,
  ConversationMessageSchema,
} from "../api/responses/conversation-message.js";
import {
  addMessage,
  createConversation,
} from "../persistence/conversation-crud.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { handleListMessages } from "../runtime/routes/conversation-routes.js";

await initializeDb();

describe("handleListMessages camera-frame projection", () => {
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM message_attachments");
    db.run("DELETE FROM attachments");
    db.run("DELETE FROM messages");
    db.run("DELETE FROM conversations");
  });

  test.each([
    {
      name: "an ambient keep",
      metadata: { scripted: true, sightFrameAttachmentIds: ["att-keep"] },
      cameraFrame: true,
    },
    {
      name: "a spoken turn carrying a parked frame",
      metadata: {
        sightFrameAttachmentIds: ["att-parked"],
        voiceSessionTurn: true,
      },
      cameraFrame: false,
    },
    {
      name: "a shutter photo",
      metadata: { livePhoto: true, voiceSessionTurn: true, scripted: false },
      cameraFrame: false,
    },
    {
      name: "a plain user row with literal camera-frame text",
      metadata: undefined,
      cameraFrame: false,
    },
    {
      name: "a scripted row with no frame tag",
      metadata: { scripted: true },
      cameraFrame: false,
    },
    {
      name: "a scripted row with an empty frame tag",
      metadata: { scripted: true, sightFrameAttachmentIds: [] },
      cameraFrame: false,
    },
    {
      name: "a scripted row with invalid frame ids",
      metadata: { scripted: true, sightFrameAttachmentIds: [""] },
      cameraFrame: false,
    },
  ])("classifies $name from metadata", async ({ metadata, cameraFrame }) => {
    const conv = createConversation();
    const row = await addMessage(
      conv.id,
      "user",
      JSON.stringify([{ type: "text", text: "(camera frame)" }]),
      { metadata },
    );

    const response = (await handleListMessages({
      queryParams: { conversationId: conv.id },
    })) as { messages: ConversationMessage[] };

    expect(response.messages).toHaveLength(1);
    const projected = response.messages[0]!;
    expect(projected.id).toBe(row.id);
    expect(() => ConversationMessageSchema.parse(projected)).not.toThrow();
    if (cameraFrame) {
      expect(projected.cameraFrame).toBe(true);
    } else {
      expect(projected).not.toHaveProperty("cameraFrame");
    }
    expect(
      ConversationMessageSchema.safeParse({ ...projected, cameraFrame: false })
        .success,
    ).toBe(false);
  });

  test.each(["not-json", "null", "", "{}"])(
    "omits cameraFrame for unreadable or empty metadata %j",
    async (metadata) => {
      const conv = createConversation();
      const row = await addMessage(
        conv.id,
        "user",
        JSON.stringify([{ type: "text", text: "(camera frame)" }]),
      );
      getDb()
        .$client.prepare("UPDATE messages SET metadata = ? WHERE id = ?")
        .run(metadata, row.id);

      const response = (await handleListMessages({
        queryParams: { conversationId: conv.id },
      })) as { messages: ConversationMessage[] };

      expect(response.messages).toHaveLength(1);
      const projected = response.messages[0]!;
      expect(projected.id).toBe(row.id);
      expect(projected).not.toHaveProperty("cameraFrame");
      expect(() => ConversationMessageSchema.parse(projected)).not.toThrow();
    },
  );
});
