import { describe, expect, test } from "bun:test";

import { createConversation } from "../persistence/conversation-crud.js";
import { initializeDb } from "../persistence/db-init.js";
import {
  getBindingByConversation,
  upsertBinding,
} from "../persistence/external-conversation-store.js";

await initializeDb();

async function boundConversation(): Promise<string> {
  const conversation = await createConversation({ title: "t" });
  upsertBinding({
    conversationId: conversation.id,
    sourceChannel: "slack",
    externalChatId: "C0123CHANNEL",
    externalChatName: "user-feedback",
  });
  return conversation.id;
}

describe("upsertBinding chat-name preservation", () => {
  test("a nameless upsert for the same chat keeps the stored name", async () => {
    const conversationId = await boundConversation();
    upsertBinding({
      conversationId,
      sourceChannel: "slack",
      externalChatId: "C0123CHANNEL",
    });
    expect(getBindingByConversation(conversationId)?.externalChatName).toBe(
      "user-feedback",
    );
  });

  test("a move to a nameless chat clears the stored name", async () => {
    const conversationId = await boundConversation();
    upsertBinding({
      conversationId,
      sourceChannel: "slack",
      externalChatId: "D0MOVEDHERE",
    });
    const binding = getBindingByConversation(conversationId);
    expect(binding?.externalChatId).toBe("D0MOVEDHERE");
    expect(binding?.externalChatName ?? null).toBeNull();
  });

  test("a move that reports a name takes the new name", async () => {
    const conversationId = await boundConversation();
    upsertBinding({
      conversationId,
      sourceChannel: "slack",
      externalChatId: "C0ELSEWHERE",
      externalChatName: "new-home",
    });
    expect(getBindingByConversation(conversationId)?.externalChatName).toBe(
      "new-home",
    );
  });
});
