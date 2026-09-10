import { beforeAll, describe, expect, test } from "bun:test";

import { addMessage } from "../conversation-crud.js";
import { getOrCreateConversation } from "../conversation-key-store.js";
import { initializeDb } from "../db-init.js";
import {
  buildScopedConversationKey,
  resolveInboundConversation,
} from "../delivery-crud.js";

// A Slack thread may continue the conversation that lives on the flat
// channel key. The evidence for that includes the thread's root being a
// post the assistant made from that conversation, so a reply under the
// assistant's own top-level post lands where the post is recorded.

beforeAll(async () => {
  await initializeDb();
});

describe("slack thread evidence", () => {
  test("a thread rooted at the assistant's own flat post continues the flat conversation", async () => {
    const flat = getOrCreateConversation(
      buildScopedConversationKey("slack", "C0ROOTED"),
    );
    await addMessage(flat.conversationId, "assistant", "posted from a run", {
      skipIndexing: true,
      metadata: {
        providerMeta: JSON.stringify({
          source: "slack",
          conversationExternalId: "C0ROOTED",
          messageId: "1700000000.000900",
          eventKind: "message",
        }),
      },
    });

    const reply = resolveInboundConversation(
      "slack",
      "C0ROOTED",
      "1700000000.000900",
    );
    expect(reply.conversationId).toBe(flat.conversationId);
  });

  test("a post recorded in another chat is not evidence for this one", async () => {
    const flat = getOrCreateConversation(
      buildScopedConversationKey("slack", "C0OTHERCHAT"),
    );
    await addMessage(flat.conversationId, "assistant", "posted elsewhere", {
      skipIndexing: true,
      metadata: {
        providerMeta: JSON.stringify({
          source: "slack",
          conversationExternalId: "C0SOMEWHEREELSE",
          messageId: "1700000000.000902",
          eventKind: "message",
        }),
      },
    });
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
