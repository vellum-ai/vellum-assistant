/**
 * Tests for persisting an answered `ask_question` prompt onto its tool_use
 * block, so the question and the user's answer stay in the transcript instead
 * of disappearing with the interactive card.
 *
 * Covers the write half of the round-trip:
 *   handleToolResult(event carrying answeredQuestion)
 *     → immediate `_answeredQuestion` stamp on the persisted row
 *     → state.toolAnsweredQuestions captures it
 *     → annotatePersistedAssistantMessage re-stamps at end of turn
 *
 * The read half (renderHistoryContent in handlers/shared.ts) lives in
 * server-history-render.test.ts.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

let mockedRowContent = "";
const updates: Array<{ id: string; content: string }> = [];

mock.module("../persistence/conversation-crud.js", () => ({
  setConversationProcessingStartedAt: () => {},
  isConversationProcessing: () => false,
  addMessage: () => ({ id: "mock-msg-id" }),
  getMessageById: (id: string) =>
    mockedRowContent ? { id, content: JSON.parse(mockedRowContent) } : null,
  updateMessageContent: (id: string, content: string) => {
    updates.push({ id, content });
    mockedRowContent = content;
  },
  provenanceFromTrustContext: () => ({}),
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
}));

mock.module("../persistence/llm-request-log-store.js", () => ({
  recordRequestLog: () => {},
  backfillMessageIdOnLogs: () => {},
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────
import type { AnsweredQuestion } from "../api/events/question-answered.js";
import type {
  EventHandlerDeps,
  EventHandlerState,
} from "../daemon/conversation-agent-loop-handlers.js";
import {
  createEventHandlerState,
  handleToolResult,
} from "../daemon/conversation-agent-loop-handlers.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const emitted: Array<Record<string, unknown>> = [];

function makeDeps(): EventHandlerDeps {
  return {
    ctx: {
      conversationId: "test-conv",
      provider: { name: "anthropic" },
      streamThinking: false,
      emitActivityState: () => {},
      markWorkspaceTopLevelDirty: () => {},
      currentTurnSurfaces: [],
    } as unknown as EventHandlerDeps["ctx"],
    onEvent: (event: unknown) => {
      emitted.push(event as Record<string, unknown>);
    },
    reqId: "test-req",
    isFirstMessage: false,
    shouldGenerateTitle: false,
    rlog: new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }) as unknown as EventHandlerDeps["rlog"],
    turnChannelContext: {
      userMessageChannel: "vellum",
      assistantMessageChannel: "vellum",
    } as unknown as EventHandlerDeps["turnChannelContext"],
    turnInterfaceContext: {
      userMessageInterface: "web",
      assistantMessageInterface: "web",
    } as unknown as EventHandlerDeps["turnInterfaceContext"],
    applyCompaction: async () => {},
  };
}

/**
 * Seed a turn whose assistant row holds `toolUseIds` tool_use blocks, all of
 * them `ask_question` unless stated otherwise. Every id is registered as
 * in-flight, so end-of-turn annotation only runs once each has a result.
 */
function setupState(toolUseIds: string[]): EventHandlerState {
  const state = createEventHandlerState();
  state.lastAssistantMessageId = "msg-1";
  for (const id of toolUseIds) {
    state.toolUseIdToName.set(id, "ask_question");
    state.toolCallTimestamps.set(id, { startedAt: Date.now() });
    state.currentTurnToolUseIds.push(id);
  }
  mockedRowContent = JSON.stringify(
    toolUseIds.map((id) => ({
      type: "tool_use",
      id,
      name: "ask_question",
      input: { questions: [{ question: "Which Alice?", options: [] }] },
    })),
  );
  return state;
}

function persistedToolUse(toolUseId: string): Record<string, unknown> {
  const parsed = JSON.parse(mockedRowContent) as Array<Record<string, unknown>>;
  const block = parsed.find((b) => b.type === "tool_use" && b.id === toolUseId);
  if (!block) {
    throw new Error(`tool_use block ${toolUseId} not found`);
  }
  return block;
}

