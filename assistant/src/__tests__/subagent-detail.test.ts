/**
 * Tests for parseSubagentMessages — verifies that tool result content is
 * correctly extracted from both string and array formats.
 */

import { describe, expect, test } from "bun:test";

import type { MessageRow } from "../memory/conversation-crud.js";
import { parseSubagentMessages } from "../runtime/routes/subagents-routes.js";

let msgCounter = 0;
function msg(role: string, content: unknown[]): MessageRow {
  msgCounter += 1;
  return {
    id: `msg-${msgCounter}`,
    conversationId: "conv-1",
    role,
    content: JSON.stringify(content),
    createdAt: Date.now(),
    metadata: null,
  };
}

describe("parseSubagentMessages", () => {
  test("extracts string tool_result content", () => {
    const messages = [
      msg("user", [{ type: "text", text: "Do something" }]),
      msg("assistant", [
        {
          type: "tool_use",
          id: "t1",
          name: "web_search",
          input: { query: "test" },
        },
      ]),
      msg("user", [
        {
          type: "tool_result",
          tool_use_id: "t1",
          content: "Search results here",
        },
      ]),
    ];

    const result = parseSubagentMessages("sub-1", messages);
    const toolResult = result.events.find((e) => e.type === "tool_result");
    expect(toolResult).toBeDefined();
    expect(toolResult!.content).toBe("Search results here");
    expect(toolResult!.toolName).toBe("web_search");
  });

  test("extracts array-format tool_result content", () => {
    const messages = [
      msg("user", [{ type: "text", text: "Do something" }]),
      msg("assistant", [
        {
          type: "tool_use",
          id: "t2",
          name: "file_read",
          input: { file_path: "/tmp/test.txt" },
        },
      ]),
      msg("user", [
        {
          type: "tool_result",
          tool_use_id: "t2",
          content: [
            { type: "text", text: "Line 1 of file" },
            { type: "text", text: "Line 2 of file" },
          ],
        },
      ]),
    ];

    const result = parseSubagentMessages("sub-1", messages);
    const toolResult = result.events.find((e) => e.type === "tool_result");
    expect(toolResult).toBeDefined();
    expect(toolResult!.content).toBe("Line 1 of file\nLine 2 of file");
    expect(toolResult!.toolName).toBe("file_read");
  });

  test("handles null tool_result content gracefully", () => {
    const messages = [
      msg("user", [{ type: "text", text: "Do something" }]),
      msg("assistant", [
        {
          type: "tool_use",
          id: "t3",
          name: "bash",
          input: { command: "echo hi" },
        },
      ]),
      msg("user", [{ type: "tool_result", tool_use_id: "t3", content: null }]),
    ];

    const result = parseSubagentMessages("sub-1", messages);
    const toolResult = result.events.find((e) => e.type === "tool_result");
    expect(toolResult).toBeDefined();
    expect(toolResult!.content).toBe("");
  });

  test("extracts objective from first user message", () => {
    const messages = [
      msg("user", [{ type: "text", text: "Research vampire lore" }]),
      msg("assistant", [{ type: "text", text: "On it." }]),
    ];

    const result = parseSubagentMessages("sub-1", messages);
    expect(result.objective).toBe("Research vampire lore");
  });

  test("strips fork directive framing from objective", () => {
    const forkPrompt = [
      "⎯⎯⎯ FORK TASK ⎯⎯⎯",
      "You have been forked from the parent conversation to execute a specific task.",
      "The conversation above is context — do NOT continue it. Do NOT spawn sub-agents.",
      "Complete this task directly and return only your findings:",
      "",
      "Research vampire lore",
      "⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯",
    ].join("\n");

    const messages = [
      msg("user", [{ type: "text", text: forkPrompt }]),
      msg("assistant", [{ type: "text", text: "On it." }]),
    ];

    const result = parseSubagentMessages("sub-1", messages);
    expect(result.objective).toBe("Research vampire lore");
  });

  test("includes messageId on text events from assistant messages", () => {
    const messages = [
      msg("user", [{ type: "text", text: "Do something" }]),
      msg("assistant", [{ type: "text", text: "Done." }]),
    ];

    const result = parseSubagentMessages("sub-1", messages);
    const textEvent = result.events.find((e) => e.type === "text");
    expect(textEvent).toBeDefined();
    expect(textEvent!.messageId).toBe(messages[1].id);
  });
});
