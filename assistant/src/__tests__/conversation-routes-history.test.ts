import { describe, expect, mock, test } from "bun:test";

const getMessagesMock = mock((_conversationId: string) => [
  {
    id: "assistant-1",
    role: "assistant",
    content: JSON.stringify([
      { type: "text", text: "What are you working on?" },
      {
        type: "tool_use",
        id: "tu_1",
        name: "memory_save",
        input: { key: "task" },
      },
      { type: "tool_result", tool_use_id: "tu_1", content: "saved" },
      { type: "text", text: "Saved that to memory." },
    ]),
    createdAt: new Date("2026-03-10T10:00:00.000Z").toISOString(),
  },
]);

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../memory/conversation-crud.js", () => ({
  addMessage: mock(async () => ({ id: "unused" })),
  getMessages: (conversationId: string) => getMessagesMock(conversationId),
}));

mock.module("../memory/attachments-store.js", () => ({
  getAttachmentMetadataForMessage: () => [],
  getAttachmentsByIds: () => [],
}));

import { handleListMessages } from "../runtime/routes/conversation-routes.js";

describe("handleListMessages", () => {
  test("preserves contentOrder for interleaved assistant history", async () => {
    const res = handleListMessages(
      new URL("http://localhost/v1/messages?conversationId=conv-1"),
      null,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messages: Array<{
        role: string;
        textSegments?: string[];
        contentOrder?: string[];
      }>;
    };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe("assistant");
    expect(body.messages[0].textSegments).toEqual([
      "What are you working on?",
      "Saved that to memory.",
    ]);
    expect(body.messages[0].contentOrder).toEqual([
      "text:0",
      "tool:0",
      "text:1",
    ]);
  });
});
