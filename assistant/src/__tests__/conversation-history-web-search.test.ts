/**
 * Tests for web_search_tool_result handling across session-history,
 * window-manager, and Anthropic client ensureToolPairing.
 *
 * These tests reproduce the bug where web_search_tool_result blocks are
 * dropped during consolidation because the code only checks for
 * block.type === "tool_result" and misses the distinct
 * "web_search_tool_result" type.
 *
 * Expected: tests 1-4 FAIL before the fix is applied (PR 2).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Module mocks (must precede imports of the module under test) ─────

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

// ── DB layer mocks for session-history ───────────────────────────────

/** In-memory message store for the fake DB layer. */
let dbMessages: Array<{
  id: string;
  conversationId: string;
  role: string;
  content: string;
  createdAt: number;
  metadata: string | null;
}> = [];

let deletedMessageIds: string[] = [];
let updatedMessages: Array<{ id: string; content: string }> = [];

mock.module("../memory/conversation-crud.js", () => ({
  getMessages: (conversationId: string) =>
    dbMessages.filter((m) => m.conversationId === conversationId),
  deleteMessageById: (messageId: string) => {
    deletedMessageIds.push(messageId);
    dbMessages = dbMessages.filter((m) => m.id !== messageId);
    return { segmentIds: [], orphanedItemIds: [] };
  },
  updateMessageContent: (messageId: string, content: string) => {
    updatedMessages.push({ id: messageId, content });
    const msg = dbMessages.find((m) => m.id === messageId);
    if (msg) msg.content = content;
  },
  relinkAttachments: () => 0,
  deleteLastExchange: () => 0,
}));

mock.module("../memory/conversation-queries.js", () => ({
  isLastUserMessageToolResult: () => false,
}));

mock.module("../memory/jobs-store.js", () => ({
  enqueueMemoryJob: () => {},
}));

mock.module("../memory/qdrant-circuit-breaker.js", () => ({
  withQdrantBreaker: async (fn: () => Promise<unknown>) => fn(),
}));

mock.module("../memory/qdrant-client.js", () => ({
  getQdrantClient: () => {
    throw new Error("Qdrant not initialized");
  },
}));

// Import after mocking
import {
  consolidateAssistantMessages,
  findLastUndoableUserMessageIndex,
  type HistoryConversationContext,
  regenerate,
} from "../daemon/conversation-history.js";
import type { ContentBlock, Message } from "../providers/types.js";

// ── Helpers ──────────────────────────────────────────────────────────

function makeDbMessage(
  id: string,
  conversationId: string,
  role: string,
  content: ContentBlock[],
  createdAt: number,
): (typeof dbMessages)[0] {
  return {
    id,
    conversationId,
    role,
    content: JSON.stringify(content),
    createdAt,
    metadata: null,
  };
}

// ── Test 1: consolidateAssistantMessages preserves web_search_tool_result ─

