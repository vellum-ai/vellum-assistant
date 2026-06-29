/**
 * Tests for `handleToolUse` stamping a tool start time both on the live
 * `tool_use_start` event and on the already-durable persisted tool_use block.
 *
 * The live event carries `startedAt` so clients can anchor a running
 * elapsed-time counter to the server clock instead of SSE receipt time. The
 * persisted `_startedAt` (mapped to the wire `startedAt` in handlers/shared.ts)
 * lets a `/messages` snapshot fetched mid-tool — e.g. after a refresh or
 * reconnect, before the live event was seen — still render that counter.
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
  getConfig: () => ({
    skills: {
      entries: {},
      load: { extraDirs: [], watch: false, watchDebounceMs: 0 },
      install: { nodeManager: "npm" },
      allowBundled: null,
      remoteProviders: {
        skillssh: { enabled: true },
        clawhub: { enabled: true },
      },
      remotePolicy: {
        blockSuspicious: true,
        blockMalware: true,
        maxSkillsShRisk: "medium",
      },
    },
  }),
  loadConfig: () => ({}),
}));

let mockedRowContent = "";
const updates: Array<{ id: string; content: string }> = [];

mock.module("../persistence/conversation-crud.js", () => ({
  setConversationProcessingStartedAt: () => {},
  isConversationProcessing: () => false,
  addMessage: () => ({ id: "mock-msg-id" }),
  getMessageById: (id: string) =>
    mockedRowContent ? { id, content: mockedRowContent } : null,
  updateMessageContent: (id: string, content: string) => {
    updates.push({ id, content });
  },
  provenanceFromTrustContext: () => ({}),
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
  recordConversationPersistedSeq: () => {},
  getConversationPersistedSeq: () => null,
}));

mock.module("../persistence/llm-request-log-store.js", () => ({
  recordRequestLog: () => {},
  backfillMessageIdOnLogs: () => {},
}));

mock.module("../runtime/assistant-stream-state.js", () => ({
  getCurrentSeq: () => 0,
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────
import type { AgentEvent } from "../agent/loop.js";
import type {
  EventHandlerDeps,
  EventHandlerState,
} from "../daemon/conversation-agent-loop-handlers.js";
import {
  createEventHandlerState,
  handleToolUse,
} from "../daemon/conversation-agent-loop-handlers.js";
import type { ServerMessage } from "../daemon/message-protocol.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDeps(onEvent: (event: ServerMessage) => void): EventHandlerDeps {
  return {
    ctx: {
      conversationId: "test-conv",
      provider: { name: "anthropic" },
      traceEmitter: { emit: () => {} },
      streamThinking: false,
      emitActivityState: () => {},
      markWorkspaceTopLevelDirty: () => {},
      currentTurnSurfaces: [],
    } as unknown as EventHandlerDeps["ctx"],
    onEvent,
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

function toolUseEvent(
  id: string,
  name: string,
): Extract<AgentEvent, { type: "tool_use" }> {
  return { type: "tool_use", id, name, input: { command: "ls" } };
}

function findBlockById(
  rawContent: string,
  id: string,
): Record<string, unknown> {
  const parsed = JSON.parse(rawContent) as Array<Record<string, unknown>>;
  const block = parsed.find((b) => b.id === id);
  if (!block) throw new Error(`block ${id} not found`);
  return block;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("handleToolUse — tool start timestamp", () => {
  beforeEach(() => {
    updates.length = 0;
    mockedRowContent = "";
  });

  test("emits a numeric startedAt on the tool_use_start event and records it in state", () => {
    // GIVEN a fresh handler state with a persisted assistant message
    const toolUseId = "tu_bash";
    const state: EventHandlerState = createEventHandlerState();
    state.lastAssistantMessageId = "msg-1";
    mockedRowContent = JSON.stringify([
      {
        type: "tool_use",
        id: toolUseId,
        name: "bash",
        input: { command: "ls" },
      },
    ]);
    const events: ServerMessage[] = [];
    const before = Date.now();

    // WHEN the tool begins
    handleToolUse(
      state,
      makeDeps((e) => events.push(e)),
      toolUseEvent(toolUseId, "bash"),
    );

    // THEN the emitted tool_use_start carries a numeric startedAt within the
    // execution window AND the same value is recorded in toolCallTimestamps
    const startEvent = events.find((e) => e.type === "tool_use_start");
    expect(startEvent?.type).toBe("tool_use_start");
    const startedAt =
      startEvent?.type === "tool_use_start" ? startEvent.startedAt : undefined;
    expect(typeof startedAt).toBe("number");
    expect(startedAt).toBeGreaterThanOrEqual(before);
    expect(startedAt).toBeLessThanOrEqual(Date.now());
    expect(state.toolCallTimestamps.get(toolUseId)?.startedAt).toBe(startedAt);
  });

  test("stamps _startedAt onto the in-flight persisted tool_use block", () => {
    // GIVEN a durable tool_use block with no timing metadata yet
    const toolUseId = "tu_bash";
    const state: EventHandlerState = createEventHandlerState();
    state.lastAssistantMessageId = "msg-1";
    mockedRowContent = JSON.stringify([
      {
        type: "tool_use",
        id: toolUseId,
        name: "bash",
        input: { command: "ls" },
      },
    ]);
    const events: ServerMessage[] = [];

    // WHEN the tool begins
    handleToolUse(
      state,
      makeDeps((e) => events.push(e)),
      toolUseEvent(toolUseId, "bash"),
    );

    // THEN the persisted block is updated with _startedAt matching the event,
    // so a mid-tool snapshot surfaces the start time via handlers/shared.ts
    expect(updates).toHaveLength(1);
    const block = findBlockById(updates[0].content, toolUseId);
    const startEvent = events.find((e) => e.type === "tool_use_start");
    const startedAt =
      startEvent?.type === "tool_use_start" ? startEvent.startedAt : undefined;
    expect(block._startedAt).toBe(startedAt);
  });

  test("stamps _previewStartedAt onto the persisted block when a preview start was recorded", () => {
    // GIVEN a durable tool_use block AND a recorded first-byte preview timestamp
    const toolUseId = "tu_bash";
    const previewStartedAt = 1_700_000_000_000;
    const state: EventHandlerState = createEventHandlerState();
    state.lastAssistantMessageId = "msg-1";
    state.toolPreviewStartedAt.set(toolUseId, previewStartedAt);
    mockedRowContent = JSON.stringify([
      {
        type: "tool_use",
        id: toolUseId,
        name: "bash",
        input: { command: "ls" },
      },
    ]);

    // WHEN the tool begins (the block now exists, unlike at preview-event time)
    handleToolUse(
      state,
      makeDeps(() => {}),
      toolUseEvent(toolUseId, "bash"),
    );

    // THEN a persisted write carries the first-byte anchor as _previewStartedAt,
    // so a mid-tool snapshot keeps the perceived-start rather than falling back
    // to execution start
    const previewWrite = updates.find(
      (u) =>
        findBlockById(u.content, toolUseId)._previewStartedAt ===
        previewStartedAt,
    );
    expect(previewWrite).toBeDefined();
  });

  test("does not stamp _previewStartedAt when no preview start was recorded", () => {
    // GIVEN a durable tool_use block and NO recorded preview timestamp
    const toolUseId = "tu_bash";
    const state: EventHandlerState = createEventHandlerState();
    state.lastAssistantMessageId = "msg-1";
    mockedRowContent = JSON.stringify([
      {
        type: "tool_use",
        id: toolUseId,
        name: "bash",
        input: { command: "ls" },
      },
    ]);

    // WHEN the tool begins
    handleToolUse(
      state,
      makeDeps(() => {}),
      toolUseEvent(toolUseId, "bash"),
    );

    // THEN no persisted write carries a _previewStartedAt (only _startedAt)
    for (const u of updates) {
      expect(
        findBlockById(u.content, toolUseId)._previewStartedAt,
      ).toBeUndefined();
    }
  });

  test("does not write when no persisted block matches the tool id", () => {
    // GIVEN a persisted message whose only block is unrelated to the tool
    const state: EventHandlerState = createEventHandlerState();
    state.lastAssistantMessageId = "msg-1";
    mockedRowContent = JSON.stringify([{ type: "text", text: "thinking" }]);

    // WHEN a tool begins
    handleToolUse(
      state,
      makeDeps(() => {}),
      toolUseEvent("tu_missing", "bash"),
    );

    // THEN no persisted-content write is attempted
    expect(updates).toHaveLength(0);
  });
});
