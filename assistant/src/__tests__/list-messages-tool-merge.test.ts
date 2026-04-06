/**
 * Tests for handleListMessages tool_result merging.
 *
 * Verifies that tool_result blocks from user messages are merged into the
 * preceding assistant message so they render with proper tool names instead
 * of "Unknown" after a conversation reload.
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

import { addMessage, createConversation } from "../memory/conversation-crud.js";
import { getDb, initializeDb } from "../memory/db.js";
import { handleListMessages } from "../runtime/routes/conversation-routes.js";

initializeDb();

function resetTables() {
  const db = getDb();
  db.run("DELETE FROM message_attachments");
  db.run("DELETE FROM attachments");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

function createTestUrl(conversationId: string): URL {
  return new URL(
    `http://localhost/v1/messages?conversationId=${conversationId}`,
  );
}

interface ToolCallPayload {
  name: string;
  input: Record<string, unknown>;
  result?: string;
  isError?: boolean;
}

interface MessagePayload {
  role: string;
  content: string;
  toolCalls?: ToolCallPayload[];
  textSegments?: string[];
}

describe("handleListMessages tool_result merging", () => {
  beforeEach(resetTables);

  test("merges tool_result from user message into preceding assistant", async () => {
    const conv = createConversation();
    // User prompt
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([{ type: "text", text: "run ls" }]),
    );
    // Assistant with tool_use
    await addMessage(
      conv.id,
      "assistant",
      JSON.stringify([
        { type: "text", text: "Running command." },
        { type: "tool_use", id: "tu1", name: "bash", input: { command: "ls" } },
      ]),
    );
    // Tool result (separate user message)
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([
        { type: "tool_result", tool_use_id: "tu1", content: "file1.txt\nfile2.txt" },
      ]),
    );

    const response = handleListMessages(createTestUrl(conv.id), null);
    const body = (await response.json()) as { messages: MessagePayload[] };

    // Should be 2 messages: user prompt + assistant (tool_result user msg suppressed)
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[1].role).toBe("assistant");

    // Assistant tool call should have proper name AND result
    const toolCalls = body.messages[1].toolCalls;
    expect(toolCalls).toBeDefined();
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls![0].name).toBe("bash");
    expect(toolCalls![0].result).toBe("file1.txt\nfile2.txt");
  });

  test("merges multiple tool_results into matching tool_uses", async () => {
    const conv = createConversation();
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([{ type: "text", text: "do stuff" }]),
    );
    await addMessage(
      conv.id,
      "assistant",
      JSON.stringify([
        { type: "tool_use", id: "tu1", name: "bash", input: { command: "ls" } },
        { type: "text", text: "and also" },
        { type: "tool_use", id: "tu2", name: "file_read", input: { path: "/tmp/a" } },
      ]),
    );
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([
        { type: "tool_result", tool_use_id: "tu1", content: "dir listing" },
        { type: "tool_result", tool_use_id: "tu2", content: "file contents" },
      ]),
    );

    const response = handleListMessages(createTestUrl(conv.id), null);
    const body = (await response.json()) as { messages: MessagePayload[] };

    expect(body.messages).toHaveLength(2);
    const toolCalls = body.messages[1].toolCalls!;
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0].name).toBe("bash");
    expect(toolCalls[0].result).toBe("dir listing");
    expect(toolCalls[1].name).toBe("file_read");
    expect(toolCalls[1].result).toBe("file contents");
  });

  test("plain user message passes through unchanged", async () => {
    const conv = createConversation();
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([{ type: "text", text: "hello" }]),
    );
    await addMessage(
      conv.id,
      "assistant",
      JSON.stringify([{ type: "text", text: "hi there" }]),
    );
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([{ type: "text", text: "how are you?" }]),
    );

    const response = handleListMessages(createTestUrl(conv.id), null);
    const body = (await response.json()) as { messages: MessagePayload[] };

    expect(body.messages).toHaveLength(3);
    expect(body.messages[2].role).toBe("user");
    expect(body.messages[2].content).toBe("how are you?");
  });

  test("tool_result at start of array (no preceding assistant) is preserved", async () => {
    const conv = createConversation();
    // Orphan tool_result with no preceding assistant (pagination boundary).
    // The preceding assistant tool_use lives in the previous page — dropping
    // the result would be unrecoverable, so it is kept as-is.
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([
        { type: "tool_result", tool_use_id: "tu_orphan", content: "stale result" },
      ]),
    );
    await addMessage(
      conv.id,
      "assistant",
      JSON.stringify([{ type: "text", text: "response" }]),
    );

    const response = handleListMessages(createTestUrl(conv.id), null);
    const body = (await response.json()) as { messages: MessagePayload[] };

    // Orphan tool_result is preserved (not suppressed) to avoid data loss
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe("user");
    // The preserved message must retain the actual tool_result payload
    const orphanToolCalls = body.messages[0].toolCalls;
    expect(orphanToolCalls).toBeDefined();
    expect(orphanToolCalls).toHaveLength(1);
    expect(orphanToolCalls![0].result).toBe("stale result");
    expect(body.messages[1].role).toBe("assistant");
    expect(body.messages[1].content).toBe("response");
  });

  test("multi-turn: each tool_result merges into correct assistant", async () => {
    const conv = createConversation();
    // Turn 1
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([{ type: "text", text: "list files" }]),
    );
    await addMessage(
      conv.id,
      "assistant",
      JSON.stringify([
        { type: "tool_use", id: "tu1", name: "bash", input: { command: "ls" } },
      ]),
    );
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([
        { type: "tool_result", tool_use_id: "tu1", content: "files" },
      ]),
    );
    // Turn 2
    await addMessage(
      conv.id,
      "assistant",
      JSON.stringify([
        { type: "text", text: "Now reading:" },
        { type: "tool_use", id: "tu2", name: "file_read", input: { path: "/x" } },
      ]),
    );
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([
        { type: "tool_result", tool_use_id: "tu2", content: "file data" },
      ]),
    );
    // Turn 3: real user message
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([{ type: "text", text: "thanks" }]),
    );

    const response = handleListMessages(createTestUrl(conv.id), null);
    const body = (await response.json()) as { messages: MessagePayload[] };

    // user("list files"), assistant(bash), assistant(file_read), user("thanks")
    expect(body.messages).toHaveLength(4);
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[1].role).toBe("assistant");
    expect(body.messages[1].toolCalls![0].name).toBe("bash");
    expect(body.messages[1].toolCalls![0].result).toBe("files");
    expect(body.messages[2].role).toBe("assistant");
    expect(body.messages[2].toolCalls![0].name).toBe("file_read");
    expect(body.messages[2].toolCalls![0].result).toBe("file data");
    expect(body.messages[3].role).toBe("user");
    expect(body.messages[3].content).toBe("thanks");
  });

  test("tool_result with is_error propagates error status", async () => {
    const conv = createConversation();
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([{ type: "text", text: "do it" }]),
    );
    await addMessage(
      conv.id,
      "assistant",
      JSON.stringify([
        { type: "tool_use", id: "tu1", name: "bash", input: { command: "fail" } },
      ]),
    );
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([
        {
          type: "tool_result",
          tool_use_id: "tu1",
          content: "command not found",
          is_error: true,
        },
      ]),
    );

    const response = handleListMessages(createTestUrl(conv.id), null);
    const body = (await response.json()) as { messages: MessagePayload[] };

    expect(body.messages).toHaveLength(2);
    const tc = body.messages[1].toolCalls![0];
    expect(tc.name).toBe("bash");
    expect(tc.result).toBe("command not found");
    expect(tc.isError).toBe(true);
  });
});
