/**
 * Tests for the compaction-trail route + projection.
 *
 * The handler is exercised against a fake `LlmRequestLogSource` so we
 * can pin (a) the BadRequestError / NotFoundError branches that don't
 * involve any logs, and (b) the happy path that returns a projected
 * trail with the expected shape. The projection function is unit-tested
 * directly so its branches stay covered even if the handler ever swaps
 * to a different log source.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../../../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    model: "test",
    provider: "test",
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0 },
    secretDetection: { enabled: false },
    llmRequestLogs: { readSource: "local" as const },
  }),
}));

// ---------------------------------------------------------------------
// Source + conversation-crud module mocks
// ---------------------------------------------------------------------

import type { CompactionLogEvent } from "../../../memory/compaction-log-store-clickhouse.js";
import type { LogRow } from "../../../memory/llm-request-log-store.js";

interface FakeSourceState {
  conversation: { id: string } | null;
  selectedCall: LogRow | null;
  turnBounds: { startTime: number; endTime: number } | null;
  compactionLogs: LogRow[];
  /** null = compactionLogs destination not configured (legacy-only). */
  compactionStoreEvents: CompactionLogEvent[] | null;
  compactionStoreError: Error | null;
}

const state: FakeSourceState = {
  conversation: null,
  selectedCall: null,
  turnBounds: null,
  compactionLogs: [],
  compactionStoreEvents: null,
  compactionStoreError: null,
};

// Records the inputs the handler passed to its collaborators so tests
// can pin the windowing plumbing without relying on the projection.
const sourceCalls = {
  getRequestLogByIdArgs: [] as string[],
  getTurnTimeBoundsArgs: [] as Array<{
    conversationId: string;
    messageCreatedAt: number;
  }>,
  getCompactionLogsBetweenArgs: [] as Array<{
    conversationId: string;
    afterCreatedAt: number | null;
    beforeCreatedAt: number;
  }>,
  getEventsBetweenArgs: [] as Array<{
    conversationId: string;
    afterStartedAt: number | null;
    beforeStartedAt: number;
  }>,
};

mock.module("../../../memory/compaction-log-store-clickhouse.js", () => ({
  getCompactionLogStore: () =>
    state.compactionStoreEvents === null && state.compactionStoreError === null
      ? null
      : {
          getEventsBetween: async (
            conversationId: string,
            afterStartedAt: number | null,
            beforeStartedAt: number,
          ) => {
            sourceCalls.getEventsBetweenArgs.push({
              conversationId,
              afterStartedAt,
              beforeStartedAt,
            });
            if (state.compactionStoreError) throw state.compactionStoreError;
            return state.compactionStoreEvents ?? [];
          },
        },
}));

mock.module("../../../memory/conversation-crud.js", () => ({
  getConversation: (id: string) =>
    state.conversation && state.conversation.id === id
      ? state.conversation
      : null,
  getTurnTimeBounds: (conversationId: string, messageCreatedAt: number) => {
    sourceCalls.getTurnTimeBoundsArgs.push({
      conversationId,
      messageCreatedAt,
    });
    return state.turnBounds;
  },
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
}));

mock.module("../../../memory/llm-request-log-source.js", () => ({
  getLlmRequestLogSource: async () => ({
    getRequestLogById: async (id: string) => {
      sourceCalls.getRequestLogByIdArgs.push(id);
      return state.selectedCall;
    },
    getRequestLogsByMessageId: async () => [],
    getRequestLogsByConversationId: async () => [],
    getCompactionLogsBetween: async (
      conversationId: string,
      afterCreatedAt: number | null,
      beforeCreatedAt: number,
    ) => {
      sourceCalls.getCompactionLogsBetweenArgs.push({
        conversationId,
        afterCreatedAt,
        beforeCreatedAt,
      });
      return state.compactionLogs;
    },
  }),
}));

// Imported AFTER the mocks so the handler picks up the fakes.
import {
  projectCompactionLogEventToTrailEvent,
  projectLogRowToCompactionTrailEvent,
  ROUTES,
} from "../conversation-compaction-routes.js";
import { BadRequestError, NotFoundError } from "../errors.js";

