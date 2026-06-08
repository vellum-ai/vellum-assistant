/**
 * Tests for the `/clean` slash command primitives.
 *
 * `/clean` is wired up so that:
 *   1. Runtime injection prefixes are stripped from user-message text blocks
 *      (same allowlist `/compact` uses).
 *   2. Assistant turns, tool_use blocks, and tool_result blocks are preserved
 *      verbatim — `/clean` never alters history shape.
 *   3. The user-facing result message reports tokens reclaimed and the
 *      number of messages preserved.
 *
 * The slash-routing layer is covered by `conversation-slash-commands.test.ts`;
 * the graph-memory eviction hook is covered by the v2 routing tests. This
 * file focuses on the formatter and the strip behavior that defines the
 * "no history loss" contract.
 */
import { describe, expect, test } from "bun:test";

import { formatCleanResult } from "../daemon/conversation-process.js";
import { stripInjectionsForCompaction } from "../daemon/conversation-runtime-assembly.js";
import type { Message } from "../providers/types.js";

describe("formatCleanResult", () => {
  test("formats token reclamation and preserved-message count", () => {
    const out = formatCleanResult({
      previousEstimatedInputTokens: 100_000,
      estimatedInputTokens: 95_000,
      maxInputTokens: 200_000,
      preservedMessages: 250,
    });
    expect(out).toContain("Context Cleaned");
    expect(out).toContain("100,000 → 95,000 (5,000 reclaimed)");
    expect(out).toContain("95,000 / 200,000 tokens");
    expect(out).toContain("250 preserved");
  });

  test("renders zero reclaimed when nothing was stripped", () => {
    const out = formatCleanResult({
      previousEstimatedInputTokens: 12_345,
      estimatedInputTokens: 12_345,
      maxInputTokens: 200_000,
      preservedMessages: 10,
    });
    expect(out).toContain("12,345 → 12,345 (0 reclaimed)");
    expect(out).toContain("10 preserved");
  });
});

describe("stripInjectionsForCompaction preserves history shape", () => {
  test("strips known injection prefixes from user text blocks", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<NOW.md Always keep this up to date>\nfoo\n</NOW.md>",
          },
          { type: "text", text: "Hello, please help with X." },
        ],
      },
    ];
    const out = stripInjectionsForCompaction(messages);
    expect(out).toHaveLength(1);
    expect(out[0].content).toHaveLength(1);
    expect(out[0].content[0]).toEqual({
      type: "text",
      text: "Hello, please help with X.",
    });
  });

  test("preserves assistant turns and tool_use/tool_result blocks verbatim", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<knowledge_base>\nstale kb\n</knowledge_base>",
          },
          { type: "text", text: "Run the calculator." },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Using the calculator." },
          {
            type: "tool_use",
            id: "tool-1",
            name: "calculator",
            input: { expr: "1 + 2" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: "3",
          },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "The answer is 3." }],
      },
    ];

    const out = stripInjectionsForCompaction(messages);

    expect(out).toHaveLength(4);
    expect(out[0].content).toEqual([
      { type: "text", text: "Run the calculator." },
    ]);
    expect(out[1]).toEqual(messages[1]);
    expect(out[2]).toEqual(messages[2]);
    expect(out[3]).toEqual(messages[3]);
  });

  test("strips <workspace> but leaves <turn_context> and <memory __injected> alone", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "<turn_context>\nnow\n</turn_context>" },
          { type: "text", text: "<workspace>\nfiles\n</workspace>" },
          { type: "text", text: "<memory __injected>\nrecent\n</memory>" },
        ],
      },
    ];
    const out = stripInjectionsForCompaction(messages);
    expect(out[0].content).toEqual([
      { type: "text", text: "<turn_context>\nnow\n</turn_context>" },
      { type: "text", text: "<memory __injected>\nrecent\n</memory>" },
    ]);
  });
});