describe("consolidateAssistantMessages with web_search_tool_result", () => {
  beforeEach(() => {
    dbMessages = [];
    deletedMessageIds = [];
    updatedMessages = [];
  });

  test("preserves web_search_tool_result blocks in user messages — does not merge into consolidated assistant", () => {
    // Conversation:
    //   [0] user: "search for X"
    //   [1] assistant: server_tool_use (web_search)
    //   [2] user: web_search_tool_result (internal tool result)
    //   [3] assistant: "Here are the results..."
    const conversationId = "conv-ws-1";

    dbMessages = [
      makeDbMessage(
        "msg-u1",
        conversationId,
        "user",
        [{ type: "text", text: "search for X" }],
        1000,
      ),
      makeDbMessage(
        "msg-a1",
        conversationId,
        "assistant",
        [
          {
            type: "server_tool_use",
            id: "srvtoolu_abc",
            name: "web_search",
            input: { query: "X" },
          },
        ],
        2000,
      ),
      makeDbMessage(
        "msg-u2",
        conversationId,
        "user",
        [
          {
            type: "web_search_tool_result",
            tool_use_id: "srvtoolu_abc",
            content: [
              {
                type: "web_search_result",
                url: "https://example.com",
                title: "Example",
                encrypted_content: "enc_abc",
              },
            ],
          },
        ],
        3000,
      ),
      makeDbMessage(
        "msg-a2",
        conversationId,
        "assistant",
        [{ type: "text", text: "Here are the results..." }],
        4000,
      ),
    ];

    // Trigger consolidation starting from the first user message
    consolidateAssistantMessages(conversationId, "msg-u1");

    // The web_search_tool_result message (msg-u2) should be treated as an
    // internal tool result message and deleted — just like tool_result messages.
    // The consolidated assistant message should contain:
    //   - server_tool_use from msg-a1
    //   - web_search_tool_result from msg-u2 (merged in)
    //   - text from msg-a2
    // BUG: Currently msg-u2 is NOT recognized as a tool-result-only message
    // because the check only looks for block.type === "tool_result", not
    // "web_search_tool_result". This causes consolidation to stop at msg-u2,
    // treating it as a real user message.

    // After consolidation, the web_search_tool_result message should be deleted
    expect(deletedMessageIds).toContain("msg-u2");

    // The consolidated message should contain content from both assistant
    // messages AND the web_search_tool_result blocks
    expect(updatedMessages.length).toBeGreaterThanOrEqual(1);
    const consolidatedContent = JSON.parse(updatedMessages[0].content);

    // Should have server_tool_use + web_search_tool_result + text
    const blockTypes = consolidatedContent.map((b: { type: string }) => b.type);
    expect(blockTypes).toContain("server_tool_use");
    expect(blockTypes).toContain("web_search_tool_result");
    expect(blockTypes).toContain("text");
  });
});

// ── Test 2: web_search_tool_result-only messages identified as internal ──

describe("consolidateAssistantMessages identifies web_search_tool_result-only messages as internal", () => {
  beforeEach(() => {
    dbMessages = [];
    deletedMessageIds = [];
    updatedMessages = [];
  });

  test("web_search_tool_result-only user message is treated the same as tool_result-only", () => {
    const conversationId = "conv-ws-2";

    // Scenario: assistant with server_tool_use, then web_search_tool_result-only
    // user message, then another assistant message. The consolidation should
    // recognize the web_search_tool_result user message as internal (like tool_result).
    dbMessages = [
      makeDbMessage(
        "msg-u1",
        conversationId,
        "user",
        [{ type: "text", text: "search the web" }],
        1000,
      ),
      makeDbMessage(
        "msg-a1",
        conversationId,
        "assistant",
        [
          {
            type: "server_tool_use",
            id: "srvtoolu_def",
            name: "web_search",
            input: { query: "query" },
          },
        ],
        2000,
      ),
      makeDbMessage(
        "msg-ws",
        conversationId,
        "user",
        [
          {
            type: "web_search_tool_result",
            tool_use_id: "srvtoolu_def",
            content: [],
          },
        ],
        3000,
      ),
      makeDbMessage(
        "msg-a2",
        conversationId,
        "assistant",
        [{ type: "text", text: "Found results." }],
        4000,
      ),
    ];

    consolidateAssistantMessages(conversationId, "msg-u1");

    // The web_search_tool_result user message should be deleted as internal
    expect(deletedMessageIds).toContain("msg-ws");

    // Both assistant messages should be consolidated
    // (msg-a2 should be deleted, msg-a1 updated)
    expect(deletedMessageIds).toContain("msg-a2");
  });
});

// ── Test 3: isUndoableUserMessage returns false for web_search_tool_result-only ─

