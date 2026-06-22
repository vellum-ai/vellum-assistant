/**
 * Tests for the ClickHouse compaction log store.
 *
 * The store is exercised with an injected `fetchImpl` so the tests pin the
 * wire shape: lazy CREATE TABLE on first write, INSERT statements via the
 * `query` URL param with JSONEachRow bodies, the start/end row mappings
 * (sentinels on the start row, full `ContextWindowResult` projection on the
 * end row), and the read path that pairs rows back into per-attempt events.
 */
import { describe, expect, test } from "bun:test";

import type { ContextWindowResult } from "../../plugins/defaults/compaction/window-manager.js";
import {
  ClickHouseCompactionLogStore,
  type CompactionEndEvent,
  type CompactionStartEvent,
} from "../compaction-log-store-clickhouse.js";

interface CapturedRequest {
  url: URL;
  body: string;
}

function createWriter(overrides?: {
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
}): { writer: ClickHouseCompactionLogStore; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  const fetchImpl = (overrides?.fetchImpl ??
    (async (url: string, init?: RequestInit) => {
      requests.push({ url: new URL(url), body: String(init?.body ?? "") });
      return new Response("", { status: 200 });
    })) as typeof fetch;
  const writer = new ClickHouseCompactionLogStore(
    { database: "analytics", table: "compaction_logs", user: "writer" },
    {
      resolveUrl: async () => "http://clickhouse.example.com:8123",
      resolvePassword: async () => "secret",
      resolveAssistantId: async () => "assistant-123",
      fetchImpl,
    },
  );
  return { writer, requests };
}

const startEvent: CompactionStartEvent = {
  type: "context_compacting",
  compactionId: "comp-1",
  requestId: "req-1",
  trigger: "budget",
  startedAt: 1000,
  messages: [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "assistant", content: [{ type: "text", text: "hello" }] },
  ],
};

const result: ContextWindowResult = {
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
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
  summaryText: "summary text",
  reason: "auto",
  exhausted: false,
};

const endEvent: CompactionEndEvent = {
  type: "compaction_completed",
  compactionId: "comp-1",
  requestId: "req-1",
  trigger: "budget",
  startedAt: 1000,
  finishedAt: 1500,
  ...result,
};

