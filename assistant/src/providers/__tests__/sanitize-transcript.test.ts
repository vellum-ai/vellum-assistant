import { describe, expect, test } from "bun:test";

import { sanitizeTranscriptForNestedInference } from "../sanitize-transcript.js";
import type { Message } from "../types.js";

describe("sanitizeTranscriptForNestedInference", () => {
  test("drops a trailing dangling tool_use and the now-empty message", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "do the thing" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "working on it" },
          { type: "tool_use", id: "tu_done", name: "search", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_done",
            content: "found it",
          },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_inflight", name: "advisor", input: {} },
        ],
      },
    ];

    const result = sanitizeTranscriptForNestedInference(messages);

    expect(result).toHaveLength(3);
    expect(result[1].content).toEqual([
      { type: "text", text: "working on it" },
      { type: "tool_use", id: "tu_done", name: "search", input: {} },
    ]);
    expect(result[2].role).toBe("user");
    const allToolUseIds = result.flatMap((m) =>
      m.content
        .filter((b) => b.type === "tool_use")
        .map((b) => (b as { id: string }).id),
    );
    expect(allToolUseIds).toEqual(["tu_done"]);
  });

  test("dropToolUseId removes a matched tool_use too", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "calling advisor" },
          { type: "tool_use", id: "tu_advisor", name: "advisor", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_advisor",
            content: "advice",
          },
        ],
      },
    ];

    const result = sanitizeTranscriptForNestedInference(messages, {
      dropToolUseId: "tu_advisor",
    });

    expect(result[0].content).toEqual([
      { type: "text", text: "calling advisor" },
    ]);
  });

  test("preserves a tool_use with a matching tool_result in a later message", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_ok", name: "search", input: { q: "x" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu_ok", content: "result" },
        ],
      },
    ];

    const result = sanitizeTranscriptForNestedInference(messages);

    expect(result).toEqual(messages);
  });

  test("does not mutate the input", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "thinking" },
          { type: "tool_use", id: "tu_inflight", name: "advisor", input: {} },
        ],
      },
    ];
    const snapshot = structuredClone(messages);

    sanitizeTranscriptForNestedInference(messages, {
      dropToolUseId: "tu_inflight",
    });

    expect(messages).toEqual(snapshot);
  });
});
