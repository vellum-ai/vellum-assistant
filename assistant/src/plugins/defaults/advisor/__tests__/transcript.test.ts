import { describe, expect, test } from "bun:test";

import type { ContentBlock, Message } from "../../../../providers/types.js";
import { toAdvisorMessages } from "../transcript.js";

const text = (t: string): ContentBlock => ({ type: "text", text: t });

describe("toAdvisorMessages", () => {
  test("drops thinking and redacted-thinking blocks", () => {
    const messages: Message[] = [
      { role: "user", content: [text("do the task")] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "secret", signature: "sig" },
          { type: "redacted_thinking", data: "blob" },
          text("here is my answer"),
        ],
      },
    ];

    const out = toAdvisorMessages(messages);
    expect(out).toHaveLength(2);
    expect(out[1].content).toEqual([text("here is my answer")]);
  });

  test("strips the pending advisor (and sibling) tool_use from the final assistant turn", () => {
    const messages: Message[] = [
      { role: "user", content: [text("task")] },
      {
        role: "assistant",
        content: [
          text("let me consult the advisor"),
          { type: "tool_use", id: "t1", name: "advisor", input: {} },
          { type: "tool_use", id: "t2", name: "bash", input: { cmd: "ls" } },
        ],
      },
    ];

    const out = toAdvisorMessages(messages);
    // Pending tool calls (no results yet) removed; explanatory text kept.
    expect(out[1].content).toEqual([text("let me consult the advisor")]);
  });

  test("preserves completed tool_use / tool_result pairs in earlier turns", () => {
    const messages: Message[] = [
      { role: "user", content: [text("task")] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "a", name: "bash", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "a", content: "output" }],
      },
      {
        role: "assistant",
        content: [
          text("done thinking"),
          { type: "server_tool_use", id: "b", name: "advisor", input: {} },
        ],
      },
    ];

    const out = toAdvisorMessages(messages);
    // The earlier tool_use and its tool_result survive...
    expect(out[1].content[0]).toEqual({
      type: "tool_use",
      id: "a",
      name: "bash",
      input: {},
    });
    expect(out[2].content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "a",
      content: "output",
    });
    // ...while the final pending advisor call is stripped, leaving only text.
    expect(out[3].content).toEqual([text("done thinking")]);
  });

  test("drops messages that become empty after sanitizing", () => {
    const messages: Message[] = [
      { role: "user", content: [text("task")] },
      {
        role: "assistant",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "x" },
          },
        ],
      },
    ];

    const out = toAdvisorMessages(messages);
    expect(out).toHaveLength(1);
    expect(out[0].content).toEqual([text("task")]);
  });

  test("strips rich contentBlocks from tool_result, keeping the text payload", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "a",
            content: "text payload",
            contentBlocks: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: "x" },
              },
            ],
          },
        ],
      },
    ];

    const out = toAdvisorMessages(messages);
    expect(out[0].content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "a",
      content: "text payload",
      contentBlocks: undefined,
    });
  });
});
