import { describe, expect, test } from "bun:test";

import { sanitizeDisplayMessages } from "@/domains/chat/utils/sanitize-display-messages.js";
import type { DisplayMessage } from "@/domains/chat/types/types.js";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types.js";
import { newStableId } from "@/domains/chat/utils/stable-id.js";

function makeMessage(
  overrides: Partial<DisplayMessage> & { stableId?: string },
): DisplayMessage {
  return {
    stableId: overrides.stableId ?? newStableId("test"),
    role: "assistant",
    content: "",
    ...overrides,
  };
}

function makeToolCall(
  overrides: Partial<ChatMessageToolCall> & { id: string; toolName: string },
): ChatMessageToolCall {
  return {
    input: {},
    status: "completed",
    ...overrides,
  };
}

describe("sanitizeDisplayMessages", () => {
  test("returns the input unchanged when no sub-method fires", () => {
    const messages: DisplayMessage[] = [
      makeMessage({ stableId: "u-1", role: "user", content: "hi", timestamp: 1 }),
      makeMessage({ stableId: "a-1", role: "assistant", content: "hello", timestamp: 2 }),
    ];
    const result = sanitizeDisplayMessages(messages);
    expect(result.map((m) => m.stableId)).toEqual(["u-1", "a-1"]);
  });

  test("does not mutate the input array", () => {
    const messages: DisplayMessage[] = [
      makeMessage({ stableId: "b", role: "assistant", content: "b", timestamp: 200 }),
      makeMessage({ stableId: "a", role: "assistant", content: "a", timestamp: 100 }),
    ];
    const snapshot = messages.map((m) => m.stableId);
    sanitizeDisplayMessages(messages);
    expect(messages.map((m) => m.stableId)).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------------------
// Hack #1 — timestamp sort
// ---------------------------------------------------------------------------

describe("sanitizeDisplayMessages · timestamp sort", () => {
  // These tests intentionally interleave user / assistant rows so the trailing
  // assistant-duplicate hack (#3) never fires and we observe the sort in
  // isolation.
  test("orders timestamped messages ascending", () => {
    const messages: DisplayMessage[] = [
      makeMessage({ stableId: "c", role: "user", content: "c", timestamp: 300 }),
      makeMessage({ stableId: "a", role: "user", content: "a", timestamp: 100 }),
      makeMessage({ stableId: "b", role: "user", content: "b", timestamp: 200 }),
    ];
    const result = sanitizeDisplayMessages(messages);
    expect(result.map((m) => m.stableId)).toEqual(["a", "b", "c"]);
  });

  test("rows without a timestamp keep their original slot", () => {
    const messages: DisplayMessage[] = [
      makeMessage({ stableId: "later-ts", role: "user", content: "x", timestamp: 200 }),
      makeMessage({ stableId: "no-ts", role: "user", content: "y" }),
      makeMessage({ stableId: "earlier-ts", role: "user", content: "z", timestamp: 100 }),
    ];
    const result = sanitizeDisplayMessages(messages);
    expect(result.map((m) => m.stableId)).toEqual([
      "earlier-ts",
      "no-ts",
      "later-ts",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Hack #2 — invalid (blank / phantom) row filter
// ---------------------------------------------------------------------------

describe("sanitizeDisplayMessages · invalid row filter", () => {
  test("drops blank user rows with no content / segments / surfaces / attachments / tool calls", () => {
    const blank = makeMessage({ stableId: "blank", role: "user", content: "" });
    const real = makeMessage({ stableId: "real", role: "user", content: "hi", timestamp: 1 });
    const result = sanitizeDisplayMessages([blank, real]);
    expect(result.map((m) => m.stableId)).toEqual(["real"]);
  });

  test("drops user rows with whitespace-only content", () => {
    const whitespace = makeMessage({
      stableId: "whitespace",
      role: "user",
      content: "   \n\t  ",
    });
    const result = sanitizeDisplayMessages([whitespace]);
    expect(result).toEqual([]);
  });

  test("drops user rows whose textSegments are all empty strings", () => {
    const emptySegments = makeMessage({
      stableId: "empty-segments",
      role: "user",
      content: "",
      textSegments: [{ type: "text", content: "" }],
    });
    const result = sanitizeDisplayMessages([emptySegments]);
    expect(result).toEqual([]);
  });

  test("drops phantom tool-only user messages where every toolName === 'unknown'", () => {
    const phantom = makeMessage({
      stableId: "phantom",
      role: "user",
      content: "",
      toolCalls: [
        makeToolCall({ id: "tc-1", toolName: "unknown", result: "orphan" }),
      ],
    });
    const result = sanitizeDisplayMessages([phantom]);
    expect(result).toEqual([]);
  });

  test("keeps user messages with mixed known + unknown tool calls", () => {
    const mixed = makeMessage({
      stableId: "mixed",
      role: "user",
      content: "",
      toolCalls: [
        makeToolCall({ id: "tc-1", toolName: "unknown", result: "orphan" }),
        makeToolCall({ id: "tc-2", toolName: "bash", result: "file.txt" }),
      ],
    });
    const result = sanitizeDisplayMessages([mixed]);
    expect(result.map((m) => m.stableId)).toEqual(["mixed"]);
  });

  test("never drops assistant rows even when they look 'empty'", () => {
    const emptyAssistant = makeMessage({
      stableId: "empty-asst",
      role: "assistant",
      content: "",
    });
    const result = sanitizeDisplayMessages([emptyAssistant]);
    expect(result.map((m) => m.stableId)).toEqual(["empty-asst"]);
  });

  test("never drops queued user rows", () => {
    const queued = makeMessage({
      stableId: "queued",
      role: "user",
      content: "",
      queueStatus: "queued",
    });
    const result = sanitizeDisplayMessages([queued]);
    expect(result.map((m) => m.stableId)).toEqual(["queued"]);
  });
});

// ---------------------------------------------------------------------------
// Hack #3 — drop a duplicate trailing assistant message
// ---------------------------------------------------------------------------

describe("sanitizeDisplayMessages · drop trailing assistant duplicate", () => {
  test("drops a trailing assistant row that mirrors the previous one (the bug we're patching)", () => {
    // Mirrors production failure: a "server-…" stableId row with `id` set is
    // followed by an "assistant-…" stableId row with `id` undefined.
    const server = makeMessage({
      stableId: "server-abc",
      id: "msg-1",
      role: "assistant",
      content: "Final answer",
      textSegments: [{ type: "text", content: "Final answer" }],
      toolCalls: [
        makeToolCall({ id: "tc-1", toolName: "bash", result: "ok" }),
      ],
      timestamp: 1000,
    });
    const orphan = makeMessage({
      stableId: "assistant-abc",
      role: "assistant",
      content: "Final answer",
      textSegments: [{ type: "text", content: "Final answer" }],
      toolCalls: [
        makeToolCall({ id: "tc-1", toolName: "bash", result: "ok" }),
      ],
      timestamp: 1000,
    });

    const result = sanitizeDisplayMessages([server, orphan]);
    expect(result.map((m) => m.stableId)).toEqual(["server-abc"]);
  });

  test("keeps both rows when only one is the assistant", () => {
    const user = makeMessage({ stableId: "u", role: "user", content: "hi", timestamp: 1 });
    const assistant = makeMessage({
      stableId: "a",
      role: "assistant",
      content: "hi",
      timestamp: 2,
    });
    const result = sanitizeDisplayMessages([user, assistant]);
    expect(result.map((m) => m.stableId)).toEqual(["u", "a"]);
  });

  test("keeps both rows when textSegments differ", () => {
    const first = makeMessage({
      stableId: "first",
      role: "assistant",
      textSegments: [{ type: "text", content: "Answer A" }],
      timestamp: 1,
    });
    const second = makeMessage({
      stableId: "second",
      role: "assistant",
      textSegments: [{ type: "text", content: "Answer B" }],
      timestamp: 2,
    });
    const result = sanitizeDisplayMessages([first, second]);
    expect(result.map((m) => m.stableId)).toEqual(["first", "second"]);
  });

  test("keeps both rows when textSegments lengths differ", () => {
    const first = makeMessage({
      stableId: "first",
      role: "assistant",
      textSegments: [{ type: "text", content: "Answer" }],
      timestamp: 1,
    });
    const second = makeMessage({
      stableId: "second",
      role: "assistant",
      textSegments: [
        { type: "text", content: "Answer" },
        { type: "text", content: "More" },
      ],
      timestamp: 2,
    });
    const result = sanitizeDisplayMessages([first, second]);
    expect(result.map((m) => m.stableId)).toEqual(["first", "second"]);
  });

  test("keeps both rows when tool call toolName differs", () => {
    const first = makeMessage({
      stableId: "first",
      role: "assistant",
      toolCalls: [makeToolCall({ id: "tc", toolName: "bash", result: "x" })],
      timestamp: 1,
    });
    const second = makeMessage({
      stableId: "second",
      role: "assistant",
      toolCalls: [makeToolCall({ id: "tc", toolName: "read", result: "x" })],
      timestamp: 2,
    });
    const result = sanitizeDisplayMessages([first, second]);
    expect(result.map((m) => m.stableId)).toEqual(["first", "second"]);
  });

  test("keeps both rows when tool call result differs", () => {
    const first = makeMessage({
      stableId: "first",
      role: "assistant",
      toolCalls: [makeToolCall({ id: "tc", toolName: "bash", result: "a" })],
      timestamp: 1,
    });
    const second = makeMessage({
      stableId: "second",
      role: "assistant",
      toolCalls: [makeToolCall({ id: "tc", toolName: "bash", result: "b" })],
      timestamp: 2,
    });
    const result = sanitizeDisplayMessages([first, second]);
    expect(result.map((m) => m.stableId)).toEqual(["first", "second"]);
  });

  test("keeps both rows when tool call counts differ", () => {
    const first = makeMessage({
      stableId: "first",
      role: "assistant",
      toolCalls: [makeToolCall({ id: "tc", toolName: "bash", result: "x" })],
      timestamp: 1,
    });
    const second = makeMessage({
      stableId: "second",
      role: "assistant",
      toolCalls: [
        makeToolCall({ id: "tc-a", toolName: "bash", result: "x" }),
        makeToolCall({ id: "tc-b", toolName: "bash", result: "y" }),
      ],
      timestamp: 2,
    });
    const result = sanitizeDisplayMessages([first, second]);
    expect(result.map((m) => m.stableId)).toEqual(["first", "second"]);
  });

  test("does not look beyond the trailing pair", () => {
    // Three identical assistant rows in a row — only the very last one is
    // dropped, not the middle one. The hack is intentionally narrow.
    const a = makeMessage({
      stableId: "a",
      role: "assistant",
      textSegments: [{ type: "text", content: "Same" }],
      timestamp: 1,
    });
    const b = makeMessage({
      stableId: "b",
      role: "assistant",
      textSegments: [{ type: "text", content: "Same" }],
      timestamp: 2,
    });
    const c = makeMessage({
      stableId: "c",
      role: "assistant",
      textSegments: [{ type: "text", content: "Same" }],
      timestamp: 3,
    });
    const result = sanitizeDisplayMessages([a, b, c]);
    expect(result.map((m) => m.stableId)).toEqual(["a", "b"]);
  });

  test("handles two assistant rows with no tool calls and matching segments", () => {
    const first = makeMessage({
      stableId: "first",
      role: "assistant",
      textSegments: [{ type: "text", content: "Hi" }],
      timestamp: 1,
    });
    const second = makeMessage({
      stableId: "second",
      role: "assistant",
      textSegments: [{ type: "text", content: "Hi" }],
      timestamp: 2,
    });
    const result = sanitizeDisplayMessages([first, second]);
    expect(result.map((m) => m.stableId)).toEqual(["first"]);
  });

  test("handles two assistant rows with no segments and matching tool calls", () => {
    const first = makeMessage({
      stableId: "first",
      role: "assistant",
      toolCalls: [makeToolCall({ id: "tc", toolName: "bash", result: "x" })],
      timestamp: 1,
    });
    const second = makeMessage({
      stableId: "second",
      role: "assistant",
      toolCalls: [makeToolCall({ id: "tc", toolName: "bash", result: "x" })],
      timestamp: 2,
    });
    const result = sanitizeDisplayMessages([first, second]);
    expect(result.map((m) => m.stableId)).toEqual(["first"]);
  });

  test("single-message arrays are returned unchanged", () => {
    const only = makeMessage({
      stableId: "only",
      role: "assistant",
      content: "lonely",
      timestamp: 1,
    });
    const result = sanitizeDisplayMessages([only]);
    expect(result.map((m) => m.stableId)).toEqual(["only"]);
  });

  test("empty arrays are returned unchanged", () => {
    expect(sanitizeDisplayMessages([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Integration — all three hacks compose
// ---------------------------------------------------------------------------

describe("sanitizeDisplayMessages · integration", () => {
  test("sort → invalid filter → trailing-dup drop runs in order", () => {
    // Construct a messy input that exercises all three hacks at once.
    const phantom = makeMessage({
      stableId: "phantom",
      role: "user",
      content: "",
      toolCalls: [
        makeToolCall({ id: "p", toolName: "unknown", result: "orphan" }),
      ],
      timestamp: 50,
    });
    const userTurn = makeMessage({
      stableId: "user",
      role: "user",
      content: "What's the answer?",
      timestamp: 100,
    });
    // The "real" assistant turn (server-assigned id).
    const server = makeMessage({
      stableId: "server-abc",
      id: "msg-1",
      role: "assistant",
      textSegments: [{ type: "text", content: "42" }],
      timestamp: 200,
    });
    // The duplicate orphan emission (no id, "assistant-…" stableId).
    const orphan = makeMessage({
      stableId: "assistant-abc",
      role: "assistant",
      textSegments: [{ type: "text", content: "42" }],
      timestamp: 200,
    });

    // Insertion order is intentionally jumbled to make sure the sort runs
    // first; `server` precedes `orphan` in the input because the sort is
    // stable on equal timestamps and the production duplicate-emission
    // order is "server row first, orphan row second".
    const result = sanitizeDisplayMessages([phantom, server, orphan, userTurn]);

    // Expect:
    //   - phantom dropped by hack #2,
    //   - rows sorted by timestamp (user → server → orphan after sort),
    //   - trailing orphan dropped by hack #3.
    expect(result.map((m) => m.stableId)).toEqual(["user", "server-abc"]);
  });
});
