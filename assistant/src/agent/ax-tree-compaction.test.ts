import { describe, expect, test } from "bun:test";

import type { Message } from "../providers/types.js";
import { compactAxTreeHistory, escapeAxTreeContent } from "./loop.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a user message with a single tool_result containing an AX tree. */
function axTreeToolResult(id: string, axContent: string): Message {
  return {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: id,
        content: `Some preamble\n<ax-tree>\n${axContent}\n</ax-tree>`,
        is_error: false,
      },
    ],
  };
}

/** Build an assistant message (no tool use). */
function assistantText(text: string): Message {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
  };
}

/** Build a user message without AX tree content. */
function userText(text: string): Message {
  return {
    role: "user",
    content: [{ type: "text", text }],
  };
}

// ---------------------------------------------------------------------------
// compactAxTreeHistory
// ---------------------------------------------------------------------------

describe("compactAxTreeHistory", () => {
  test("returns messages unchanged when fewer than MAX_AX_TREES_IN_HISTORY AX trees", () => {
    const messages: Message[] = [
      axTreeToolResult("t1", "tree-1"),
      assistantText("ok"),
      axTreeToolResult("t2", "tree-2"),
    ];
    const result = compactAxTreeHistory(messages);
    expect(result).toBe(messages); // same reference — no copy
  });

  test("returns messages unchanged when exactly MAX_AX_TREES_IN_HISTORY AX trees", () => {
    const messages: Message[] = [
      axTreeToolResult("t1", "tree-1"),
      assistantText("ok"),
      axTreeToolResult("t2", "tree-2"),
    ];
    const result = compactAxTreeHistory(messages);
    expect(result).toBe(messages);
  });

  test("strips oldest AX trees, keeps only last 2 from 5", () => {
    const messages: Message[] = [
      axTreeToolResult("t1", "tree-1"),
      assistantText("ok"),
      axTreeToolResult("t2", "tree-2"),
      assistantText("ok"),
      axTreeToolResult("t3", "tree-3"),
      assistantText("ok"),
      axTreeToolResult("t4", "tree-4"),
      assistantText("ok"),
      axTreeToolResult("t5", "tree-5"),
    ];

    const result = compactAxTreeHistory(messages);

    // Messages at indices 0, 2, 4 should have AX trees stripped (t1, t2, t3)
    for (const idx of [0, 2, 4]) {
      const block = result[idx].content[0];
      expect(block.type).toBe("tool_result");
      if (block.type === "tool_result") {
        expect(block.content).not.toContain("<ax-tree>");
        expect(block.content).toContain("<ax_tree_omitted />");
      }
    }

    // Messages at indices 6, 8 should still have AX trees (t4, t5)
    for (const idx of [6, 8]) {
      const block = result[idx].content[0];
      expect(block.type).toBe("tool_result");
      if (block.type === "tool_result") {
        expect(block.content).toContain("<ax-tree>");
        expect(block.content).not.toContain("<ax_tree_omitted />");
      }
    }
  });

  test("does not modify assistant messages", () => {
    const messages: Message[] = [
      axTreeToolResult("t1", "tree-1"),
      assistantText("ok"),
      axTreeToolResult("t2", "tree-2"),
      assistantText("response with <ax-tree>fake</ax-tree>"),
      axTreeToolResult("t3", "tree-3"),
    ];

    const result = compactAxTreeHistory(messages);

    // Assistant message should be unchanged
    const assistantMsg = result[3];
    expect(assistantMsg.content[0].type).toBe("text");
    if (assistantMsg.content[0].type === "text") {
      expect(assistantMsg.content[0].text).toContain("<ax-tree>");
    }
  });

  test("does not modify user messages without tool_result blocks", () => {
    const messages: Message[] = [
      axTreeToolResult("t1", "tree-1"),
      assistantText("ok"),
      axTreeToolResult("t2", "tree-2"),
      assistantText("ok"),
      userText("Please help"),
      axTreeToolResult("t3", "tree-3"),
    ];

    const result = compactAxTreeHistory(messages);

    // The plain user text message should be untouched
    expect(result[4]).toBe(messages[4]);
  });

  test("preserves non-AX-tree tool_result blocks in stripped messages", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: "normal result without ax tree",
            is_error: false,
          },
          {
            type: "tool_result",
            tool_use_id: "t1-ax",
            content: "<ax-tree>\ntree-1\n</ax-tree>",
            is_error: false,
          },
        ],
      },
      assistantText("ok"),
      axTreeToolResult("t2", "tree-2"),
      assistantText("ok"),
      axTreeToolResult("t3", "tree-3"),
    ];

    const result = compactAxTreeHistory(messages);

    // First message should have the AX tree stripped but normal result preserved
    const firstMsg = result[0];
    const normalBlock = firstMsg.content[0];
    expect(normalBlock.type).toBe("tool_result");
    if (normalBlock.type === "tool_result") {
      expect(normalBlock.content).toBe("normal result without ax tree");
    }

    const axBlock = firstMsg.content[1];
    expect(axBlock.type).toBe("tool_result");
    if (axBlock.type === "tool_result") {
      expect(axBlock.content).toContain("<ax_tree_omitted />");
      expect(axBlock.content).not.toContain("<ax-tree>");
    }
  });

  test("returns empty array for empty input", () => {
    const result = compactAxTreeHistory([]);
    expect(result).toEqual([]);
  });

  test("counts AX trees per block, not per message", () => {
    // One message has two AX tree blocks — they should count as 2 trees
    const messages: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1a",
            content: "<ax-tree>\ntree-1a\n</ax-tree>",
            is_error: false,
          },
          {
            type: "tool_result",
            tool_use_id: "t1b",
            content: "<ax-tree>\ntree-1b\n</ax-tree>",
            is_error: false,
          },
        ],
      },
      assistantText("ok"),
      axTreeToolResult("t2", "tree-2"),
    ];

    const result = compactAxTreeHistory(messages);

    // 3 total AX tree blocks, keep last 2 → strip only first block (t1a)
    const msg0 = result[0];
    const block0 = msg0.content[0];
    expect(block0.type).toBe("tool_result");
    if (block0.type === "tool_result") {
      expect(block0.content).toContain("<ax_tree_omitted />");
      expect(block0.content).not.toContain("<ax-tree>");
    }

    // Second block in same message (t1b) should be kept
    const block1 = msg0.content[1];
    expect(block1.type).toBe("tool_result");
    if (block1.type === "tool_result") {
      expect(block1.content).toContain("<ax-tree>");
      expect(block1.content).not.toContain("<ax_tree_omitted />");
    }

    // Last message (t2) should also be kept
    const lastBlock = result[2].content[0];
    expect(lastBlock.type).toBe("tool_result");
    if (lastBlock.type === "tool_result") {
      expect(lastBlock.content).toContain("<ax-tree>");
    }
  });

  test("is pure — does not mutate input messages", () => {
    const messages: Message[] = [
      axTreeToolResult("t1", "tree-1"),
      assistantText("ok"),
      axTreeToolResult("t2", "tree-2"),
      assistantText("ok"),
      axTreeToolResult("t3", "tree-3"),
    ];

    // Deep copy to compare later
    const originalContent = messages[0].content[0];
    const originalText =
      originalContent.type === "tool_result" ? originalContent.content : "";

    compactAxTreeHistory(messages);

    // Original message should be unchanged
    const afterContent = messages[0].content[0];
    const afterText =
      afterContent.type === "tool_result" ? afterContent.content : "";
    expect(afterText).toBe(originalText);
  });
});

// ---------------------------------------------------------------------------
// escapeAxTreeContent
// ---------------------------------------------------------------------------

describe("escapeAxTreeContent", () => {
  test("escapes literal </ax-tree> inside content", () => {
    const input = "Some XML: <div></ax-tree></div>";
    const result = escapeAxTreeContent(input);
    expect(result).toBe("Some XML: <div>&lt;/ax-tree&gt;</div>");
  });

  test("handles case-insensitive matches", () => {
    const input = "</AX-TREE> and </Ax-Tree>";
    const result = escapeAxTreeContent(input);
    expect(result).toBe("&lt;/ax-tree&gt; and &lt;/ax-tree&gt;");
  });

  test("returns content unchanged when no closing tags present", () => {
    const input = "Normal AX tree content with <ax-tree> opening tag";
    const result = escapeAxTreeContent(input);
    expect(result).toBe(input);
  });

  test("handles empty string", () => {
    expect(escapeAxTreeContent("")).toBe("");
  });
});
