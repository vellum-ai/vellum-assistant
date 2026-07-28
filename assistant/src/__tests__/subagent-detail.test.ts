/**
 * Tests for parseSubagentMessages — verifies that tool result content is
 * correctly extracted from both string and array formats — and for the
 * getSubagentDetail route handler's server-side resolution of the subagent's
 * own conversation id.
 */

import { describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — must be registered before importing the module under test
// ---------------------------------------------------------------------------

/** conversationId → messages, so a wrong id yields a visibly wrong transcript. */
const conversations = new Map<string, MessageRow[]>();

mock.module("../persistence/conversation-crud.js", () => ({
  getMessages: (conversationId: string) =>
    conversations.get(conversationId) ?? [],
}));

const usageByConversation = new Map<
  string,
  { inputTokens: number; outputTokens: number; estimatedCost: number }
>();

mock.module("../persistence/llm-usage-store.js", () => ({
  getConversationUsageTotals: (conversationId: string) =>
    usageByConversation.get(conversationId) ?? {
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: 0,
    },
}));

/** Subagents the live manager still holds, keyed by subagent id. */
const liveSubagents = new Map<
  string,
  { conversationId: string; status: string; config: { label: string } }
>();

mock.module("../subagent/index.js", () => ({
  getSubagentManager: () => ({
    getState: (id: string) => liveSubagents.get(id),
  }),
}));

/** Subagents that survive only in durable records, keyed by subagent id. */
const durableRecords = new Map<
  string,
  { conversationId: string; label: string }
>();

mock.module("../persistence/subagent-store.js", () => ({
  getSubagentRecordById: (id: string) => durableRecords.get(id),
}));

import type { MessageRow } from "../persistence/conversation-crud.js";
import { BadRequestError } from "../runtime/routes/errors.js";
import {
  parseSubagentMessages,
  ROUTES,
} from "../runtime/routes/subagents-routes.js";

let msgCounter = 0;
function msg(role: string, content: unknown[]): MessageRow {
  msgCounter += 1;
  return {
    id: `msg-${msgCounter}`,
    conversationId: "conv-1",
    role,
    content: content as MessageRow["content"],
    createdAt: Date.now(),
    metadata: null,
    clientMessageId: null,
    finalized: 1,
  };
}

describe("parseSubagentMessages", () => {
  test("extracts string tool_result content", () => {
    const messages = [
      msg("user", [{ type: "text", text: "Do something" }]),
      msg("assistant", [
        {
          type: "tool_use",
          id: "t1",
          name: "web_search",
          input: { query: "test" },
        },
      ]),
      msg("user", [
        {
          type: "tool_result",
          tool_use_id: "t1",
          content: "Search results here",
        },
      ]),
    ];

    const result = parseSubagentMessages("sub-1", messages);
    const toolResult = result.events.find((e) => e.type === "tool_result");
    expect(toolResult).toBeDefined();
    expect(toolResult!.content).toBe("Search results here");
    expect(toolResult!.toolName).toBe("web_search");
  });

  test("extracts array-format tool_result content", () => {
    const messages = [
      msg("user", [{ type: "text", text: "Do something" }]),
      msg("assistant", [
        {
          type: "tool_use",
          id: "t2",
          name: "file_read",
          input: { file_path: "/tmp/test.txt" },
        },
      ]),
      msg("user", [
        {
          type: "tool_result",
          tool_use_id: "t2",
          content: [
            { type: "text", text: "Line 1 of file" },
            { type: "text", text: "Line 2 of file" },
          ],
        },
      ]),
    ];

    const result = parseSubagentMessages("sub-1", messages);
    const toolResult = result.events.find((e) => e.type === "tool_result");
    expect(toolResult).toBeDefined();
    expect(toolResult!.content).toBe("Line 1 of file\nLine 2 of file");
    expect(toolResult!.toolName).toBe("file_read");
  });

  test("handles null tool_result content gracefully", () => {
    const messages = [
      msg("user", [{ type: "text", text: "Do something" }]),
      msg("assistant", [
        {
          type: "tool_use",
          id: "t3",
          name: "bash",
          input: { command: "echo hi" },
        },
      ]),
      msg("user", [{ type: "tool_result", tool_use_id: "t3", content: null }]),
    ];

    const result = parseSubagentMessages("sub-1", messages);
    const toolResult = result.events.find((e) => e.type === "tool_result");
    expect(toolResult).toBeDefined();
    expect(toolResult!.content).toBe("");
  });

  test("extracts objective from first user message", () => {
    const messages = [
      msg("user", [{ type: "text", text: "Research vampire lore" }]),
      msg("assistant", [{ type: "text", text: "On it." }]),
    ];

    const result = parseSubagentMessages("sub-1", messages);
    expect(result.objective).toBe("Research vampire lore");
  });

  test("strips fork directive framing from objective", () => {
    const forkPrompt = [
      "⎯⎯⎯ FORK TASK ⎯⎯⎯",
      "You have been forked from the parent conversation to execute a specific task.",
      "The conversation above is context — do NOT continue it. Do NOT spawn sub-agents.",
      "Complete this task directly and return only your findings:",
      "",
      "Research vampire lore",
      "⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯",
    ].join("\n");

    const messages = [
      msg("user", [{ type: "text", text: forkPrompt }]),
      msg("assistant", [{ type: "text", text: "On it." }]),
    ];

    const result = parseSubagentMessages("sub-1", messages);
    expect(result.objective).toBe("Research vampire lore");
  });

  test("emits toolUseId and raw input on tool_use, toolUseId on tool_result", () => {
    const messages = [
      msg("user", [{ type: "text", text: "Do something" }]),
      msg("assistant", [
        {
          type: "tool_use",
          id: "t-abc",
          name: "bash",
          input: { command: "ls -la" },
        },
      ]),
      msg("user", [
        { type: "tool_result", tool_use_id: "t-abc", content: "total 0" },
      ]),
    ];

    const result = parseSubagentMessages("sub-1", messages);
    const toolUse = result.events.find((e) => e.type === "tool_use");
    expect(toolUse).toBeDefined();
    expect(toolUse!.toolUseId).toBe("t-abc");
    expect(toolUse!.input).toEqual({ command: "ls -la" });

    const toolResult = result.events.find((e) => e.type === "tool_result");
    expect(toolResult).toBeDefined();
    expect(toolResult!.toolUseId).toBe("t-abc");
  });

  test("includes messageId on text events from assistant messages", () => {
    const messages = [
      msg("user", [{ type: "text", text: "Do something" }]),
      msg("assistant", [{ type: "text", text: "Done." }]),
    ];

    const result = parseSubagentMessages("sub-1", messages);
    const textEvent = result.events.find((e) => e.type === "text");
    expect(textEvent).toBeDefined();
    expect(textEvent!.messageId).toBe(messages[1].id);
  });
});

// ---------------------------------------------------------------------------
// getSubagentDetail route — server-side conversation resolution
// ---------------------------------------------------------------------------

const detailRoute = ROUTES.find((r) => r.operationId === "getSubagentDetail")!;

interface DetailResponse {
  events: Array<{ type: string; content: string }>;
  usage?: { inputTokens: number; outputTokens: number; estimatedCost: number };
  status?: string;
  label?: string;
  conversationId?: string;
}

function fetchDetail(id: string, conversationId?: string): DetailResponse {
  return detailRoute.handler({
    pathParams: { id },
    queryParams: conversationId ? { conversationId } : {},
  }) as DetailResponse;
}

function seedConversation(conversationId: string, text: string): void {
  conversations.set(conversationId, [
    msg("user", [{ type: "text", text: `objective for ${conversationId}` }]),
    msg("assistant", [{ type: "text", text }]),
  ]);
}

describe("getSubagentDetail route resolution", () => {
  test("ignores a wrong conversationId param when the manager knows the subagent", () => {
    seedConversation("parent-conv", "parent transcript");
    seedConversation("child-conv", "child transcript");
    usageByConversation.set("parent-conv", {
      inputTokens: 999,
      outputTokens: 999,
      estimatedCost: 9.99,
    });
    usageByConversation.set("child-conv", {
      inputTokens: 12,
      outputTokens: 34,
      estimatedCost: 0.5,
    });
    liveSubagents.set("sub-live", {
      conversationId: "child-conv",
      status: "running",
      config: { label: "Live label" },
    });

    // The client sends the PARENT id — server-side resolution must win.
    const result = fetchDetail("sub-live", "parent-conv");

    expect(result.events.map((e) => e.content)).toContain("child transcript");
    expect(result.usage).toEqual({
      inputTokens: 12,
      outputTokens: 34,
      estimatedCost: 0.5,
    });
    expect(result.status).toBe("running");
    expect(result.label).toBe("Live label");
    expect(result.conversationId).toBe("child-conv");
  });

  test("falls back to the durable record when the manager has evicted the subagent", () => {
    seedConversation("evicted-child-conv", "evicted transcript");
    durableRecords.set("sub-evicted", {
      conversationId: "evicted-child-conv",
      label: "Recorded label",
    });

    const result = fetchDetail("sub-evicted", "parent-conv");

    expect(result.events.map((e) => e.content)).toContain("evicted transcript");
    expect(result.status).toBeUndefined();
    expect(result.label).toBe("Recorded label");
    expect(result.conversationId).toBe("evicted-child-conv");
  });

  test("uses the query param when the daemon knows nothing about the subagent", () => {
    seedConversation("orphan-conv", "orphan transcript");

    const result = fetchDetail("sub-orphan", "orphan-conv");

    expect(result.events.map((e) => e.content)).toContain("orphan transcript");
    expect(result.label).toBeUndefined();
    expect(result.conversationId).toBe("orphan-conv");
  });

  test("throws BadRequestError when no conversation can be resolved", () => {
    expect(() => fetchDetail("sub-unknown")).toThrow(BadRequestError);
  });
});
