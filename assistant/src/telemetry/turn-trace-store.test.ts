/**
 * Tests for the turn-trace assembler.
 *
 * Verifies that a turn's transcript (user message, assistant responses, and
 * tool_result rows) plus its tool invocations are gathered into a faithful,
 * window-bounded trace, that the window stops at the next REAL user turn (and
 * never at the turn's own tool-result rows), that tool inputs/results are
 * captured verbatim (no field-level redaction), that coalesced-batch turns
 * trace their natural windows (head user-only, shared response on the final
 * batched turn — no batch inference), and that the size cap omits oversized
 * traces fail-closed.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { makeMockLogger } from "../__tests__/helpers/mock-logger.js";

mock.module("../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

// Control the live-conversation lookup so `isTurnSettled` can be exercised
// without a running agent loop. Returns `undefined` (no live conversation) by
// default; tests set a fake with a chosen `isProcessing()`.
let mockLiveConversation:
  | {
      isProcessing: () => boolean;
      getCurrentSystemPrompt?: () => string;
      getRegisteredToolNames?: () => Set<string>;
    }
  | undefined;
mock.module("../daemon/conversation-registry.js", () => ({
  findConversation: () => mockLiveConversation,
}));

// Stub the tool registry so trace assembly can resolve descriptions without
// loading the real tool graph. Returns `undefined` by default; tests override
// for specific tool names.
let mockToolDescriptions: Record<string, string> = {};
mock.module("../tools/registry.js", () => ({
  getTool: (name: string) =>
    mockToolDescriptions[name]
      ? { description: mockToolDescriptions[name] }
      : undefined,
}));

import { createConversation } from "../persistence/conversation-crud.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { messages, toolInvocations } from "../persistence/schema/index.js";
import {
  assembleBoundedTurnTrace,
  assembleTurnTrace,
  isTurnSettled,
  MAX_TRACE_SERIALIZED_BYTES,
  type TurnTraceBoundary,
} from "./turn-trace-store.js";

await initializeDb();

function purge(): void {
  const db = getDb();
  db.run("DELETE FROM tool_invocations");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

beforeEach(() => {
  purge();
  mockLiveConversation = undefined;
  mockToolDescriptions = {};
});

interface MessageSeed {
  id: string;
  role: "user" | "assistant" | "system";
  content: unknown;
  createdAt: number;
}

function insertMessage(conversationId: string, seed: MessageSeed): void {
  getDb()
    .insert(messages)
    .values({
      id: seed.id,
      conversationId,
      role: seed.role,
      content:
        typeof seed.content === "string"
          ? seed.content
          : JSON.stringify(seed.content),
      createdAt: seed.createdAt,
    })
    .run();
}

interface ToolSeed {
  id: string;
  toolName: string;
  input: string;
  result: string;
  decision?: string;
  durationMs?: number;
  createdAt: number;
}

function insertTool(conversationId: string, seed: ToolSeed): void {
  getDb()
    .insert(toolInvocations)
    .values({
      id: seed.id,
      conversationId,
      toolName: seed.toolName,
      input: seed.input,
      result: seed.result,
      decision: seed.decision ?? "allow",
      riskLevel: "low",
      durationMs: seed.durationMs ?? 5,
      createdAt: seed.createdAt,
    })
    .run();
}

function boundary(
  conversationId: string,
  userMessageId: string,
  createdAt: number,
): TurnTraceBoundary {
  return { conversationId, userMessageId, userMessageCreatedAt: createdAt };
}

describe("assembleTurnTrace", () => {
  test("gathers user message, assistant responses, tool-result rows, and tool calls for a multi-message turn", () => {
    const conv = createConversation({ conversationType: "standard" });

    // Turn 1: user asks, assistant calls a tool, tool result lands as a
    // role="user" row, assistant replies.
    insertMessage(conv.id, {
      id: "m-user-1",
      role: "user",
      content: [{ type: "text", text: "what's on my calendar?" }],
      createdAt: 1000,
    });
    insertMessage(conv.id, {
      id: "m-asst-1a",
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "tu-1",
          name: "calendar_list_events",
          input: { range: "today" },
        },
      ],
      createdAt: 1100,
    });
    insertMessage(conv.id, {
      id: "m-toolresult-1",
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu-1", content: "2 events" },
      ],
      createdAt: 1200,
    });
    insertMessage(conv.id, {
      id: "m-asst-1b",
      role: "assistant",
      content: [{ type: "text", text: "You have 2 events today." }],
      createdAt: 1300,
    });
    insertTool(conv.id, {
      id: "ti-1",
      toolName: "calendar_list_events",
      input: JSON.stringify({ range: "today" }),
      result: JSON.stringify({ events: 2 }),
      createdAt: 1150,
    });

    // Turn 2: next real user turn — must NOT be in turn 1's trace.
    insertMessage(conv.id, {
      id: "m-user-2",
      role: "user",
      content: [{ type: "text", text: "thanks" }],
      createdAt: 2000,
    });
    insertTool(conv.id, {
      id: "ti-2",
      toolName: "noop",
      input: "{}",
      result: "{}",
      createdAt: 2100,
    });

    const trace = assembleTurnTrace(boundary(conv.id, "m-user-1", 1000));

    expect(trace.schema_version).toBe(2);
    // Window stops before turn 2: only turn-1 message rows, oldest-first.
    expect(trace.messages.map((m) => m.id)).toEqual([
      "m-user-1",
      "m-asst-1a",
      "m-toolresult-1",
      "m-asst-1b",
    ]);
    // The tool-result row keeps role="user" (faithful to what the model saw).
    const toolResultMsg = trace.messages.find((m) => m.id === "m-toolresult-1");
    expect(toolResultMsg?.role).toBe("user");
    // Content is parsed JSON (ContentBlock[]), not a string.
    expect(Array.isArray(toolResultMsg?.content)).toBe(true);

    // Only turn-1's tool invocation is in scope.
    expect(trace.tool_calls.map((t) => t.id)).toEqual(["ti-1"]);
    expect(trace.tool_calls[0]).toMatchObject({
      tool_name: "calendar_list_events",
      decision: "allow",
      duration_ms: 5,
      created_at: 1150,
    });
    // Result is forwarded verbatim.
    expect(trace.tool_calls[0].result).toBe(JSON.stringify({ events: 2 }));
  });

  test("includes system_prompt and tool_definitions from the live conversation", () => {
    const conv = createConversation({ conversationType: "standard" });
    insertMessage(conv.id, {
      id: "m-user-1",
      role: "user",
      content: [{ type: "text", text: "hello" }],
      createdAt: 1000,
    });
    insertMessage(conv.id, {
      id: "m-asst-1",
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      createdAt: 1100,
    });

    mockLiveConversation = {
      isProcessing: () => false,
      getCurrentSystemPrompt: () => "You are a helpful assistant.",
      getRegisteredToolNames: () =>
        new Set(["web_search", "file_read", "notify_parent"]),
    };
    mockToolDescriptions = {
      web_search: "Search the web",
      file_read: "Read a file",
      // notify_parent intentionally not in the map — description should be ""
    };

    const trace = assembleTurnTrace(boundary(conv.id, "m-user-1", 1000));

    expect(trace.system_prompt).toBe("You are a helpful assistant.");
    expect(trace.tool_definitions).toEqual([
      { name: "file_read", description: "Read a file" },
      { name: "notify_parent", description: "" },
      { name: "web_search", description: "Search the web" },
    ]);
  });

  test("system_prompt is null and tool_definitions is empty when conversation is evicted", () => {
    const conv = createConversation({ conversationType: "standard" });
    insertMessage(conv.id, {
      id: "m-user-1",
      role: "user",
      content: [{ type: "text", text: "hello" }],
      createdAt: 1000,
    });
    insertMessage(conv.id, {
      id: "m-asst-1",
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      createdAt: 1100,
    });

    // No mockLiveConversation set — simulates evicted conversation.
    const trace = assembleTurnTrace(boundary(conv.id, "m-user-1", 1000));

    expect(trace.system_prompt).toBeNull();
    expect(trace.tool_definitions).toEqual([]);
  });

  test("the final turn's window runs to the end of the conversation", () => {
    const conv = createConversation({ conversationType: "standard" });
    insertMessage(conv.id, {
      id: "m-user-1",
      role: "user",
      content: [{ type: "text", text: "first" }],
      createdAt: 1000,
    });
    insertMessage(conv.id, {
      id: "m-user-2",
      role: "user",
      content: [{ type: "text", text: "second (latest)" }],
      createdAt: 2000,
    });
    insertMessage(conv.id, {
      id: "m-asst-2",
      role: "assistant",
      content: [{ type: "text", text: "reply to second" }],
      createdAt: 2100,
    });
    insertTool(conv.id, {
      id: "ti-late",
      toolName: "noop",
      input: "{}",
      result: "ok",
      createdAt: 2200,
    });

    const trace = assembleTurnTrace(boundary(conv.id, "m-user-2", 2000));
    expect(trace.messages.map((m) => m.id)).toEqual(["m-user-2", "m-asst-2"]);
    expect(trace.tool_calls.map((t) => t.id)).toEqual(["ti-late"]);
  });

  test("two real user turns sharing created_at: the first turn's trace is not truncated and excludes the second turn", () => {
    // Forked conversations preserve the source `created_at` with fresh ids, so
    // two real user messages can share a millisecond. A timestamp-only upper
    // bound would equal the current turn's own `created_at` and empty the
    // window — the compound `(created_at, id)` bound must keep this turn's rows
    // (which sort by id at the shared millisecond) while excluding the next.
    const conv = createConversation({ conversationType: "standard" });

    // Turn 1 (id "m-user-1") and turn 2 (id "m-user-2") share created_at=1000.
    // Turn 1's assistant reply, tool-result row, and tool call also land at
    // 1000 — the worst case for a timestamp-only bound.
    insertMessage(conv.id, {
      id: "m-user-1",
      role: "user",
      content: [{ type: "text", text: "first (same ms)" }],
      createdAt: 1000,
    });
    insertMessage(conv.id, {
      id: "m-user-1-asst",
      role: "assistant",
      content: [{ type: "text", text: "reply to first" }],
      createdAt: 1000,
    });
    insertMessage(conv.id, {
      id: "m-user-1-toolresult",
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu-1", content: "ok" }],
      createdAt: 1000,
    });
    insertTool(conv.id, {
      id: "ti-turn1",
      toolName: "noop",
      input: "{}",
      result: "r1",
      createdAt: 1000,
    });

    // Turn 2 user message + its content, same created_at=1000 (higher id).
    insertMessage(conv.id, {
      id: "m-user-2",
      role: "user",
      content: [{ type: "text", text: "second (same ms)" }],
      createdAt: 1000,
    });
    insertMessage(conv.id, {
      id: "m-user-2-asst",
      role: "assistant",
      content: [{ type: "text", text: "reply to second" }],
      createdAt: 1000,
    });

    const trace = assembleTurnTrace(boundary(conv.id, "m-user-1", 1000));

    // Turn 1's rows (ids < "m-user-2" at ms 1000) are present; the trace is
    // NOT truncated/emptied. The second user turn and its reply are excluded.
    expect(trace.messages.map((m) => m.id)).toEqual([
      "m-user-1",
      "m-user-1-asst",
      "m-user-1-toolresult",
    ]);
    // Turn 1's same-millisecond tool call is retained (degenerate `<=` window).
    expect(trace.tool_calls.map((t) => t.id)).toEqual(["ti-turn1"]);
  });

  test("the SECOND of two same-created_at turns captures its own trace to end of conversation", () => {
    // Complement of the previous test: assembling the trace for the later of
    // two same-millisecond user turns must include only that turn's rows.
    const conv = createConversation({ conversationType: "standard" });
    insertMessage(conv.id, {
      id: "m-user-1",
      role: "user",
      content: [{ type: "text", text: "first (same ms)" }],
      createdAt: 1000,
    });
    insertMessage(conv.id, {
      id: "m-user-1-asst",
      role: "assistant",
      content: [{ type: "text", text: "reply to first" }],
      createdAt: 1000,
    });
    insertMessage(conv.id, {
      id: "m-user-2",
      role: "user",
      content: [{ type: "text", text: "second (same ms, latest)" }],
      createdAt: 1000,
    });
    insertMessage(conv.id, {
      id: "m-user-2-asst",
      role: "assistant",
      content: [{ type: "text", text: "reply to second" }],
      createdAt: 1100,
    });

    const trace = assembleTurnTrace(boundary(conv.id, "m-user-2", 1000));
    expect(trace.messages.map((m) => m.id)).toEqual([
      "m-user-2",
      "m-user-2-asst",
    ]);
  });

  test("a tool-result role=user row does NOT truncate the turn it belongs to", () => {
    const conv = createConversation({ conversationType: "standard" });
    insertMessage(conv.id, {
      id: "m-user-1",
      role: "user",
      content: [{ type: "text", text: "do a thing" }],
      createdAt: 1000,
    });
    // Tool-result row persisted as role="user" — must be treated as part of
    // the turn, not as the next user turn.
    insertMessage(conv.id, {
      id: "m-toolresult",
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu-x", content: "done" }],
      createdAt: 1100,
    });
    insertMessage(conv.id, {
      id: "m-asst-after-result",
      role: "assistant",
      content: [{ type: "text", text: "all done" }],
      createdAt: 1200,
    });

    const trace = assembleTurnTrace(boundary(conv.id, "m-user-1", 1000));
    // All three rows belong to the single turn — the tool-result row did not
    // close the window early.
    expect(trace.messages.map((m) => m.id)).toEqual([
      "m-user-1",
      "m-toolresult",
      "m-asst-after-result",
    ]);
  });

  test("captures tool inputs verbatim — no field-level redaction, even for credential-shaped keys", () => {
    // The consented trace is full-fidelity. Keys that look sensitive
    // (access_token, api_key) are NOT redacted — the protections are the
    // consent gate, the PII-segregated table, and its TTL, not redaction.
    const conv = createConversation({ conversationType: "standard" });
    insertMessage(conv.id, {
      id: "m-user-1",
      role: "user",
      content: [{ type: "text", text: "use my token" }],
      createdAt: 1000,
    });
    const rawInput = {
      url: "https://api.example.com",
      access_token: "super-secret-value",
      nested: { api_key: "also-secret" },
    };
    insertTool(conv.id, {
      id: "ti-secret",
      toolName: "http_request",
      input: JSON.stringify(rawInput),
      result: JSON.stringify({ status: 200 }),
      createdAt: 1100,
    });

    const trace = assembleTurnTrace(boundary(conv.id, "m-user-1", 1000));
    const call = trace.tool_calls[0];
    // Parsed input matches the raw stored input exactly — including the
    // credential-shaped values, which are present verbatim (not redacted).
    expect(call.input).toEqual(rawInput);
    const input = call.input as Record<string, unknown>;
    expect(input.access_token).toBe("super-secret-value");
    expect((input.nested as Record<string, unknown>).api_key).toBe(
      "also-secret",
    );
    expect(JSON.stringify(call.input)).not.toContain("<redacted />");
    // Result is also forwarded verbatim.
    expect(call.result).toBe(JSON.stringify({ status: 200 }));
  });

  test("non-JSON tool input is forwarded as a raw string", () => {
    const conv = createConversation({ conversationType: "standard" });
    insertMessage(conv.id, {
      id: "m-user-1",
      role: "user",
      content: [{ type: "text", text: "hi" }],
      createdAt: 1000,
    });
    insertTool(conv.id, {
      id: "ti-raw",
      toolName: "bash",
      input: "ls -la /tmp",
      result: "ok",
      createdAt: 1100,
    });

    const trace = assembleTurnTrace(boundary(conv.id, "m-user-1", 1000));
    expect(trace.tool_calls[0].input).toBe("ls -la /tmp");
  });

  test("legacy plain-string message content is forwarded as a string", () => {
    const conv = createConversation({ conversationType: "standard" });
    // A legacy row stored the content as a bare (JSON) string, not a block
    // array. JSON.parse of a quoted string yields a string; an unquoted
    // legacy value falls back to the raw string.
    insertMessage(conv.id, {
      id: "m-user-1",
      role: "user",
      content: "plain legacy text",
      createdAt: 1000,
    });
    const trace = assembleTurnTrace(boundary(conv.id, "m-user-1", 1000));
    expect(trace.messages[0].content).toBe("plain legacy text");
  });

  test("scopes the trace to a single conversation", () => {
    const a = createConversation({ conversationType: "standard" });
    const b = createConversation({ conversationType: "standard" });
    insertMessage(a.id, {
      id: "m-a-user",
      role: "user",
      content: [{ type: "text", text: "in A" }],
      createdAt: 1000,
    });
    insertMessage(b.id, {
      id: "m-b-user",
      role: "user",
      content: [{ type: "text", text: "in B" }],
      createdAt: 1050,
    });
    insertTool(b.id, {
      id: "ti-b",
      toolName: "noop",
      input: "{}",
      result: "ok",
      createdAt: 1060,
    });

    const trace = assembleTurnTrace(boundary(a.id, "m-a-user", 1000));
    expect(trace.messages.map((m) => m.id)).toEqual(["m-a-user"]);
    // Tool calls from conversation B never leak into A's trace.
    expect(trace.tool_calls).toEqual([]);
  });
});

describe("assembleTurnTrace — coalesced-batch natural windows", () => {
  // The daemon coalesces queued user messages: drainBatch persists every
  // batched user row, then runs ONE shared response attributed to the LAST
  // batched user row. On disk: [u1][u2][u3][assistant + tools][u4][assistant2].
  // No batch inference is attempted (there is no durable batch signal in the
  // stored messages, and a batch head is indistinguishable from a turn that
  // failed/cancelled before responding). Each turn just traces its natural
  // window, which is faithful.
  function seedThreeMessageBatch(convId: string): void {
    insertMessage(convId, {
      id: "u1",
      role: "user",
      content: [{ type: "text", text: "first batched" }],
      createdAt: 1000,
    });
    insertMessage(convId, {
      id: "u2",
      role: "user",
      content: [{ type: "text", text: "second batched" }],
      createdAt: 1010,
    });
    insertMessage(convId, {
      id: "u3",
      role: "user",
      content: [{ type: "text", text: "third batched (final)" }],
      createdAt: 1020,
    });
    // Shared response written AFTER the last batched user row, with a tool call.
    insertMessage(convId, {
      id: "a-shared",
      role: "assistant",
      content: [
        { type: "tool_use", id: "tu-1", name: "calendar", input: {} },
        { type: "text", text: "shared reply to all three" },
      ],
      createdAt: 1030,
    });
    insertMessage(convId, {
      id: "a-shared-toolresult",
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu-1", content: "ok" }],
      createdAt: 1040,
    });
    insertTool(convId, {
      id: "ti-shared",
      toolName: "calendar",
      input: "{}",
      result: "ok",
      createdAt: 1035,
    });
  }

  test("a batched HEAD turn's trace contains only its own user row (faithful, no batch field)", () => {
    const conv = createConversation({ conversationType: "standard" });
    seedThreeMessageBatch(conv.id);

    const trace = assembleTurnTrace(boundary(conv.id, "u1", 1000));
    // Natural window: just the head's own user row. Its window genuinely has no
    // assistant response (the shared response is on the final batched turn).
    expect(trace.messages.map((m) => m.id)).toEqual(["u1"]);
    expect(trace.tool_calls).toEqual([]);
    // No batch inference: the response is not duplicated onto the head, and the
    // trace carries no `batch` field.
    expect(JSON.stringify(trace)).not.toContain("shared reply to all three");
    expect("batch" in trace).toBe(false);
  });

  test("a batched MIDDLE turn's trace also contains only its own user row", () => {
    const conv = createConversation({ conversationType: "standard" });
    seedThreeMessageBatch(conv.id);

    const trace = assembleTurnTrace(boundary(conv.id, "u2", 1010));
    expect(trace.messages.map((m) => m.id)).toEqual(["u2"]);
    expect(trace.tool_calls).toEqual([]);
    expect("batch" in trace).toBe(false);
  });

  test("the FINAL batched turn's trace contains the shared assistant response + tools", () => {
    const conv = createConversation({ conversationType: "standard" });
    seedThreeMessageBatch(conv.id);

    // The shared response is attributed by the daemon to the last batched user
    // row (lastUserMessageId == u3); u3's natural window includes it.
    const trace = assembleTurnTrace(boundary(conv.id, "u3", 1020));
    expect(trace.messages.map((m) => m.id)).toEqual([
      "u3",
      "a-shared",
      "a-shared-toolresult",
    ]);
    expect(trace.tool_calls.map((t) => t.id)).toEqual(["ti-shared"]);
    expect("batch" in trace).toBe(false);
  });
});

describe("assembleBoundedTurnTrace", () => {
  test("returns the trace when under the size cap", () => {
    const conv = createConversation({ conversationType: "standard" });
    insertMessage(conv.id, {
      id: "m-user-1",
      role: "user",
      content: [{ type: "text", text: "small" }],
      createdAt: 1000,
    });
    const trace = assembleBoundedTurnTrace(boundary(conv.id, "m-user-1", 1000));
    expect(trace).not.toBeNull();
    expect(trace?.messages.map((m) => m.id)).toEqual(["m-user-1"]);
  });

  test("omits (returns null) when the serialized trace exceeds the cap", () => {
    const conv = createConversation({ conversationType: "standard" });
    insertMessage(conv.id, {
      id: "m-user-1",
      role: "user",
      content: [{ type: "text", text: "huge" }],
      createdAt: 1000,
    });
    // A single oversized tool result pushes the trace past the cap.
    insertTool(conv.id, {
      id: "ti-huge",
      toolName: "dump",
      input: "{}",
      result: "x".repeat(MAX_TRACE_SERIALIZED_BYTES + 1024),
      createdAt: 1100,
    });

    const trace = assembleBoundedTurnTrace(boundary(conv.id, "m-user-1", 1000));
    expect(trace).toBeNull();
  });
});

describe("isTurnSettled", () => {
  test("batched head with a later real user row is NOT settled while the conversation is processing", () => {
    // Batched-message path: drainBatch persists the head user row AND the tail
    // user row(s) up front, then runs ONE shared response. So the head has a
    // later real user turn while the shared response is still in flight — it
    // must NOT be treated as settled (the old "successor exists" shortcut would
    // have shipped a partial trace for the head).
    const conv = createConversation({ conversationType: "standard" });
    insertMessage(conv.id, {
      id: "m-user-1",
      role: "user",
      content: [{ type: "text", text: "head of batch" }],
      createdAt: 1000,
    });
    insertMessage(conv.id, {
      id: "m-user-2",
      role: "user",
      content: [{ type: "text", text: "tail of batch" }],
      createdAt: 2000,
    });
    // Shared response still generating.
    mockLiveConversation = { isProcessing: () => true };
    expect(isTurnSettled(boundary(conv.id, "m-user-1", 1000))).toBe(false);
    // The tail (latest turn) is likewise deferred while processing.
    expect(isTurnSettled(boundary(conv.id, "m-user-2", 2000))).toBe(false);
  });

  test("the batched head settles once the shared response completes (conversation idle)", () => {
    const conv = createConversation({ conversationType: "standard" });
    insertMessage(conv.id, {
      id: "m-user-1",
      role: "user",
      content: [{ type: "text", text: "head of batch" }],
      createdAt: 1000,
    });
    insertMessage(conv.id, {
      id: "m-user-2",
      role: "user",
      content: [{ type: "text", text: "tail of batch" }],
      createdAt: 2000,
    });
    // Shared response finished -> conversation idle -> both turns settle.
    mockLiveConversation = { isProcessing: () => false };
    expect(isTurnSettled(boundary(conv.id, "m-user-1", 1000))).toBe(true);
    expect(isTurnSettled(boundary(conv.id, "m-user-2", 2000))).toBe(true);
  });

  test("a completed earlier turn defers while a later turn's response is in flight, then settles when idle", () => {
    // Serialized (non-batch) path: T1 finished, T2 now generating. Gating on
    // isProcessing() defers T1 until the conversation goes idle. This is a
    // latency cost, not data loss — T1 traces completely once T2 finishes.
    const conv = createConversation({ conversationType: "standard" });
    insertMessage(conv.id, {
      id: "m-user-1",
      role: "user",
      content: [{ type: "text", text: "first (done)" }],
      createdAt: 1000,
    });
    insertMessage(conv.id, {
      id: "m-user-2",
      role: "user",
      content: [{ type: "text", text: "second (generating)" }],
      createdAt: 2000,
    });
    mockLiveConversation = { isProcessing: () => true };
    expect(isTurnSettled(boundary(conv.id, "m-user-1", 1000))).toBe(false);

    // Conversation goes idle -> the earlier turn settles promptly.
    mockLiveConversation = { isProcessing: () => false };
    expect(isTurnSettled(boundary(conv.id, "m-user-1", 1000))).toBe(true);
  });

  test("settledness follows the conversation's processing state regardless of intervening tool-result rows", () => {
    const conv = createConversation({ conversationType: "standard" });
    insertMessage(conv.id, {
      id: "m-user-1",
      role: "user",
      content: [{ type: "text", text: "do a thing" }],
      createdAt: 1000,
    });
    // Tool-result row persisted as role="user" — part of this turn's response.
    insertMessage(conv.id, {
      id: "m-toolresult",
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu-x", content: "done" }],
      createdAt: 1100,
    });
    // Still generating -> not settled.
    mockLiveConversation = { isProcessing: () => true };
    expect(isTurnSettled(boundary(conv.id, "m-user-1", 1000))).toBe(false);
    // Response finished -> settled.
    mockLiveConversation = { isProcessing: () => false };
    expect(isTurnSettled(boundary(conv.id, "m-user-1", 1000))).toBe(true);
  });

  test("NOT settled when this is the latest real user turn and the conversation is processing", () => {
    const conv = createConversation({ conversationType: "standard" });
    insertMessage(conv.id, {
      id: "m-user-1",
      role: "user",
      content: [{ type: "text", text: "still generating" }],
      createdAt: 1000,
    });
    // Latest real turn + live conversation actively processing -> in-flight.
    mockLiveConversation = { isProcessing: () => true };
    expect(isTurnSettled(boundary(conv.id, "m-user-1", 1000))).toBe(false);
  });

  test("settled when this is the latest real user turn but the conversation is idle (final turn)", () => {
    const conv = createConversation({ conversationType: "standard" });
    insertMessage(conv.id, {
      id: "m-user-1",
      role: "user",
      content: [{ type: "text", text: "final turn" }],
      createdAt: 1000,
    });
    mockLiveConversation = { isProcessing: () => false };
    expect(isTurnSettled(boundary(conv.id, "m-user-1", 1000))).toBe(true);
  });

  test("settled when the conversation is not in the live registry (evicted / not loaded)", () => {
    const conv = createConversation({ conversationType: "standard" });
    insertMessage(conv.id, {
      id: "m-user-1",
      role: "user",
      content: [{ type: "text", text: "from an evicted conversation" }],
      createdAt: 1000,
    });
    // No live conversation -> no in-flight turn -> settled.
    mockLiveConversation = undefined;
    expect(isTurnSettled(boundary(conv.id, "m-user-1", 1000))).toBe(true);
  });
});