const route = ROUTES.find(
  (r) => r.operationId === "conversations_compaction_trail_get",
)!;
const handler = route.handler as (
  args: Record<string, unknown>,
) => Promise<{ conversationId: string; events: unknown[] }>;

function fakeLogRow(overrides: Partial<LogRow> = {}): LogRow {
  return {
    id: "log-default",
    conversationId: "conv-default",
    messageId: null,
    provider: "anthropic",
    requestPayload: "{}",
    responsePayload: "{}",
    createdAt: 1000,
    agentLoopExitReason: null,
    callSite: null,
    ...overrides,
  };
}

function fakeCompactionLogEvent(
  overrides: Partial<CompactionLogEvent> = {},
): CompactionLogEvent {
  return {
    compactionId: "comp-1",
    requestId: "req-1",
    trigger: "budget",
    startedAt: 3000,
    finishedAt: 3500,
    durationMs: 500,
    preMessageCount: 12,
    basisMessageCount: 4,
    compacted: true,
    previousEstimatedInputTokens: 900,
    estimatedInputTokens: 300,
    maxInputTokens: 1000,
    thresholdTokens: 850,
    compactedMessages: 10,
    compactedPersistedMessages: 8,
    preservedTailMessages: 2,
    summaryCalls: 1,
    summaryInputTokens: 880,
    summaryOutputTokens: 120,
    summaryModel: "test-model",
    summaryFailed: false,
    reason: "auto",
    exhausted: false,
    injectionMode: null,
    autoCompressApplied: false,
    summaryText: "summary text",
    completed: true,
    ...overrides,
  };
}

beforeEach(() => {
  state.conversation = null;
  state.selectedCall = null;
  state.turnBounds = null;
  state.compactionLogs = [];
  state.compactionStoreEvents = null;
  state.compactionStoreError = null;
  sourceCalls.getRequestLogByIdArgs.length = 0;
  sourceCalls.getTurnTimeBoundsArgs.length = 0;
  sourceCalls.getCompactionLogsBetweenArgs.length = 0;
  sourceCalls.getEventsBetweenArgs.length = 0;
});

// ---------------------------------------------------------------------
// Route registration sanity
// ---------------------------------------------------------------------

describe("conversation-compaction-routes — registration", () => {
  test("exposes one GET route at conversations/:id/compaction", () => {
    expect(route).toBeDefined();
    expect(route.method).toBe("GET");
    expect(route.endpoint).toBe("conversations/:id/compaction");
    expect(route.policy?.requiredScopes).toContain("chat.read");
  });
});

// ---------------------------------------------------------------------
// Handler — error branches
// ---------------------------------------------------------------------

describe("handleGetCompactionTrail — request-shape errors", () => {
  test("throws BadRequestError when the conversation id path param is missing", async () => {
    await expect(
      handler({ pathParams: {}, queryParams: { callId: "call-1" } }),
    ).rejects.toThrow(BadRequestError);
  });

  test("throws BadRequestError when the callId query param is missing", async () => {
    state.conversation = { id: "conv-1" };
    await expect(
      handler({ pathParams: { id: "conv-1" }, queryParams: {} }),
    ).rejects.toThrow(BadRequestError);
  });

  test("throws NotFoundError when the conversation does not exist", async () => {
    state.conversation = null;
    await expect(
      handler({
        pathParams: { id: "missing" },
        queryParams: { callId: "call-1" },
      }),
    ).rejects.toThrow(NotFoundError);
  });

  test("throws NotFoundError when the referenced LLM call does not exist", async () => {
    state.conversation = { id: "conv-1" };
    state.selectedCall = null;
    await expect(
      handler({
        pathParams: { id: "conv-1" },
        queryParams: { callId: "missing-call" },
      }),
    ).rejects.toThrow(NotFoundError);
  });

  test("throws BadRequestError when callId belongs to a different conversation", async () => {
    state.conversation = { id: "conv-1" };
    state.selectedCall = fakeLogRow({
      id: "call-x",
      conversationId: "conv-other",
      createdAt: 1234,
    });
    await expect(
      handler({
        pathParams: { id: "conv-1" },
        queryParams: { callId: "call-x" },
      }),
    ).rejects.toThrow(BadRequestError);
  });
});

