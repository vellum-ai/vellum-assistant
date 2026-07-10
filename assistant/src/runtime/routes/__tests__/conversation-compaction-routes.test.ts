/**
 * Tests for the compaction route + projection.
 *
 * The handler is exercised against a fake `LlmRequestLogSource` so we
 * can pin (a) the BadRequestError / NotFoundError branches that don't
 * involve any logs, and (b) the happy path that returns the projected
 * compaction(s) with the expected shape. The projection functions are
 * unit-tested directly so their branches stay covered even if the
 * handler ever swaps to a different log source.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Mutable so a test can flip the master switch off and assert the guard.
let llmRequestLoggingEnabled = true;
mock.module("../../../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    model: "test",
    provider: "test",
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0 },
    secretDetection: { enabled: false },
    llmRequestLogs: {
      readSource: "local" as const,
      enabled: llmRequestLoggingEnabled,
    },
  }),
}));

// ---------------------------------------------------------------------
// Source + conversation-crud module mocks
// ---------------------------------------------------------------------

import type { CompactionLogEvent } from "../../../persistence/compaction-log-store-clickhouse.js";
import type {
  CompactionAgentLogRow,
  LogMetaRow,
} from "../../../persistence/llm-request-log-store.js";

interface FakeSourceState {
  conversation: { id: string } | null;
  selectedCall: LogMetaRow | null;
  /** `createdAt` of the previous real call, or null = no earlier call. */
  previousNonCompactionCallCreatedAt: number | null;
  compactionLogs: CompactionAgentLogRow[];
  /** null = compactionLogs destination not configured (legacy-only). */
  compactionStoreEvents: CompactionLogEvent[] | null;
  compactionStoreError: Error | null;
}

const state: FakeSourceState = {
  conversation: null,
  selectedCall: null,
  previousNonCompactionCallCreatedAt: null,
  compactionLogs: [],
  compactionStoreEvents: null,
  compactionStoreError: null,
};

