import { describe, expect, test } from "bun:test";

import { StreamContentShadow } from "../stream-content-shadow.js";

// Mirrors the SDK accumulator's message format, including the trailing
// `. JSON: <buf>` suffix carrying the exact buffer it choked on.
const PARSE_ERROR = new Error(
  "Unable to parse tool parameter JSON from model. Please retry your request " +
    "or adjust your prompt. Error: SyntaxError: JSON Parse error: " +
    "Expected ']'. JSON: {\"content\": [Jul 18 5:15 AM CT] ENTRY TITLE —",
);

function blockStart(index: number, contentBlock: Record<string, unknown>) {
  return { type: "content_block_start", index, content_block: contentBlock };
}

function blockDelta(index: number, delta: Record<string, unknown>) {
  return { type: "content_block_delta", index, delta };
}

function blockStop(index: number) {
  return { type: "content_block_stop", index };
}

function textBlockEvents(index: number, text: string) {
  return [
    blockStart(index, { type: "text", text: "" }),
    blockDelta(index, { type: "text_delta", text }),
    blockStop(index),
  ];
}

describe("StreamContentShadow.salvage", () => {
  test("wraps the in-flight tool call and keeps completed blocks", () => {
    const shadow = new StreamContentShadow();
    for (const event of textBlockEvents(0, "let me save that")) {
      shadow.handleEvent(event);
    }
    shadow.handleEvent(
      blockStart(1, {
        type: "tool_use",
        id: "tu_1",
        name: "remember",
        input: {},
      }),
    );
    shadow.handleEvent(
      blockDelta(1, { type: "input_json_delta", partial_json: '{"content": ' }),
    );
    // The poison delta itself is never observed — the SDK suppresses events
    // after its internal accumulator errors.

    const salvaged = shadow.salvage(PARSE_ERROR);

    expect(salvaged).toBeDefined();
    expect(salvaged!.toolName).toBe("remember");
    expect(salvaged!.message.stop_reason).toBe("tool_use");
    expect(salvaged!.message.content).toEqual([
      { type: "text", text: "let me save that" },
      {
        type: "tool_use",
        id: "tu_1",
        name: "remember",
        // Raw args come from the error's `. JSON:` suffix — the full buffer,
        // including the final chunk the shadow never saw.
        input: { _raw: '{"content": [Jul 18 5:15 AM CT] ENTRY TITLE —' },
      },
    ]);
    expect(salvaged!.rawArgsLength).toBeGreaterThan(0);
  });

  test("falls back to the shadow-accumulated buffer when the error carries no JSON suffix", () => {
    const shadow = new StreamContentShadow();
    shadow.handleEvent(
      blockStart(0, {
        type: "tool_use",
        id: "tu_1",
        name: "remember",
        input: {},
      }),
    );
    shadow.handleEvent(
      blockDelta(0, {
        type: "input_json_delta",
        partial_json: '{"content": [Jul',
      }),
    );

    const salvaged = shadow.salvage(
      new Error("Unable to parse tool parameter JSON from model."),
    );

    expect(salvaged).toBeDefined();
    expect(salvaged!.message.content).toEqual([
      {
        type: "tool_use",
        id: "tu_1",
        name: "remember",
        input: { _raw: '{"content": [Jul' },
      },
    ]);
  });

  test("returns undefined for unrelated errors", () => {
    const shadow = new StreamContentShadow();
    shadow.handleEvent(
      blockStart(0, {
        type: "tool_use",
        id: "tu_1",
        name: "remember",
        input: {},
      }),
    );

    expect(
      shadow.salvage(new Error("Anthropic API error: Request was aborted.")),
    ).toBeUndefined();
  });

  test("returns undefined when no tool_use block is in flight", () => {
    const shadow = new StreamContentShadow();
    for (const event of textBlockEvents(0, "just text")) {
      shadow.handleEvent(event);
    }

    expect(shadow.salvage(PARSE_ERROR)).toBeUndefined();
  });

  test("returns undefined when the in-flight block is not a tool_use", () => {
    const shadow = new StreamContentShadow();
    shadow.handleEvent(blockStart(0, { type: "text", text: "" }));
    shadow.handleEvent(
      blockDelta(0, { type: "text_delta", text: "streaming…" }),
    );

    expect(shadow.salvage(PARSE_ERROR)).toBeUndefined();
  });

  test("parses completed tool calls strictly and preserves multi-block order", () => {
    const shadow = new StreamContentShadow();
    shadow.handleEvent(
      blockStart(0, {
        type: "tool_use",
        id: "tu_1",
        name: "recall",
        input: {},
      }),
    );
    shadow.handleEvent(
      blockDelta(0, { type: "input_json_delta", partial_json: '{"query": ' }),
    );
    shadow.handleEvent(
      blockDelta(0, { type: "input_json_delta", partial_json: '"alice"}' }),
    );
    shadow.handleEvent(blockStop(0));
    shadow.handleEvent(
      blockStart(1, {
        type: "tool_use",
        id: "tu_2",
        name: "remember",
        input: {},
      }),
    );
    shadow.handleEvent(
      blockDelta(1, {
        type: "input_json_delta",
        partial_json: '{"content": [Jul',
      }),
    );

    const salvaged = shadow.salvage(
      new Error("Unable to parse tool parameter JSON from model."),
    );

    expect(salvaged).toBeDefined();
    expect(salvaged!.message.content).toEqual([
      {
        type: "tool_use",
        id: "tu_1",
        name: "recall",
        input: { query: "alice" },
      },
      {
        type: "tool_use",
        id: "tu_2",
        name: "remember",
        input: { _raw: '{"content": [Jul' },
      },
    ]);
  });

  test("wraps a completed tool call whose buffer only satisfied the lenient partial parser", () => {
    const shadow = new StreamContentShadow();
    // `{"content": "abc` parses partially (unterminated string) so the SDK
    // accumulator survives the block — but it is not strict JSON.
    shadow.handleEvent(
      blockStart(0, {
        type: "tool_use",
        id: "tu_1",
        name: "remember",
        input: {},
      }),
    );
    shadow.handleEvent(
      blockDelta(0, {
        type: "input_json_delta",
        partial_json: '{"content": "abc',
      }),
    );
    shadow.handleEvent(blockStop(0));
    shadow.handleEvent(
      blockStart(1, {
        type: "tool_use",
        id: "tu_2",
        name: "remember",
        input: {},
      }),
    );
    shadow.handleEvent(
      blockDelta(1, { type: "input_json_delta", partial_json: "{" }),
    );

    const salvaged = shadow.salvage(
      new Error("Unable to parse tool parameter JSON from model."),
    );

    expect(salvaged).toBeDefined();
    expect(salvaged!.message.content[0]).toEqual({
      type: "tool_use",
      id: "tu_1",
      name: "remember",
      input: { _raw: '{"content": "abc' },
    });
  });

  test("accumulates thinking blocks with signatures", () => {
    const shadow = new StreamContentShadow();
    shadow.handleEvent(blockStart(0, { type: "thinking", thinking: "" }));
    shadow.handleEvent(
      blockDelta(0, { type: "thinking_delta", thinking: "hmm, " }),
    );
    shadow.handleEvent(
      blockDelta(0, { type: "thinking_delta", thinking: "let me save this" }),
    );
    shadow.handleEvent(
      blockDelta(0, { type: "signature_delta", signature: "sig_abc" }),
    );
    shadow.handleEvent(blockStop(0));
    shadow.handleEvent(
      blockStart(1, {
        type: "tool_use",
        id: "tu_1",
        name: "remember",
        input: {},
      }),
    );
    shadow.handleEvent(
      blockDelta(1, { type: "input_json_delta", partial_json: "{" }),
    );

    const salvaged = shadow.salvage(
      new Error("Unable to parse tool parameter JSON from model."),
    );

    expect(salvaged).toBeDefined();
    expect(salvaged!.message.content[0]).toEqual({
      type: "thinking",
      thinking: "hmm, let me save this",
      signature: "sig_abc",
    });
  });
});
