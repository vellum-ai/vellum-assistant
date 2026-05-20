/**
 * Tests for handleListMessages metadata.hidden filtering.
 *
 * Messages persisted with `metadata: { hidden: true }` (e.g. internal
 * scaffolding like retrospective instructions) must be omitted from the
 * UI history list while remaining visible to the LLM-side history loader.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    model: "test",
    provider: "test",
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0 },
  }),
}));

import {
  addMessage,
  createConversation,
  getMessages,
} from "../memory/conversation-crud.js";
import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { handleListMessages } from "../runtime/routes/conversation-routes.js";

initializeDb();

function resetTables() {
  const db = getDb();
  db.run("DELETE FROM message_attachments");
  db.run("DELETE FROM attachments");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

interface MessagePayload {
  role: string;
  content: string;
}

describe("handleListMessages metadata.hidden filtering", () => {
  beforeEach(resetTables);

  test("UI serializer omits hidden messages but LLM-side getMessages includes them", async () => {
    const conv = createConversation();
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([{ type: "text", text: "first visible" }]),
    );
    await addMessage(
      conv.id,
      "assistant",
      JSON.stringify([{ type: "text", text: "internal scaffolding" }]),
      { hidden: true },
    );
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([{ type: "text", text: "second visible" }]),
    );

    const response = handleListMessages({
      queryParams: { conversationId: conv.id },
    });
    const body = response as { messages: MessagePayload[] };

    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].content).toBe("first visible");
    expect(body.messages[1].content).toBe("second visible");
    expect(
      body.messages.some((m) => m.content.includes("internal scaffolding")),
    ).toBe(false);

    // LLM-side loader must include the hidden row so agent context is intact.
    const llmRows = getMessages(conv.id);
    expect(llmRows).toHaveLength(3);
    expect(llmRows[1].metadata).toContain('"hidden":true');
  });

  test("messages without metadata or with hidden=false are returned", async () => {
    const conv = createConversation();
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([{ type: "text", text: "no metadata" }]),
    );
    await addMessage(
      conv.id,
      "assistant",
      JSON.stringify([{ type: "text", text: "hidden false" }]),
      { hidden: false },
    );

    const response = handleListMessages({
      queryParams: { conversationId: conv.id },
    });
    const body = response as { messages: MessagePayload[] };

    expect(body.messages).toHaveLength(2);
  });
});