// ---------------------------------------------------------------------
// Handler — happy path
// ---------------------------------------------------------------------

describe("handleGetCompactionTrail — happy path", () => {
  test("forwards the turn window to the source (start - 1 as floor, end + 1 as ceiling)", async () => {
    state.conversation = { id: "conv-1" };
    state.selectedCall = fakeLogRow({
      id: "call-selected",
      conversationId: "conv-1",
      createdAt: 5000,
    });
    // Selected call sits inside a turn that runs [2000, 9000].
    state.turnBounds = { startTime: 2000, endTime: 9000 };
    state.compactionLogs = [];

    await handler({
      pathParams: { id: "conv-1" },
      queryParams: { callId: "call-selected" },
    });

    expect(sourceCalls.getRequestLogByIdArgs).toEqual(["call-selected"]);
    expect(sourceCalls.getTurnTimeBoundsArgs).toEqual([
      { conversationId: "conv-1", messageCreatedAt: 5000 },
    ]);
    // 1ms-shift around the exclusive `(>, <)` predicate so rows that
    // land on the bounds themselves come back.
    expect(sourceCalls.getCompactionLogsBetweenArgs).toEqual([
      { conversationId: "conv-1", afterCreatedAt: 1999, beforeCreatedAt: 9001 },
    ]);
  });

  test("scopes the trail to the whole turn — compactions after the selected call are in scope", async () => {
    // Selecting an early call in a turn that contains compactions
    // *after* the selected call must still surface those later events.
    // This is the core promise of turn-scoping: position within the
    // turn is irrelevant.
    state.conversation = { id: "conv-1" };
    state.selectedCall = fakeLogRow({
      id: "call-early",
      conversationId: "conv-1",
      createdAt: 2500,
    });
    state.turnBounds = { startTime: 2000, endTime: 9000 };
    state.compactionLogs = [];

    await handler({
      pathParams: { id: "conv-1" },
      queryParams: { callId: "call-early" },
    });

    // Ceiling is the *turn end*, not the selected call's createdAt.
    expect(sourceCalls.getCompactionLogsBetweenArgs).toEqual([
      { conversationId: "conv-1", afterCreatedAt: 1999, beforeCreatedAt: 9001 },
    ]);
  });

  test("falls back to a null floor + selectedCall.createdAt ceiling when getTurnTimeBounds returns null", async () => {
    // The only-message-in-conversation edge case. Preserves the
    // pre-turn-scoping behavior for this degenerate input.
    state.conversation = { id: "conv-1" };
    state.selectedCall = fakeLogRow({
      id: "call-solo",
      conversationId: "conv-1",
      createdAt: 5000,
    });
    state.turnBounds = null;
    state.compactionLogs = [];

    await handler({
      pathParams: { id: "conv-1" },
      queryParams: { callId: "call-solo" },
    });

    expect(sourceCalls.getCompactionLogsBetweenArgs).toEqual([
      { conversationId: "conv-1", afterCreatedAt: null, beforeCreatedAt: 5000 },
    ]);
  });

  test("returns an empty events list when no compactions ran in the window", async () => {
    state.conversation = { id: "conv-1" };
    state.selectedCall = fakeLogRow({
      id: "call-1",
      conversationId: "conv-1",
      createdAt: 5000,
    });
    state.turnBounds = { startTime: 2000, endTime: 9000 };
    state.compactionLogs = [];

    const result = await handler({
      pathParams: { id: "conv-1" },
      queryParams: { callId: "call-1" },
    });
    expect(result).toEqual({ conversationId: "conv-1", events: [] });
  });

  test("projects each compaction log to the wire shape", async () => {
    state.conversation = { id: "conv-1" };
    state.selectedCall = fakeLogRow({
      id: "call-1",
      conversationId: "conv-1",
      createdAt: 9000,
    });
    state.turnBounds = { startTime: 500, endTime: 10_000 };
    state.compactionLogs = [
      fakeLogRow({
        id: "compaction-1",
        conversationId: "conv-1",
        createdAt: 1000,
      }),
      fakeLogRow({
        id: "compaction-2",
        conversationId: "conv-1",
        createdAt: 2000,
      }),
    ];

    const result = await handler({
      pathParams: { id: "conv-1" },
      queryParams: { callId: "call-1" },
    });

    expect(result.conversationId).toBe("conv-1");
    expect(result.events).toHaveLength(2);
    // Field-set check on the first event — values are validated by the
    // projection tests below; here we just confirm the route emits the
    // full wire shape.
    expect(Object.keys(result.events[0] as object).sort()).toEqual([
      "createdAt",
      "durationMs",
      "estimatedCostUsd",
      "id",
      "inputTokens",
      "model",
      "outputTokens",
      "provider",
      "requestMessageCount",
      "responsePreview",
      "stopReason",
    ]);
  });
});