describe("ClickHouseCompactionLogStore", () => {
  test("first write creates the table then inserts", async () => {
    const { writer, requests } = createWriter();

    await writer.writeStart("conv-1", startEvent);

    expect(requests.length).toBe(2);
    expect(requests[0]!.body).toContain("CREATE TABLE IF NOT EXISTS");
    expect(requests[0]!.body).toContain("`compaction_logs`");
    expect(requests[0]!.url.searchParams.get("database")).toBe("analytics");

    const insert = requests[1]!;
    expect(insert.url.searchParams.get("query")).toBe(
      "INSERT INTO `compaction_logs` FORMAT JSONEachRow",
    );
    const row = JSON.parse(insert.body) as Record<string, unknown>;
    expect(row.assistant_id).toBe("assistant-123");
    expect(row.conversation_id).toBe("conv-1");
    expect(row.compaction_id).toBe("comp-1");
    expect(row.request_id).toBe("req-1");
    expect(row.phase).toBe("start");
    expect(row.trigger).toBe("budget");
    expect(row.started_at).toBe(1000);
    expect(row.pre_message_count).toBe(2);
    // End-only fields stay at their sentinels on the start row.
    expect(row.finished_at).toBe(0);
    expect(row.duration_ms).toBe(-1);
    expect(row.estimated_input_tokens).toBe(-1);
    expect(row.summary_model).toBe("");
  });

  test("table creation happens once across writes", async () => {
    const { writer, requests } = createWriter();

    await writer.writeStart("conv-1", startEvent);
    await writer.writeEnd("conv-1", endEvent);

    const ddl = requests.filter((r) => r.body.includes("CREATE TABLE"));
    expect(ddl.length).toBe(1);
    expect(requests.length).toBe(3);
  });

  test("end row projects the full ContextWindowResult", async () => {
    const { writer, requests } = createWriter();

    await writer.writeEnd("conv-1", endEvent);

    const row = JSON.parse(requests[1]!.body) as Record<string, unknown>;
    expect(row.phase).toBe("end");
    expect(row.finished_at).toBe(1500);
    expect(row.duration_ms).toBe(500);
    expect(row.result_message_count).toBe(1);
    expect(row.compacted).toBe(1);
    expect(row.previous_estimated_input_tokens).toBe(900);
    expect(row.estimated_input_tokens).toBe(300);
    expect(row.max_input_tokens).toBe(1000);
    expect(row.threshold_tokens).toBe(850);
    expect(row.compacted_messages).toBe(10);
    expect(row.compacted_persisted_messages).toBe(8);
    expect(row.preserved_tail_messages).toBe(2);
    expect(row.summary_calls).toBe(1);
    expect(row.summary_input_tokens).toBe(880);
    expect(row.summary_output_tokens).toBe(120);
    expect(row.summary_model).toBe("test-model");
    expect(row.summary_failed).toBe(-1);
    expect(row.reason).toBe("auto");
    expect(row.exhausted).toBe(0);
    expect(row.summary_text).toBe("summary text");
  });

  test("end row maps explicit summaryFailed and omitted optionals", async () => {
    const { writer, requests } = createWriter();

    await writer.writeEnd("conv-1", {
      ...endEvent,
      compacted: false,
      summaryFailed: true,
      preservedTailMessages: undefined,
      reason: undefined,
      exhausted: true,
    });

    const row = JSON.parse(requests[1]!.body) as Record<string, unknown>;
    expect(row.compacted).toBe(0);
    expect(row.summary_failed).toBe(1);
    expect(row.preserved_tail_messages).toBe(-1);
    expect(row.reason).toBe("");
    expect(row.exhausted).toBe(1);
  });

  test("failed table creation retries on the next write", async () => {
    let calls = 0;
    const requests: CapturedRequest[] = [];
    const { writer } = createWriter({
      fetchImpl: async (url: string, init?: RequestInit) => {
        calls++;
        requests.push({ url: new URL(url), body: String(init?.body ?? "") });
        if (calls === 1) return new Response("boom", { status: 500 });
        return new Response("", { status: 200 });
      },
    });

    await expect(writer.writeStart("conv-1", startEvent)).rejects.toThrow(
      "ClickHouse compaction-log request failed",
    );

    await writer.writeStart("conv-1", startEvent);
    const ddl = requests.filter((r) => r.body.includes("CREATE TABLE"));
    expect(ddl.length).toBe(2);
  });

  test("write failures surface the HTTP status and body", async () => {
    let calls = 0;
    const { writer } = createWriter({
      fetchImpl: async () => {
        calls++;
        if (calls === 1) return new Response("", { status: 200 });
        return new Response("table is read-only", { status: 403 });
      },
    });

    await expect(writer.writeEnd("conv-1", endEvent)).rejects.toThrow(
      /HTTP 403.*table is read-only/,
    );
  });

  test("long summary text is truncated", async () => {
    const { writer, requests } = createWriter();

    await writer.writeEnd("conv-1", {
      ...endEvent,
      summaryText: "x".repeat(10_000),
    });

    const row = JSON.parse(requests[1]!.body) as Record<string, unknown>;
    expect((row.summary_text as string).length).toBe(4000);
  });
});

// ---------------------------------------------------------------------
// Read path — getEventsBetween
// ---------------------------------------------------------------------

function startRow(overrides: Record<string, unknown> = {}) {
  return {
    compaction_id: "comp-1",
    request_id: "req-1",
    phase: "start",
    trigger: "budget",
    started_at: 1000,
    finished_at: 0,
    duration_ms: -1,
    pre_message_count: 12,
    result_message_count: -1,
    compacted: 0,
    previous_estimated_input_tokens: -1,
    estimated_input_tokens: -1,
    max_input_tokens: -1,
    threshold_tokens: -1,
    compacted_messages: -1,
    compacted_persisted_messages: -1,
    preserved_tail_messages: -1,
    summary_calls: -1,
    summary_input_tokens: -1,
    summary_output_tokens: -1,
    summary_model: "",
    summary_failed: -1,
    reason: "",
    exhausted: 0,
    injection_mode: "",
    auto_compress_applied: 0,
    summary_text: "",
    ...overrides,
  };
}

function endRow(overrides: Record<string, unknown> = {}) {
  return startRow({
    phase: "end",
    finished_at: 1500,
    duration_ms: 500,
    pre_message_count: -1,
    result_message_count: 4,
    compacted: 1,
    previous_estimated_input_tokens: 900,
    estimated_input_tokens: 300,
    max_input_tokens: 1000,
    threshold_tokens: 850,
    compacted_messages: 10,
    compacted_persisted_messages: 8,
    preserved_tail_messages: 2,
    summary_calls: 1,
    summary_input_tokens: 880,
    summary_output_tokens: 120,
    summary_model: "test-model",
    summary_failed: 0,
    reason: "auto",
    summary_text: "summary text",
    ...overrides,
  });
}

function createReader(rows: Record<string, unknown>[]): {
  writer: ClickHouseCompactionLogStore;
  requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
  const { writer } = createWriter({
    fetchImpl: async (url: string, init?: RequestInit) => {
      requests.push({ url: new URL(url), body: String(init?.body ?? "") });
      const body =
        rows.length === 0
          ? ""
          : rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
      return new Response(body, { status: 200 });
    },
  });
  return { writer, requests };
}

