/**
 * Tests for the ClickHouse compaction log writer.
 *
 * The writer is exercised with an injected `fetchImpl` so the tests pin the
 * wire shape: lazy CREATE TABLE on first write, INSERT statements via the
 * `query` URL param with JSONEachRow bodies, and the start/end row mappings
 * (sentinels on the start row, full `ContextWindowResult` projection on the
 * end row).
 */
import { describe, expect, test } from "bun:test";

import type { ContextWindowResult } from "../../plugins/defaults/compaction/window-manager.js";
import {
  ClickHouseCompactionLogWriter,
  type CompactionEndEvent,
  type CompactionStartEvent,
} from "../compaction-log-writer-clickhouse.js";

interface CapturedRequest {
  url: URL;
  body: string;
}

function createWriter(overrides?: {
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
}): { writer: ClickHouseCompactionLogWriter; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  const fetchImpl = (overrides?.fetchImpl ??
    (async (url: string, init?: RequestInit) => {
      requests.push({ url: new URL(url), body: String(init?.body ?? "") });
      return new Response("", { status: 200 });
    })) as typeof fetch;
  const writer = new ClickHouseCompactionLogWriter(
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
  messages: [],
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
  result,
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
};

describe("ClickHouseCompactionLogWriter", () => {
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
    expect(row.basis_message_count).toBe(1);
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
      result: {
        ...result,
        compacted: false,
        summaryFailed: true,
        preservedTailMessages: undefined,
        reason: undefined,
        exhausted: true,
      },
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
      "ClickHouse compaction-log write failed",
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
      result: { ...result, summaryText: "x".repeat(10_000) },
    });

    const row = JSON.parse(requests[1]!.body) as Record<string, unknown>;
    expect((row.summary_text as string).length).toBe(4000);
  });
});