// ---------------------------------------------------------------------
// Handler — compaction-log store path
// ---------------------------------------------------------------------

describe("handleGetCompactionTrail — compaction log store", () => {
  test("serves the trail from the store and skips the legacy projection", async () => {
    state.conversation = { id: "conv-1" };
    state.selectedCall = fakeLogRow({
      id: "call-1",
      conversationId: "conv-1",
      createdAt: 5000,
    });
    state.turnBounds = { startTime: 2000, endTime: 9000 };
    state.compactionStoreEvents = [fakeCompactionLogEvent()];

    const result = await handler({
      pathParams: { id: "conv-1" },
      queryParams: { callId: "call-1" },
    });

    // Same ±1ms-shifted turn window as the legacy path.
    expect(sourceCalls.getEventsBetweenArgs).toEqual([
      {
        conversationId: "conv-1",
        afterStartedAt: 1999,
        beforeStartedAt: 9001,
      },
    ]);
    expect(sourceCalls.getCompactionLogsBetweenArgs).toEqual([]);
    expect(result.events).toEqual([
      {
        id: "comp-1",
        createdAt: 3000,
        model: "test-model",
        provider: null,
        inputTokens: 880,
        outputTokens: 120,
        durationMs: 500,
        responsePreview: "summary text",
        requestMessageCount: 12,
        stopReason: "auto",
        estimatedCostUsd: null,
      },
    ]);
  });

  test("falls back to the legacy projection when the store has no rows for the window", async () => {
    state.conversation = { id: "conv-1" };
    state.selectedCall = fakeLogRow({
      id: "call-1",
      conversationId: "conv-1",
      createdAt: 5000,
    });
    state.turnBounds = { startTime: 2000, endTime: 9000 };
    state.compactionStoreEvents = [];
    state.compactionLogs = [
      fakeLogRow({ id: "compaction-legacy", conversationId: "conv-1" }),
    ];

    const result = await handler({
      pathParams: { id: "conv-1" },
      queryParams: { callId: "call-1" },
    });

    expect(sourceCalls.getEventsBetweenArgs).toHaveLength(1);
    expect(sourceCalls.getCompactionLogsBetweenArgs).toHaveLength(1);
    expect(result.events).toHaveLength(1);
    expect((result.events[0] as { id: string }).id).toBe("compaction-legacy");
  });

  test("falls back to the legacy projection when the store read throws", async () => {
    state.conversation = { id: "conv-1" };
    state.selectedCall = fakeLogRow({
      id: "call-1",
      conversationId: "conv-1",
      createdAt: 5000,
    });
    state.turnBounds = { startTime: 2000, endTime: 9000 };
    state.compactionStoreError = new Error("clickhouse unreachable");
    state.compactionLogs = [
      fakeLogRow({ id: "compaction-legacy", conversationId: "conv-1" }),
    ];

    const result = await handler({
      pathParams: { id: "conv-1" },
      queryParams: { callId: "call-1" },
    });

    expect(sourceCalls.getCompactionLogsBetweenArgs).toHaveLength(1);
    expect(result.events).toHaveLength(1);
    expect((result.events[0] as { id: string }).id).toBe("compaction-legacy");
  });
});

// ---------------------------------------------------------------------
// Projection unit tests
// ---------------------------------------------------------------------

