/**
 * Tests for handleListMessages tool_result merging.
 *
 * Verifies that tool_result blocks from user messages are merged into the
 * preceding assistant message so they render with proper tool names instead
 * of "Unknown" after a conversation reload.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

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
} from "../persistence/conversation-crud.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { handleListMessages } from "../runtime/routes/conversation-routes.js";

await initializeDb();

function resetTables() {
  const db = getDb();
  db.run("DELETE FROM message_attachments");
  db.run("DELETE FROM attachments");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

function createTestArgs(conversationId: string) {
  return { queryParams: { conversationId } };
}

interface ToolCallPayload {
  name: string;
  input: Record<string, unknown>;
  result?: string;
  isError?: boolean;
}

interface MessagePayload {
  id: string;
  mergedMessageIds?: string[];
  role: string;
  toolCalls?: ToolCallPayload[];
  textSegments?: string[];
  contentOrder?: string[];
  contentBlocks?: Array<{ type: string; [key: string]: unknown }>;
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
        {
          type: "tool_result",
          tool_use_id: "tu1",
          content: "file1.txt\nfile2.txt",
        },
      ]),
    );

    const response = handleListMessages(createTestArgs(conv.id));
    const body = response as { messages: MessagePayload[] };

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

    // The unified contentBlocks projection ships alongside the legacy arrays,
    // in contentOrder order, with the tool_result already paired onto the
    // tool_use block.
    expect(body.messages[1].contentOrder).toEqual(["text:0", "tool:0"]);
    expect(body.messages[1].contentBlocks).toEqual([
      { type: "text", text: "Running command." },
      {
        type: "tool_use",
        toolCall: {
          id: "tu1",
          name: "bash",
          input: { command: "ls" },
          result: "file1.txt\nfile2.txt",
          isError: false,
        },
      },
    ]);
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
        {
          type: "tool_use",
          id: "tu2",
          name: "file_read",
          input: { path: "/tmp/a" },
        },
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

    const response = handleListMessages(createTestArgs(conv.id));
    const body = response as { messages: MessagePayload[] };

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

    const response = handleListMessages(createTestArgs(conv.id));
    const body = response as { messages: MessagePayload[] };

    expect(body.messages).toHaveLength(3);
    expect(body.messages[2].role).toBe("user");
    expect(body.messages[2].textSegments).toEqual(["how are you?"]);
  });

  test("includes merged assistant ids for consecutive assistant history rows", async () => {
    const conv = createConversation();
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([{ type: "text", text: "start" }]),
    );
    const anchor = await addMessage(
      conv.id,
      "assistant",
      JSON.stringify([{ type: "text", text: "Checking." }]),
    );
    const tail = await addMessage(
      conv.id,
      "assistant",
      JSON.stringify([{ type: "text", text: "Done." }]),
    );

    const response = handleListMessages(createTestArgs(conv.id));
    const body = response as { messages: MessagePayload[] };

    expect(body.messages).toHaveLength(2);
    expect(body.messages[1]).toMatchObject({
      id: anchor.id,
      role: "assistant",
      mergedMessageIds: [tail.id],
    });
  });

  test("orphan tool_result at pagination boundary is suppressed entirely", async () => {
    const conv = createConversation();
    // Orphan tool_result with no preceding assistant in this page. The
    // matching tool_use lives on the previous page, so renderHistoryContent
    // would silently drop the orphan downstream and leave a blank user
    // bubble. The merger now suppresses the user row outright at the
    // boundary to prevent that blank bubble from reaching the client.
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([
        {
          type: "tool_result",
          tool_use_id: "tu_orphan",
          content: "stale result",
        },
      ]),
    );
    await addMessage(
      conv.id,
      "assistant",
      JSON.stringify([{ type: "text", text: "response" }]),
    );

    const response = handleListMessages(createTestArgs(conv.id));
    const body = response as { messages: MessagePayload[] };

    // User row dropped entirely; only the assistant survives.
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe("assistant");
    expect(body.messages[0].textSegments).toEqual(["response"]);
  });

  test("mixed content at pagination boundary keeps real user text", async () => {
    const conv = createConversation();
    // Row has both real user text AND an orphan tool_result. The orphan
    // gets stripped (it'd be dropped by renderHistoryContent anyway), but
    // the user text is preserved.
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([
        {
          type: "tool_result",
          tool_use_id: "tu_orphan",
          content: "stale result",
        },
        { type: "text", text: "what about this?" },
      ]),
    );
    await addMessage(
      conv.id,
      "assistant",
      JSON.stringify([{ type: "text", text: "answering" }]),
    );

    const response = handleListMessages(createTestArgs(conv.id));
    const body = response as { messages: MessagePayload[] };

    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[0].textSegments).toEqual(["what about this?"]);
    expect(body.messages[0].toolCalls).toBeUndefined();
    expect(body.messages[1].role).toBe("assistant");
    expect(body.messages[1].textSegments).toEqual(["answering"]);
  });

  test("orphan tool_result + system_notice at boundary is suppressed", async () => {
    const conv = createConversation();
    // System notices ride alongside tool_results in the agent loop. At a
    // boundary they shouldn't keep the row alive on their own — the row
    // is still semantically tool-result-only from the user's perspective.
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([
        {
          type: "tool_result",
          tool_use_id: "tu_orphan",
          content: "stale",
        },
        { type: "text", text: "<system_notice>internal</system_notice>" },
      ]),
    );
    await addMessage(
      conv.id,
      "assistant",
      JSON.stringify([{ type: "text", text: "ok" }]),
    );

    const response = handleListMessages(createTestArgs(conv.id));
    const body = response as { messages: MessagePayload[] };

    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe("assistant");
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
        {
          type: "tool_use",
          id: "tu2",
          name: "file_read",
          input: { path: "/x" },
        },
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

    const response = handleListMessages(createTestArgs(conv.id));
    const body = response as { messages: MessagePayload[] };

    // Consecutive assistant messages are merged at query time so the client
    // sees one grouped message (matching the streaming path behavior).
    // user("list files"), merged-assistant(bash + file_read), user("thanks")
    expect(body.messages).toHaveLength(3);
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[1].role).toBe("assistant");
    expect(body.messages[1].toolCalls).toHaveLength(2);
    expect(body.messages[1].toolCalls![0].name).toBe("bash");
    expect(body.messages[1].toolCalls![0].result).toBe("files");
    expect(body.messages[1].toolCalls![1].name).toBe("file_read");
    expect(body.messages[1].toolCalls![1].result).toBe("file data");
    expect(body.messages[2].role).toBe("user");
    expect(body.messages[2].textSegments).toEqual(["thanks"]);
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
        {
          type: "tool_use",
          id: "tu1",
          name: "bash",
          input: { command: "fail" },
        },
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

    const response = handleListMessages(createTestArgs(conv.id));
    const body = response as { messages: MessagePayload[] };

    expect(body.messages).toHaveLength(2);
    const tc = body.messages[1].toolCalls![0];
    expect(tc.name).toBe("bash");
    expect(tc.result).toBe("command not found");
    expect(tc.isError).toBe(true);
  });
});
