import { describe, expect, test } from "bun:test";

import { stripHistoricalThinkingBlocks } from "../daemon/thinking-history.js";
import type { Message } from "../providers/types.js";

describe("stripHistoricalThinkingBlocks", () => {
  test("no-op when no thinking blocks are present", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [{ type: "text", text: "Hi" }] },
    ];

    const { messages: result, stats } = stripHistoricalThinkingBlocks(messages);

    expect(result).toEqual(messages);
    expect(stats.blocksStripped).toBe(0);
    expect(stats.messagesModified).toBe(0);
  });

  test("strips thinking blocks from all assistant messages except the last", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Q1" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "r1", signature: "sig-1" },
          { type: "text", text: "A1" },
        ],
      },
      { role: "user", content: [{ type: "text", text: "Q2" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "r2", signature: "sig-2" },
          { type: "text", text: "A2" },
        ],
      },
      { role: "user", content: [{ type: "text", text: "Q3" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "r3-latest", signature: "sig-3" },
          { type: "text", text: "A3" },
        ],
      },
    ];

    const { messages: result, stats } = stripHistoricalThinkingBlocks(messages);

    expect(stats.blocksStripped).toBe(2);
    expect(stats.messagesModified).toBe(2);
    // First two assistant messages lose their thinking blocks
    expect(result[1].content).toEqual([{ type: "text", text: "A1" }]);
    expect(result[3].content).toEqual([{ type: "text", text: "A2" }]);
    // Latest assistant message keeps its thinking block
    expect(result[5].content).toEqual([
      { type: "thinking", thinking: "r3-latest", signature: "sig-3" },
      { type: "text", text: "A3" },
    ]);
  });

  test("strips redacted_thinking along with thinking", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Q1" }] },
      {
        role: "assistant",
        content: [
          { type: "redacted_thinking", data: "opaque-1" },
          { type: "thinking", thinking: "r1", signature: "sig-1" },
          { type: "text", text: "A1" },
        ],
      },
      { role: "user", content: [{ type: "text", text: "Q2" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "Latest" }],
      },
    ];

    const { messages: result, stats } = stripHistoricalThinkingBlocks(messages);

    expect(stats.blocksStripped).toBe(2);
    expect(stats.messagesModified).toBe(1);
    expect(result[1].content).toEqual([{ type: "text", text: "A1" }]);
  });

  test("never touches user messages", () => {
    // User messages do not contain real thinking blocks, but confirm the
    // filter is keyed on assistant role.
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "Q" },
          // synthetic: if a user message ever had one, we still leave it alone
          { type: "thinking", thinking: "bogus", signature: "sig-u" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "r1", signature: "sig-1" },
          { type: "text", text: "A" },
        ],
      },
    ];

    const { messages: result, stats } = stripHistoricalThinkingBlocks(messages);

    expect(stats.blocksStripped).toBe(0);
    expect(stats.messagesModified).toBe(0);
    // User message untouched; the assistant message is the "latest" and
    // thus preserved too.
    expect(result).toEqual(messages);
  });

  test("preserves thinking block when there is only one assistant message", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Q" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "r", signature: "sig" },
          { type: "text", text: "A" },
        ],
      },
    ];

    const { messages: result, stats } = stripHistoricalThinkingBlocks(messages);

    expect(stats.blocksStripped).toBe(0);
    expect(result).toEqual(messages);
  });

  test("leaves non-thinking blocks on stripped messages intact", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Q1" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "r1", signature: "sig-1" },
          { type: "text", text: "partial" },
          { type: "tool_use", id: "tu_1", name: "bash", input: { cmd: "ls" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
      },
    ];

    const { messages: result, stats } = stripHistoricalThinkingBlocks(messages);

    expect(stats.blocksStripped).toBe(1);
    expect(result[1].content).toEqual([
      { type: "text", text: "partial" },
      { type: "tool_use", id: "tu_1", name: "bash", input: { cmd: "ls" } },
    ]);
  });
});