const ANSWERED: AnsweredQuestion = {
  requestId: "req-1",
  questions: [
    {
      id: "q1",
      question: "Which Alice?",
      options: [
        { id: "alice_work", label: "Alice (work)" },
        { id: "alice_personal", label: "Alice (personal)" },
      ],
    },
  ],
  responses: [{ questionId: "q1", decision: "option", optionId: "alice_work" }],
  overall: "completed",
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("answered ask_question persistence", () => {
  beforeEach(() => {
    updates.length = 0;
    emitted.length = 0;
    mockedRowContent = "";
  });

  test("stamps the answered record on the tool_use block and forwards it to clients", () => {
    const state = setupState(["tu_q"]);

    handleToolResult(state, makeDeps(), {
      type: "tool_result",
      toolUseId: "tu_q",
      content: 'Question "Which Alice?" → Option: alice_work (Alice (work))',
      isError: false,
      answeredQuestion: ANSWERED,
    });

    expect(persistedToolUse("tu_q")._answeredQuestion).toEqual(ANSWERED);
    const toolResult = emitted.find((e) => e.type === "tool_result");
    expect(toolResult?.answeredQuestion).toEqual(ANSWERED);
  });

  test("stamps immediately, before the turn's other tools have finished", () => {
    // A batch where `ask_question` settles first: the user can switch away
    // (forcing a history refetch) while the sibling tool still runs, so the
    // answer must already be durable rather than waiting for end-of-turn
    // annotation.
    const state = setupState(["tu_q", "tu_slow"]);

    handleToolResult(state, makeDeps(), {
      type: "tool_result",
      toolUseId: "tu_q",
      content: "answered",
      isError: false,
      answeredQuestion: ANSWERED,
    });

    expect(
      state.toolCallTimestamps.get("tu_slow")?.completedAt,
    ).toBeUndefined();
    expect(persistedToolUse("tu_q")._answeredQuestion).toEqual(ANSWERED);
  });

  test("survives the end-of-turn annotation that re-stamps the row", () => {
    const state = setupState(["tu_q"]);
    const deps = makeDeps();

    handleToolResult(state, deps, {
      type: "tool_result",
      toolUseId: "tu_q",
      content: "answered",
      isError: false,
      answeredQuestion: ANSWERED,
    });

    // The result above completes the turn's only tool, so annotation has
    // already run. It writes timing metadata alongside, and must not drop the
    // answered record it did not author.
    const block = persistedToolUse("tu_q");
    expect(block._answeredQuestion).toEqual(ANSWERED);
    expect(block._startedAt).toBeNumber();
  });

  test("re-stamping the same record does not rewrite the row", () => {
    const state = setupState(["tu_q"]);
    const deps = makeDeps();

    handleToolResult(state, deps, {
      type: "tool_result",
      toolUseId: "tu_q",
      content: "answered",
      isError: false,
      answeredQuestion: ANSWERED,
    });
    // Early stamp + end-of-turn annotation.
    expect(updates).toHaveLength(2);

    handleToolResult(state, deps, {
      type: "tool_result",
      toolUseId: "tu_q",
      content: "answered",
      isError: false,
      answeredQuestion: ANSWERED,
    });

    // The second result re-runs the early stamp; the identical requestId makes
    // it a no-op, so the row is not rewritten.
    expect(updates).toHaveLength(2);
    expect(persistedToolUse("tu_q")._answeredQuestion).toEqual(ANSWERED);
  });

  test("leaves the block unstamped when the result carries no answered record", () => {
    const state = setupState(["tu_q"]);

    handleToolResult(state, makeDeps(), {
      type: "tool_result",
      toolUseId: "tu_q",
      content: "User did not respond within timeout",
      isError: true,
    });

    expect(persistedToolUse("tu_q")._answeredQuestion).toBeUndefined();
  });
});
