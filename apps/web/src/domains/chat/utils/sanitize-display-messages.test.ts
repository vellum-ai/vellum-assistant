import { describe, expect, test } from "bun:test";

import { sanitizeDisplayMessages } from "@/domains/chat/utils/sanitize-display-messages";
import type { DisplayMessage } from "@/domains/chat/types/types";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
function makeMessage(
  overrides: Partial<DisplayMessage> & { id?: string },
): DisplayMessage {
  return {
    id: overrides.id ?? crypto.randomUUID(),
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
      makeMessage({ id: "u-1", role: "user", content: "hi", timestamp: 1 }),
      makeMessage({ id: "a-1", role: "assistant", content: "hello", timestamp: 2 }),
    ];
    const result = sanitizeDisplayMessages(messages);
    expect(result.map((m) => m.id)).toEqual(["u-1", "a-1"]);
  });

  test("does not mutate the input array", () => {
    const messages: DisplayMessage[] = [
      makeMessage({ id: "b", role: "assistant", content: "b", timestamp: 200 }),
      makeMessage({ id: "a", role: "assistant", content: "a", timestamp: 100 }),
    ];
    const snapshot = messages.map((m) => m.id);
    sanitizeDisplayMessages(messages);
    expect(messages.map((m) => m.id)).toEqual(snapshot);
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
      makeMessage({ id: "c", role: "user", content: "c", timestamp: 300 }),
      makeMessage({ id: "a", role: "user", content: "a", timestamp: 100 }),
      makeMessage({ id: "b", role: "user", content: "b", timestamp: 200 }),
    ];
    const result = sanitizeDisplayMessages(messages);
    expect(result.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  test("rows without a timestamp keep their original slot", () => {
    const messages: DisplayMessage[] = [
      makeMessage({ id: "later-ts", role: "user", content: "x", timestamp: 200 }),
      makeMessage({ id: "no-ts", role: "user", content: "y" }),
      makeMessage({ id: "earlier-ts", role: "user", content: "z", timestamp: 100 }),
    ];
    const result = sanitizeDisplayMessages(messages);
    expect(result.map((m) => m.id)).toEqual([
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
    const blank = makeMessage({ id: "blank", role: "user", content: "" });
    const real = makeMessage({ id: "real", role: "user", content: "hi", timestamp: 1 });
    const result = sanitizeDisplayMessages([blank, real]);
    expect(result.map((m) => m.id)).toEqual(["real"]);
  });

  test("drops user rows with whitespace-only content", () => {
    const whitespace = makeMessage({
      id: "whitespace",
      role: "user",
      content: "   \n\t  ",
    });
    const result = sanitizeDisplayMessages([whitespace]);
    expect(result).toEqual([]);
  });

  test("drops user rows whose textSegments are all empty strings", () => {
    const emptySegments = makeMessage({
      id: "empty-segments",
      role: "user",
      content: "",
      textSegments: [{ type: "text", content: "" }],
    });
    const result = sanitizeDisplayMessages([emptySegments]);
    expect(result).toEqual([]);
  });

  test("drops phantom tool-only user messages where every toolName === 'unknown'", () => {
    const phantom = makeMessage({
      id: "phantom",
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
      id: "mixed",
      role: "user",
      content: "",
      toolCalls: [
        makeToolCall({ id: "tc-1", toolName: "unknown", result: "orphan" }),
        makeToolCall({ id: "tc-2", toolName: "bash", result: "file.txt" }),
      ],
    });
    const result = sanitizeDisplayMessages([mixed]);
    expect(result.map((m) => m.id)).toEqual(["mixed"]);
  });

  test("never drops assistant rows even when they look 'empty'", () => {
    const emptyAssistant = makeMessage({
      id: "empty-asst",
      role: "assistant",
      content: "",
    });
    const result = sanitizeDisplayMessages([emptyAssistant]);
    expect(result.map((m) => m.id)).toEqual(["empty-asst"]);
  });

  test("never drops queued user rows", () => {
    const queued = makeMessage({
      id: "queued",
      role: "user",
      content: "",
      queueStatus: "queued",
    });
    const result = sanitizeDisplayMessages([queued]);
    expect(result.map((m) => m.id)).toEqual(["queued"]);
  });
});

// ---------------------------------------------------------------------------
// Hack #3 — drop a duplicate trailing assistant message
// ---------------------------------------------------------------------------

describe("sanitizeDisplayMessages · drop trailing assistant duplicate", () => {
  test("drops a trailing assistant row that mirrors the previous one (the bug we're patching)", () => {
    // Mirrors production failure: a server-id row is followed by a
    // sibling row whose `id` is a different value (here a synthesized
    // optimistic-style id).
    const server = makeMessage({
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
      id: "assistant-abc",
      role: "assistant",
      content: "Final answer",
      textSegments: [{ type: "text", content: "Final answer" }],
      toolCalls: [
        makeToolCall({ id: "tc-1", toolName: "bash", result: "ok" }),
      ],
      timestamp: 1000,
    });

    const result = sanitizeDisplayMessages([server, orphan]);
    expect(result.map((m) => m.id)).toEqual(["msg-1"]);
  });

  test("keeps both rows when only one is the assistant", () => {
    const user = makeMessage({ id: "u", role: "user", content: "hi", timestamp: 1 });
    const assistant = makeMessage({
      id: "a",
      role: "assistant",
      content: "hi",
      timestamp: 2,
    });
    const result = sanitizeDisplayMessages([user, assistant]);
    expect(result.map((m) => m.id)).toEqual(["u", "a"]);
  });

  test("keeps both rows when textSegments differ", () => {
    const first = makeMessage({
      id: "first",
      role: "assistant",
      textSegments: [{ type: "text", content: "Answer A" }],
      timestamp: 1,
    });
    const second = makeMessage({
      id: "second",
      role: "assistant",
      textSegments: [{ type: "text", content: "Answer B" }],
      timestamp: 2,
    });
    const result = sanitizeDisplayMessages([first, second]);
    expect(result.map((m) => m.id)).toEqual(["first", "second"]);
  });

  test("keeps both rows when textSegments lengths differ", () => {
    const first = makeMessage({
      id: "first",
      role: "assistant",
      textSegments: [{ type: "text", content: "Answer" }],
      timestamp: 1,
    });
    const second = makeMessage({
      id: "second",
      role: "assistant",
      textSegments: [
        { type: "text", content: "Answer" },
        { type: "text", content: "More" },
      ],
      timestamp: 2,
    });
    const result = sanitizeDisplayMessages([first, second]);
    expect(result.map((m) => m.id)).toEqual(["first", "second"]);
  });

  test("keeps both rows when tool call toolName differs", () => {
    const first = makeMessage({
      id: "first",
      role: "assistant",
      toolCalls: [makeToolCall({ id: "tc", toolName: "bash", result: "x" })],
      timestamp: 1,
    });
    const second = makeMessage({
      id: "second",
      role: "assistant",
      toolCalls: [makeToolCall({ id: "tc", toolName: "read", result: "x" })],
      timestamp: 2,
    });
    const result = sanitizeDisplayMessages([first, second]);
    expect(result.map((m) => m.id)).toEqual(["first", "second"]);
  });

  test("keeps both rows when tool call result differs", () => {
    const first = makeMessage({
      id: "first",
      role: "assistant",
      toolCalls: [makeToolCall({ id: "tc", toolName: "bash", result: "a" })],
      timestamp: 1,
    });
    const second = makeMessage({
      id: "second",
      role: "assistant",
      toolCalls: [makeToolCall({ id: "tc", toolName: "bash", result: "b" })],
      timestamp: 2,
    });
    const result = sanitizeDisplayMessages([first, second]);
    expect(result.map((m) => m.id)).toEqual(["first", "second"]);
  });

  test("keeps both rows when tool call counts differ", () => {
    const first = makeMessage({
      id: "first",
      role: "assistant",
      toolCalls: [makeToolCall({ id: "tc", toolName: "bash", result: "x" })],
      timestamp: 1,
    });
    const second = makeMessage({
      id: "second",
      role: "assistant",
      toolCalls: [
        makeToolCall({ id: "tc-a", toolName: "bash", result: "x" }),
        makeToolCall({ id: "tc-b", toolName: "bash", result: "y" }),
      ],
      timestamp: 2,
    });
    const result = sanitizeDisplayMessages([first, second]);
    expect(result.map((m) => m.id)).toEqual(["first", "second"]);
  });

  test("does not look beyond the trailing pair", () => {
    // Three identical assistant rows in a row — only the very last one is
    // dropped, not the middle one. The hack is intentionally narrow.
    const a = makeMessage({
      id: "a",
      role: "assistant",
      textSegments: [{ type: "text", content: "Same" }],
      timestamp: 1,
    });
    const b = makeMessage({
      id: "b",
      role: "assistant",
      textSegments: [{ type: "text", content: "Same" }],
      timestamp: 2,
    });
    const c = makeMessage({
      id: "c",
      role: "assistant",
      textSegments: [{ type: "text", content: "Same" }],
      timestamp: 3,
    });
    const result = sanitizeDisplayMessages([a, b, c]);
    expect(result.map((m) => m.id)).toEqual(["a", "b"]);
  });

  test("handles two assistant rows with no tool calls and matching segments", () => {
    const first = makeMessage({
      id: "first",
      role: "assistant",
      textSegments: [{ type: "text", content: "Hi" }],
      timestamp: 1,
    });
    const second = makeMessage({
      id: "second",
      role: "assistant",
      textSegments: [{ type: "text", content: "Hi" }],
      timestamp: 2,
    });
    const result = sanitizeDisplayMessages([first, second]);
    expect(result.map((m) => m.id)).toEqual(["first"]);
  });

  test("handles two assistant rows with no segments and matching tool calls", () => {
    const first = makeMessage({
      id: "first",
      role: "assistant",
      toolCalls: [makeToolCall({ id: "tc", toolName: "bash", result: "x" })],
      timestamp: 1,
    });
    const second = makeMessage({
      id: "second",
      role: "assistant",
      toolCalls: [makeToolCall({ id: "tc", toolName: "bash", result: "x" })],
      timestamp: 2,
    });
    const result = sanitizeDisplayMessages([first, second]);
    expect(result.map((m) => m.id)).toEqual(["first"]);
  });

  test("single-message arrays are returned unchanged", () => {
    const only = makeMessage({
      id: "only",
      role: "assistant",
      content: "lonely",
      timestamp: 1,
    });
    const result = sanitizeDisplayMessages([only]);
    expect(result.map((m) => m.id)).toEqual(["only"]);
  });

  test("empty arrays are returned unchanged", () => {
    expect(sanitizeDisplayMessages([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Hack #4 — repair dangling tool calls on older assistant messages
// ---------------------------------------------------------------------------

describe("sanitizeDisplayMessages · repair dangling tool calls", () => {
  const SYNTHETIC =
    "Tool call completed on the server, but the result never reached the client. Subsequent assistant activity confirms the tool returned — this is a client-side data loss, not a tool failure.";

  test("patches a running tool call on an older assistant when a later assistant exists", () => {
    const older = makeMessage({
      id: "a-old",
      role: "assistant",
      timestamp: 100,
      toolCalls: [
        makeToolCall({ id: "tc-1", toolName: "bash", status: "running" }),
      ],
    });
    const later = makeMessage({
      id: "a-new",
      role: "assistant",
      content: "follow-up",
      timestamp: 200,
    });
    const [patchedOld, untouchedNew] = sanitizeDisplayMessages([older, later]);
    expect(patchedOld!.toolCalls![0]).toEqual({
      id: "tc-1",
      toolName: "bash",
      input: {},
      status: "error",
      isError: true,
      result: SYNTHETIC,
    });
    // The later assistant is untouched even if it has its own tool calls.
    expect(untouchedNew).toBe(later);
  });

  test("does NOT patch the last assistant — it could still be streaming", () => {
    const userMsg = makeMessage({
      id: "u",
      role: "user",
      content: "go",
      timestamp: 100,
    });
    const last = makeMessage({
      id: "a-last",
      role: "assistant",
      timestamp: 200,
      toolCalls: [
        makeToolCall({ id: "tc-1", toolName: "bash", status: "running" }),
      ],
    });
    const result = sanitizeDisplayMessages([userMsg, last]);
    expect(result[1]).toBe(last);
    expect(result[1]!.toolCalls![0]!.status).toBe("running");
  });

  test("does NOT patch when only a subsequent USER message exists (no assistant proof)", () => {
    const onlyAssistant = makeMessage({
      id: "a-only",
      role: "assistant",
      timestamp: 100,
      toolCalls: [
        makeToolCall({ id: "tc-1", toolName: "bash", status: "running" }),
      ],
    });
    const trailingUser = makeMessage({
      id: "u",
      role: "user",
      content: "ping",
      timestamp: 200,
    });
    const result = sanitizeDisplayMessages([onlyAssistant, trailingUser]);
    expect(result[0]).toBe(onlyAssistant);
    expect(result[0]!.toolCalls![0]!.status).toBe("running");
  });

  test("patches across an intervening user message", () => {
    const a1 = makeMessage({
      id: "a1",
      role: "assistant",
      timestamp: 100,
      toolCalls: [
        makeToolCall({ id: "tc-1", toolName: "bash", status: "running" }),
      ],
    });
    const u = makeMessage({
      id: "u",
      role: "user",
      content: "more",
      timestamp: 200,
    });
    const a2 = makeMessage({
      id: "a2",
      role: "assistant",
      content: "result",
      timestamp: 300,
    });
    const result = sanitizeDisplayMessages([a1, u, a2]);
    expect(result[0]!.toolCalls![0]!.status).toBe("error");
    expect(result[0]!.toolCalls![0]!.result).toBe(SYNTHETIC);
  });

  test("leaves `status: 'completed'` tool calls alone (not dangling)", () => {
    const older = makeMessage({
      id: "a-old",
      role: "assistant",
      timestamp: 100,
      toolCalls: [
        makeToolCall({
          id: "tc-1",
          toolName: "bash",
          status: "completed",
          result: "ok",
        }),
      ],
    });
    const later = makeMessage({
      id: "a-new",
      role: "assistant",
      content: "follow-up",
      timestamp: 200,
    });
    const result = sanitizeDisplayMessages([older, later]);
    // No patching happened → identity preserved (COW guarantee).
    expect(result).toBe(result); // sanity
    expect(result[0]).toBe(older);
    expect(result[1]).toBe(later);
  });

  test("leaves `status: 'error'` tool calls alone (already terminal)", () => {
    const older = makeMessage({
      id: "a-old",
      role: "assistant",
      timestamp: 100,
      toolCalls: [
        makeToolCall({
          id: "tc-1",
          toolName: "bash",
          status: "error",
          isError: true,
          result: "boom",
        }),
      ],
    });
    const later = makeMessage({
      id: "a-new",
      role: "assistant",
      content: "ok",
      timestamp: 200,
    });
    const result = sanitizeDisplayMessages([older, later]);
    expect(result[0]).toBe(older);
    expect(result[0]!.toolCalls![0]!.result).toBe("boom");
  });

  test("patches only the running tool, leaves siblings on the same message alone", () => {
    const older = makeMessage({
      id: "a-old",
      role: "assistant",
      timestamp: 100,
      toolCalls: [
        makeToolCall({
          id: "tc-1",
          toolName: "bash",
          status: "completed",
          result: "first ok",
        }),
        makeToolCall({ id: "tc-2", toolName: "web_search", status: "running" }),
        makeToolCall({
          id: "tc-3",
          toolName: "read_file",
          status: "completed",
          result: "third ok",
        }),
      ],
    });
    const later = makeMessage({
      id: "a-new",
      role: "assistant",
      content: "done",
      timestamp: 200,
    });
    const result = sanitizeDisplayMessages([older, later]);
    expect(result[0]!.toolCalls![0]!.result).toBe("first ok");
    expect(result[0]!.toolCalls![1]!.status).toBe("error");
    expect(result[0]!.toolCalls![1]!.isError).toBe(true);
    expect(result[0]!.toolCalls![1]!.result).toBe(SYNTHETIC);
    expect(result[0]!.toolCalls![2]!.result).toBe("third ok");
  });

  test("patches multiple older assistants in a row", () => {
    const a1 = makeMessage({
      id: "a1",
      role: "assistant",
      timestamp: 100,
      toolCalls: [
        makeToolCall({ id: "tc-1", toolName: "bash", status: "running" }),
      ],
    });
    const a2 = makeMessage({
      id: "a2",
      role: "assistant",
      timestamp: 200,
      toolCalls: [
        makeToolCall({ id: "tc-2", toolName: "bash", status: "running" }),
      ],
    });
    const a3 = makeMessage({
      id: "a3",
      role: "assistant",
      content: "done",
      timestamp: 300,
    });
    const result = sanitizeDisplayMessages([a1, a2, a3]);
    expect(result[0]!.toolCalls![0]!.status).toBe("error");
    expect(result[1]!.toolCalls![0]!.status).toBe("error");
    expect(result[2]).toBe(a3);
  });

  test("does not mutate the input messages or tool-call objects", () => {
    const tc = makeToolCall({ id: "tc", toolName: "bash", status: "running" });
    const older = makeMessage({
      id: "a-old",
      role: "assistant",
      timestamp: 100,
      toolCalls: [tc],
    });
    const later = makeMessage({
      id: "a-new",
      role: "assistant",
      content: "ok",
      timestamp: 200,
    });
    sanitizeDisplayMessages([older, later]);
    expect(tc.status).toBe("running");
    expect(tc.result).toBeUndefined();
    expect(older.toolCalls![0]).toBe(tc);
  });

  test("preserves message identity when no tool calls are dangling", () => {
    // The sort step always returns a new outer array, so the array-identity
    // assertion lives at the *element* level: every message object must be
    // the same reference. Confirms the repair step is COW at the message
    // boundary when nothing needs patching.
    const a1 = makeMessage({
      id: "a1",
      role: "assistant",
      timestamp: 100,
      toolCalls: [
        makeToolCall({
          id: "tc-1",
          toolName: "bash",
          status: "completed",
          result: "ok",
        }),
      ],
    });
    const a2 = makeMessage({
      id: "a2",
      role: "assistant",
      content: "done",
      timestamp: 200,
    });
    const result = sanitizeDisplayMessages([a1, a2]);
    expect(result[0]).toBe(a1);
    expect(result[1]).toBe(a2);
  });

  test("empty array returns empty (no crashes from index math)", () => {
    expect(sanitizeDisplayMessages([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Integration — all four hacks compose
// ---------------------------------------------------------------------------

describe("sanitizeDisplayMessages · integration", () => {
  test("sort → invalid filter → trailing-dup drop → dangling-tool repair runs in order", () => {
    // Construct a messy input that exercises all four hacks at once.
    const phantom = makeMessage({
      id: "phantom",
      role: "user",
      content: "",
      toolCalls: [
        makeToolCall({ id: "p", toolName: "unknown", result: "orphan" }),
      ],
      timestamp: 50,
    });
    const userTurn = makeMessage({
      id: "user",
      role: "user",
      content: "What's the answer?",
      timestamp: 100,
    });
    // An older assistant message with a running tool call — its `tool_result`
    // event was lost in transit. We expect hack #4 to patch this.
    const olderWithDangling = makeMessage({
      id: "older",
      role: "assistant",
      textSegments: [{ type: "text", content: "let me check" }],
      toolCalls: [
        makeToolCall({ id: "tc-x", toolName: "bash", status: "running" }),
      ],
      timestamp: 150,
    });
    // The "real" assistant turn (server-assigned id).
    const server = makeMessage({
      id: "msg-1",
      role: "assistant",
      textSegments: [{ type: "text", content: "42" }],
      timestamp: 200,
    });
    // The duplicate orphan emission (a synthesized optimistic-style id).
    const orphan = makeMessage({
      id: "assistant-abc",
      role: "assistant",
      textSegments: [{ type: "text", content: "42" }],
      timestamp: 200,
    });

    // Insertion order is intentionally jumbled to make sure the sort runs
    // first; `server` precedes `orphan` in the input because the sort is
    // stable on equal timestamps and the production duplicate-emission
    // order is "server row first, orphan row second".
    const result = sanitizeDisplayMessages([
      phantom,
      server,
      orphan,
      olderWithDangling,
      userTurn,
    ]);

    // Expect:
    //   - phantom dropped by hack #2,
    //   - rows sorted by timestamp (user → olderWithDangling → server → orphan),
    //   - trailing orphan dropped by hack #3 (matches `server` on text + tool calls),
    //   - olderWithDangling's running tool call patched by hack #4 because
    //     `server` is a later assistant.
    expect(result.map((m) => m.id)).toEqual([
      "user",
      "older",
      "msg-1",
    ]);
    const patchedTool = result[1]!.toolCalls![0]!;
    expect(patchedTool.status).toBe("error");
    expect(patchedTool.isError).toBe(true);
    expect(patchedTool.result).toContain("client-side data loss");
  });
});