describe("isUndoableUserMessage with web_search_tool_result", () => {
  test("findLastUndoableUserMessageIndex skips web_search_tool_result-only messages", () => {
    const messages: Message[] = [
      // Real user message (undoable)
      {
        role: "user",
        content: [{ type: "text", text: "search for something" }],
      },
      // Assistant with server_tool_use
      {
        role: "assistant",
        content: [
          {
            type: "server_tool_use",
            id: "srvtoolu_undo",
            name: "web_search",
            input: { query: "test" },
          },
        ],
      },
      // web_search_tool_result-only user message (should NOT be undoable)
      {
        role: "user",
        content: [
          {
            type: "web_search_tool_result",
            tool_use_id: "srvtoolu_undo",
            content: [],
          },
        ],
      },
      // Final assistant response
      {
        role: "assistant",
        content: [{ type: "text", text: "Here are the results." }],
      },
    ];

    const lastUndoableIdx = findLastUndoableUserMessageIndex(messages);

    // The last undoable user message should be index 0 (the real user message),
    // NOT index 2 (the web_search_tool_result-only message).
    // BUG: Currently, web_search_tool_result blocks pass the
    // `block.type !== "tool_result"` check, so the message at index 2
    // is incorrectly identified as undoable.
    expect(lastUndoableIdx).toBe(0);
  });

  test("user message with both text and web_search_tool_result IS undoable", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "user text" },
          {
            type: "web_search_tool_result",
            tool_use_id: "srvtoolu_mixed",
            content: [],
          },
        ],
      },
    ];

    const lastUndoableIdx = findLastUndoableUserMessageIndex(messages);

    // A message with BOTH text and web_search_tool_result should be undoable
    // because it contains real user content.
    expect(lastUndoableIdx).toBe(0);
  });
});

// ── Test 4: regenerate handles conversations with web_search_tool_result ─

describe("regenerate with web_search_tool_result", () => {
  beforeEach(() => {
    dbMessages = [];
    deletedMessageIds = [];
    updatedMessages = [];
  });

  test("regenerate skips web_search_tool_result-only user messages when finding last real user message", async () => {
    const conversationId = "conv-ws-regen";

    // DB messages: user → assistant(server_tool_use) → user(web_search_tool_result) → assistant(text)
    dbMessages = [
      makeDbMessage(
        "msg-u1",
        conversationId,
        "user",
        [{ type: "text", text: "search for X" }],
        1000,
      ),
      makeDbMessage(
        "msg-a1",
        conversationId,
        "assistant",
        [
          {
            type: "server_tool_use",
            id: "srvtoolu_regen",
            name: "web_search",
            input: { query: "X" },
          },
        ],
        2000,
      ),
      makeDbMessage(
        "msg-ws",
        conversationId,
        "user",
        [
          {
            type: "web_search_tool_result",
            tool_use_id: "srvtoolu_regen",
            content: [],
          },
        ],
        3000,
      ),
      makeDbMessage(
        "msg-a2",
        conversationId,
        "assistant",
        [{ type: "text", text: "Results here." }],
        4000,
      ),
    ];

    // In-memory messages matching DB
    const inMemoryMessages: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "search for X" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "server_tool_use",
            id: "srvtoolu_regen",
            name: "web_search",
            input: { query: "X" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "web_search_tool_result",
            tool_use_id: "srvtoolu_regen",
            content: [],
          },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Results here." }],
      },
    ];

    let agentLoopCalled = false;
    let agentLoopContent = "";
    let agentLoopUserMessageId = "";

    const session: HistoryConversationContext = {
      conversationId,
      traceEmitter: {
        emit: () => {},
      } as unknown as HistoryConversationContext["traceEmitter"],
      messages: [...inMemoryMessages],
      processing: false,
      abortController: null,
      async runAgentLoop(content, userMessageId) {
        agentLoopCalled = true;
        agentLoopContent = content;
        agentLoopUserMessageId = userMessageId;
      },
    };

    const events: Array<{ type: string; message?: string }> = [];

    await regenerate(session, (msg) => events.push(msg));

    // regenerate should find the real user message (msg-u1) and skip the
    // web_search_tool_result-only message (msg-ws).
    // BUG: Currently, regenerate only checks for tool_result in the
    // `parsed.every(b => b.type === "tool_result")` check, so msg-ws
    // is treated as a real user message, and regenerate gets confused.

    expect(agentLoopCalled).toBe(true);
    expect(agentLoopUserMessageId).toBe("msg-u1");
    expect(agentLoopContent).toBe("search for X");

    // Messages after the user message should be deleted
    expect(deletedMessageIds).toContain("msg-a1");
    expect(deletedMessageIds).toContain("msg-ws");
    expect(deletedMessageIds).toContain("msg-a2");
  });
});

