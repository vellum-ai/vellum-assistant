/**
 * `vellum conversations export` writes a transcript a person reads, so it
 * projects each row the way the transcript does: a row a `send_user_message`
 * turn marked private contributes the delivered message, never the model's
 * working notes. Unmarked rows are untouched.
 */

import { describe, expect, mock, test } from "bun:test";

const CONVERSATION = {
  id: "conv-export",
  title: "Export me",
  createdAt: 1,
  updatedAt: 2,
};

const messages = [
  {
    id: "m1",
    role: "user",
    content: [{ type: "text", text: "what is on my calendar?" }],
    metadata: null,
    createdAt: 1,
  },
  {
    id: "m2",
    role: "assistant",
    content: [
      { type: "text", text: "zzscratchpad reasoning nobody saw" },
      {
        type: "tool_use",
        id: "tu_1",
        name: "send_user_message",
        input: { message: "You have two meetings today." },
      },
    ],
    metadata: JSON.stringify({ assistantTextVisibility: "private" }),
    createdAt: 2,
  },
  {
    id: "m3",
    role: "assistant",
    content: [{ type: "text", text: "an ordinary unmarked reply" }],
    metadata: null,
    createdAt: 3,
  },
];

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realCrud = require("../../../persistence/conversation-crud.js");
mock.module("../../../persistence/conversation-crud.js", () => ({
  ...realCrud,
  isConversationProcessing: () => false,
  getConversation: () => CONVERSATION,
  getMessages: () => messages,
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realQueries = require("../../../persistence/conversation-queries.js");
mock.module("../../../persistence/conversation-queries.js", () => ({
  ...realQueries,
  listConversations: () => [CONVERSATION],
}));

const { ROUTES } = await import("../conversation-cli-routes.js");

function exportHandler() {
  const route = ROUTES.find((r) => r.endpoint === "conversations/cli/export");
  if (!route) {
    throw new Error("export route not registered");
  }
  return route.handler;
}

describe("conversation export visibility", () => {
  test("markdown export carries the delivered message, not the scratchpad", async () => {
    const result = (await exportHandler()({
      body: { conversationId: CONVERSATION.id, format: "md" },
    })) as { output: string };

    expect(result.output).toContain("You have two meetings today.");
    expect(result.output).not.toContain("zzscratchpad");
    // Untouched rows still export exactly as before.
    expect(result.output).toContain("an ordinary unmarked reply");
    expect(result.output).toContain("what is on my calendar?");
  });

  test("json export carries the same projection", async () => {
    const result = (await exportHandler()({
      body: { conversationId: CONVERSATION.id, format: "json" },
    })) as { output: string };

    expect(result.output).toContain("You have two meetings today.");
    expect(result.output).not.toContain("zzscratchpad");
  });
});