describe("ClickHouseCompactionLogStore — getEventsBetween", () => {
  test("binds the window via param_ URL slots, never string interpolation", async () => {
    const { writer, requests } = createReader([]);

    await writer.getEventsBetween("conv-1", 1999, 9001);

    expect(requests.length).toBe(1);
    const req = requests[0]!;
    expect(req.url.searchParams.get("database")).toBe("analytics");
    expect(req.url.searchParams.get("param_assistant_id")).toBe(
      "assistant-123",
    );
    expect(req.url.searchParams.get("param_conversation_id")).toBe("conv-1");
    expect(req.url.searchParams.get("param_after_started_at")).toBe("1999");
    expect(req.url.searchParams.get("param_before_started_at")).toBe("9001");
    expect(req.body).toContain("{assistant_id:String}");
    expect(req.body).toContain(
      "started_at > fromUnixTimestamp64Milli({after_started_at:Int64})",
    );
    expect(req.body).toContain("LIMIT 1 BY compaction_id, phase");
    expect(req.body).toContain("FORMAT JSONEachRow");
  });

  test("omits the floor predicate when afterStartedAt is null", async () => {
    const { writer, requests } = createReader([]);

    await writer.getEventsBetween("conv-1", null, 9001);

    const req = requests[0]!;
    expect(req.url.searchParams.get("param_after_started_at")).toBeNull();
    expect(req.body).not.toContain("after_started_at");
  });

  test("pairs start and end rows into one completed event", async () => {
    const { writer } = createReader([startRow(), endRow()]);

    const events = await writer.getEventsBetween("conv-1", null, 9001);

    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.compactionId).toBe("comp-1");
    expect(event.completed).toBe(true);
    expect(event.trigger).toBe("budget");
    expect(event.startedAt).toBe(1000);
    expect(event.finishedAt).toBe(1500);
    expect(event.durationMs).toBe(500);
    // Start-phase field comes from the start row even though the end
    // row carries the -1 sentinel for it.
    expect(event.preMessageCount).toBe(12);
    expect(event.resultMessageCount).toBe(4);
    expect(event.compacted).toBe(true);
    expect(event.summaryInputTokens).toBe(880);
    expect(event.summaryOutputTokens).toBe(120);
    expect(event.summaryModel).toBe("test-model");
    expect(event.summaryFailed).toBe(false);
    expect(event.reason).toBe("auto");
    expect(event.exhausted).toBe(false);
    expect(event.summaryText).toBe("summary text");
  });

  test("start-only rows surface as incomplete events with null end fields", async () => {
    const { writer } = createReader([startRow()]);

    const events = await writer.getEventsBetween("conv-1", null, 9001);

    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.completed).toBe(false);
    expect(event.preMessageCount).toBe(12);
    expect(event.finishedAt).toBeNull();
    expect(event.durationMs).toBeNull();
    expect(event.compacted).toBeNull();
    expect(event.summaryModel).toBeNull();
    expect(event.summaryFailed).toBeNull();
    expect(event.summaryText).toBeNull();
  });

  test("maps sentinels back to null and coerces quoted Int64 values", async () => {
    // ClickHouse may serialize Int64 columns as JSON strings.
    const { writer } = createReader([
      endRow({
        compaction_id: "comp-2",
        started_at: "2000",
        duration_ms: "700",
        preserved_tail_messages: -1,
        summary_failed: -1,
        reason: "",
        summary_text: "",
      }),
    ]);

    const events = await writer.getEventsBetween("conv-1", null, 9001);

    const event = events[0]!;
    expect(event.startedAt).toBe(2000);
    expect(event.durationMs).toBe(700);
    expect(event.preservedTailMessages).toBeNull();
    expect(event.summaryFailed).toBeNull();
    expect(event.reason).toBeNull();
    expect(event.summaryText).toBeNull();
    // End-only pair: start-phase field is unknown.
    expect(event.preMessageCount).toBeNull();
  });

  test("sorts paired events by startedAt ascending", async () => {
    const { writer } = createReader([
      startRow({ compaction_id: "comp-late", started_at: 5000 }),
      startRow({ compaction_id: "comp-early", started_at: 1000 }),
      endRow({ compaction_id: "comp-late", started_at: 5000 }),
    ]);

    const events = await writer.getEventsBetween("conv-1", null, 9001);

    expect(events.map((e) => e.compactionId)).toEqual([
      "comp-early",
      "comp-late",
    ]);
  });

  test("empty response body yields an empty event list", async () => {
    const { writer } = createReader([]);

    const events = await writer.getEventsBetween("conv-1", null, 9001);

    expect(events).toEqual([]);
  });
});
