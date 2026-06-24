import { describe, expect, test } from "bun:test";

import type { ContentBlock, Message } from "../../providers/types.js";
import { sanitizeConsultTranscript } from "../consult-transcript.js";

const text = (t: string): ContentBlock => ({ type: "text", text: t });

describe("sanitizeConsultTranscript", () => {
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
    const out = sanitizeConsultTranscript(messages);
    expect(out).toHaveLength(2);
    expect(out[1].content).toEqual([text("here is my answer")]);
  });

  test("drops a file block", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          text("read this"),
          {
            type: "file",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: "z",
              filename: "f.pdf",
            },
          },
        ],
      },
    ];
    const out = sanitizeConsultTranscript(messages);
    expect(out[0].content).toEqual([text("read this")]);
  });

  test("strips the pending tool_use from the final assistant turn", () => {
    const messages: Message[] = [
      { role: "user", content: [text("task")] },
      {
        role: "assistant",
        content: [
          text("let me consult the advisor"),
          { type: "tool_use", id: "t1", name: "advisor", input: {} },
        ],
      },
    ];
    const out = sanitizeConsultTranscript(messages);
    expect(out[1].content).toEqual([text("let me consult the advisor")]);
  });

  test("preserves completed client tool_use / tool_result pairs in earlier turns", () => {
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
      { role: "assistant", content: [text("done")] },
    ];
    const out = sanitizeConsultTranscript(messages);
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
  });

  test("drops a web-search server_tool_use AND its result together — no orphan", () => {
    const messages: Message[] = [
      { role: "user", content: [text("look it up")] },
      {
        role: "assistant",
        content: [
          text("searching"),
          { type: "server_tool_use", id: "ws1", name: "web_search", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "web_search_tool_result",
            tool_use_id: "ws1",
            content: [{ title: "x", url: "y" }],
          },
        ],
      },
      { role: "assistant", content: [text("found it; here is the answer")] },
    ];
    const out = sanitizeConsultTranscript(messages);
    const flat = out.flatMap((m) => m.content);
    expect(flat.some((b) => b.type === "server_tool_use")).toBe(false);
    expect(flat.some((b) => b.type === "web_search_tool_result")).toBe(false);
    expect(flat).toContainEqual(text("searching"));
    expect(flat).toContainEqual(text("found it; here is the answer"));
  });

  test("keeps top-level image blocks", () => {
    const img: ContentBlock = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "x" },
    };
    const messages: Message[] = [
      { role: "user", content: [text("look at this"), img] },
    ];
    const out = sanitizeConsultTranscript(messages);
    expect(out[0].content).toEqual([text("look at this"), img]);
  });

  test("keeps image contentBlocks on a tool_result, dropping disallowed ones", () => {
    const img: ContentBlock = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "x" },
    };
    const messages: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "a",
            content: "screenshot",
            contentBlocks: [
              img,
              {
                type: "file",
                source: {
                  type: "base64",
                  media_type: "application/pdf",
                  data: "z",
                  filename: "f.pdf",
                },
              },
            ],
          },
        ],
      },
    ];
    const out = sanitizeConsultTranscript(messages);
    expect(out[0].content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "a",
      content: "screenshot",
      contentBlocks: [img],
    });
  });

  test("drops messages that are empty after sanitization", () => {
    const messages: Message[] = [
      { role: "user", content: [text("task")] },
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "secret", signature: "sig" }],
      },
      { role: "assistant", content: [text("answer")] },
    ];
    const out = sanitizeConsultTranscript(messages);
    expect(out).toHaveLength(2);
    expect(out[0].content).toEqual([text("task")]);
    expect(out[1].content).toEqual([text("answer")]);
  });
});
