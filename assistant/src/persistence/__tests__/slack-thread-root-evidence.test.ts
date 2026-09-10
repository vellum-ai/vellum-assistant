import { beforeAll, describe, expect, test } from "bun:test";

import { addMessage } from "../conversation-crud.js";
import { getOrCreateConversation } from "../conversation-key-store.js";
import { initializeDb } from "../db-init.js";
import {
  buildScopedConversationKey,
  recordOutboundPost,
  resolveInboundConversation,
} from "../delivery-crud.js";

// A Slack thread may continue the conversation that lives on the flat
// channel key. The evidence for that includes the thread's root being a
// post the assistant made from that conversation, resolved through the
// outbound-post index the post-send reconciliation writes, so a reply under
// the assistant's own top-level post lands where the post is recorded.

beforeAll(async () => {
  await initializeDb();
});

/** Record a delivered post the way the post-send reconciliation does. */
async function recordFlatPost(
  chatId: string,
  providerMessageIds: readonly string[],
): Promise<{ conversationId: string }> {
  const flat = getOrCreateConversation(
    buildScopedConversationKey("slack", chatId),
  );
  const [firstId] = providerMessageIds;
  const row = await addMessage(flat.conversationId, "assistant", "posted", {
    skipIndexing: true,
    metadata: {
      providerMeta: JSON.stringify({
        source: "slack",
        conversationExternalId: chatId,
        messageId: firstId,
        eventKind: "message",
      }),
    },
  });
  for (const providerMessageId of providerMessageIds) {
    recordOutboundPost({
      sourceChannel: "slack",
      externalChatId: chatId,
      providerMessageId,
      messageId: row.id,
      conversationId: flat.conversationId,
    });
  }
  return flat;
}

describe("slack thread evidence", () => {
  test("a thread rooted at the assistant's own flat post continues the flat conversation", async () => {
    const flat = await recordFlatPost("C0ROOTED", ["1700000000.000900"]);
    const reply = resolveInboundConversation(
      "slack",
      "C0ROOTED",
      "1700000000.000900",
    );
    expect(reply.conversationId).toBe(flat.conversationId);
  });

  test("a thread rooted at a later chunk of a split post continues it too", async () => {
    const flat = await recordFlatPost("C0SPLIT", [
      "1700000000.000910",
      "1700000000.000911",
    ]);
    const reply = resolveInboundConversation(
      "slack",
      "C0SPLIT",
      "1700000000.000911",
    );
    expect(reply.conversationId).toBe(flat.conversationId);
  });

  test("a post recorded for another chat is not evidence for this one", async () => {
    await recordFlatPost("C0SOMEWHEREELSE", ["1700000000.000902"]);
    const flat = getOrCreateConversation(
      buildScopedConversationKey("slack", "C0OTHERCHAT"),
    );
    const reply = resolveInboundConversation(
      "slack",
      "C0OTHERCHAT",
      "1700000000.000902",
    );
    expect(reply.conversationId).not.toBe(flat.conversationId);
  });

  test("a thread with no evidence in the flat conversation is its own conversation", async () => {
    const flat = getOrCreateConversation(
      buildScopedConversationKey("slack", "C0UNRELATED"),
    );
    const reply = resolveInboundConversation(
      "slack",
      "C0UNRELATED",
      "1700000000.000901",
    );
    expect(reply.conversationId).not.toBe(flat.conversationId);
  });
});
