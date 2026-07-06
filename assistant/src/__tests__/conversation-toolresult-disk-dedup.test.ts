/**
 * Regression test: a turn with multiple parallel tool calls must project
 * exactly one grouped tool-result line into the conversation disk view
 * (`messages.jsonl`), carrying every result once.
 *
 * The grouped `user` row is reserved once per batch and rewritten in place in
 * SQLite as sibling parallel results land. Because `syncMessageToDisk` appends
 * to the append-only JSONL rather than upserting the row, projecting on every
 * arrival emitted one duplicate line per result (N results -> N+1 identical
 * lines). The disk-view projection is deferred to `finalizePendingToolResultRow`
 * so the batch lands as a single line.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, mock, test } from "bun:test";

// ── Mocks (must precede imports that read them) ──────────────────────────────
mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
  LOG_FILE_PATTERN: /assistant-(\d{4}-\d{2}-\d{2})\.log/,
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    model: "test",
    provider: "test",
    memory: { enabled: false },
    llm: { pricingOverrides: {} },
    rateLimit: { maxRequestsPerMinute: 0 },
  }),
  loadConfig: () => ({}),
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────
import type { AgentEvent } from "../agent/loop.js";
import type {
  EventHandlerDeps,
  EventHandlerState,
} from "../daemon/conversation-agent-loop-handlers.js";
import {
  createEventHandlerState,
  finalizePendingToolResultRow,
  handleToolResult,
} from "../daemon/conversation-agent-loop-handlers.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import { createConversation } from "../persistence/conversation-crud.js";
import { getConversationDirPath } from "../persistence/conversation-disk-view.js";
import { initializeDb } from "../persistence/db-init.js";

await initializeDb();

const noopLog = new Proxy({} as Record<string, unknown>, {
  get: () => () => {},
}) as unknown as EventHandlerDeps["rlog"];

function createDeps(conversationId: string): EventHandlerDeps {
  return {
    ctx: {
      conversationId,
      provider: { name: "anthropic" },
      traceEmitter: { emit: () => {} },
      streamThinking: false,
      emitActivityState: () => {},
      markWorkspaceTopLevelDirty: () => {},
      currentTurnSurfaces: [],
    } as unknown as EventHandlerDeps["ctx"],
    onEvent: (_msg: ServerMessage) => {},
    reqId: "req-dedup",
    isFirstMessage: false,
    shouldGenerateTitle: false,
    rlog: noopLog,
    turnChannelContext: {
      userMessageChannel: "vellum",
      assistantMessageChannel: "vellum",
    } as EventHandlerDeps["turnChannelContext"],
    turnInterfaceContext: {
      userMessageInterface: "macos",
      assistantMessageInterface: "macos",
    } as EventHandlerDeps["turnInterfaceContext"],
    applyCompaction: async () => {},
  } as EventHandlerDeps;
}

function toolResultEvent(
  toolUseId: string,
  content: string,
): Extract<AgentEvent, { type: "tool_result" }> {
  return { type: "tool_result", toolUseId, content, isError: false };
}

describe("parallel tool results → disk view", () => {
  test("projects one grouped JSONL line holding every result exactly once", async () => {
    const conv = createConversation("Parallel Tools");
    const deps = createDeps(conv.id);
    const state: EventHandlerState = createEventHandlerState();

    // Simulate three parallel tool results arriving for one assistant turn.
    // Each arrival persists the shared grouped row on arrival (DB-only).
    await handleToolResult(state, deps, toolResultEvent("toolu_a", "result A"));
    await handleToolResult(state, deps, toolResultEvent("toolu_b", "result B"));
    await handleToolResult(state, deps, toolResultEvent("toolu_c", "result C"));

    // Turn boundary: drain the buffer and project the completed row to disk.
    await finalizePendingToolResultRow(
      state,
      conv.id,
      { provenanceTrustClass: "unknown" },
      noopLog,
    );

    const jsonlPath = join(
      getConversationDirPath(conv.id, conv.createdAt),
      "messages.jsonl",
    );
    const lines = readFileSync(jsonlPath, "utf-8")
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);

    // Exactly one grouped tool-result line — not N+1 duplicates.
    expect(lines).toHaveLength(1);

    const record = JSON.parse(lines[0]) as {
      role: string;
      toolResults?: Array<{ content: unknown }>;
    };
    expect(record.role).toBe("user");
    expect(record.toolResults).toHaveLength(3);
    expect(record.toolResults?.map((r) => r.content)).toEqual([
      "result A",
      "result B",
      "result C",
    ]);
  });
});
