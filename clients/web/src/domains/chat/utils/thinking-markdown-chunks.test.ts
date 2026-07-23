import { describe, expect, test } from "bun:test";

import { splitThinkingMarkdownChunks } from "@/domains/chat/utils/thinking-markdown-chunks";

describe("splitThinkingMarkdownChunks", () => {
  test("splits paragraph-style thinking at blank lines", () => {
    expect(
      splitThinkingMarkdownChunks("First thought.\n\nSecond thought."),
    ).toEqual(["First thought.", "Second thought."]);
  });

  test("chunks long list-style thinking without requiring blank lines", () => {
    const content = Array.from({ length: 7 }, (_, i) => `- item ${i + 1}`).join(
      "\n",
    );

    expect(splitThinkingMarkdownChunks(content, { maxLines: 3 })).toEqual([
      "- item 1\n- item 2\n- item 3",
      "- item 4\n- item 5\n- item 6",
      "- item 7",
    ]);
  });

  test("does not split inside fenced code blocks", () => {
    const content = [
      "Before.",
      "",
      "```ts",
      "const a = 1;",
      "",
      "const b = 2;",
      "```",
      "",
      "After.",
    ].join("\n");

    expect(splitThinkingMarkdownChunks(content, { maxLines: 2 })).toEqual([
      "Before.",
      "```ts\nconst a = 1;\n\nconst b = 2;\n```",
      "After.",
    ]);
  });
});
