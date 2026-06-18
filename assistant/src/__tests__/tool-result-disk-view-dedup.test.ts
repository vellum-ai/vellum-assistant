/**
 * Regression test for "Subagents duplicate messages".
 *
 * The grouped tool-result `user` row is reserved once per turn and rewritten in
 * place in the DB (a single message row). The JSONL disk view, however, is
 * append-only: each `syncMessageToDisk` call appends a fresh line. The bug was
 * that the row was synced to disk BOTH on arrival (`persistPendingToolResultRow`,
 * fired per `tool_result` event) AND again at the turn boundary
 * (`finalizePendingToolResultRow`), so a single DB tool-result message produced
 * two (or, with N parallel results, N+1) identical lines in `messages.jsonl`.
 * Surfaces that render from the disk view — e.g. subagent tool results — then
 * showed every tool-result message twice.
 *
 * The fix syncs the grouped row to disk exactly once, at the turn/loop
 * boundary, mirroring the assistant row (which streams in place during the turn
 * and is synced once after the loop completes). These tests pin that invariant:
 * one `syncMessageToDisk` call for the reserved tool-result row per turn,
 * regardless of how many results arrived.
 *
 * Mirrors the mocked-dependency pattern in tool-preview-lifecycle.test.ts.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Mock platform (must precede imports that read it) ─────────────────────────
mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({ memory: {} }),
  loadConfig: () => ({}),
}));

// The grouped tool-result row reserves under role "user"; return a stable,
// role-distinct id so the assertions can target exactly that row. A non-null
// `getConversation`/`getMessageById` is required so BOTH the on-arrival and
// finalize disk-sync paths are reachable (each guards on a real row) — the
// pre-fix code would then sync twice.
const reserveMessageMock = mock(
  async (_conversationId: string, role: string) =>
    role === "user" ? { id: "tool-result-row" } : { id: "assistant-row" },
);
mock.module("../memory/conversation-crud.js", () => ({
  getConversation: () => ({ id: "conv-dedup", createdAt: 1_700_000_000_000 }),
  getMessageById: () => ({
    id: "tool-result-row",
    role: "user",
    createdAt: 1_700_000_000_000,
    metadata: null,
  }),
  updateMessageContent: () => {},
  provenanceFromTrustContext: () => ({}),
  reserveMessage: reserveMessageMock,
}));

const syncMessageToDiskMock = mock(
  (_conversationId: string, _messageId: string, _createdAtMs: number) => {},
);
mock.module("../memory/conversation-disk-view.js", () => ({
  syncMessageToDisk: syncMessageToDiskMock,
}));

// finalize indexes the row for memory recall; keep it inert.
mock.module("../memory/indexer.js", () => ({
  indexMessageNow: async () => {},
}));

mock.module("../memory/llm-request-log-store.js", () => ({
  recordRequestLog: () => {},
  backfillMessageIdOnLogs: () => {},
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function createMockDeps(): EventHandlerDeps {
  return {
    ctx: {
      conversationId: "conv-dedup",
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
    rlog: new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }) as unknown as EventHandlerDeps["rlog"],
    turnChannelContext: {
      userMessageChannel: "vellum",
      assistantMessageChannel: "vellum",
    } as EventHandlerDeps["turnChannelContext"],
    turnInterfaceContext: {
      userMessageInterface: "web",
      assistantMessageInterface: "web",
    } as EventHandlerDeps["turnInterfaceContext"],
    applyCompaction: async () => {},
  } as EventHandlerDeps;
}

function primeToolUse(state: EventHandlerState, toolUseId: string): void {
  state.toolUseIdToName.set(toolUseId, "subagent_read");
  state.toolCallTimestamps.set(toolUseId, { startedAt: Date.now() });
  state.currentTurnToolUseIds.push(toolUseId);
}

function toolResultEvent(
  toolUseId: string,
  content: string,
): Extract<AgentEvent, { type: "tool_result" }> {
  return {
    type: "tool_result",
    toolUseId,
    content,
    isError: false,
  } as Extract<AgentEvent, { type: "tool_result" }>;
}

function toolResultMetadata(): Record<string, unknown> {
  return {
    userMessageChannel: "vellum",
    assistantMessageChannel: "vellum",
    userMessageInterface: "web",
    assistantMessageInterface: "web",
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("tool-result disk-view sync is not duplicated", () => {
  let state: EventHandlerState;

  beforeEach(() => {
    state = createEventHandlerState();
    syncMessageToDiskMock.mockClear();
    reserveMessageMock.mockClear();
  });

  test("a single tool result syncs to disk exactly once across arrival + finalize", async () => {
    const deps = createMockDeps();
    const toolUseId = "toolu_single";
    primeToolUse(state, toolUseId);

    // Arrival: persists the grouped row in place (no disk sync).
    await handleToolResult(state, deps, toolResultEvent(toolUseId, "output"));
    // Turn boundary: rewrites the row and syncs it to disk once.
    await finalizePendingToolResultRow(
      state,
      deps.ctx.conversationId,
      toolResultMetadata(),
      deps.rlog,
    );

    const syncedRowIds = syncMessageToDiskMock.mock.calls.map(
      (call) => (call as unknown as [string, string, number])[1],
    );
    expect(syncedRowIds).toEqual(["tool-result-row"]);
  });

  test("multiple parallel tool results still sync the grouped row once", async () => {
    const deps = createMockDeps();
    const ids = ["toolu_a", "toolu_b", "toolu_c"];
    for (const id of ids) primeToolUse(state, id);

    // Each parallel result arrives and persists into the same reserved row.
    for (const id of ids) {
      await handleToolResult(state, deps, toolResultEvent(id, `out-${id}`));
    }
    await finalizePendingToolResultRow(
      state,
      deps.ctx.conversationId,
      toolResultMetadata(),
      deps.rlog,
    );

    const syncedRowIds = syncMessageToDiskMock.mock.calls.map(
      (call) => (call as unknown as [string, string, number])[1],
    );
    // One row, reserved once, synced once — not once per arrival.
    expect(reserveMessageMock.mock.calls.length).toBe(1);
    expect(syncedRowIds).toEqual(["tool-result-row"]);
  });
});
