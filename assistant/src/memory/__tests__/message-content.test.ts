import { describe, expect, test } from "bun:test";

import { stringifyMessageContent } from "../message-content.js";

describe("stringifyMessageContent", () => {
  test("returns trimmed raw text for legacy plain-string rows", () => {
    expect(stringifyMessageContent("  hello world  ")).toBe("hello world");
  });

  test("returns trimmed inner string when JSON parses to a string", () => {
    expect(stringifyMessageContent(JSON.stringify("  inner  "))).toBe("inner");
  });

  test("concatenates text blocks from a ContentBlock[] payload", () => {
    const raw = JSON.stringify([
      { type: "text", text: "alpha" },
      { type: "tool_use", id: "x", name: "noop", input: {} },
      { type: "text", text: "beta" },
    ]);
    expect(stringifyMessageContent(raw)).toBe("alpha\nbeta");
  });

  test("falls back to raw trimmed text when JSON parses to a non-array object", () => {
    const raw = '  {"type":"text","text":"hi"}  ';
    expect(stringifyMessageContent(raw)).toBe('{"type":"text","text":"hi"}');
  });

  test("falls back to raw trimmed text when JSON parses to a number", () => {
    expect(stringifyMessageContent("  42  ")).toBe("42");
  });

  test("returns trimmed raw text when JSON parsing fails", () => {
    expect(stringifyMessageContent("  not json  ")).toBe("not json");
  });
});
