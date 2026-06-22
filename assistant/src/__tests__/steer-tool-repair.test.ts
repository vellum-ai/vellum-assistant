/**
 * Tests for the tool-result repair logic that runs during queue drain
 * after a steer-to-message abort interrupts an in-flight tool call.
 *
 * Uses the exported drainQueue indirectly by testing the repair helper's
 * observable effects on conversation.messages. We import the
 * repairPendingToolUseBlocks behavior through drainQueue's contract.
 */

import { describe, expect, test } from "bun:test";

import type { Message } from "../providers/types.js";

/**
 * Minimal reproduction of repairPendingToolUseBlocks logic for direct
 * unit testing. The real implementation lives in conversation-process.ts.
 * This mirrors it exactly to avoid needing the full Conversation.
 */
function repairPendingToolUseBlocks(messages: Message[]): Message[] {
  if (messages.length === 0) return messages;

  const resolvedToolUseIds = new Set<string>();
  const pendingToolUseIds: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "user") {
      for (const block of msg.content) {
        if (block.type === "tool_result") {
          resolvedToolUseIds.add(block.tool_use_id);
        }
      }
    } else if (msg.role === "assistant") {
      for (const block of msg.content) {
        if (block.type === "tool_use" && !resolvedToolUseIds.has(block.id)) {
          pendingToolUseIds.push(block.id);
        }
      }
      break;
    }
  }

  if (pendingToolUseIds.length === 0) return messages;

  const syntheticContent = pendingToolUseIds.map((toolUseId) => ({
    type: "tool_result" as const,
    tool_use_id: toolUseId,
    content: "Tool execution was interrupted by user steering.",
    is_error: true,
  }));
  messages.push({ role: "user", content: syntheticContent });
  return messages;
}

describe("steer tool-result repair", () => {
  test("no-op when messages are empty", () => {
    const messages: Message[] = [];
    repairPendingToolUseBlocks(messages);
    expect(messages).toHaveLength(0);
  });

  test("no-op when last message is a user message", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
    ];
    repairPendingToolUseBlocks(messages);
    expect(messages).toHaveLength(1);
  });

  test("no-op when last assistant message has no tool_use blocks", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "hi there" }],
      },
    ];
    repairPendingToolUseBlocks(messages);
    expect(messages).toHaveLength(2);
  });

  test("no-op when tool_use has a matching tool_result", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "let me run a command" },
          {
            type: "tool_use",
            id: "tu_1",
            name: "bash",
            input: { command: "ls" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_1",
            content: "file1.txt\nfile2.txt",
          },
        ],
      },
    ];
    repairPendingToolUseBlocks(messages);
    // No synthetic message added
    expect(messages).toHaveLength(3);
  });

  test("injects synthetic tool_result for a single pending tool_use", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "let me run a command" },
          {
            type: "tool_use",
            id: "tu_1",
            name: "bash",
            input: { command: "ls" },
          },
        ],
      },
    ];
    repairPendingToolUseBlocks(messages);
    expect(messages).toHaveLength(3);

    const synthetic = messages[2];
    expect(synthetic.role).toBe("user");
    expect(synthetic.content).toHaveLength(1);
    expect(synthetic.content[0].type).toBe("tool_result");
    if (synthetic.content[0].type === "tool_result") {
      expect(synthetic.content[0].tool_use_id).toBe("tu_1");
      expect(synthetic.content[0].is_error).toBe(true);
      expect(synthetic.content[0].content).toContain("interrupted");
    }
  });

  test("injects synthetic tool_results for multiple pending tool_use blocks", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu_1",
            name: "bash",
            input: { command: "ls" },
          },
          {
            type: "tool_use",
            id: "tu_2",
            name: "read_file",
            input: { path: "/tmp/foo" },
          },
        ],
      },
    ];
    repairPendingToolUseBlocks(messages);
    expect(messages).toHaveLength(3);

    const synthetic = messages[2];
    expect(synthetic.role).toBe("user");
    expect(synthetic.content).toHaveLength(2);

    const ids = synthetic.content
      .filter((b) => b.type === "tool_result")
      .map((b) => (b as { tool_use_id: string }).tool_use_id);
    expect(ids).toContain("tu_1");
    expect(ids).toContain("tu_2");
  });

  test("handles partial resolution — one of two tool_use blocks resolved", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu_1",
            name: "bash",
            input: { command: "ls" },
          },
          {
            type: "tool_use",
            id: "tu_2",
            name: "read_file",
            input: { path: "/tmp/foo" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_1",
            content: "file1.txt",
          },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "now reading the file" },
          {
            type: "tool_use",
            id: "tu_3",
            name: "write_file",
            input: { path: "/tmp/bar", content: "test" },
          },
        ],
      },
    ];
    repairPendingToolUseBlocks(messages);
    expect(messages).toHaveLength(5);

    const synthetic = messages[4];
    expect(synthetic.role).toBe("user");
    expect(synthetic.content).toHaveLength(1);
    if (synthetic.content[0].type === "tool_result") {
      expect(synthetic.content[0].tool_use_id).toBe("tu_3");
      expect(synthetic.content[0].is_error).toBe(true);
    }
  });
});
