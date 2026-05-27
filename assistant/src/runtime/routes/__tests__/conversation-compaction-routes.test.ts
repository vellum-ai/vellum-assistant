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

import type { LogRow } from "../../../memory/llm-request-log-store.js";

interface FakeSourceState {
  conversation: { id: string } | null;
  selectedCall: LogRow | null;
  previousNonCompactionCallCreatedAt: number | null;
  compactionLogs: LogRow[];
}

const state: FakeSourceState = {
  conversation: null,
  selectedCall: null,
  previousNonCompactionCallCreatedAt: null,
  compactionLogs: [],
};

// Records the inputs the handler passed to the source so tests can
// pin the windowing plumbing without relying on the projection.
const sourceCalls = {
  getRequestLogByIdArgs: [] as string[],
  getPreviousNonCompactionCallCreatedAtArgs: [] as Array<{
    conversationId: string;
    beforeCreatedAt: number;
  }>,
  getCompactionLogsBetweenArgs: [] as Array<{
    conversationId: string;
    afterCreatedAt: number | null;
    beforeCreatedAt: number;
  }>,
};

mock.module("../../../memory/conversation-crud.js", () => ({
  getConversation: (id: string) =>
    state.conversation && state.conversation.id === id
      ? state.conversation
      : null,
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
import { projectLogRowToCompactionTrailEvent,ROUTES } from "../conversation-compaction-routes.js";
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

beforeEach(() => {
  state.conversation = null;
  state.selectedCall = null;
  state.previousNonCompactionCallCreatedAt = null;
  state.compactionLogs = [];
  sourceCalls.getRequestLogByIdArgs.length = 0;
  sourceCalls.getPreviousNonCompactionCallCreatedAtArgs.length = 0;
  sourceCalls.getCompactionLogsBetweenArgs.length = 0;
});

// ---------------------------------------------------------------------
// Route registration sanity
// ---------------------------------------------------------------------

describe("conversation-compaction-routes — registration", () => {
  test("exposes one GET route at conversations/:id/compaction", () => {
    expect(route).toBeDefined();
    expect(route.method).toBe("GET");
    expect(route.endpoint).toBe("conversations/:id/compaction");
    expect(route.policyKey).toBe("conversations/compaction");
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
  test("forwards both window bounds to the source (prior call as floor, selected call as ceiling)", async () => {
    state.conversation = { id: "conv-1" };
    state.selectedCall = fakeLogRow({
      id: "call-selected",
      conversationId: "conv-1",
      createdAt: 5000,
    });
    state.previousNonCompactionCallCreatedAt = 2000;
    state.compactionLogs = [];

    await handler({
      pathParams: { id: "conv-1" },
      queryParams: { callId: "call-selected" },
    });

    expect(sourceCalls.getRequestLogByIdArgs).toEqual(["call-selected"]);
    expect(sourceCalls.getPreviousNonCompactionCallCreatedAtArgs).toEqual([
      { conversationId: "conv-1", beforeCreatedAt: 5000 },
    ]);
    expect(sourceCalls.getCompactionLogsBetweenArgs).toEqual([
      { conversationId: "conv-1", afterCreatedAt: 2000, beforeCreatedAt: 5000 },
    ]);
  });

  test("passes a null floor when the selected call is the first real call in the conversation", async () => {
    state.conversation = { id: "conv-1" };
    state.selectedCall = fakeLogRow({
      id: "call-first",
      conversationId: "conv-1",
      createdAt: 5000,
    });
    state.previousNonCompactionCallCreatedAt = null;
    state.compactionLogs = [];

    await handler({
      pathParams: { id: "conv-1" },
      queryParams: { callId: "call-first" },
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
    state.previousNonCompactionCallCreatedAt = 2000;
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
    state.previousNonCompactionCallCreatedAt = 500;
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
    expect(Object.keys((result.events[0] as object)).sort()).toEqual([
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
// Projection unit tests
// ---------------------------------------------------------------------

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
