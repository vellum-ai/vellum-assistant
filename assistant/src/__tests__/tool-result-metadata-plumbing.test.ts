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
import type { AssistantEvent } from "../api/index.js";
import { toolImageFilename } from "../daemon/assistant-attachments.js";
import type {
  EventHandlerDeps,
  EventHandlerState,
} from "../daemon/conversation-agent-loop-handlers.js";
import {
  createEventHandlerState,
  handleToolResult,
  handleToolUse,
} from "../daemon/conversation-agent-loop-handlers.js";
import type { ToolActivityMetadata } from "../daemon/message-types/web-activity.js";

type ToolResultEvent = Extract<AssistantEvent, { type: "tool_result" }>;

// ── Helpers ───────────────────────────────────────────────────────────────────

function createCollectorDeps(): {
  deps: EventHandlerDeps;
  events: AssistantEvent[];
} {
  const events: AssistantEvent[] = [];
  const deps = {
    ctx: {
      conversationId: "conv-meta",
      provider: { name: "anthropic" },
      streamThinking: false,
      emitActivityState: () => {},
      markWorkspaceTopLevelDirty: () => {},
      currentTurnSurfaces: [],
    } as unknown as EventHandlerDeps["ctx"],
    onEvent: (msg: AssistantEvent) => events.push(msg),
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

describe("computer-use screenshot capture", () => {
  test("tracks direct and wrapped invocations but excludes their images from ordinary promotion", () => {
    const state = createEventHandlerState();
    const { deps } = createCollectorDeps();

    handleToolUse(state, deps, {
      type: "tool_use",
      id: "direct-call",
      name: "computer_use_click",
      input: { x: 10, y: 20 },
    });
    handleToolUse(state, deps, {
      type: "tool_use",
      id: "wrapped-call",
      name: "skill_execute",
      input: { tool: "computer_use_scroll" },
    });
    handleToolUse(state, deps, {
      type: "tool_use",
      id: "ordinary-call",
      name: "browser_screenshot",
      input: {},
    });
    handleToolResult(state, deps, {
      type: "tool_result",
      toolUseId: "wrapped-call",
      content: "scrolled",
      isError: false,
      contentBlocks: [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: "c2NyZWVuc2hvdA==",
          },
        },
      ],
    });

    expect(state.computerUseToolUseIds).toEqual([
      "direct-call",
      "wrapped-call",
    ]);
    expect(state.computerUseToolNames).toEqual(
      new Map([
        ["direct-call", "computer_use_click"],
        ["wrapped-call", "computer_use_scroll"],
      ]),
    );
    expect(
      toolImageFilename(
        "image/png",
        state.computerUseToolNames.get("wrapped-call"),
      ),
    ).toBe("computer-use-scroll.png");
    expect(state.computerUseScreenshotBlocks.has("wrapped-call")).toBe(true);
    expect(state.accumulatedToolContentBlocks).toEqual([]);
  });
});