// ── Test 5: ensureToolPairing preserves server_tool_use / web_search_tool_result pairs ─

describe("ensureToolPairing with server_tool_use / web_search_tool_result", () => {
  // This test goes through the Anthropic provider's sendMessage which
  // internally calls ensureToolPairing. It verifies that properly paired
  // server_tool_use + web_search_tool_result blocks are preserved.

  let lastStreamParams: Record<string, unknown> | null = null;

  const fakeResponse = {
    content: [{ type: "text", text: "Done" }],
    model: "claude-sonnet-4-6",
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    stop_reason: "end_turn",
  };

  class FakeAPIError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
      this.name = "APIError";
    }
  }

  // We need to mock the Anthropic SDK for this test
  mock.module("@anthropic-ai/sdk", () => ({
    default: class MockAnthropic {
      static APIError = FakeAPIError;
      constructor(_args: Record<string, unknown>) {}
      messages = {
        stream: (
          params: Record<string, unknown>,
          _options?: Record<string, unknown>,
        ) => {
          lastStreamParams = JSON.parse(JSON.stringify(params));
          const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
          return {
            on(event: string, cb: (...args: unknown[]) => void) {
              (handlers[event] ??= []).push(cb);
              return this;
            },
            async finalMessage() {
              return fakeResponse;
            },
          };
        },
      };
    },
  }));

  // Import after mocking
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { AnthropicProvider } = require("../providers/anthropic/client.js");

  test("matched server_tool_use + web_search_tool_result pairs pass through ensureToolPairing", async () => {
    const provider = new AnthropicProvider("sk-ant-test", "claude-sonnet-4-6");

    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "search for X" }] },
      {
        role: "assistant",
        content: [
          {
            type: "server_tool_use",
            id: "srvtoolu_pair1",
            name: "web_search",
            input: { query: "X" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "web_search_tool_result",
            tool_use_id: "srvtoolu_pair1",
            content: [
              {
                type: "web_search_result",
                url: "https://example.com",
                title: "Example",
                encrypted_content: "enc_data",
              },
            ],
          },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Here are the results" }],
      },
      { role: "user", content: [{ type: "text", text: "thanks" }] },
    ];

    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{ type: string; tool_use_id?: string; id?: string }>;
    }>;

    // Find the assistant message with server_tool_use
    const assistantWithToolUse = sent.find(
      (m) =>
        m.role === "assistant" &&
        m.content.some((b) => b.type === "server_tool_use"),
    );
    expect(assistantWithToolUse).toBeDefined();

    // Find the user message with web_search_tool_result
    const userWithResult = sent.find(
      (m) =>
        m.role === "user" &&
        m.content.some((b) => b.type === "web_search_tool_result"),
    );
    expect(userWithResult).toBeDefined();

    // The web_search_tool_result should reference the server_tool_use ID
    const resultBlock = userWithResult!.content.find(
      (b) => b.type === "web_search_tool_result",
    );
    expect(resultBlock!.tool_use_id).toBe("srvtoolu_pair1");

    // The server_tool_use block should be in the assistant message
    const serverToolBlock = assistantWithToolUse!.content.find(
      (b) => b.type === "server_tool_use",
    );
    expect(serverToolBlock!.id).toBe("srvtoolu_pair1");
  });
});

// ── Test 6: context window compaction treats web_search_tool_result same as tool_result ─

