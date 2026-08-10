import { beforeEach, describe, expect, test } from "bun:test";

import { eq } from "drizzle-orm";

import { createConversation } from "./conversation-crud.js";
import { getDb } from "./db-connection.js";
import { initializeDb } from "./db-init.js";
import {
  countMessagesByRoleForConversations,
  existingMessageIds,
  latestAssistantMessage,
  latestAssistantMessageBefore,
  latestUserMessageRawContent,
  messageConversationId,
} from "./message-reads.js";
import { messages } from "./schema/index.js";

await initializeDb();

let seq = 0;
function insertRow(opts: {
  conversationId: string;
  role: string;
  createdAt: number;
  content?: string;
  finalized?: 0 | 1;
}): string {
  const id = `msg-${String(++seq).padStart(4, "0")}`;
  getDb()
    .insert(messages)
    .values({
      id,
      conversationId: opts.conversationId,
      role: opts.role,
      content: opts.content ?? JSON.stringify([{ type: "text", text: "hi" }]),
      createdAt: opts.createdAt,
      metadata: null,
      finalized: opts.finalized ?? 1,
    })
    .run();
  return id;
}

function seedConversation(): string {
  return createConversation("Message reads test").id;
}

describe("message-reads", () => {
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM messages");
    db.run("DELETE FROM conversations");
  });

  test("latestAssistantMessage returns the newest finalized assistant row", () => {
    const conv = seedConversation();
    insertRow({ conversationId: conv, role: "user", createdAt: 1_000 });
    const older = insertRow({
      conversationId: conv,
      role: "assistant",
      createdAt: 2_000,
    });
    const newer = insertRow({
      conversationId: conv,
      role: "assistant",
      createdAt: 3_000,
    });

    expect(latestAssistantMessage(conv)?.id).toBe(newer);
    expect(latestAssistantMessage(conv)?.id).not.toBe(older);
    expect(latestAssistantMessage("missing-conv")).toBeNull();
  });

  test("latestAssistantMessage never anchors on a streaming row", () => {
    const conv = seedConversation();
    const finalizedReply = insertRow({
      conversationId: conv,
      role: "assistant",
      createdAt: 1_000,
    });
    insertRow({
      conversationId: conv,
      role: "assistant",
      createdAt: 2_000,
      finalized: 0,
    });

    // The streaming row is newest but is not a reply yet; the watermark must
    // sit on the completed one until the turn finishes.
    expect(latestAssistantMessage(conv)?.id).toBe(finalizedReply);
  });

  test("a streaming row qualifies on its own once finalized", () => {
    const conv = seedConversation();
    insertRow({ conversationId: conv, role: "assistant", createdAt: 1_000 });
    const streaming = insertRow({
      conversationId: conv,
      role: "assistant",
      createdAt: 2_000,
      finalized: 0,
    });

    getDb()
      .update(messages)
      .set({ finalized: 1 })
      .where(eq(messages.id, streaming))
      .run();

    expect(latestAssistantMessage(conv)?.id).toBe(streaming);
  });

  test("latestAssistantMessageBefore is strict and skips streaming rows", () => {
    const conv = seedConversation();
    const first = insertRow({
      conversationId: conv,
      role: "assistant",
      createdAt: 1_000,
    });
    insertRow({
      conversationId: conv,
      role: "assistant",
      createdAt: 2_000,
      finalized: 0,
    });
    insertRow({ conversationId: conv, role: "assistant", createdAt: 3_000 });

    // Strictly before 3000: the streaming row at 2000 is passed over in
    // favour of the completed row at 1000.
    expect(latestAssistantMessageBefore(conv, 3_000)?.id).toBe(first);
    // Strictly before 1000: nothing.
    expect(latestAssistantMessageBefore(conv, 1_000)).toBeNull();
  });

  test("latestUserMessageRawContent resolves same-timestamp rows by insertion order", () => {
    const conv = seedConversation();
    insertRow({
      conversationId: conv,
      role: "user",
      createdAt: 1_000,
      content: "first",
    });
    insertRow({
      conversationId: conv,
      role: "user",
      createdAt: 1_000,
      content: "second",
    });
    insertRow({ conversationId: conv, role: "assistant", createdAt: 2_000 });

    expect(latestUserMessageRawContent(conv)).toBe("second");
    expect(latestUserMessageRawContent("missing-conv")).toBeNull();
  });

  test("countMessagesByRoleForConversations aggregates per conversation", () => {
    const convA = seedConversation();
    const convB = seedConversation();
    insertRow({ conversationId: convA, role: "assistant", createdAt: 1_000 });
    insertRow({ conversationId: convA, role: "assistant", createdAt: 2_000 });
    insertRow({ conversationId: convA, role: "user", createdAt: 3_000 });
    insertRow({ conversationId: convB, role: "assistant", createdAt: 4_000 });

    const stats = countMessagesByRoleForConversations(
      [convA, convB],
      "assistant",
    );
    expect(stats.get(convA)).toEqual({ count: 2, lastAt: 2_000 });
    expect(stats.get(convB)).toEqual({ count: 1, lastAt: 4_000 });
    expect(countMessagesByRoleForConversations([], "assistant").size).toBe(0);
  });

  test("existingMessageIds returns only ids that exist", () => {
    const conv = seedConversation();
    const present = insertRow({
      conversationId: conv,
      role: "user",
      createdAt: 1_000,
    });

    const existing = existingMessageIds([present, "msg-not-there"]);
    expect(existing.has(present)).toBe(true);
    expect(existing.has("msg-not-there")).toBe(false);
    expect(existingMessageIds([]).size).toBe(0);
  });

  test("messageConversationId resolves ownership in any state", () => {
    const conv = seedConversation();
    const streaming = insertRow({
      conversationId: conv,
      role: "assistant",
      createdAt: 1_000,
      finalized: 0,
    });

    expect(messageConversationId(streaming)).toBe(conv);
    expect(messageConversationId("msg-not-there")).toBeNull();
  });
});
