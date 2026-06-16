import { describe, expect, test } from "bun:test";

import { sanitizeTranscriptForNestedInference } from "../sanitize-transcript.js";
import type { Message } from "../types.js";

describe("sanitizeTranscriptForNestedInference", () => {
  test("drops a trailing dangling tool_use with no matching tool_result", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "calling a tool" },
          { type: "tool_use", id: "call_1", name: "search", input: {} },
        ],
      },
    ];

    const result = sanitizeTranscriptForNestedInference(messages);

    expect(result).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "calling a tool" }] },
    ]);
  });

  test("drops a message left empty after removing its only tool_use", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", name: "search", input: {} }],
      },
    ];

    const result = sanitizeTranscriptForNestedInference(messages);

    expect(result).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
  });

  test("keeps a completed tool_use/tool_result pair untouched", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", name: "search", input: {} }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "result" },
        ],
      },
    ];

    const result = sanitizeTranscriptForNestedInference(messages);

    expect(result).toEqual(messages);
  });

  test("removes paired tool_result when dropToolUseId targets a completed call", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "thinking" },
          { type: "tool_use", id: "advisor_call", name: "advisor", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "advisor_call",
            content: "advice",
          },
        ],
      },
    ];

    const result = sanitizeTranscriptForNestedInference(messages, {
      dropToolUseId: "advisor_call",
    });

    // The assistant tool_use is gone, its text survives, and the user message
    // that held only the paired tool_result is dropped entirely — no orphan.
    expect(result).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "thinking" }] },
    ]);

    const orphanResults = result.flatMap((m) =>
      m.content.filter((b) => b.type === "tool_result"),
    );
    expect(orphanResults).toEqual([]);
  });

  test("removes only the targeted pair, leaving sibling pairs intact", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_keep", name: "search", input: {} },
          { type: "tool_use", id: "call_drop", name: "advisor", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_keep", content: "kept" },
          { type: "tool_result", tool_use_id: "call_drop", content: "dropped" },
        ],
      },
    ];

    const result = sanitizeTranscriptForNestedInference(messages, {
      dropToolUseId: "call_drop",
    });

    expect(result).toEqual([
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_keep", name: "search", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_keep", content: "kept" },
        ],
      },
    ]);
  });

  test("does not mutate the input messages or their content arrays", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "thinking" },
          { type: "tool_use", id: "call_1", name: "search", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "result" },
        ],
      },
    ];
    const snapshot = JSON.parse(JSON.stringify(messages));

    sanitizeTranscriptForNestedInference(messages, { dropToolUseId: "call_1" });

    expect(messages).toEqual(snapshot);
  });

  test("leaves other block types untouched", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm", signature: "sig" },
          { type: "server_tool_use", id: "srv_1", name: "web_search", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "web_search_tool_result",
            tool_use_id: "srv_1",
            content: "opaque",
          },
        ],
      },
    ];

    const result = sanitizeTranscriptForNestedInference(messages, {
      dropToolUseId: "nonexistent",
    });

    expect(result).toEqual(messages);
  });
});