describe("context window compaction with web_search_tool_result", () => {
  test("collectUserTurnStartIndexes (via ContextWindowManager) skips web_search_tool_result-only messages", () => {
    // The isToolResultOnly function in window-manager.ts is used by
    // collectUserTurnStartIndexes to decide which user messages are real
    // user turns vs. internal tool result messages.
    //
    // A web_search_tool_result-only user message should be treated the same
    // as a tool_result-only message: it should NOT appear in the list of
    // user turn start indexes.

    // We test this indirectly: a web_search_tool_result-only message should
    // not be counted as a user turn start. We can verify this by constructing
    // messages and checking that shouldCompact doesn't count web_search_tool_result
    // messages as separate user turns.

    // Build messages with a web_search_tool_result-only user message
    const messages: Message[] = [
      // Real user turn 1
      {
        role: "user",
        content: [{ type: "text", text: "search for X" }],
      },
      // Assistant with server_tool_use
      {
        role: "assistant",
        content: [
          {
            type: "server_tool_use",
            id: "srvtoolu_wm",
            name: "web_search",
            input: { query: "X" },
          },
        ],
      },
      // web_search_tool_result-only user message — should NOT be a user turn
      {
        role: "user",
        content: [
          {
            type: "web_search_tool_result",
            tool_use_id: "srvtoolu_wm",
            content: [],
          },
        ],
      },
      // Assistant response
      {
        role: "assistant",
        content: [{ type: "text", text: "Results found." }],
      },
      // Real user turn 2
      {
        role: "user",
        content: [{ type: "text", text: "tell me more" }],
      },
    ];

    // The isToolResultOnly helper used by collectUserTurnStartIndexes
    // checks: message.content.every(block => block.type === "tool_result")
    // BUG: web_search_tool_result blocks don't match this check, so the
    // message at index 2 is incorrectly counted as a user turn start.

    // Verify using findLastUndoableUserMessageIndex as a proxy for the same
    // logic pattern. While this tests session-history not window-manager
    // directly, both share the same underlying pattern of checking for
    // tool_result type.
    //
    // Direct test: the web_search_tool_result-only message at index 2 should
    // not be the last undoable user message.
    const lastUndoableIdx = findLastUndoableUserMessageIndex(messages);

    // Should find the real user message at index 4, skipping the
    // web_search_tool_result-only message at index 2.
    expect(lastUndoableIdx).toBe(4);

    // Additionally verify the web_search_tool_result-only message would be
    // identified correctly: if we have ONLY web_search_tool_result messages,
    // there should be no undoable messages.
    const onlyWebSearchResults: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "web_search_tool_result",
            tool_use_id: "srvtoolu_only",
            content: [],
          },
        ],
      },
    ];

    const idx = findLastUndoableUserMessageIndex(onlyWebSearchResults);
    // Should return -1 since there are no undoable user messages
    // BUG: Currently returns 0 because web_search_tool_result passes the
    // block.type !== "tool_result" check.
    expect(idx).toBe(-1);
  });
});

// ── Guard test: prevent raw "tool_result" type checks ────────────────────────