describe("projectCompactionLogEventToTrailEvent", () => {
  test("maps a completed event onto the wire shape", () => {
    const event = projectCompactionLogEventToTrailEvent(
      fakeCompactionLogEvent(),
    );
    expect(event).toEqual({
      id: "comp-1",
      createdAt: 3000,
      model: "test-model",
      provider: null,
      inputTokens: 880,
      outputTokens: 120,
      durationMs: 500,
      responsePreview: "summary text",
      requestMessageCount: 12,
      stopReason: "auto",
      estimatedCostUsd: null,
    });
  });

  test("maps an incomplete (start-only) event with nulls for end-phase fields", () => {
    const event = projectCompactionLogEventToTrailEvent(
      fakeCompactionLogEvent({
        completed: false,
        finishedAt: null,
        durationMs: null,
        summaryInputTokens: null,
        summaryOutputTokens: null,
        summaryModel: null,
        reason: null,
        summaryText: null,
      }),
    );
    expect(event.durationMs).toBeNull();
    expect(event.model).toBeNull();
    expect(event.inputTokens).toBeNull();
    expect(event.outputTokens).toBeNull();
    expect(event.responsePreview).toBeNull();
    expect(event.stopReason).toBeNull();
    // The start row always carries the pre-compaction message count.
    expect(event.requestMessageCount).toBe(12);
  });
});

describe("projectLogRowToCompactionTrailEvent", () => {
  test("returns null for every summary-derived field when payloads are empty", () => {
    const event = projectLogRowToCompactionTrailEvent(fakeLogRow());
    expect(event.id).toBe("log-default");
    expect(event.createdAt).toBe(1000);
    expect(event.model).toBeNull();
    expect(event.inputTokens).toBeNull();
    expect(event.outputTokens).toBeNull();
    expect(event.responsePreview).toBeNull();
    expect(event.requestMessageCount).toBeNull();
    expect(event.stopReason).toBeNull();
    expect(event.estimatedCostUsd).toBeNull();
  });

  test("always returns null for durationMs (column not yet recorded)", () => {
    // Even if a future payload shape carries duration info, the
    // projection deliberately drops it — the gap is what surfaces to
    // the UI as "Unavailable" and informs the data-model decision.
    const event = projectLogRowToCompactionTrailEvent(
      fakeLogRow({
        responsePayload: JSON.stringify({
          // A made-up shape with a duration value to confirm the
          // projection ignores it.
          durationMs: 1234,
          duration_ms: 1234,
        }),
      }),
    );
    expect(event.durationMs).toBeNull();
  });

  test("falls back to the stored provider when the normalizer can't infer one", () => {
    // Empty payloads => normalizer returns no summary => fallback to
    // the row's stored `provider` column.
    const event = projectLogRowToCompactionTrailEvent(
      fakeLogRow({ provider: "anthropic" }),
    );
    expect(event.provider).toBe("anthropic");
  });

  test("extracts model + inputTokens + stopReason from a real Anthropic payload", () => {
    const event = projectLogRowToCompactionTrailEvent(
      fakeLogRow({
        provider: "anthropic",
        requestPayload: JSON.stringify({
          model: "claude-sonnet-4-5",
          messages: [{ role: "user", content: "Summarize the prior context." }],
        }),
        responsePayload: JSON.stringify({
          type: "message",
          model: "claude-sonnet-4-5",
          role: "assistant",
          content: [{ type: "text", text: "Summary text…" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 12_000, output_tokens: 800 },
        }),
      }),
    );
    expect(event.model).toBe("claude-sonnet-4-5");
    expect(event.provider).toBe("anthropic");
    expect(event.inputTokens).toBe(12_000);
    expect(event.outputTokens).toBe(800);
    expect(event.stopReason).toBe("end_turn");
  });

  test("tolerates non-JSON payloads without throwing (falls back to nulls)", () => {
    const event = projectLogRowToCompactionTrailEvent(
      fakeLogRow({
        requestPayload: "not-json{{{",
        responsePayload: "<html>nope</html>",
      }),
    );
    expect(event.id).toBe("log-default");
    expect(event.model).toBeNull();
    expect(event.inputTokens).toBeNull();
  });
});
