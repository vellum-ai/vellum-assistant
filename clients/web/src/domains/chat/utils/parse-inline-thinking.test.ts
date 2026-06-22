import { describe, expect, test } from "bun:test";

import {
  containsInlineThinkingTag,
  parseInlineThinkingTags,
} from "@/domains/chat/utils/parse-inline-thinking";

describe("containsInlineThinkingTag", () => {
  test("detects both tag formats and rejects plain text", () => {
    expect(containsInlineThinkingTag("a <thinking>b</thinking>")).toBe(true);
    expect(containsInlineThinkingTag("a <think>b</think>")).toBe(true);
    expect(containsInlineThinkingTag("no tags here")).toBe(false);
    // The `<think>` needle requires an immediate `>` so `<thinker>` is not a
    // false positive.
    expect(containsInlineThinkingTag("<thinker>nope</thinker>")).toBe(false);
  });
});

describe("parseInlineThinkingTags", () => {
  test("returns null when no tag is present", () => {
    expect(parseInlineThinkingTags("just a normal reply")).toBeNull();
  });

  test("splits a closed tag into thinking and surrounding text", () => {
    expect(
      parseInlineThinkingTags("before <thinking> the plan </thinking> after"),
    ).toEqual([
      { type: "text", text: "before " },
      { type: "thinking", thinking: "the plan" },
      { type: "text", text: " after" },
    ]);
  });

  test("treats an unclosed tag's remainder as still-streaming thinking", () => {
    expect(parseInlineThinkingTags("<thinking>still figuring this out")).toEqual([
      { type: "thinking", thinking: "still figuring this out" },
    ]);
  });

  test("handles multiple blocks interleaved with text", () => {
    expect(
      parseInlineThinkingTags(
        "<thinking>first</thinking>one<thinking>second</thinking>two",
      ),
    ).toEqual([
      { type: "thinking", thinking: "first" },
      { type: "text", text: "one" },
      { type: "thinking", thinking: "second" },
      { type: "text", text: "two" },
    ]);
  });

  test("drops whitespace-only text between tags and empty thinking bodies", () => {
    expect(
      parseInlineThinkingTags("<thinking>a</thinking>\n\n<thinking>b</thinking>"),
    ).toEqual([
      { type: "thinking", thinking: "a" },
      { type: "thinking", thinking: "b" },
    ]);
    expect(parseInlineThinkingTags("<thinking>  </thinking>ok")).toEqual([
      { type: "text", text: "ok" },
    ]);
  });

  test("supports the <think> variant alongside <thinking>", () => {
    expect(
      parseInlineThinkingTags("<think>short form</think>reply"),
    ).toEqual([
      { type: "thinking", thinking: "short form" },
      { type: "text", text: "reply" },
    ]);
  });

  test("a bare opening tag yields no segments", () => {
    expect(parseInlineThinkingTags("<thinking>")).toEqual([]);
  });
});
