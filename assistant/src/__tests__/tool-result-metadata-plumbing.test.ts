/**
 * Tests that `ToolExecutionResult.activityMetadata` plumbs through to the
 * emitted `tool_result` server event via `handleToolResult`. The forward path
 * is: ToolExecutionResult (set by the tool executor) → AgentEvent tool_result
 * (emitted by the agent loop) → tool_result server message (emitted by
 * handleToolResult to the SSE sink).
 *
 * Mirrors the mocked-dependency pattern used in tool-preview-lifecycle.test.ts
 * and annotate-risk-options.test.ts.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../persistence/conversation-crud.js", () => ({
  setConversationProcessingStartedAt: () => {},
  isConversationProcessing: () => false,
  addMessage: () => ({ id: "mock-msg-id" }),
  getMessageById: () => null,
  updateMessageContent: () => {},
  provenanceFromTrustContext: () => ({}),
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
}));

mock.module("../persistence/llm-request-log-store.js", () => ({
  recordRequestLog: () => {},
  backfillMessageIdOnLogs: () => {},
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────
import type {
  EventHandlerDeps,
  EventHandlerState,
} from "../daemon/conversation-agent-loop-handlers.js";
import {
  createEventHandlerState,
  handleToolResult,
} from "../daemon/conversation-agent-loop-handlers.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import type { ToolActivityMetadata } from "../daemon/message-types/web-activity.js";

type ToolResultEvent = Extract<ServerMessage, { type: "tool_result" }>;

// ── Helpers ───────────────────────────────────────────────────────────────────

function createCollectorDeps(): {
  deps: EventHandlerDeps;
  events: ServerMessage[];
} {
  const events: ServerMessage[] = [];
  const deps = {
    ctx: {
      conversationId: "conv-meta",
      provider: { name: "anthropic" },
      streamThinking: false,
      emitActivityState: () => {},
      markWorkspaceTopLevelDirty: () => {},
      currentTurnSurfaces: [],
    } as unknown as EventHandlerDeps["ctx"],
    onEvent: (msg: ServerMessage) => events.push(msg),
    reqId: "req-meta",
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
      userMessageInterface: "macos",
      assistantMessageInterface: "macos",
    } as EventHandlerDeps["turnInterfaceContext"],
    applyCompaction: async () => {},
  } as EventHandlerDeps;
  return { deps, events };
}

function primeState(state: EventHandlerState, toolUseId: string): void {
  state.toolUseIdToName.set(toolUseId, "web_search");
  state.toolCallTimestamps.set(toolUseId, { startedAt: Date.now() });
  state.currentTurnToolUseIds.push(toolUseId);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("tool_result activityMetadata plumbing", () => {
  let state: EventHandlerState;

  beforeEach(() => {
    state = createEventHandlerState();
  });

  test("forwards activityMetadata to the emitted tool_result event", () => {
    const { deps, events } = createCollectorDeps();
    const toolUseId = "toolu_meta_present";
    primeState(state, toolUseId);

    const activityMetadata: ToolActivityMetadata = {
      webSearch: {
        query: "x",
        provider: "tavily",
        resultCount: 0,
        durationMs: 1,
        results: [],
      },
    };

    handleToolResult(state, deps, {
      type: "tool_result",
      toolUseId,
      content: "",
      isError: false,
      activityMetadata,
    });

    const toolResultEvent = events.find(
      (e): e is ToolResultEvent => e.type === "tool_result",
    );
    expect(toolResultEvent).toBeDefined();
    expect(toolResultEvent?.activityMetadata).toEqual(activityMetadata);
  });

  test("omits activityMetadata when the executor did not populate it", () => {
    const { deps, events } = createCollectorDeps();
    const toolUseId = "toolu_meta_absent";
    primeState(state, toolUseId);

    handleToolResult(state, deps, {
      type: "tool_result",
      toolUseId,
      content: "ok",
      isError: false,
    });

    const toolResultEvent = events.find(
      (e): e is ToolResultEvent => e.type === "tool_result",
    );
    expect(toolResultEvent).toBeDefined();
    expect(toolResultEvent?.activityMetadata).toBeUndefined();
  });
});
