import { describe, expect, it } from "bun:test";

import {
  adjustTailIndexForToolPairing,
  canonicalDateTimeKey,
} from "../context/compactor.js";
import type { Message } from "../providers/types.js";

const userText = (text: string): Message => ({
  role: "user",
  content: [{ type: "text", text }],
});

const userToolResult = (toolUseId: string): Message => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: toolUseId, content: "ok" }],
});

const userToolResultAndText = (toolUseId: string, text: string): Message => ({
  role: "user",
  content: [
    { type: "tool_result", tool_use_id: toolUseId, content: "ok" },
    { type: "text", text },
  ],
});

const assistantToolUse = (id: string): Message => ({
  role: "assistant",
  content: [{ type: "tool_use", id, name: "Bash", input: {} }],
});

const assistantText = (text: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
});

const assistantWebSearch = (id: string): Message => ({
  role: "assistant",
  content: [
    { type: "server_tool_use", id, name: "web_search", input: {} },
    { type: "web_search_tool_result", tool_use_id: id, content: [] },
  ],
});

describe("canonicalDateTimeKey", () => {
  const stored = "2026-04-02 (Thursday) 01:52:33 -05:00 (America/Chicago)";

  it("reduces the verbatim stored format to date+time", () => {
    expect(canonicalDateTimeKey(stored)).toBe("2026-04-02T01:52:33");
  });

  it("matches when the model drops the weekday parens", () => {
    expect(
      canonicalDateTimeKey("2026-04-02 01:52:33 -05:00 (America/Chicago)"),
    ).toBe("2026-04-02T01:52:33");
  });

  it("matches when the model drops the timezone parens", () => {
    expect(canonicalDateTimeKey("2026-04-02 (Thursday) 01:52:33 -05:00")).toBe(
      "2026-04-02T01:52:33",
    );
  });

  it("matches when the model emits ISO-8601 with a T separator", () => {
    expect(canonicalDateTimeKey("2026-04-02T01:52:33-05:00")).toBe(
      "2026-04-02T01:52:33",
    );
  });

  it("matches when the model emits only date and time", () => {
    expect(canonicalDateTimeKey("2026-04-02 01:52:33")).toBe(
      "2026-04-02T01:52:33",
    );
  });

  it("returns null when no date+time pair is present", () => {
    expect(canonicalDateTimeKey("hello world")).toBeNull();
    expect(canonicalDateTimeKey("2026-04-02")).toBeNull();
    expect(canonicalDateTimeKey("01:52:33")).toBeNull();
  });
});

describe("adjustTailIndexForToolPairing", () => {
  it("returns tailIndex unchanged when the tail starts on a clean user turn", () => {
    const messages: Message[] = [
      userText("hi"),
      assistantText("hello"),
      userText("how are you"),
    ];
    expect(adjustTailIndexForToolPairing(messages, 2)).toBe(2);
  });

  it("walks back past the orphan tool_result cluster to the prior user turn", () => {
    const messages: Message[] = [
      userText("setup"),
      assistantText("ok"),
      userText("run a command"),
      assistantToolUse("X"),
      userToolResult("X"),
    ];
    expect(adjustTailIndexForToolPairing(messages, 4)).toBe(2);
  });

  it("keeps walking when the candidate also leads with tool_result", () => {
    const messages: Message[] = [
      userText("first"),
      userText("second"),
      assistantToolUse("X1"),
      userToolResult("X1"),
      assistantToolUse("X2"),
      userToolResult("X2"),
    ];
    expect(adjustTailIndexForToolPairing(messages, 5)).toBe(1);
  });

  it("returns 0 when the walk falls off the front of the array", () => {
    const messages: Message[] = [
      userToolResult("X"),
      assistantToolUse("Y"),
      userToolResult("Y"),
    ];
    expect(adjustTailIndexForToolPairing(messages, 2)).toBe(0);
  });

  it("ignores server-side web_search_tool_result blocks", () => {
    const messages: Message[] = [
      userText("look it up"),
      assistantWebSearch("WS1"),
      userText("thanks"),
    ];
    expect(adjustTailIndexForToolPairing(messages, 2)).toBe(2);
  });

  it("treats mixed tool_result + text user messages as unsafe", () => {
    const messages: Message[] = [
      userText("kick off"),
      assistantToolUse("X"),
      userToolResultAndText("X", "and here is more text"),
    ];
    expect(adjustTailIndexForToolPairing(messages, 2)).toBe(0);
  });

  it("returns tailIndex unchanged when tailIndex is 0", () => {
    const messages: Message[] = [userText("only one")];
    expect(adjustTailIndexForToolPairing(messages, 0)).toBe(0);
  });
});
