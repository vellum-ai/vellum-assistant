import { describe, expect, test } from "bun:test";

import { deepRepairHistory, repairHistory } from "../daemon/history-repair.js";
import type { Message } from "../providers/types.js";

describe("repairHistory", () => {
  test("no-op for valid histories", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_1", name: "read", input: { path: "/a" } },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_1",
            content: "file contents",
          },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Here is the file." }],
      },
    ];

    const { messages: repaired, stats } = repairHistory(messages);

    expect(repaired).toEqual(messages);
    expect(stats.assistantToolResultsMigrated).toBe(0);
    expect(stats.missingToolResultsInserted).toBe(0);
    expect(stats.orphanToolResultsDowngraded).toBe(0);
  });

  test("strips tool_result blocks from assistant messages", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Sure" },
          { type: "tool_result", tool_use_id: "tu_x", content: "stale" },
        ],
      },
    ];

    const { messages: repaired, stats } = repairHistory(messages);

    expect(repaired).toHaveLength(2);
    expect(repaired[1].content).toEqual([{ type: "text", text: "Sure" }]);
    expect(stats.assistantToolResultsMigrated).toBe(1);
  });

  test("inserts missing tool_result when user message lacks it", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Run tool" }] },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_1", name: "bash", input: { cmd: "ls" } },
          { type: "tool_use", id: "tu_2", name: "read", input: { path: "/b" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu_1", content: "ok" },
          // tu_2 is missing
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Done" }],
      },
    ];

    const { messages: repaired, stats } = repairHistory(messages);

    expect(stats.missingToolResultsInserted).toBe(1);

    // The user message should now have both tool_results
    const userMsg = repaired[2];
    expect(userMsg.role).toBe("user");
    const trBlocks = userMsg.content.filter((b) => b.type === "tool_result");
    expect(trBlocks).toHaveLength(2);

    const synth = trBlocks.find(
      (b) => b.type === "tool_result" && b.tool_use_id === "tu_2",
    );
    expect(synth).toBeDefined();
    expect(synth!.type === "tool_result" && synth!.is_error).toBe(true);
  });

  test("injects synthetic user message when assistant tool_use has no following user message", () => {
    // assistant with tool_use followed by another assistant (no user in between)
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Go" }] },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_1", name: "bash", input: { cmd: "ls" } },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Oops" }],
      },
    ];

    const { messages: repaired, stats } = repairHistory(messages);

    expect(stats.missingToolResultsInserted).toBe(1);
    expect(repaired).toHaveLength(4);
    expect(repaired[2].role).toBe("user");
    expect(repaired[2].content[0].type).toBe("tool_result");
  });

  test("injects synthetic user message for trailing assistant with tool_use", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Go" }] },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_1", name: "bash", input: { cmd: "ls" } },
        ],
      },
    ];

    const { messages: repaired, stats } = repairHistory(messages);

    expect(stats.missingToolResultsInserted).toBe(1);
    expect(repaired).toHaveLength(3);
    expect(repaired[2].role).toBe("user");
  });

  test("downgrades orphan tool_result blocks to text", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_1", name: "bash", input: { cmd: "ls" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu_1", content: "ok" },
          {
            type: "tool_result",
            tool_use_id: "tu_unknown",
            content: "stale result",
          },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Done" }],
      },
    ];

    const { messages: repaired, stats } = repairHistory(messages);

    expect(stats.orphanToolResultsDowngraded).toBe(1);

    const userContent = repaired[2].content;
    expect(userContent).toHaveLength(2);
    expect(userContent[0].type).toBe("tool_result");
    expect(userContent[1].type).toBe("text");
    expect(userContent[1].type === "text" && userContent[1].text).toContain(
      "orphaned tool_result",
    );
  });

  test("downgrades tool_result in user message when no preceding tool_use", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "hi" },
          { type: "tool_result", tool_use_id: "tu_gone", content: "wat" },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Hello" }],
      },
    ];

    const { messages: repaired, stats } = repairHistory(messages);

    expect(stats.orphanToolResultsDowngraded).toBe(1);
    expect(repaired[0].content[1].type).toBe("text");
  });

  test("preserves non-tool content unchanged", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "Hello" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "abc" },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm", signature: "sig" },
          { type: "text", text: "World" },
        ],
      },
    ];

    const { messages: repaired, stats } = repairHistory(messages);

    expect(repaired).toEqual(messages);
    expect(stats.assistantToolResultsMigrated).toBe(0);
    expect(stats.missingToolResultsInserted).toBe(0);
    expect(stats.orphanToolResultsDowngraded).toBe(0);
  });

  test("idempotency: running twice produces same output", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Go" }] },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_1", name: "bash", input: { cmd: "ls" } },
          { type: "tool_result", tool_use_id: "tu_x", content: "bad" },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu_orphan", content: "stale" },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Done" }],
      },
    ];

    const first = repairHistory(messages);
    const second = repairHistory(first.messages);

    expect(second.messages).toEqual(first.messages);
    expect(second.stats.assistantToolResultsMigrated).toBe(0);
    expect(second.stats.missingToolResultsInserted).toBe(0);
    expect(second.stats.orphanToolResultsDowngraded).toBe(0);
  });

  test("handles multiple tool_use blocks with all results missing", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Run" }] },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_a", name: "bash", input: {} },
          { type: "tool_use", id: "tu_b", name: "read", input: {} },
          { type: "tool_use", id: "tu_c", name: "write", input: {} },
        ],
      },
      {
        role: "user",
        content: [{ type: "text", text: "next message" }],
      },
    ];

    const { messages: repaired, stats } = repairHistory(messages);

    // The text-only user message should have 3 synthetic tool_results injected
    expect(stats.missingToolResultsInserted).toBe(3);

    const userMsg = repaired[2];
    const trBlocks = userMsg.content.filter((b) => b.type === "tool_result");
    expect(trBlocks).toHaveLength(3);
    // Original text content preserved
    expect(userMsg.content[0]).toEqual({ type: "text", text: "next message" });
  });

  test("migrates tool_result from assistant message to user message preserving content", () => {
    // Legacy corruption: assistant has both tool_use and its own tool_result
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Go" }] },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_1", name: "bash", input: { cmd: "ls" } },
          { type: "tool_result", tool_use_id: "tu_1", content: "file1\nfile2" },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Here are the files." }],
      },
    ];

    const { messages: repaired, stats } = repairHistory(messages);

    expect(stats.assistantToolResultsMigrated).toBe(1);
    expect(stats.missingToolResultsInserted).toBe(0);

    // assistant message should have tool_use only
    expect(repaired[1].content).toEqual([
      { type: "tool_use", id: "tu_1", name: "bash", input: { cmd: "ls" } },
    ]);

    // injected user message should carry the original result, not a synthetic error
    expect(repaired[2].role).toBe("user");
    expect(repaired[2].content).toEqual([
      { type: "tool_result", tool_use_id: "tu_1", content: "file1\nfile2" },
    ]);

    // original second assistant message follows
    expect(repaired[3].content).toEqual([
      { type: "text", text: "Here are the files." },
    ]);
  });

  test("migrates tool_result from assistant to following user message filling gap", () => {
    // assistant has tool_use(tu_1) + tool_result(tu_1), user message has no tool_result
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Go" }] },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_1", name: "bash", input: { cmd: "ls" } },
          { type: "tool_result", tool_use_id: "tu_1", content: "success data" },
        ],
      },
      {
        role: "user",
        content: [{ type: "text", text: "thanks" }],
      },
    ];

    const { messages: repaired, stats } = repairHistory(messages);

    expect(stats.assistantToolResultsMigrated).toBe(1);
    expect(stats.missingToolResultsInserted).toBe(0);

    // user message should now have both original text and the migrated tool_result
    const userMsg = repaired[2];
    expect(userMsg.content).toHaveLength(2);
    expect(userMsg.content[0]).toEqual({ type: "text", text: "thanks" });
    expect(userMsg.content[1]).toEqual({
      type: "tool_result",
      tool_use_id: "tu_1",
      content: "success data",
    });
  });

  test("merges user(tool_result) with user(text) in checkpoint handoff scenario", () => {
    // After a checkpoint handoff the history can end with:
    //   assistant(tool_use) -> user(tool_result) -> user(new_message)
    // repairHistory MUST merge these to satisfy the Anthropic API alternation
    // requirement. Undo semantics for the merged message are handled by
    // isUndoableUserMessage which considers a message with both tool_result
    // and text blocks as undoable (since it contains user-authored content).
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_1", name: "bash", input: { cmd: "ls" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu_1", content: "file1" },
        ],
      },
      {
        role: "user",
        content: [{ type: "text", text: "Now do something else" }],
      },
    ];

    const { messages: repaired, stats } = repairHistory(messages);

    expect(stats.consecutiveSameRoleMerged).toBe(1);
    expect(repaired).toHaveLength(3);
    // user messages are merged into one
    expect(repaired[2].role).toBe("user");
    expect(repaired[2].content).toHaveLength(2);
    expect(repaired[2].content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "tu_1",
      content: "file1",
    });
    expect(repaired[2].content[1]).toEqual({
      type: "text",
      text: "Now do something else",
    });
  });

  test("merges multiple consecutive same-role messages", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "A" }] },
      { role: "user", content: [{ type: "text", text: "B" }] },
      { role: "user", content: [{ type: "text", text: "C" }] },
      { role: "assistant", content: [{ type: "text", text: "Hi" }] },
    ];

    const { messages: repaired, stats } = repairHistory(messages);

    expect(stats.consecutiveSameRoleMerged).toBe(2);
    expect(repaired).toHaveLength(2);
    expect(repaired[0].role).toBe("user");
    expect(repaired[0].content).toHaveLength(3);
  });

  test("handles empty message array", () => {
    const { messages, stats } = repairHistory([]);
    expect(messages).toEqual([]);
    expect(stats.assistantToolResultsMigrated).toBe(0);
    expect(stats.missingToolResultsInserted).toBe(0);
    expect(stats.orphanToolResultsDowngraded).toBe(0);
    expect(stats.consecutiveSameRoleMerged).toBe(0);
  });

  test("preserves server_tool_use and web_search_tool_result pairing", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Search for cats" }] },
      {
        role: "assistant",
        content: [
          {
            type: "server_tool_use",
            id: "stu_1",
            name: "web_search",
            input: { query: "cats" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "web_search_tool_result",
            tool_use_id: "stu_1",
            content: [{ type: "web_search_result", url: "https://cats.com" }],
          },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Here are the results." }],
      },
    ];

    const { messages: repaired, stats } = repairHistory(messages);

    expect(repaired).toEqual(messages);
    expect(stats.missingToolResultsInserted).toBe(0);
    expect(stats.orphanToolResultsDowngraded).toBe(0);
  });

  test("inserts synthetic web_search_tool_result when missing", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Search" }] },
      {
        role: "assistant",
        content: [
          {
            type: "server_tool_use",
            id: "stu_1",
            name: "web_search",
            input: { query: "test" },
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "text", text: "next message" }],
      },
    ];

    const { messages: repaired, stats } = repairHistory(messages);

    expect(stats.missingToolResultsInserted).toBe(1);

    const userMsg = repaired[2];
    const wsBlocks = userMsg.content.filter(
      (b) => b.type === "web_search_tool_result",
    );
    expect(wsBlocks).toHaveLength(1);
    expect(wsBlocks[0]).toMatchObject({
      type: "web_search_tool_result",
      tool_use_id: "stu_1",
      content: { type: "web_search_tool_result_error", error_code: "unavailable" },
    });
  });

  test("does not orphan web_search_tool_result paired with server_tool_use", () => {
    // This is the exact scenario from the bug: server_tool_use followed by
    // web_search_tool_result should NOT be treated as orphaned
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Search" }] },
      {
        role: "assistant",
        content: [
          {
            type: "server_tool_use",
            id: "srvtoolu_abc",
            name: "web_search",
            input: { query: "test" },
          },
          {
            type: "tool_use",
            id: "tu_1",
            name: "bash",
            input: { cmd: "ls" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "web_search_tool_result",
            tool_use_id: "srvtoolu_abc",
            content: [{ type: "web_search_result", url: "https://example.com" }],
          },
          { type: "tool_result", tool_use_id: "tu_1", content: "files" },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Done" }],
      },
    ];

    const { messages: repaired, stats } = repairHistory(messages);

    expect(stats.orphanToolResultsDowngraded).toBe(0);
    expect(stats.missingToolResultsInserted).toBe(0);
    expect(repaired).toEqual(messages);
  });

  test("injects synthetic user message for trailing server_tool_use", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Go" }] },
      {
        role: "assistant",
        content: [
          {
            type: "server_tool_use",
            id: "stu_1",
            name: "web_search",
            input: { query: "test" },
          },
        ],
      },
    ];

    const { messages: repaired, stats } = repairHistory(messages);

    expect(stats.missingToolResultsInserted).toBe(1);
    expect(repaired).toHaveLength(3);
    expect(repaired[2].role).toBe("user");
    expect(repaired[2].content[0]).toMatchObject({
      type: "web_search_tool_result",
      tool_use_id: "stu_1",
      content: { type: "web_search_tool_result_error", error_code: "unavailable" },
    });
  });

  test("downgrades type-mismatched tool_result for server_tool_use", () => {
    // A tool_result paired with a server_tool_use ID is a type mismatch —
    // the provider requires web_search_tool_result for server_tool_use
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Search" }] },
      {
        role: "assistant",
        content: [
          {
            type: "server_tool_use",
            id: "stu_1",
            name: "web_search",
            input: { query: "test" },
          },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "stu_1", content: "wrong type" },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Done" }],
      },
    ];

    const { messages: repaired, stats } = repairHistory(messages);

    // The mismatched tool_result should be downgraded and a synthetic web_search_tool_result inserted
    expect(stats.orphanToolResultsDowngraded).toBe(1);
    expect(stats.missingToolResultsInserted).toBe(1);

    const userMsg = repaired[2];
    const wsBlocks = userMsg.content.filter(
      (b) => b.type === "web_search_tool_result",
    );
    expect(wsBlocks).toHaveLength(1);
    expect(wsBlocks[0]).toMatchObject({
      type: "web_search_tool_result",
      tool_use_id: "stu_1",
      content: { type: "web_search_tool_result_error", error_code: "unavailable" },
    });
  });

  test("downgrades type-mismatched web_search_tool_result for tool_use", () => {
    // A web_search_tool_result paired with a regular tool_use ID is a type mismatch
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Go" }] },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_1", name: "bash", input: { cmd: "ls" } },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "web_search_tool_result",
            tool_use_id: "tu_1",
            content: [{ type: "web_search_result", url: "https://example.com" }],
          },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Done" }],
      },
    ];

    const { messages: repaired, stats } = repairHistory(messages);

    expect(stats.orphanToolResultsDowngraded).toBe(1);
    expect(stats.missingToolResultsInserted).toBe(1);

    const userMsg = repaired[2];
    const trBlocks = userMsg.content.filter((b) => b.type === "tool_result");
    expect(trBlocks).toHaveLength(1);
    expect(trBlocks[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "tu_1",
      is_error: true,
    });
  });
});

