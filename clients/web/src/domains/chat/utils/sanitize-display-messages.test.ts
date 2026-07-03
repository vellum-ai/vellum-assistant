import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { sanitizeDisplayMessages } from "@/domains/chat/utils/sanitize-display-messages";
import type { DisplayMessage } from "@/domains/chat/types/types";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import {
  textBody,
  toolCallStatusWireFields,
} from "@/domains/chat/utils/message-test-helpers";
import { isToolCallRunning } from "@/domains/chat/utils/tool-call-status";

function makeMessage(
  overrides: Partial<DisplayMessage> & { id?: string },
): DisplayMessage {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    role: "assistant",
    ...textBody(""),
    ...overrides,
  };
}

function makeToolCall(
  overrides: Partial<ChatMessageToolCall> & {
    id: string;
    name: string;
    status?: "running" | "completed" | "error";
  },
): ChatMessageToolCall {
  const { status = "completed", ...rest } = overrides;
  return {
    input: {},
    ...toolCallStatusWireFields(status),
    ...rest,
  };
}

describe("sanitizeDisplayMessages", () => {
  test("returns the input unchanged when no sub-method fires", () => {
    const messages: DisplayMessage[] = [
      makeMessage({ id: "u-1", role: "user", ...textBody("hi"), timestamp: 1 }),
      makeMessage({ id: "a-1", role: "assistant", ...textBody("hello"), timestamp: 2 }),
    ];
    const result = sanitizeDisplayMessages(messages);
    expect(result.map((m) => m.id)).toEqual(["u-1", "a-1"]);
  });

  test("does not mutate the input array", () => {
    const messages: DisplayMessage[] = [
      makeMessage({ id: "b", role: "assistant", ...textBody("b"), timestamp: 200 }),
      makeMessage({ id: "a", role: "assistant", ...textBody("a"), timestamp: 100 }),
    ];
    const snapshot = messages.map((m) => m.id);
    sanitizeDisplayMessages(messages);
    expect(messages.map((m) => m.id)).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------------------
// Invalid (blank / phantom) row filter
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

describe("sanitizeDisplayMessages · invalid row filter", () => {
  test("drops blank user rows with no content / segments / surfaces / attachments / tool calls", () => {
    const blank = makeMessage({ id: "blank", role: "user", ...textBody("") });
    const real = makeMessage({ id: "real", role: "user", ...textBody("hi"), timestamp: 1 });
    const result = sanitizeDisplayMessages([blank, real]);
    expect(result.map((m) => m.id)).toEqual(["real"]);
  });

  test("drops user rows with whitespace-only content", () => {
    const whitespace = makeMessage({
      id: "whitespace",
      role: "user",
      ...textBody("   \n\t  "),
    });
    const result = sanitizeDisplayMessages([whitespace]);
    expect(result).toEqual([]);
  });

  test("drops user rows whose textSegments are all empty strings", () => {
    const emptySegments = makeMessage({
      id: "empty-segments",
      role: "user",
      textSegments: [""],
    });
    const result = sanitizeDisplayMessages([emptySegments]);
    expect(result).toEqual([]);
  });

  test("drops phantom tool-only user messages where every name === 'unknown'", () => {
    const phantom = makeMessage({
      id: "phantom",
      role: "user",
      ...textBody(""),
      toolCalls: [
        makeToolCall({ id: "tc-1", name: "unknown", result: "orphan" }),
      ],
    });
    const result = sanitizeDisplayMessages([phantom]);
    expect(result).toEqual([]);
  });

  test("keeps user messages with mixed known + unknown tool calls", () => {
    const mixed = makeMessage({
      id: "mixed",
      role: "user",
      ...textBody(""),
      toolCalls: [
        makeToolCall({ id: "tc-1", name: "unknown", result: "orphan" }),
        makeToolCall({ id: "tc-2", name: "bash", result: "file.txt" }),
      ],
    });
    const result = sanitizeDisplayMessages([mixed]);
    expect(result.map((m) => m.id)).toEqual(["mixed"]);
  });

  test("never drops assistant rows even when they look 'empty'", () => {
    const emptyAssistant = makeMessage({
      id: "empty-asst",
      role: "assistant",
      ...textBody(""),
    });
    const result = sanitizeDisplayMessages([emptyAssistant]);
    expect(result.map((m) => m.id)).toEqual(["empty-asst"]);
  });

  test("never drops queued user rows", () => {
    const queued = makeMessage({
      id: "queued",
      role: "user",
      ...textBody(""),
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
      textSegments: ["Final answer"],
      toolCalls: [
        makeToolCall({ id: "tc-1", name: "bash", result: "ok" }),
      ],
      timestamp: 1000,
    });
    const orphan = makeMessage({
      id: "assistant-abc",
      role: "assistant",
      textSegments: ["Final answer"],
      toolCalls: [
        makeToolCall({ id: "tc-1", name: "bash", result: "ok" }),
      ],
      timestamp: 1000,
    });

    const result = sanitizeDisplayMessages([server, orphan]);
    expect(result.map((m) => m.id)).toEqual(["msg-1"]);
  });

  test("keeps both rows when only one is the assistant", () => {
    const user = makeMessage({ id: "u", role: "user", ...textBody("hi"), timestamp: 1 });
    const assistant = makeMessage({
      id: "a",
      role: "assistant",
      ...textBody("hi"),
      timestamp: 2,
    });
    const result = sanitizeDisplayMessages([user, assistant]);
    expect(result.map((m) => m.id)).toEqual(["u", "a"]);
  });

  test("keeps both rows when textSegments differ", () => {
    const first = makeMessage({
      id: "first",
      role: "assistant",
      textSegments: ["Answer A"],
      timestamp: 1,
    });
    const second = makeMessage({
      id: "second",
      role: "assistant",
      textSegments: ["Answer B"],
      timestamp: 2,
    });
    const result = sanitizeDisplayMessages([first, second]);
    expect(result.map((m) => m.id)).toEqual(["first", "second"]);
  });

  test("keeps both rows when textSegments lengths differ", () => {
    const first = makeMessage({
      id: "first",
      role: "assistant",
      textSegments: ["Answer"],
      timestamp: 1,
    });
    const second = makeMessage({
      id: "second",
      role: "assistant",
      textSegments: [
        "Answer",
        "More",
      ],
      timestamp: 2,
    });
    const result = sanitizeDisplayMessages([first, second]);
    expect(result.map((m) => m.id)).toEqual(["first", "second"]);
  });

  test("keeps both rows when tool call name differs", () => {
    const first = makeMessage({
      id: "first",
      role: "assistant",
      toolCalls: [makeToolCall({ id: "tc", name: "bash", result: "x" })],
      timestamp: 1,
    });
    const second = makeMessage({
      id: "second",
      role: "assistant",
      toolCalls: [makeToolCall({ id: "tc", name: "read", result: "x" })],
      timestamp: 2,
    });
    const result = sanitizeDisplayMessages([first, second]);
    expect(result.map((m) => m.id)).toEqual(["first", "second"]);
  });

  test("keeps both rows when tool call result differs", () => {
    const first = makeMessage({
      id: "first",
      role: "assistant",
      toolCalls: [makeToolCall({ id: "tc", name: "bash", result: "a" })],
      timestamp: 1,
    });
    const second = makeMessage({
      id: "second",
      role: "assistant",
      toolCalls: [makeToolCall({ id: "tc", name: "bash", result: "b" })],
      timestamp: 2,
    });
    const result = sanitizeDisplayMessages([first, second]);
    expect(result.map((m) => m.id)).toEqual(["first", "second"]);
  });

  test("keeps both rows when tool call counts differ", () => {
    const first = makeMessage({
      id: "first",
      role: "assistant",
      toolCalls: [makeToolCall({ id: "tc", name: "bash", result: "x" })],
      timestamp: 1,
    });
    const second = makeMessage({
      id: "second",
      role: "assistant",
      toolCalls: [
        makeToolCall({ id: "tc-a", name: "bash", result: "x" }),
        makeToolCall({ id: "tc-b", name: "bash", result: "y" }),
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
      textSegments: ["Same"],
      timestamp: 1,
    });
    const b = makeMessage({
      id: "b",
      role: "assistant",
      textSegments: ["Same"],
      timestamp: 2,
    });
    const c = makeMessage({
      id: "c",
      role: "assistant",
      textSegments: ["Same"],
      timestamp: 3,
    });
    const result = sanitizeDisplayMessages([a, b, c]);
    expect(result.map((m) => m.id)).toEqual(["a", "b"]);
  });

  test("handles two assistant rows with no tool calls and matching segments", () => {
    const first = makeMessage({
      id: "first",
      role: "assistant",
      textSegments: ["Hi"],
      timestamp: 1,
    });
    const second = makeMessage({
      id: "second",
      role: "assistant",
      textSegments: ["Hi"],
      timestamp: 2,
    });
    const result = sanitizeDisplayMessages([first, second]);
    expect(result.map((m) => m.id)).toEqual(["first"]);
  });

  test("handles two assistant rows with no segments and matching tool calls", () => {
    const first = makeMessage({
      id: "first",
      role: "assistant",
      toolCalls: [makeToolCall({ id: "tc", name: "bash", result: "x" })],
      timestamp: 1,
    });
    const second = makeMessage({
      id: "second",
      role: "assistant",
      toolCalls: [makeToolCall({ id: "tc", name: "bash", result: "x" })],
      timestamp: 2,
    });
    const result = sanitizeDisplayMessages([first, second]);
    expect(result.map((m) => m.id)).toEqual(["first"]);
  });

  test("single-message arrays are returned unchanged", () => {
    const only = makeMessage({
      id: "only",
      role: "assistant",
      ...textBody("lonely"),
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
        makeToolCall({ id: "tc-1", name: "bash", status: "running" }),
      ],
    });
    const later = makeMessage({
      id: "a-new",
      role: "assistant",
      ...textBody("follow-up"),
      timestamp: 200,
    });
    const [patchedOld, untouchedNew] = sanitizeDisplayMessages([older, later]);
    expect(patchedOld!.toolCalls![0]).toEqual({
      id: "tc-1",
      name: "bash",
      input: {},
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
      ...textBody("go"),
      timestamp: 100,
    });
    const last = makeMessage({
      id: "a-last",
      role: "assistant",
      timestamp: 200,
      toolCalls: [
        makeToolCall({ id: "tc-1", name: "bash", status: "running" }),
      ],
    });
    const result = sanitizeDisplayMessages([userMsg, last]);
    expect(result[1]).toBe(last);
    expect(isToolCallRunning(result[1]!.toolCalls![0]!)).toBe(true);
  });

  test("does NOT patch when only a subsequent USER message exists (no assistant proof)", () => {
    const onlyAssistant = makeMessage({
      id: "a-only",
      role: "assistant",
      timestamp: 100,
      toolCalls: [
        makeToolCall({ id: "tc-1", name: "bash", status: "running" }),
      ],
    });
    const trailingUser = makeMessage({
      id: "u",
      role: "user",
      ...textBody("ping"),
      timestamp: 200,
    });
    const result = sanitizeDisplayMessages([onlyAssistant, trailingUser]);
    expect(result[0]).toBe(onlyAssistant);
    expect(isToolCallRunning(result[0]!.toolCalls![0]!)).toBe(true);
  });

  test("patches across an intervening user message", () => {
    const a1 = makeMessage({
      id: "a1",
      role: "assistant",
      timestamp: 100,
      toolCalls: [
        makeToolCall({ id: "tc-1", name: "bash", status: "running" }),
      ],
    });
    const u = makeMessage({
      id: "u",
      role: "user",
      ...textBody("more"),
      timestamp: 200,
    });
    const a2 = makeMessage({
      id: "a2",
      role: "assistant",
      ...textBody("result"),
      timestamp: 300,
    });
    const result = sanitizeDisplayMessages([a1, u, a2]);
    expect(Boolean((result[0]!.toolCalls![0]!).isError)).toBe(true);
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
          name: "bash",
          status: "completed",
          result: "ok",
        }),
      ],
    });
    const later = makeMessage({
      id: "a-new",
      role: "assistant",
      ...textBody("follow-up"),
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
          name: "bash",
          status: "error",
          isError: true,
          result: "boom",
        }),
      ],
    });
    const later = makeMessage({
      id: "a-new",
      role: "assistant",
      ...textBody("ok"),
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
          name: "bash",
          status: "completed",
          result: "first ok",
        }),
        makeToolCall({ id: "tc-2", name: "web_search", status: "running" }),
        makeToolCall({
          id: "tc-3",
          name: "read_file",
          status: "completed",
          result: "third ok",
        }),
      ],
    });
    const later = makeMessage({
      id: "a-new",
      role: "assistant",
      ...textBody("done"),
      timestamp: 200,
    });
    const result = sanitizeDisplayMessages([older, later]);
    expect(result[0]!.toolCalls![0]!.result).toBe("first ok");
    expect(Boolean((result[0]!.toolCalls![1]!).isError)).toBe(true);
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
        makeToolCall({ id: "tc-1", name: "bash", status: "running" }),
      ],
    });
    const a2 = makeMessage({
      id: "a2",
      role: "assistant",
      timestamp: 200,
      toolCalls: [
        makeToolCall({ id: "tc-2", name: "bash", status: "running" }),
      ],
    });
    const a3 = makeMessage({
      id: "a3",
      role: "assistant",
      ...textBody("done"),
      timestamp: 300,
    });
    const result = sanitizeDisplayMessages([a1, a2, a3]);
    expect(Boolean((result[0]!.toolCalls![0]!).isError)).toBe(true);
    expect(Boolean((result[1]!.toolCalls![0]!).isError)).toBe(true);
    expect(result[2]).toBe(a3);
  });

  test("does not mutate the input messages or tool-call objects", () => {
    const tc = makeToolCall({ id: "tc", name: "bash", status: "running" });
    const older = makeMessage({
      id: "a-old",
      role: "assistant",
      timestamp: 100,
      toolCalls: [tc],
    });
    const later = makeMessage({
      id: "a-new",
      role: "assistant",
      ...textBody("ok"),
      timestamp: 200,
    });
    sanitizeDisplayMessages([older, later]);
    expect(isToolCallRunning(tc)).toBe(true);
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
          name: "bash",
          status: "completed",
          result: "ok",
        }),
      ],
    });
    const a2 = makeMessage({
      id: "a2",
      role: "assistant",
      ...textBody("done"),
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
// Hack #5 — fail stale tool calls on assistant restart / silent daemon death
// ---------------------------------------------------------------------------

describe("sanitizeDisplayMessages · fail stale tool calls", () => {
  const STALE_PREFIX = "Tool call exceeded the execution timeout";
  // Mirrors `DEFAULT_TOOL_EXECUTION_TIMEOUT_SEC` from @vellumai/assistant-api.
  // Hard-coded in the test so a regression that changes the wire-contract
  // default by accident shows up here too.
  const DEFAULT_TIMEOUT_MS = 120_000;
  // Mirrors `STALE_GRACE_MS` from the sanitizer. Same reasoning as above.
  const GRACE_MS = 30_000;
  // Convenience: just past the threshold a default-timeout running tool
  // call becomes stale.
  const PAST_DEFAULT_TIMEOUT_MS = DEFAULT_TIMEOUT_MS + GRACE_MS + 1_000;

  // The sanitizer reads `Date.now()` once per call to produce a stable
  // `nowMs` for Hack #5. Tests pin that clock via spyOn so the
  // stale-detection window is deterministic. Each test sets up its own
  // spy with `mockNow(...)`; the afterEach restores the real clock so
  // unrelated tests in the file (and adjacent test files in the same
  // worker) keep seeing real time.
  let nowSpy: ReturnType<typeof spyOn> | null = null;
  function mockNow(nowMs: number): void {
    nowSpy = spyOn(Date, "now").mockReturnValue(nowMs);
  }
  afterEach(() => {
    nowSpy?.mockRestore();
    nowSpy = null;
  });

  test("marks a running tool call stale once default timeout + grace elapses", () => {
    const started = 1_000;
    const now = started + PAST_DEFAULT_TIMEOUT_MS;
    const m = makeMessage({
      id: "a",
      role: "assistant",
      timestamp: started,
      toolCalls: [
        makeToolCall({
          id: "tc",
          name: "web_search",
          status: "running",
          startedAt: started,
        }),
      ],
    });
    mockNow(now);
    const [patched] = sanitizeDisplayMessages([m]);
    expect(Boolean((patched!.toolCalls![0]!).isError)).toBe(true);
    expect(patched!.toolCalls![0]!.isError).toBe(true);
    expect(patched!.toolCalls![0]!.result).toContain(STALE_PREFIX);
  });

  test("does NOT mark stale before timeout + grace elapses", () => {
    const started = 1_000;
    // Right at the threshold, NOT past it. Predicate is strict >.
    const now = started + DEFAULT_TIMEOUT_MS + GRACE_MS;
    const m = makeMessage({
      id: "a",
      role: "assistant",
      timestamp: started,
      toolCalls: [
        makeToolCall({
          id: "tc",
          name: "web_search",
          status: "running",
          startedAt: started,
        }),
      ],
    });
    mockNow(now);
    const result = sanitizeDisplayMessages([m]);
    expect(result[0]).toBe(m);
    expect(isToolCallRunning(result[0]!.toolCalls![0]!)).toBe(true);
  });

  test("marks stale after the default execution timeout elapses", () => {
    // No daemon-side progress signal exists. Every running tool is
    // measured against the canonical DEFAULT_TOOL_EXECUTION_TIMEOUT_SEC.
    const started = 1_000;
    const now = started + PAST_DEFAULT_TIMEOUT_MS;
    const m = makeMessage({
      id: "a",
      role: "assistant",
      timestamp: started,
      toolCalls: [
        makeToolCall({
          id: "tc",
          name: "web_search",
          status: "running",
          startedAt: started,
        }),
      ],
    });
    mockNow(now);
    const [patched] = sanitizeDisplayMessages([m]);
    expect(Boolean((patched!.toolCalls![0]!).isError)).toBe(true);
    expect(patched!.toolCalls![0]!.result).toContain(STALE_PREFIX);
  });

  test("does NOT mark stale when pendingConfirmation is set", () => {
    // A tool waiting on user approval is correctly stalled — the
    // daemon's execution clock hasn't even started. Could sit here for
    // arbitrarily long without being dead.
    const started = 1_000;
    const now = started + 24 * 60 * 60 * 1_000;
    const m = makeMessage({
      id: "a",
      role: "assistant",
      timestamp: started,
      toolCalls: [
        makeToolCall({
          id: "tc",
          name: "bash",
          status: "running",
          startedAt: started,
          pendingConfirmation: {
            requestId: "rq-1",
            toolName: "bash",
            input: {},
          },
        }),
      ],
    });
    mockNow(now);
    const result = sanitizeDisplayMessages([m]);
    expect(result[0]).toBe(m);
    expect(isToolCallRunning(result[0]!.toolCalls![0]!)).toBe(true);
  });

  test("does NOT mark stale when startedAt is missing (no clock to measure)", () => {
    const m = makeMessage({
      id: "a",
      role: "assistant",
      timestamp: 100,
      toolCalls: [
        makeToolCall({
          id: "tc",
          name: "bash",
          status: "running",
          // No startedAt — typically a pre-stamping history hydration.
        }),
      ],
    });
    mockNow(1_000_000_000);
    const result = sanitizeDisplayMessages([m]);
    expect(result[0]).toBe(m);
    expect(isToolCallRunning(result[0]!.toolCalls![0]!)).toBe(true);
  });

  test("marks stale tools on the LAST assistant too (no subsequent-assistant requirement)", () => {
    // Differs from hack #4 — for stale we don't require any later
    // assistant message, because the timeout itself is the proof.
    const started = 1_000;
    const now = started + PAST_DEFAULT_TIMEOUT_MS;
    const u = makeMessage({
      id: "u",
      role: "user",
      ...textBody("go"),
      timestamp: started - 100,
    });
    const lastAssistant = makeMessage({
      id: "a-last",
      role: "assistant",
      timestamp: started,
      toolCalls: [
        makeToolCall({
          id: "tc",
          name: "web_search",
          status: "running",
          startedAt: started,
        }),
      ],
    });
    mockNow(now);
    const result = sanitizeDisplayMessages([u, lastAssistant]);
    expect(Boolean((result[1]!.toolCalls![0]!).isError)).toBe(true);
    expect(result[1]!.toolCalls![0]!.result).toContain(STALE_PREFIX);
  });

  test("leaves siblings on the same message alone when one is stale", () => {
    const started = 1_000;
    const now = started + PAST_DEFAULT_TIMEOUT_MS;
    const m = makeMessage({
      id: "a",
      role: "assistant",
      timestamp: started,
      toolCalls: [
        makeToolCall({
          id: "tc-1",
          name: "bash",
          status: "completed",
          startedAt: started,
          result: "first ok",
        }),
        makeToolCall({
          id: "tc-2",
          name: "web_search",
          status: "running",
          startedAt: started,
        }),
        makeToolCall({
          id: "tc-3",
          name: "read_file",
          status: "completed",
          startedAt: started,
          result: "third ok",
        }),
      ],
    });
    mockNow(now);
    const [patched] = sanitizeDisplayMessages([m]);
    expect(patched!.toolCalls![0]!.result).toBe("first ok");
    expect(Boolean((patched!.toolCalls![1]!).isError)).toBe(true);
    expect(patched!.toolCalls![1]!.isError).toBe(true);
    expect(patched!.toolCalls![1]!.result).toContain(STALE_PREFIX);
    expect(patched!.toolCalls![2]!.result).toBe("third ok");
  });

  test("does not mutate the input messages or tool-call objects", () => {
    const started = 1_000;
    const now = started + PAST_DEFAULT_TIMEOUT_MS;
    const tc = makeToolCall({
      id: "tc",
      name: "web_search",
      status: "running",
      startedAt: started,
    });
    const m = makeMessage({
      id: "a",
      role: "assistant",
      timestamp: started,
      toolCalls: [tc],
    });
    mockNow(now);
    sanitizeDisplayMessages([m]);
    expect(isToolCallRunning(tc)).toBe(true);
    expect(tc.result).toBeUndefined();
    expect(m.toolCalls![0]).toBe(tc);
  });

  test("preserves message identity when no tool calls are stale", () => {
    // The sort step always returns a new outer array, so identity lives
    // at the message level. Confirms hack #5 is COW at the message
    // boundary when nothing needs patching.
    const m1 = makeMessage({
      id: "a1",
      role: "assistant",
      timestamp: 100,
      toolCalls: [
        makeToolCall({
          id: "tc-1",
          name: "bash",
          status: "completed",
          startedAt: 100,
          result: "ok",
        }),
      ],
    });
    const m2 = makeMessage({
      id: "a2",
      role: "assistant",
      ...textBody("done"),
      timestamp: 200,
    });
    mockNow(10_000_000);
    const result = sanitizeDisplayMessages([m1, m2]);
    expect(result[0]).toBe(m1);
    expect(result[1]).toBe(m2);
  });
});

// ---------------------------------------------------------------------------
// Integration — all five hacks compose
// ---------------------------------------------------------------------------

describe("sanitizeDisplayMessages · integration", () => {
  test("invalid filter → trailing-dup drop → dangling-tool repair runs in order", () => {
    // Construct an input that exercises the composing render-layer hacks.
    const phantom = makeMessage({
      id: "phantom",
      role: "user",
      ...textBody(""),
      toolCalls: [
        makeToolCall({ id: "p", name: "unknown", result: "orphan" }),
      ],
      timestamp: 50,
    });
    const userTurn = makeMessage({
      id: "user",
      role: "user",
      ...textBody("What's the answer?"),
      timestamp: 100,
    });
    // An older assistant message with a running tool call — its `tool_result`
    // event was lost in transit. We expect hack #4 to patch this.
    const olderWithDangling = makeMessage({
      id: "older",
      role: "assistant",
      textSegments: ["let me check"],
      toolCalls: [
        makeToolCall({ id: "tc-x", name: "bash", status: "running" }),
      ],
      timestamp: 150,
    });
    // The "real" assistant turn (server-assigned id).
    const server = makeMessage({
      id: "msg-1",
      role: "assistant",
      textSegments: ["42"],
      timestamp: 200,
    });
    // The duplicate orphan emission (a synthesized optimistic-style id).
    const orphan = makeMessage({
      id: "assistant-abc",
      role: "assistant",
      textSegments: ["42"],
      timestamp: 200,
    });

    // Input is in render order — the seam no longer sorts. `server` precedes
    // `orphan` because the production duplicate emission is "server row first,
    // orphan row second", which the trailing-duplicate filter relies on.
    const result = sanitizeDisplayMessages([
      phantom,
      userTurn,
      olderWithDangling,
      server,
      orphan,
    ]);

    // Expect:
    //   - phantom dropped by the invalid-row filter,
    //   - trailing orphan dropped by the duplicate-trailing-assistant filter
    //     (matches `server` on text + tool calls),
    //   - olderWithDangling's running tool call patched by the dangling-tool
    //     repair because `server` is a later assistant.
    expect(result.map((m) => m.id)).toEqual([
      "user",
      "older",
      "msg-1",
    ]);
    const patchedTool = result[1]!.toolCalls![0]!;
    expect(Boolean((patchedTool).isError)).toBe(true);
    expect(patchedTool.isError).toBe(true);
    expect(patchedTool.result).toContain("client-side data loss");
  });
});
