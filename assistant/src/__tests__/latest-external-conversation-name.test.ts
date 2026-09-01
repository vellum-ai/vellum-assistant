import { describe, expect, test } from "bun:test";

import {
  addMessage,
  createConversation,
} from "../persistence/conversation-crud.js";
import { initializeDb } from "../persistence/db-init.js";
import { getLatestExternalConversationName } from "../persistence/delivery-crud.js";

await initializeDb();

function slackMetaFor(channelName?: string): Record<string, unknown> {
  return {
    slackMeta: JSON.stringify({
      source: "slack",
      channelId: "C0123CHANNEL",
      channelTs: `170000000${Math.floor(Math.random() * 10)}.000100`,
      eventKind: "message",
      ...(channelName ? { channelName } : {}),
    }),
  };
}

describe("getLatestExternalConversationName", () => {
  test("returns the newest row's captured channel name", async () => {
    const conversation = await createConversation({ title: "t" });
    await addMessage(conversation.id, "user", "hello", {
      metadata: slackMetaFor("old-name"),
    });
    await addMessage(conversation.id, "user", "hello again", {
      metadata: slackMetaFor("user-feedback"),
    });

    expect(getLatestExternalConversationName(conversation.id, "slack")).toBe(
      "user-feedback",
    );
  });

  test("skips rows without a name and other channels", async () => {
    const conversation = await createConversation({ title: "t" });
    await addMessage(conversation.id, "user", "unnamed", {
      metadata: slackMetaFor(),
    });

    expect(
      getLatestExternalConversationName(conversation.id, "slack"),
    ).toBeNull();
    expect(
      getLatestExternalConversationName(conversation.id, "telegram"),
    ).toBeNull();
  });

  test("never lends a name from a different external chat", async () => {
    const conversation = await createConversation({ title: "t" });
    await addMessage(conversation.id, "user", "hello", {
      metadata: slackMetaFor("user-feedback"),
    });

    expect(
      getLatestExternalConversationName(
        conversation.id,
        "slack",
        "C0123CHANNEL",
      ),
    ).toBe("user-feedback");
    expect(
      getLatestExternalConversationName(conversation.id, "slack", "C0OTHER"),
    ).toBeNull();
  });
});
