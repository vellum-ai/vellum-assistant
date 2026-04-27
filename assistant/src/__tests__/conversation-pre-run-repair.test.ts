import { describe, expect, test } from "bun:test";

import { repairHistory } from "../daemon/history-repair.js";
import type { Message } from "../providers/types.js";

describe("pre-run history repair", () => {
  test("missing tool_result after tool_use gets synthesized", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "First" }],
      },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_1", name: "bash", input: { cmd: "ls" } },
        ],
      },
      // Missing tool_result user message
      {
        role: "user",
        content: [{ type: "text", text: "Next question" }],
      },
    ];

    const { messages: repaired, stats } = repairHistory(messages);

    // The user message after the assistant should now contain a tool_result
    const assistantIdx = repaired.findIndex((m) =>
      m.content.some((b) => b.type === "tool_use"),
    );
    const nextUser = repaired[assistantIdx + 1];
    expect(nextUser).toBeDefined();
    expect(nextUser.role).toBe("user");

    const hasResult = nextUser.content.some(
      (b) => b.type === "tool_result" && b.tool_use_id === "tu_1",
    );
    expect(hasResult).toBe(true);
    expect(stats.missingToolResultsInserted).toBe(1);
  });

  test("trailing tool_use with no following message gets synthetic result appended", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Do something" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu_2",
            name: "bash",
            input: { cmd: "echo hi" },
          },
        ],
      },
    ];

    const { messages: repaired, stats } = repairHistory(messages);

    expect(repaired).toHaveLength(3);
    const syntheticUser = repaired[2];
    expect(syntheticUser.role).toBe("user");
    expect(
      syntheticUser.content.some(
        (b) => b.type === "tool_result" && b.tool_use_id === "tu_2",
      ),
    ).toBe(true);
    expect(stats.missingToolResultsInserted).toBe(1);
  });

  test("tool_result in assistant message gets migrated to user message", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu_3",
            name: "bash",
            input: { cmd: "ls" },
          },
          {
            type: "tool_result",
            tool_use_id: "tu_3",
            content: "file.txt",
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "text", text: "Thanks" }],
      },
    ];

    const { messages: repaired, stats } = repairHistory(messages);

    // Assistant message should no longer contain tool_result
    const assistant = repaired.find((m) => m.role === "assistant")!;
    expect(assistant.content.every((b) => b.type !== "tool_result")).toBe(true);

    // A user message between assistant and final user should have the result
    const assistantIdx = repaired.indexOf(assistant);
    const nextUser = repaired[assistantIdx + 1];
    expect(nextUser.role).toBe("user");
    expect(
      nextUser.content.some(
        (b) => b.type === "tool_result" && b.tool_use_id === "tu_3",
      ),
    ).toBe(true);
    expect(stats.assistantToolResultsMigrated).toBe(1);
  });

  test("consecutive same-role messages get merged", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "First" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "Second" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Reply" }],
      },
    ];

    const { messages: repaired, stats } = repairHistory(messages);

    expect(repaired).toHaveLength(2);
    expect(repaired[0].role).toBe("user");
    expect(repaired[0].content).toHaveLength(2);
    expect(stats.consecutiveSameRoleMerged).toBe(1);
  });

  test("clean history passes through unchanged", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Hi there" }],
      },
    ];

    const { messages: repaired, stats } = repairHistory(messages);

    expect(repaired).toHaveLength(2);
    expect(stats.missingToolResultsInserted).toBe(0);
    expect(stats.assistantToolResultsMigrated).toBe(0);
    expect(stats.orphanToolResultsDowngraded).toBe(0);
    expect(stats.consecutiveSameRoleMerged).toBe(0);
  });
});