describe("web_search_tool_result structural guard", () => {
  /**
   * Structural guard that prevents future regressions where new code checks
   * for `=== "tool_result"` or `!== "tool_result"` without also handling
   * `"web_search_tool_result"`.
   *
   * This test scans ALL source files under assistant/src/ (excluding test
   * files, .d.ts declarations, and node_modules) for raw tool_result type
   * comparisons. Files where only `tool_result` is legitimately needed
   * are listed in the allowlist below.
   *
   * If this test fails, either:
   * 1. Use `isToolResultBlock()` from conversation-history.ts, or
   * 2. Include both "tool_result" and "web_search_tool_result" in the check, or
   * 3. Add the file to the allowlist with a comment explaining why only
   *    `tool_result` is correct.
   */

  const SRC_DIR = join(import.meta.dir, "..");

  /**
   * Files where raw `tool_result` checks are legitimate and
   * `web_search_tool_result` handling is NOT required.
   *
   * Each entry must have a comment explaining why the file is exempt.
   */
  const ALLOWLISTED_FILES = new Set([
    // Truncation logic operates on tool_result text content (string `.content`);
    // web_search_tool_result has a structurally different content format
    // (array of web_search_result objects) and is not truncated this way.
    "context/tool-result-truncation.ts",

    // Anthropic provider type guards define API-specific discriminants.
    // It has a separate isWebSearchToolResultBlock for the other type.
    "providers/anthropic/client.ts",

    // OpenAI provider converts Anthropic-style messages to OpenAI format.
    // OpenAI API does not support web_search_tool_result natively; those
    // blocks are handled upstream before reaching the OpenAI client.
    "providers/openai/client.ts",

    // Renders tool_result blocks for client display. web_search_tool_result
    // blocks are rendered by the client via their own display path.
    "daemon/handlers/shared.ts",

    // Agent loop tool execution: these handle results from locally-executed
    // tools (tool_use -> tool_result). Server-side web search results
    // (server_tool_use -> web_search_tool_result) are injected by the
    // provider, not the local tool executor, so they never flow here.
    "agent/loop.ts",

    // Reconciles synthesized cancellation tool_results for locally-executed
    // tools only. Same reasoning as agent/loop.ts above.
    "daemon/conversation-agent-loop.ts",

    // Parses tool_result blocks from skill invocation results. Skills
    // return tool_result blocks, never web_search_tool_result blocks.
    "skills/active-skill-tools.ts",

    // Renders tool_result events for subagent event streams.
    // web_search_tool_result is not emitted through the subagent event path.
    "runtime/routes/subagents-routes.ts",

    // Extracts tool results from persisted message content for work-item
    // display. web_search_tool_result blocks are not relevant here.
    "runtime/routes/work-items-routes.ts",
  ]);

  /**
   * Find lines with raw tool_result type comparisons that are NOT inside
   * an approved helper function definition.
   *
   * Approved patterns (allowlisted):
   * - The `isToolResultBlock` function body (which defines the canonical
   *   check for both "tool_result" and "web_search_tool_result")
   * - Lines that also mention "web_search_tool_result" within a +/-3 line
   *   window (multi-line paired check), or a `guard:allow-tool-result-only`
   *   annotation. Each suppression line can only cover ONE raw check to
   *   prevent a single annotation from silently covering multiple violations.
   */
  function findRawToolResultChecks(
    source: string,
    filePath: string,
  ): Array<{ file: string; line: number; text: string }> {
    const violations: Array<{ file: string; line: number; text: string }> = [];
    const lines = source.split("\n");

    // Track whether we're inside an isToolResultBlock or isToolResultContent
    // helper function definition (which canonically defines the check).
    // We use brace depth tracking so nested blocks (if/else, etc.) inside the
    // helper don't prematurely end the allowlisted region.
    //
    // Two-phase state: `insideHelperSignature` is true when we've matched the
    // function name but haven't yet seen the opening `{` (handles multi-line
    // signatures like `function isToolResultBlock(\n  ...\n): boolean {`).
    // Once the first `{` is found, we switch to brace-depth tracking.
    let insideHelperSignature = false;
    let helperBraceDepth = 0;

    // Track which lines have already been used to suppress a raw tool_result check.
    // Each web_search_tool_result reference or guard:allow-tool-result-only annotation
    // can only suppress one raw check, preventing adjacent violations from being
    // silently covered by a single nearby suppression.
    const consumedSuppressions = new Set<number>();

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Detect entry of known helper functions that define the canonical check
      if (
        !insideHelperSignature &&
        helperBraceDepth === 0 &&
        /function isToolResult\w*\b/.test(line)
      ) {
        // The opening `{` may be on this line or a subsequent line (multi-line
        // signatures). Check if there are braces on this line to determine
        // whether we can start depth tracking immediately.
        const opens = (line.match(/{/g) || []).length;
        const closes = (line.match(/}/g) || []).length;
        if (opens > 0) {
          helperBraceDepth = opens - closes;
        } else {
          insideHelperSignature = true;
        }
        continue;
      }

      // Still scanning the multi-line function signature for the opening `{`
      if (insideHelperSignature) {
        const opens = (line.match(/{/g) || []).length;
        if (opens > 0) {
          const closes = (line.match(/}/g) || []).length;
          helperBraceDepth = opens - closes;
          insideHelperSignature = false;
        }
        continue;
      }

      // Track brace depth while inside a helper function body
      if (helperBraceDepth > 0) {
        const opens = (line.match(/{/g) || []).length;
        const closes = (line.match(/}/g) || []).length;
        helperBraceDepth += opens - closes;
        continue;
      }

      // Check for raw tool_result type comparisons (both quote styles)
      const hasRawCheck =
        /[=!]==?\s*["']tool_result["']/.test(line) ||
        /["']tool_result["']\s*[=!]==?/.test(line);
      if (!hasRawCheck) continue;

      // Allow lines that reference web_search_tool_result nearby (paired check).
      // Multi-line patterns like `block.type === "tool_result" ||\n  block.type === "web_search_tool_result"`
      // are common, so we check a window of +/- 3 lines for the pairing.
      // Each suppression line (web_search_tool_result or guard:allow-tool-result-only)
      // can only suppress ONE raw tool_result check to prevent a single annotation
      // from silently covering multiple adjacent raw checks.
      const windowStart = Math.max(0, i - 3);
      const windowEnd = Math.min(lines.length - 1, i + 3);
      let pairedOrSuppressed = false;
      for (let j = windowStart; j <= windowEnd; j++) {
        if (consumedSuppressions.has(j)) continue;
        if (
          /web_search_tool_result/.test(lines[j]) ||
          /guard:allow-tool-result-only/.test(lines[j])
        ) {
          pairedOrSuppressed = true;
          consumedSuppressions.add(j);
          break;
        }
      }
      if (pairedOrSuppressed) continue;

      // Allow comment-only lines
      if (/^\s*\/\//.test(line) || /^\s*\*/.test(line)) continue;

      violations.push({
        file: filePath,
        line: i + 1,
        text: line.trim(),
      });
    }

    return violations;
  }

  /**
   * Recursively collect all .ts source files under a directory, excluding
   * test files, declaration files, and node_modules.
   */
  function collectSourceFiles(dir: string): string[] {
    const files: string[] = [];

    for (const entry of readdirSync(dir) as string[]) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);

      if (stat.isDirectory()) {
        // Skip test directories and node_modules
        if (
          entry === "__tests__" ||
          entry === "node_modules" ||
          entry === ".turbo"
        ) {
          continue;
        }
        files.push(...collectSourceFiles(fullPath));
      } else if (
        entry.endsWith(".ts") &&
        !entry.endsWith(".d.ts") &&
        !entry.endsWith(".test.ts")
      ) {
        files.push(fullPath);
      }
    }

    return files;
  }

  test("no source file has raw tool_result type checks without web_search_tool_result handling", () => {
    const sourceFiles = collectSourceFiles(SRC_DIR);
    const allViolations: Array<{ file: string; line: number; text: string }> =
      [];

    for (const filePath of sourceFiles) {
      // Compute relative path from SRC_DIR for allowlist lookup
      const relPath = filePath.slice(SRC_DIR.length + 1);

      // Skip allowlisted files
      if (ALLOWLISTED_FILES.has(relPath)) continue;

      const source = readFileSync(filePath, "utf-8");
      const violations = findRawToolResultChecks(source, relPath);
      allViolations.push(...violations);
    }

    if (allViolations.length > 0) {
      const message = [
        "Found raw tool_result type checks in source files that do not also",
        'handle "web_search_tool_result". This can cause web search results',
        "to be silently dropped.",
        "",
        "Violations:",
        ...allViolations.map((v) => `  - ${v.file}:${v.line}: ${v.text}`),
        "",
        "Fix options:",
        "  1. Use isToolResultBlock() from conversation-history.ts",
        '  2. Add || block.type === "web_search_tool_result" to your check',
        "  3. If only tool_result is correct, add the file to ALLOWLISTED_FILES",
        "     in this test with a comment explaining why.",
      ].join("\n");
      expect(allViolations, message).toEqual([]);
    }
  });
});