// Records the inputs the handler passed to its collaborators so tests
// can pin the windowing plumbing without relying on the projection.
const sourceCalls = {
  getRequestLogMetaByIdArgs: [] as string[],
  getPreviousNonCompactionCallCreatedAtArgs: [] as Array<{
    conversationId: string;
    beforeCreatedAt: number;
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

mock.module("../../../persistence/compaction-log-store-clickhouse.js", () => ({
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

mock.module("../../../persistence/conversation-crud.js", () => ({
  getConversation: (id: string) =>
    state.conversation && state.conversation.id === id
      ? state.conversation
      : null,
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
}));

mock.module("../../../persistence/llm-request-log-source.js", () => ({
  getLlmRequestLogSource: async () => ({
    getRequestLogById: async () => null,
    getRequestLogMetaById: async (id: string) => {
      sourceCalls.getRequestLogMetaByIdArgs.push(id);
      return state.selectedCall;
    },
    getRequestLogsByMessageId: async () => [],
    getRequestLogsByConversationId: async () => [],
    getPreviousNonCompactionCallCreatedAt: async (
      conversationId: string,
      beforeCreatedAt: number,
    ) => {
      sourceCalls.getPreviousNonCompactionCallCreatedAtArgs.push({
        conversationId,
        beforeCreatedAt,
      });
      return state.previousNonCompactionCallCreatedAt;
    },
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
import {
  BadRequestError,
  LlmRequestLogsDisabledError,
  NotFoundError,
} from "../errors.js";

const route = ROUTES.find(
  (r) => r.operationId === "conversations_compaction_trail_get",
)!;
const handler = route.handler as (
  args: Record<string, unknown>,
) => Promise<{ conversationId: string; events: unknown[] }>;

function fakeLogMetaRow(overrides: Partial<LogMetaRow> = {}): LogMetaRow {
  return {
    id: "log-default",
    conversationId: "conv-default",
    messageId: null,
    provider: "anthropic",
    createdAt: 1000,
    agentLoopExitReason: null,
    callSite: null,
    ...overrides,
  };
}

function fakeCompactionRow(
  overrides: Partial<CompactionAgentLogRow> = {},
): CompactionAgentLogRow {
  return {
    ...fakeLogMetaRow(),
    responsePayload: "{}",
    requestMessageCount: null,
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
    resultMessageCount: 4,
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
  llmRequestLoggingEnabled = true;
  state.conversation = null;
  state.selectedCall = null;
  state.previousNonCompactionCallCreatedAt = null;
  state.compactionLogs = [];
  state.compactionStoreEvents = null;
  state.compactionStoreError = null;
  sourceCalls.getRequestLogMetaByIdArgs.length = 0;
  sourceCalls.getPreviousNonCompactionCallCreatedAtArgs.length = 0;
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

  test("throws LlmRequestLogsDisabledError when logging is disabled", async () => {
    // Even with a valid conversation + call, the guard short-circuits before
    // any log source read — the compaction trail is inspector-only LLM data.
    llmRequestLoggingEnabled = false;
    state.conversation = { id: "conv-1" };
    state.selectedCall = fakeLogMetaRow({
      id: "call-1",
      conversationId: "conv-1",
    });
    await expect(
      handler({
        pathParams: { id: "conv-1" },
        queryParams: { callId: "call-1" },
      }),
    ).rejects.toThrow(LlmRequestLogsDisabledError);
    // The guard runs first: no metadata lookup happened.
    expect(sourceCalls.getRequestLogMetaByIdArgs).toEqual([]);
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
    state.selectedCall = fakeLogMetaRow({
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
  test("scopes the window to the previous real call (floor) and the selected call (ceiling)", async () => {
    // GIVEN a selected call whose previous real (non-compactionAgent)
    // call ran at 2000
    state.conversation = { id: "conv-1" };
    state.selectedCall = fakeLogMetaRow({
      id: "call-selected",
      conversationId: "conv-1",
      createdAt: 5000,
    });
    state.previousNonCompactionCallCreatedAt = 2000;
    state.compactionLogs = [];

    // WHEN the handler resolves the compactions for the call
    await handler({
      pathParams: { id: "conv-1" },
      queryParams: { callId: "call-selected" },
    });

    // THEN it anchors the floor on the previous real call and the
    // ceiling on the selected call's own createdAt — strictly, with no
    // boundary fudging.
    expect(sourceCalls.getRequestLogMetaByIdArgs).toEqual(["call-selected"]);
    expect(sourceCalls.getPreviousNonCompactionCallCreatedAtArgs).toEqual([
      { conversationId: "conv-1", beforeCreatedAt: 5000 },
    ]);
    expect(sourceCalls.getCompactionLogsBetweenArgs).toEqual([
      { conversationId: "conv-1", afterCreatedAt: 2000, beforeCreatedAt: 5000 },
    ]);
  });

  test("uses an open (null) floor when the selected call is the first real call", async () => {
    // GIVEN a selected call with no earlier real call in the conversation
    state.conversation = { id: "conv-1" };
    state.selectedCall = fakeLogMetaRow({
      id: "call-first",
      conversationId: "conv-1",
      createdAt: 5000,
    });
    state.previousNonCompactionCallCreatedAt = null;
    state.compactionLogs = [];

    // WHEN the handler resolves the compactions for the call
    await handler({
      pathParams: { id: "conv-1" },
      queryParams: { callId: "call-first" },
    });

    // THEN the floor is dropped so every preceding compaction is in scope
    expect(sourceCalls.getCompactionLogsBetweenArgs).toEqual([
      { conversationId: "conv-1", afterCreatedAt: null, beforeCreatedAt: 5000 },
    ]);
  });

  test("returns an empty events list when no compactions ran in the window", async () => {
    // GIVEN a selected call with no compactions attributed to it
    state.conversation = { id: "conv-1" };
    state.selectedCall = fakeLogMetaRow({
      id: "call-1",
      conversationId: "conv-1",
      createdAt: 5000,
    });
    state.previousNonCompactionCallCreatedAt = 2000;
    state.compactionLogs = [];

    // WHEN the handler resolves the compactions for the call
    const result = await handler({
      pathParams: { id: "conv-1" },
      queryParams: { callId: "call-1" },
    });

    // THEN it returns an empty list, not an error
    expect(result).toEqual({ conversationId: "conv-1", events: [] });
  });

  test("projects each compaction log row to the wire shape", async () => {
    // GIVEN two legacy compaction rows attributed to the selected call
    state.conversation = { id: "conv-1" };
    state.selectedCall = fakeLogMetaRow({
      id: "call-1",
      conversationId: "conv-1",
      createdAt: 9000,
    });
    state.previousNonCompactionCallCreatedAt = 500;
    state.compactionLogs = [
      fakeCompactionRow({
        id: "compaction-1",
        conversationId: "conv-1",
        createdAt: 1000,
      }),
      fakeCompactionRow({
        id: "compaction-2",
        conversationId: "conv-1",
        createdAt: 2000,
      }),
    ];

    // WHEN the handler resolves the compactions for the call
    const result = await handler({
      pathParams: { id: "conv-1" },
      queryParams: { callId: "call-1" },
    });

    // THEN it emits one event per row, each carrying the full wire shape
    expect(result.conversationId).toBe("conv-1");
    expect(result.events).toHaveLength(2);
    expect(Object.keys(result.events[0] as object).sort()).toEqual([
      "compacted",
      "compactedMessages",
      "contextTokensAfter",
      "contextTokensBefore",
      "createdAt",
      "durationMs",
      "id",
      "messagesAfter",
      "messagesBefore",
      "preservedTailMessages",
      "skipReason",
      "summaryFailed",
      "summaryInputTokens",
      "summaryModel",
      "summaryOutputTokens",
      "summaryText",
      "trigger",
    ]);
  });
});

// ---------------------------------------------------------------------
// Handler — compaction-log store path
// ---------------------------------------------------------------------

describe("handleGetCompactionTrail — compaction log store", () => {
  test("serves the compactions from the store and skips the legacy projection", async () => {
    // GIVEN the compaction-log store is configured and has a completed event
    state.conversation = { id: "conv-1" };
    state.selectedCall = fakeLogMetaRow({
      id: "call-1",
      conversationId: "conv-1",
      createdAt: 5000,
    });
    state.previousNonCompactionCallCreatedAt = 2000;
    state.compactionStoreEvents = [fakeCompactionLogEvent()];

    // WHEN the handler resolves the compactions for the call
    const result = await handler({
      pathParams: { id: "conv-1" },
      queryParams: { callId: "call-1" },
    });

    // THEN it queries the store with the same call window and never
    // touches the legacy projection
    expect(sourceCalls.getEventsBetweenArgs).toEqual([
      {
        conversationId: "conv-1",
        afterStartedAt: 2000,
        beforeStartedAt: 5000,
      },
    ]);
    expect(sourceCalls.getCompactionLogsBetweenArgs).toEqual([]);
    expect(result.events).toEqual([
      {
        id: "comp-1",
        createdAt: 3000,
        trigger: "budget",
        compacted: true,
        summaryFailed: false,
        skipReason: "auto",
        contextTokensBefore: 900,
        contextTokensAfter: 300,
        messagesBefore: 12,
        messagesAfter: 4,
        compactedMessages: 10,
        preservedTailMessages: 2,
        durationMs: 500,
        summaryModel: "test-model",
        summaryInputTokens: 880,
        summaryOutputTokens: 120,
        summaryText: "summary text",
      },
    ]);
  });

  test("falls back to the legacy projection when the store has no rows for the window", async () => {
    // GIVEN the store is configured but returns no events for this call
    state.conversation = { id: "conv-1" };
    state.selectedCall = fakeLogMetaRow({
      id: "call-1",
      conversationId: "conv-1",
      createdAt: 5000,
    });
    state.previousNonCompactionCallCreatedAt = 2000;
    state.compactionStoreEvents = [];
    state.compactionLogs = [
      fakeCompactionRow({ id: "compaction-legacy", conversationId: "conv-1" }),
    ];

    // WHEN the handler resolves the compactions for the call
    const result = await handler({
      pathParams: { id: "conv-1" },
      queryParams: { callId: "call-1" },
    });

    // THEN it falls through to the legacy projection
    expect(sourceCalls.getEventsBetweenArgs).toHaveLength(1);
    expect(sourceCalls.getCompactionLogsBetweenArgs).toHaveLength(1);
    expect(result.events).toHaveLength(1);
    expect((result.events[0] as { id: string }).id).toBe("compaction-legacy");
  });

  test("falls back to the legacy projection when the store read throws", async () => {
    // GIVEN the store read fails (e.g. ClickHouse unreachable)
    state.conversation = { id: "conv-1" };
    state.selectedCall = fakeLogMetaRow({
      id: "call-1",
      conversationId: "conv-1",
      createdAt: 5000,
    });
    state.previousNonCompactionCallCreatedAt = 2000;
    state.compactionStoreError = new Error("clickhouse unreachable");
    state.compactionLogs = [
      fakeCompactionRow({ id: "compaction-legacy", conversationId: "conv-1" }),
    ];

    // WHEN the handler resolves the compactions for the call
    const result = await handler({
      pathParams: { id: "conv-1" },
      queryParams: { callId: "call-1" },
    });

    // THEN it falls through to the legacy projection
    expect(sourceCalls.getCompactionLogsBetweenArgs).toHaveLength(1);
    expect(result.events).toHaveLength(1);
    expect((result.events[0] as { id: string }).id).toBe("compaction-legacy");
  });

  test("falls back to the legacy projection when any event is missing its end row", async () => {
    // GIVEN one of the store events never wrote its end row (no finishedAt)
    state.conversation = { id: "conv-1" };
    state.selectedCall = fakeLogMetaRow({
      id: "call-1",
      conversationId: "conv-1",
      createdAt: 5000,
    });
    state.previousNonCompactionCallCreatedAt = 2000;
    state.compactionStoreEvents = [
      fakeCompactionLogEvent(),
      fakeCompactionLogEvent({
        compactionId: "comp-2",
        finishedAt: null,
        durationMs: null,
        completed: false,
      }),
    ];
    state.compactionLogs = [
      fakeCompactionRow({ id: "compaction-legacy", conversationId: "conv-1" }),
    ];

    // WHEN the handler resolves the compactions for the call
    const result = await handler({
      pathParams: { id: "conv-1" },
      queryParams: { callId: "call-1" },
    });

    // THEN it falls through to the legacy projection rather than serving
    // an event with null counts/duration
    expect(sourceCalls.getEventsBetweenArgs).toHaveLength(1);
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
    // GIVEN a completed compaction-log event
    // WHEN it is projected to the wire shape
    const event = projectCompactionLogEventToTrailEvent(
      fakeCompactionLogEvent(),
    );

    // THEN the headline figures are the context reduction and the
    // summarizer's own usage is carried separately
    expect(event).toEqual({
      id: "comp-1",
      createdAt: 3000,
      trigger: "budget",
      compacted: true,
      summaryFailed: false,
      skipReason: "auto",
      contextTokensBefore: 900,
      contextTokensAfter: 300,
      messagesBefore: 12,
      messagesAfter: 4,
      compactedMessages: 10,
      preservedTailMessages: 2,
      durationMs: 500,
      summaryModel: "test-model",
      summaryInputTokens: 880,
      summaryOutputTokens: 120,
      summaryText: "summary text",
    });
  });

  test("maps an empty trigger to null", () => {
    // GIVEN an event whose trigger column is the empty-string default
    // WHEN it is projected
    const event = projectCompactionLogEventToTrailEvent(
      fakeCompactionLogEvent({ trigger: "" }),
    );

    // THEN the empty string is normalized to the "not known" sentinel
    expect(event.trigger).toBeNull();
  });

  test("carries through null end-phase fields on an incomplete event", () => {
    // GIVEN a start-only event (no end row written yet)
    // WHEN it is projected
    const event = projectCompactionLogEventToTrailEvent(
      fakeCompactionLogEvent({
        completed: false,
        finishedAt: null,
        durationMs: null,
        compacted: null,
        summaryFailed: null,
        resultMessageCount: null,
        estimatedInputTokens: null,
        summaryInputTokens: null,
        summaryOutputTokens: null,
        summaryModel: null,
        reason: null,
        summaryText: null,
      }),
    );

    // THEN the end-phase fields are null while the start-phase
    // pre-compaction figures survive
    expect(event.durationMs).toBeNull();
    expect(event.compacted).toBeNull();
    expect(event.contextTokensAfter).toBeNull();
    expect(event.messagesAfter).toBeNull();
    expect(event.summaryModel).toBeNull();
    expect(event.summaryText).toBeNull();
    expect(event.contextTokensBefore).toBe(900);
    expect(event.messagesBefore).toBe(12);
  });
});

describe("projectLogRowToCompactionTrailEvent", () => {
  test("returns null for every field the legacy row can't recover", () => {
    // GIVEN a compaction-agent row with empty payloads
    // WHEN it is projected
    const event = projectLogRowToCompactionTrailEvent(fakeCompactionRow());

    // THEN only id/createdAt survive; everything the row doesn't carry
    // lands as null
    expect(event.id).toBe("log-default");
    expect(event.createdAt).toBe(1000);
    expect(event.trigger).toBeNull();
    expect(event.compacted).toBeNull();
    expect(event.summaryFailed).toBeNull();
    expect(event.skipReason).toBeNull();
    expect(event.contextTokensBefore).toBeNull();
    expect(event.contextTokensAfter).toBeNull();
    expect(event.messagesBefore).toBeNull();
    expect(event.messagesAfter).toBeNull();
    expect(event.compactedMessages).toBeNull();
    expect(event.preservedTailMessages).toBeNull();
    expect(event.durationMs).toBeNull();
    expect(event.summaryModel).toBeNull();
    expect(event.summaryInputTokens).toBeNull();
    expect(event.summaryOutputTokens).toBeNull();
    expect(event.summaryText).toBeNull();
  });

  test("maps the SQL-computed request message count to compactedMessages", () => {
    // GIVEN a row whose request payload held 7 messages (fed to the
    // summarizer, i.e. the messages that were compacted)
    // WHEN it is projected
    const event = projectLogRowToCompactionTrailEvent(
      fakeCompactionRow({ requestMessageCount: 7 }),
    );

    // THEN that count surfaces as compactedMessages
    expect(event.compactedMessages).toBe(7);
  });

  test("extracts the summary model + token usage + text from an Anthropic payload", () => {
    // GIVEN a row carrying a real Anthropic summarizer response
    // WHEN it is projected
    const event = projectLogRowToCompactionTrailEvent(
      fakeCompactionRow({
        provider: "anthropic",
        requestMessageCount: 1,
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

    // THEN the summarizer's own model + usage + text are recovered
    expect(event.summaryModel).toBe("claude-sonnet-4-5");
    expect(event.summaryInputTokens).toBe(12_000);
    expect(event.summaryOutputTokens).toBe(800);
    expect(event.summaryText).toBe("Summary text…");
    expect(event.compactedMessages).toBe(1);
  });

  test("tolerates non-JSON payloads without throwing (falls back to nulls)", () => {
    // GIVEN a row with a malformed (non-JSON) response payload
    // WHEN it is projected
    const event = projectLogRowToCompactionTrailEvent(
      fakeCompactionRow({
        responsePayload: "<html>nope</html>",
      }),
    );

    // THEN it degrades to nulls instead of throwing
    expect(event.id).toBe("log-default");
    expect(event.summaryModel).toBeNull();
    expect(event.summaryInputTokens).toBeNull();
  });
});
