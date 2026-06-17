import { beforeEach, describe, expect, mock, test } from "bun:test";

// Silence the logger.
mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Consent reflection the store gates on. Both must be true for trace
// collection to be enabled (DARK by default).
let collectUsageData = true;
let shareProductImprovement = true;

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    model: "test",
    provider: "test",
    memory: { enabled: false },
    collectUsageData,
    shareProductImprovement,
  }),
}));

import type { TraceTelemetryEvent } from "../telemetry/types.js";
import { getDb } from "./db-connection.js";
import { initializeDb } from "./db-init.js";
import { telemetryTraceEvents } from "./schema.js";
import {
  queryUnreportedTraceEvents,
  recordTraceEvent,
  traceCollectionEnabled,
} from "./trace-events-store.js";

initializeDb();

const SAMPLE_TRACE: TraceTelemetryEvent["trace"] = {
  exit_reason: "completed",
  started_at: 1000,
  ended_at: 2000,
  llm_calls: [
    {
      index: 0,
      call_site: "mainAgent",
      model: "model-a",
      provider: "anthropic",
      completion: {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
      },
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
      },
    },
  ],
  tool_calls: [],
};

function insertRow(id: string, createdAt: number): void {
  getDb()
    .insert(telemetryTraceEvents)
    .values({
      id,
      createdAt,
      conversationId: "conv-1",
      requestId: "req-1",
      turnIndex: 1,
      trace: JSON.stringify(SAMPLE_TRACE),
    })
    .run();
}

describe("trace-events-store", () => {
  beforeEach(() => {
    collectUsageData = true;
    shareProductImprovement = true;
    getDb().delete(telemetryTraceEvents).run();
  });

  describe("consent gate (DARK by default)", () => {
    test("records nothing when shareProductImprovement is off", () => {
      shareProductImprovement = false;
      recordTraceEvent({
        conversationId: "conv-1",
        requestId: "req-1",
        trace: SAMPLE_TRACE,
      });
      expect(queryUnreportedTraceEvents(0, undefined, 10)).toHaveLength(0);
    });

    test("records nothing when collectUsageData is off", () => {
      collectUsageData = false;
      recordTraceEvent({
        conversationId: "conv-1",
        requestId: "req-1",
        trace: SAMPLE_TRACE,
      });
      expect(queryUnreportedTraceEvents(0, undefined, 10)).toHaveLength(0);
    });

    test("records nothing when both are off", () => {
      collectUsageData = false;
      shareProductImprovement = false;
      recordTraceEvent({
        conversationId: "conv-1",
        requestId: "req-1",
        trace: SAMPLE_TRACE,
      });
      expect(queryUnreportedTraceEvents(0, undefined, 10)).toHaveLength(0);
    });

    test("records only when both consents are on", () => {
      expect(traceCollectionEnabled()).toBe(true);
      recordTraceEvent({
        conversationId: "conv-1",
        requestId: "req-1",
        trace: SAMPLE_TRACE,
      });
      expect(queryUnreportedTraceEvents(0, undefined, 10)).toHaveLength(1);
    });
  });

  test("record + query round-trips the trace body and fields", () => {
    recordTraceEvent({
      conversationId: "conv-xyz",
      requestId: "req-abc",
      trace: SAMPLE_TRACE,
    });

    const rows = queryUnreportedTraceEvents(0, undefined, 10);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBeString();
    expect(row.createdAt).toBeGreaterThan(0);
    expect(row.conversationId).toBe("conv-xyz");
    expect(row.requestId).toBe("req-abc");
    // No user-message rows in this in-memory DB, so the correlated turn-index
    // count is 0 (records correctly rather than throwing).
    expect(row.turnIndex).toBe(0);
    expect(row.trace).toEqual(SAMPLE_TRACE);
  });

  test("null requestId persists as null", () => {
    recordTraceEvent({
      conversationId: "conv-1",
      requestId: null,
      trace: SAMPLE_TRACE,
    });
    const rows = queryUnreportedTraceEvents(0, undefined, 10);
    expect(rows[0]!.requestId).toBeNull();
  });

  test("malformed stored trace JSON yields an empty trace shell, not a throw", () => {
    getDb()
      .insert(telemetryTraceEvents)
      .values({
        id: "tte-bad",
        createdAt: 1000,
        conversationId: "conv-1",
        requestId: null,
        turnIndex: null,
        trace: "{not valid json",
      })
      .run();
    const rows = queryUnreportedTraceEvents(0, undefined, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.trace).toEqual({
      exit_reason: null,
      started_at: null,
      ended_at: null,
      llm_calls: [],
      tool_calls: [],
    });
  });

  test("returns rows in (createdAt, id) order and advances past the compound cursor", () => {
    insertRow("tte-1", 5000);
    insertRow("tte-2", 5000);
    insertRow("tte-3", 6000);

    const first = queryUnreportedTraceEvents(0, undefined, 1);
    expect(first.map((r) => r.id)).toEqual(["tte-1"]);

    const second = queryUnreportedTraceEvents(
      first[0]!.createdAt,
      first[0]!.id,
      100,
    );
    expect(second.map((r) => r.id)).toEqual(["tte-2", "tte-3"]);

    // Cursor past the last row returns nothing.
    const last = second[second.length - 1]!;
    expect(
      queryUnreportedTraceEvents(last.createdAt, last.id, 100).length,
    ).toBe(0);
  });

  test("honors the limit", () => {
    insertRow("tte-l1", 1000);
    insertRow("tte-l2", 2000);
    insertRow("tte-l3", 3000);
    expect(
      queryUnreportedTraceEvents(0, undefined, 2).map((r) => r.id),
    ).toEqual(["tte-l1", "tte-l2"]);
  });
});