describe("deepRepairHistory", () => {
  test("merges consecutive same-role messages", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "user", content: [{ type: "text", text: "World" }] },
      { role: "assistant", content: [{ type: "text", text: "Hi" }] },
    ];

    const { messages: repaired } = deepRepairHistory(messages);

    expect(repaired).toHaveLength(2);
    expect(repaired[0].role).toBe("user");
    expect(repaired[0].content).toHaveLength(2);
    expect(repaired[1].role).toBe("assistant");
  });

  test("strips leading assistant messages", () => {
    const messages: Message[] = [
      { role: "assistant", content: [{ type: "text", text: "Stale" }] },
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [{ type: "text", text: "Hi" }] },
    ];

    const { messages: repaired } = deepRepairHistory(messages);

    expect(repaired).toHaveLength(2);
    expect(repaired[0].role).toBe("user");
  });

  test("removes empty messages", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [] },
      { role: "assistant", content: [{ type: "text", text: "Hi" }] },
    ];

    const { messages: repaired } = deepRepairHistory(messages);

    expect(repaired).toHaveLength(2);
    expect(repaired[0].role).toBe("user");
    expect(repaired[1].role).toBe("assistant");
    expect(repaired[1].content[0]).toEqual({ type: "text", text: "Hi" });
  });

  test("applies standard repair after deep pass", () => {
    // Consecutive assistant messages with tool_use but missing tool_result
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Go" }] },
      { role: "user", content: [{ type: "text", text: "more context" }] },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_1", name: "bash", input: { cmd: "ls" } },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Done" }],
      },
    ];

    const { messages: repaired, stats } = deepRepairHistory(messages);

    // User messages merged, then tool_result inserted between assistants
    expect(repaired[0].role).toBe("user");
    expect(repaired[0].content).toHaveLength(2);
    expect(stats.missingToolResultsInserted).toBe(1);
  });

  test("no-op for already-valid history", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [{ type: "text", text: "Hi" }] },
    ];

    const { messages: repaired, stats } = deepRepairHistory(messages);

    expect(repaired).toEqual(messages);
    expect(stats.assistantToolResultsMigrated).toBe(0);
    expect(stats.missingToolResultsInserted).toBe(0);
    expect(stats.orphanToolResultsDowngraded).toBe(0);
  });
});
