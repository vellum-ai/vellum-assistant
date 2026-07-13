/**
 * Tests for the tool preview lifecycle feature.
 *
 * Verifies:
 * - handleToolUsePreviewStart emits correct events
 * - handleToolUsePreviewStart emits activity state with "tool_running" phase
 * - handleInputJsonDelta includes toolUseId in emitted tool_input_delta
 * - handleToolResult includes toolUseId in emitted tool_result
 * - Event ordering: tool_use_preview_start → input_json_delta → tool_use
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Mock conversation-crud (used by handleToolResult/handleMessageComplete) ──
// Reserve returns a role-distinct id so tests can tell the grouped tool-result
// `user` row apart from the assistant row, and assert it is reserved exactly
// once per batch. `updateMessageContent` is a spy so tests can inspect the
// content written into the row on each arrival.
// Widen the reservation window so concurrent tool-result handlers provably
// overlap before the first `reserveMessage` resolves; defaults to no delay.
let reserveMessageDelayMs = 0;
const reserveMessageMock = mock(
  async (_conversationId: string, role: string) => {
    if (reserveMessageDelayMs > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, reserveMessageDelayMs),
      );
    }
    return { id: role === "user" ? "tool-result-row" : "assistant-row" };
  },
);
const updateMessageContentMock = mock((_id: string, _content: string) => {});

// Stand-in for the `conversations.seq` column. The DB-backed
// `recordConversationPersistedSeq` / `getConversationPersistedSeq` are mocked
// over this map with the same monotonic, ignore-non-positive semantics so the
// handler's persisted-seq writes are observable without a real database.
const persistedSeqByConversation = new Map<string, number>();

mock.module("../persistence/conversation-crud.js", () => ({
  setConversationProcessingStartedAt: () => {},
  isConversationProcessing: () => false,
  getConversation: () => null,
  getMessageById: () => null,
  updateMessageContent: updateMessageContentMock,
  markMessageContentInflight: () => {},
  finalizeMessageContent: updateMessageContentMock,
  provenanceFromTrustContext: () => ({}),
  reserveMessage: reserveMessageMock,
  recordConversationPersistedSeq: (id: string, seq: number) => {
    if (!Number.isFinite(seq) || seq <= 0) return;
    const prev = persistedSeqByConversation.get(id);
    if (prev == null || prev < seq) persistedSeqByConversation.set(id, seq);
  },
  getConversationPersistedSeq: (id: string) =>
    persistedSeqByConversation.get(id) ?? null,
}));

mock.module("../persistence/conversation-disk-view.js", () => ({
  syncMessageToDisk: () => {},
}));

mock.module("../persistence/llm-request-log-store.js", () => ({
  recordRequestLog: () => {},
  backfillMessageIdOnLogs: () => {},
}));

mock.module("../plugins/defaults/memory/memory-recall-log-store.js", () => ({
  backfillMemoryRecallLogMessageId: () => {},
}));

mock.module(
  "../plugins/defaults/memory/memory-v2-activation-log-store.js",
  () => ({
    backfillMemoryV2ActivationMessageId: () => {},
  }),
);

// ── Imports (after mocks) ─────────────────────────────────────────────────────
import type { AgentEvent } from "../agent/loop.js";
import type {
  EventHandlerDeps,
  EventHandlerState,
} from "../daemon/conversation-agent-loop-handlers.js";
import {
  createEventHandlerState,
  dispatchAgentEvent,
  handleInputJsonDelta,
  handleMessageComplete,
  handleToolResult,
  handleToolUse,
  handleToolUsePreviewStart,
} from "../daemon/conversation-agent-loop-handlers.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import { getConversationPersistedSeq } from "../persistence/conversation-crud.js";
import type { AssistantEvent } from "../runtime/assistant-event.js";
import {
  _resetStreamStateForTesting,
  getCurrentSeq,
  stampAndBuffer,
} from "../runtime/assistant-stream-state.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function createMockDeps(
  overrides: Partial<EventHandlerDeps> = {},
): EventHandlerDeps {
  const emittedEvents: ServerMessage[] = [];
  const emittedActivityStates: Array<{
    phase: string;
    reason: string;
    anchor?: string;
    requestId?: string;
    statusText?: string;
  }> = [];

  return {
    ctx: {
      conversationId: "test-session-id",
      provider: { name: "anthropic" },
      streamThinking: false,
      emitActivityState: (
        phase: string,
        reason: string,
        options?: { anchor?: string; requestId?: string; statusText?: string },
      ) => {
        emittedActivityStates.push({
          phase,
          reason,
          anchor: options?.anchor,
          requestId: options?.requestId,
          statusText: options?.statusText,
        });
      },
      markWorkspaceTopLevelDirty: () => {},
      currentTurnSurfaces: [],
    } as unknown as EventHandlerDeps["ctx"],
    onEvent: (msg: ServerMessage) => {
      emittedEvents.push(msg);
    },
    reqId: "test-req-id",
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
    ...overrides,
  } as EventHandlerDeps;
}

/** Collect events by wrapping onEvent. */
function createEventCollector(): {
  events: ServerMessage[];
  activityStates: Array<{
    phase: string;
    reason: string;
    anchor?: string;
    requestId?: string;
    statusText?: string;
  }>;
  onEvent: (msg: ServerMessage) => void;
  emitActivityState: (
    phase: string,
    reason: string,
    options?: { anchor?: string; requestId?: string; statusText?: string },
  ) => void;
} {
  const events: ServerMessage[] = [];
  const activityStates: Array<{
    phase: string;
    reason: string;
    anchor?: string;
    requestId?: string;
    statusText?: string;
  }> = [];
  return {
    events,
    activityStates,
    onEvent: (msg: ServerMessage) => events.push(msg),
    emitActivityState: (phase, reason, options) =>
      activityStates.push({
        phase,
        reason,
        anchor: options?.anchor,
        requestId: options?.requestId,
        statusText: options?.statusText,
      }),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("tool preview lifecycle", () => {
  let state: EventHandlerState;

  beforeEach(() => {
    state = createEventHandlerState();
  });

  describe("handleToolUsePreviewStart", () => {
    test("emits tool_use_preview_start message", () => {
      const collector = createEventCollector();
      const deps = createMockDeps({
        onEvent: collector.onEvent,
        ctx: {
          ...createMockDeps().ctx,
          emitActivityState: collector.emitActivityState,
        } as unknown as EventHandlerDeps["ctx"],
      });

      handleToolUsePreviewStart(state, deps, {
        type: "tool_use_preview_start",
        toolUseId: "toolu_abc123",
        toolName: "bash",
      });

      expect(collector.events).toHaveLength(1);
      const emitted = collector.events[0];
      expect(emitted.type).toBe("tool_use_preview_start");
      expect((emitted as any).toolUseId).toBe("toolu_abc123");
      expect((emitted as any).toolName).toBe("bash");
      expect((emitted as any).conversationId).toBe("test-session-id");
    });

    test("stamps previewStartedAt on the event and stores it in state", () => {
      const collector = createEventCollector();
      const deps = createMockDeps({
        onEvent: collector.onEvent,
        ctx: {
          ...createMockDeps().ctx,
          emitActivityState: collector.emitActivityState,
        } as unknown as EventHandlerDeps["ctx"],
      });

      const before = Date.now();
      handleToolUsePreviewStart(state, deps, {
        type: "tool_use_preview_start",
        toolUseId: "toolu_preview_ts",
        toolName: "bash",
      });
      const after = Date.now();

      const emitted = collector.events[0] as { previewStartedAt?: number };
      expect(typeof emitted.previewStartedAt).toBe("number");
      expect(emitted.previewStartedAt!).toBeGreaterThanOrEqual(before);
      expect(emitted.previewStartedAt!).toBeLessThanOrEqual(after);
      // The same first-byte timestamp is retained in state so tool_use_start
      // can carry it through.
      expect(state.toolPreviewStartedAt.get("toolu_preview_ts")).toBe(
        emitted.previewStartedAt,
      );
    });

    test("handleToolUse carries the stored previewStartedAt onto tool_use_start", () => {
      const collector = createEventCollector();
      const deps = createMockDeps({
        onEvent: collector.onEvent,
        ctx: {
          ...createMockDeps().ctx,
          emitActivityState: collector.emitActivityState,
        } as unknown as EventHandlerDeps["ctx"],
      });

      // GIVEN a preview was recognized first
      handleToolUsePreviewStart(state, deps, {
        type: "tool_use_preview_start",
        toolUseId: "toolu_carry",
        toolName: "bash",
      });
      const previewStartedAt = state.toolPreviewStartedAt.get("toolu_carry");

      // WHEN the tool actually begins executing
      handleToolUse(state, deps, {
        type: "tool_use",
        id: "toolu_carry",
        name: "bash",
        input: { command: "ls" },
      });

      // THEN the tool_use_start event carries the first-byte anchor alongside
      // its own (later) execution startedAt
      const toolUseStart = collector.events.find(
        (e) => e.type === "tool_use_start",
      ) as { previewStartedAt?: number; startedAt?: number };
      expect(toolUseStart).toBeDefined();
      expect(toolUseStart.previewStartedAt).toBe(previewStartedAt);
      expect(typeof toolUseStart.startedAt).toBe("number");
      expect(toolUseStart.startedAt!).toBeGreaterThanOrEqual(previewStartedAt!);
    });

    test("emits activity state with tool_running phase and preview_start reason", () => {
      const collector = createEventCollector();
      const deps = createMockDeps({
        onEvent: collector.onEvent,
        ctx: {
          ...createMockDeps().ctx,
          emitActivityState: collector.emitActivityState,
        } as unknown as EventHandlerDeps["ctx"],
      });

      handleToolUsePreviewStart(state, deps, {
        type: "tool_use_preview_start",
        toolUseId: "toolu_abc123",
        toolName: "web_search",
      });

      expect(collector.activityStates).toHaveLength(1);
      const activity = collector.activityStates[0];
      expect(activity.phase).toBe("tool_running");
      expect(activity.reason).toBe("preview_start");
      expect(activity.statusText).toMatch(/^Preparing/);
    });

    test("handleInputJsonDelta includes toolUseId for app tools", () => {
      const collector = createEventCollector();
      const deps = createMockDeps({ onEvent: collector.onEvent });

      handleInputJsonDelta(state, deps, {
        type: "input_json_delta",
        toolName: "app_create",
        toolUseId: "toolu_delta456",
        accumulatedJson: '{"command": "ls"}',
      });

      expect(collector.events).toHaveLength(1);
      const emitted = collector.events[0];
      expect(emitted.type).toBe("tool_input_delta");
      expect((emitted as any).toolUseId).toBe("toolu_delta456");
      expect((emitted as any).toolName).toBe("app_create");
      expect((emitted as any).content).toBe('{"command": "ls"}');
      expect((emitted as any).conversationId).toBe("test-session-id");
    });

    test("handleToolResult includes toolUseId", async () => {
      const collector = createEventCollector();
      const deps = createMockDeps({
        onEvent: collector.onEvent,
        ctx: {
          ...createMockDeps().ctx,
          emitActivityState: collector.emitActivityState,
        } as unknown as EventHandlerDeps["ctx"],
      });

      // Pre-register the tool name mapping (normally done by handleToolUse)
      state.toolUseIdToName.set("toolu_result789", "bash");
      state.toolCallTimestamps.set("toolu_result789", {
        startedAt: Date.now(),
      });
      state.currentTurnToolUseIds.push("toolu_result789");

      await handleToolResult(state, deps, {
        type: "tool_result",
        toolUseId: "toolu_result789",
        content: "file1.txt\nfile2.txt",
        isError: false,
      });

      const toolResultEvent = collector.events.find(
        (e) => e.type === "tool_result",
      );
      expect(toolResultEvent).toBeDefined();
      expect((toolResultEvent as any).toolUseId).toBe("toolu_result789");
      expect((toolResultEvent as any).conversationId).toBe("test-session-id");
    });
  });

  // ── Event ordering ────────────────────────────────────────────────────────

  describe("persisted seq advances on tool_use_start", () => {
    beforeEach(() => {
      _resetStreamStateForTesting();
      persistedSeqByConversation.clear();
    });

    test("advances the conversation's persisted seq to the tool_use_start seq", () => {
      /**
       * The assistant row (including tool_use blocks) is persisted at
       * message_complete, which precedes tool events. handleToolUse emits a
       * seq-stamped tool_use_start afterward, so the persisted seq must catch
       * up to that event -- otherwise /messages would advertise a seq below an
       * event it already reflects.
       */
      // GIVEN an onEvent that stamps conversation-scoped events like the hub
      const collector = createEventCollector();
      const conversationId = "test-session-id";
      const deps = createMockDeps({
        onEvent: (msg: ServerMessage) => {
          collector.events.push(msg);
          stampAndBuffer(msg as unknown as AssistantEvent);
        },
        ctx: {
          ...createMockDeps().ctx,
          conversationId,
          emitActivityState: collector.emitActivityState,
        } as unknown as EventHandlerDeps["ctx"],
      });

      // AND prior streamed text deltas have already advanced the global seq
      stampAndBuffer({
        type: "assistant_text_delta",
        text: "hello",
        conversationId,
      } as unknown as AssistantEvent);
      stampAndBuffer({
        type: "assistant_text_delta",
        text: " world",
        conversationId,
      } as unknown as AssistantEvent);

      // WHEN a tool_use is handled (its block is already durable)
      handleToolUse(state, deps, {
        type: "tool_use",
        id: "toolu_abc123",
        name: "bash",
        input: { command: "ls" },
      });

      // THEN the persisted seq equals the just-stamped tool_use_start seq
      const toolUseStart = collector.events.find(
        (e) => e.type === "tool_use_start",
      );
      expect(toolUseStart).toBeDefined();
      expect(getConversationPersistedSeq(conversationId)).toBe(getCurrentSeq());
      expect(getConversationPersistedSeq(conversationId)).toBe(
        (toolUseStart as unknown as AssistantEvent).seq ?? null,
      );
    });
  });

  describe("persisted seq advances at the turn boundary for all turn types", () => {
    const conversationId = "test-session-id";

    beforeEach(() => {
      _resetStreamStateForTesting();
      persistedSeqByConversation.clear();
    });

    /** onEvent that stamps conversation-scoped events like the runtime hub. */
    function makeStampingDeps(
      overrides: Partial<EventHandlerDeps["ctx"]> = {},
    ): { deps: EventHandlerDeps; events: ServerMessage[] } {
      const events: ServerMessage[] = [];
      const deps = createMockDeps({
        onEvent: (msg: ServerMessage) => {
          events.push(msg);
          stampAndBuffer(msg as unknown as AssistantEvent);
        },
        ctx: {
          ...createMockDeps().ctx,
          conversationId,
          ...overrides,
        } as unknown as EventHandlerDeps["ctx"],
      });
      return { deps, events };
    }

    test("a streamed thinking delta is mirrored for incremental persistence", async () => {
      /**
       * Thinking rides the same mirror-and-flush path as text, so a thinking
       * delta is appended to the running view and bumps the single persisted
       * seq field -- the debounced partial flush then writes it to the row,
       * letting long reasoning streams survive a refresh just like long
       * answers do.
       */
      // GIVEN a turn that streams thinking
      const { deps, events } = makeStampingDeps({ streamThinking: true });
      state.lastAssistantMessageId = "assistant-msg-1";

      // WHEN a thinking_delta is dispatched
      await dispatchAgentEvent(state, deps, {
        type: "thinking_delta",
        thinking: "Let me reason about this.",
      } as Extract<AgentEvent, { type: "thinking_delta" }>);

      // THEN it is mirrored into the running view and the persisted seq field
      // tracks the emitted delta
      const thinkingDelta = events.find(
        (e) => e.type === "assistant_thinking_delta",
      );
      expect(thinkingDelta).toBeDefined();
      expect(state.currentMessageContent).toEqual([
        {
          type: "thinking",
          thinking: "Let me reason about this.",
          signature: "",
        },
      ]);
      expect(state.lastPersistedContentSeq).toBe(
        (thinkingDelta as unknown as AssistantEvent).seq ?? undefined,
      );
    });

    test("a thinking-only turn advances the persisted seq to the thinking delta", async () => {
      /**
       * Reasoning-model turns can emit thinking with no text delta. Because
       * thinking is now mirrored and flushed like text, the persisted seq
       * advances to the streamed thinking_delta -- otherwise /messages would
       * advertise a seq behind content the snapshot already reflects.
       */
      // GIVEN a turn that streams thinking (no text delta)
      const { deps, events } = makeStampingDeps({ streamThinking: true });
      state.lastAssistantMessageId = "assistant-msg-1";

      // WHEN a thinking_delta is dispatched, then the turn completes
      await dispatchAgentEvent(state, deps, {
        type: "thinking_delta",
        thinking: "Let me reason about this.",
      } as Extract<AgentEvent, { type: "thinking_delta" }>);
      await handleMessageComplete(state, deps, {
        type: "message_complete",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Let me reason about this." },
          ],
        },
      } as Extract<AgentEvent, { type: "message_complete" }>);

      // THEN the persisted seq equals the streamed thinking delta's seq
      const thinkingDelta = events.find(
        (e) => e.type === "assistant_thinking_delta",
      );
      expect(thinkingDelta).toBeDefined();
      expect(getConversationPersistedSeq(conversationId)).toBe(getCurrentSeq());
      expect(getConversationPersistedSeq(conversationId)).toBe(
        (thinkingDelta as unknown as AssistantEvent).seq ?? null,
      );
    });

    test("a tool result advances the persisted seq on arrival", async () => {
      /**
       * Tool results are persisted into their grouped row as they arrive (so a
       * long-running tool's output survives a refresh), advancing the persisted
       * seq to the just-stamped tool_result event rather than deferring to
       * message_complete.
       */
      // GIVEN a tool whose result is about to arrive
      const { deps, events } = makeStampingDeps({ streamThinking: true });
      state.lastAssistantMessageId = "assistant-msg-1";
      state.toolUseIdToName.set("toolu_result", "bash");
      state.toolCallTimestamps.set("toolu_result", { startedAt: Date.now() });
      state.currentTurnToolUseIds.push("toolu_result");

      // WHEN the tool result is handled
      await handleToolResult(state, deps, {
        type: "tool_result",
        toolUseId: "toolu_result",
        content: "file1.txt\nfile2.txt",
        isError: false,
      });

      // THEN the persisted seq equals the just-stamped tool_result seq
      const toolResult = events.find((e) => e.type === "tool_result");
      expect(toolResult).toBeDefined();
      expect(getConversationPersistedSeq(conversationId)).toBe(getCurrentSeq());
      expect(getConversationPersistedSeq(conversationId)).toBe(
        (toolResult as unknown as AssistantEvent).seq ?? null,
      );
    });

    test("thinking that is not streamed leaves the persisted seq unset", async () => {
      /**
       * When streamThinking is off, no thinking_delta SSE event is emitted, so
       * nothing is mirrored and there is no stamped event to anchor a seq to.
       * The turn must not invent a seq from unrelated global stream position.
       */
      // GIVEN a turn that does NOT stream thinking
      const { deps, events } = makeStampingDeps({ streamThinking: false });
      state.lastAssistantMessageId = "assistant-msg-1";

      // WHEN a thinking_delta is dispatched, then the turn completes
      await dispatchAgentEvent(state, deps, {
        type: "thinking_delta",
        thinking: "Internal reasoning.",
      } as Extract<AgentEvent, { type: "thinking_delta" }>);
      await handleMessageComplete(state, deps, {
        type: "message_complete",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "Internal reasoning." }],
        },
      } as Extract<AgentEvent, { type: "message_complete" }>);

      // THEN no thinking_delta was emitted and the persisted seq stays unset
      expect(
        events.find((e) => e.type === "assistant_thinking_delta"),
      ).toBeUndefined();
      expect(state.lastPersistedContentSeq).toBeUndefined();
      expect(getConversationPersistedSeq(conversationId)).toBeNull();
    });
  });

  describe("tool results are persisted on arrival into a grouped row", () => {
    const conversationId = "test-session-id";

    beforeEach(() => {
      _resetStreamStateForTesting();
      persistedSeqByConversation.clear();
      reserveMessageMock.mockClear();
      updateMessageContentMock.mockClear();
    });

    /** onEvent that stamps conversation-scoped events like the runtime hub. */
    function makeStampingDeps(): {
      deps: EventHandlerDeps;
      events: ServerMessage[];
    } {
      const events: ServerMessage[] = [];
      const deps = createMockDeps({
        onEvent: (msg: ServerMessage) => {
          events.push(msg);
          stampAndBuffer(msg as unknown as AssistantEvent);
        },
        ctx: {
          ...createMockDeps().ctx,
          conversationId,
        } as unknown as EventHandlerDeps["ctx"],
      });
      return { deps, events };
    }

    /** Register a tool as started so its result can be handled. */
    function registerTool(toolUseId: string): void {
      state.toolUseIdToName.set(toolUseId, "bash");
      state.toolCallTimestamps.set(toolUseId, { startedAt: Date.now() });
      state.currentTurnToolUseIds.push(toolUseId);
    }

    /** Parse the content of the most recent updateMessageContent call. */
    function latestWrittenBlocks(): Array<Record<string, unknown>> {
      const calls = updateMessageContentMock.mock.calls;
      const last = calls[calls.length - 1];
      return JSON.parse(last[1] as string);
    }

    test("the first result reserves one user row and writes its block", async () => {
      /**
       * The grouped tool-result row is a `user` message reserved when the first
       * result of a batch arrives, then written via updateContent so the result
       * is durable immediately.
       */
      // GIVEN a started tool
      const { deps } = makeStampingDeps();
      state.lastAssistantMessageId = "assistant-msg-1";
      registerTool("toolu_a");

      // WHEN its result arrives
      await handleToolResult(state, deps, {
        type: "tool_result",
        toolUseId: "toolu_a",
        content: "result-a",
        isError: false,
      });

      // THEN a single user row was reserved and tracked, and its block written
      const userReserves = reserveMessageMock.mock.calls.filter(
        (call) => call[1] === "user",
      );
      expect(userReserves).toHaveLength(1);
      expect(await state.pendingToolResultRowReservation).toBe(
        "tool-result-row",
      );
      const blocks = latestWrittenBlocks();
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toMatchObject({
        type: "tool_result",
        tool_use_id: "toolu_a",
        content: "result-a",
        is_error: false,
      });
    });

    test("parallel results share one row, grouped as sibling blocks", async () => {
      /**
       * Results from parallel tool calls in the same turn must land in a single
       * `user` row (the tool_result-in-user-turn shape providers expect), so the
       * row is reserved once and rewritten in place as each result arrives.
       */
      // GIVEN two started tools
      const { deps } = makeStampingDeps();
      state.lastAssistantMessageId = "assistant-msg-1";
      registerTool("toolu_a");
      registerTool("toolu_b");

      // WHEN both results arrive
      await handleToolResult(state, deps, {
        type: "tool_result",
        toolUseId: "toolu_a",
        content: "result-a",
        isError: false,
      });
      await handleToolResult(state, deps, {
        type: "tool_result",
        toolUseId: "toolu_b",
        content: "result-b",
        isError: false,
      });

      // THEN the row was reserved exactly once and now holds both blocks
      const userReserves = reserveMessageMock.mock.calls.filter(
        (call) => call[1] === "user",
      );
      expect(userReserves).toHaveLength(1);
      const blocks = latestWrittenBlocks();
      expect(blocks.map((b) => b.tool_use_id)).toEqual(["toolu_a", "toolu_b"]);
    });

    test("concurrent results race but reserve exactly one row", async () => {
      /**
       * `agent/loop.ts` dispatches each `tool_result` without awaiting, so two
       * handlers for one parallel batch can enter reservation before the first
       * `reserveMessage` resolves. A shared in-flight reservation promise must
       * collapse them onto a single row rather than reserving one per result.
       */
      // GIVEN two started tools AND a reservation slow enough to overlap them
      const { deps } = makeStampingDeps();
      state.lastAssistantMessageId = "assistant-msg-1";
      registerTool("toolu_a");
      registerTool("toolu_b");
      reserveMessageDelayMs = 10;

      // WHEN both results are handled concurrently (neither awaited first)
      try {
        await Promise.all([
          handleToolResult(state, deps, {
            type: "tool_result",
            toolUseId: "toolu_a",
            content: "result-a",
            isError: false,
          }),
          handleToolResult(state, deps, {
            type: "tool_result",
            toolUseId: "toolu_b",
            content: "result-b",
            isError: false,
          }),
        ]);
      } finally {
        reserveMessageDelayMs = 0;
      }

      // THEN exactly one user row was reserved and it holds both sibling blocks
      const userReserves = reserveMessageMock.mock.calls.filter(
        (call) => call[1] === "user",
      );
      expect(userReserves).toHaveLength(1);
      expect(await state.pendingToolResultRowReservation).toBe(
        "tool-result-row",
      );
      const blocks = latestWrittenBlocks();
      expect(blocks.map((b) => b.tool_use_id).sort()).toEqual([
        "toolu_a",
        "toolu_b",
      ]);
    });

    test("message_complete finalizes the on-arrival row without a second reserve", async () => {
      /**
       * Because the row already exists from the on-arrival write, the
       * message_complete drain finalizes it (rewrite + bookkeeping) instead of
       * inserting a second row, then clears the batch state.
       */
      // GIVEN a result already persisted on arrival
      const { deps } = makeStampingDeps();
      state.lastAssistantMessageId = "assistant-msg-1";
      registerTool("toolu_a");
      await handleToolResult(state, deps, {
        type: "tool_result",
        toolUseId: "toolu_a",
        content: "result-a",
        isError: false,
      });
      const reservesAfterArrival = reserveMessageMock.mock.calls.filter(
        (call) => call[1] === "user",
      ).length;

      // WHEN the next call completes, draining the buffered result
      await handleMessageComplete(state, deps, {
        type: "message_complete",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
      } as Extract<AgentEvent, { type: "message_complete" }>);

      // THEN no additional user row was reserved and the batch state is cleared
      const reservesAfterDrain = reserveMessageMock.mock.calls.filter(
        (call) => call[1] === "user",
      ).length;
      expect(reservesAfterDrain).toBe(reservesAfterArrival);
      expect(state.pendingToolResults.size).toBe(0);
      expect(state.pendingToolResultRowReservation).toBeUndefined();
      expect(state.persistedToolUseIds.has("toolu_a")).toBe(true);
    });
  });

  describe("event ordering", () => {
    test("events are emitted in correct order: tool_use_preview_start → tool_input_delta → tool_use", () => {
      const collector = createEventCollector();
      const deps = createMockDeps({
        onEvent: collector.onEvent,
        ctx: {
          ...createMockDeps().ctx,
          emitActivityState: collector.emitActivityState,
        } as unknown as EventHandlerDeps["ctx"],
      });

      const toolUseId = "toolu_ordering_test";
      // Use an app tool so input_json_delta is forwarded to the client
      const toolName = "app_create";

      // Step 1: tool_use_preview_start (emitted by provider on content_block_start)
      handleToolUsePreviewStart(state, deps, {
        type: "tool_use_preview_start",
        toolUseId,
        toolName,
      });

      // Step 2: input_json_delta (emitted during streaming of tool input)
      handleInputJsonDelta(state, deps, {
        type: "input_json_delta",
        toolName,
        toolUseId,
        accumulatedJson: '{"path": "/test"}',
      });

      // Step 3: tool_use (emitted when tool execution begins after finalMessage)
      handleToolUse(state, deps, {
        type: "tool_use",
        id: toolUseId,
        name: toolName,
        input: { path: "/test" },
      });

      // Verify ordering
      const eventTypes = collector.events.map((e) => e.type);
      expect(eventTypes).toEqual([
        "tool_use_preview_start",
        "tool_input_delta",
        "tool_use_start",
      ]);

      // Verify all events carry the same toolUseId
      for (const event of collector.events) {
        expect((event as any).toolUseId).toBe(toolUseId);
      }
    });

    test("non-app tool input_json_delta events are not forwarded to client", () => {
      const collector = createEventCollector();
      const deps = createMockDeps({
        onEvent: collector.onEvent,
        ctx: {
          ...createMockDeps().ctx,
          emitActivityState: collector.emitActivityState,
        } as unknown as EventHandlerDeps["ctx"],
      });

      const toolUseId = "toolu_non_app_delta";
      const toolName = "file_read";

      handleInputJsonDelta(state, deps, {
        type: "input_json_delta",
        toolName,
        toolUseId,
        accumulatedJson: '{"path": "/test"}',
      });

      // Non-app tools should not emit tool_input_delta to the client
      expect(collector.events).toEqual([]);
    });

    test("full lifecycle: preview_start → input_delta → tool_use → tool_result", () => {
      const collector = createEventCollector();
      const deps = createMockDeps({
        onEvent: collector.onEvent,
        ctx: {
          ...createMockDeps().ctx,
          emitActivityState: collector.emitActivityState,
        } as unknown as EventHandlerDeps["ctx"],
      });

      const toolUseId = "toolu_full_lifecycle";
      // Use an app tool so input_json_delta is forwarded to the client
      const toolName = "app_create";

      // 1. Preview start
      handleToolUsePreviewStart(state, deps, {
        type: "tool_use_preview_start",
        toolUseId,
        toolName,
      });

      // 2. Input streaming
      handleInputJsonDelta(state, deps, {
        type: "input_json_delta",
        toolName,
        toolUseId,
        accumulatedJson: '{"command": "echo hello"}',
      });

      // 3. Tool use start (after finalMessage)
      handleToolUse(state, deps, {
        type: "tool_use",
        id: toolUseId,
        name: toolName,
        input: { command: "echo hello" },
      });

      // 4. Tool result
      handleToolResult(state, deps, {
        type: "tool_result",
        toolUseId,
        content: "hello",
        isError: false,
      });

      const eventTypes = collector.events.map((e) => e.type);
      expect(eventTypes).toEqual([
        "tool_use_preview_start",
        "tool_input_delta",
        "tool_use_start",
        "tool_result",
      ]);

      // Verify toolUseId consistency across all events
      for (const event of collector.events) {
        expect((event as any).toolUseId).toBe(toolUseId);
      }

      // Verify activity state transitions
      const activityPhases = collector.activityStates.map((a) => a.phase);
      expect(activityPhases).toContain("tool_running");
      expect(activityPhases).toContain("thinking");

      // Verify reasons include preview_start and tool_use_start
      const activityReasons = collector.activityStates.map((a) => a.reason);
      expect(activityReasons).toContain("preview_start");
      expect(activityReasons).toContain("tool_use_start");
      expect(activityReasons).toContain("tool_result_received");
    });
  });
});
