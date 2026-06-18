/**
 * Tests for the turn-trace assembler.
 *
 * Verifies that a turn's transcript (user message, assistant responses, and
 * tool_result rows) plus its tool invocations are gathered into a faithful,
 * window-bounded trace, that the window stops at the next REAL user turn (and
 * never at the turn's own tool-result rows), that sensitive tool-input keys are
 * field-redacted, and that the size cap omits oversized traces fail-closed.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { makeMockLogger } from "../__tests__/helpers/mock-logger.js";

mock.module("../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

import { createConversation } from "./conversation-crud.js";
import { getDb } from "./db-connection.js";
import { initializeDb } from "./db-init.js";
import { messages, toolInvocations } from "./schema.js";
import {
  assembleBoundedTurnTrace,
  assembleTurnTrace,
  MAX_TRACE_SERIALIZED_BYTES,
  type TurnTraceBoundary,
} from "./turn-trace-store.js";

initializeDb();

function purge(): void {
  const db = getDb();
  db.run("DELETE FROM tool_invocations");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

beforeEach(() => {
  purge();
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

    expect(trace.schema_version).toBe(1);
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

  test("redacts sensitive keys in tool inputs but keeps results verbatim", () => {
    const conv = createConversation({ conversationType: "standard" });
    insertMessage(conv.id, {
      id: "m-user-1",
      role: "user",
      content: [{ type: "text", text: "use my token" }],
      createdAt: 1000,
    });
    insertTool(conv.id, {
      id: "ti-secret",
      toolName: "http_request",
      input: JSON.stringify({
        url: "https://api.example.com",
        access_token: "super-secret-value",
        nested: { api_key: "also-secret" },
      }),
      result: JSON.stringify({ status: 200 }),
      createdAt: 1100,
    });

    const trace = assembleTurnTrace(boundary(conv.id, "m-user-1", 1000));
    const call = trace.tool_calls[0];
    const input = call.input as Record<string, unknown>;
    // Non-sensitive keys pass through.
    expect(input.url).toBe("https://api.example.com");
    // Sensitive keys are redacted (value never appears).
    expect(input.access_token).toBe("<redacted />");
    expect((input.nested as Record<string, unknown>).api_key).toBe(
      "<redacted />",
    );
    expect(JSON.stringify(call.input)).not.toContain("super-secret-value");
    expect(JSON.stringify(call.input)).not.toContain("also-secret");
    // Result is NOT key-redacted — forwarded verbatim.
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
