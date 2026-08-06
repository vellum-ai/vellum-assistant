/**
 * Tests the ClickHouse WRITE sink for LLM request logs: the wire shape it
 * POSTs (lazy CREATE TABLE + JSONEachRow INSERT, null → '' sentinels,
 * assistant_id injected from credentials) and the config-gated factory.
 */
import { afterEach, describe, expect, test } from "bun:test";

import {
  ClickHouseLlmRequestLogSink,
  getClickHouseLlmRequestLogSink,
  resetClickHouseLlmRequestLogSinkForTests,
} from "../persistence/llm-request-log-sink-clickhouse.js";
import { setConfig } from "./helpers/set-config.js";

afterEach(() => {
  setConfig("llmRequestLogs", { readSource: "local" });
  resetClickHouseLlmRequestLogSinkForTests();
});

const DEFAULT_CONFIG = {
  database: "default",
  table: "llm_request_logs",
  user: "default",
};

interface FakeFetchCall {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(recorder: FakeFetchCall[], status = 200): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) => {
    recorder.push({
      url: typeof url === "string" ? url : url.toString(),
      init,
    });
    return Promise.resolve(new Response("", { status }));
  }) as typeof fetch;
}

function makeSink(recorder: FakeFetchCall[], status = 200) {
  return new ClickHouseLlmRequestLogSink(DEFAULT_CONFIG, {
    resolveUrl: async () => "https://ch.example.test:8443",
    resolvePassword: async () => "hunter2",
    resolveAssistantId: async () => "asst-fixture-001",
    fetchImpl: fakeFetch(recorder, status),
  });
}

describe("ClickHouseLlmRequestLogSink.insert", () => {
  test("creates the table then inserts the JSONEachRow wire shape", async () => {
    const calls: FakeFetchCall[] = [];
    const sink = makeSink(calls);

    await sink.insert({
      id: "log-1",
      conversationId: "conv-1",
      messageId: "msg-1",
      provider: "anthropic",
      requestPayload: '{"req":1}',
      responsePayload: '{"res":1}',
      createdAt: 1_700_000_000_123,
      agentLoopExitReason: "no_tool_calls",
      callSite: "mainAgent",
    });

    expect(calls).toHaveLength(2);
    // 1) DDL as the request body, no `query` param.
    expect(String(calls[0]!.init?.body)).toContain(
      "CREATE TABLE IF NOT EXISTS",
    );
    expect(new URL(calls[0]!.url).searchParams.get("query")).toBeNull();

    // 2) INSERT statement in the `query` param, row JSON in the body.
    const insertUrl = new URL(calls[1]!.url);
    expect(insertUrl.searchParams.get("query")).toContain(
      "INSERT INTO `llm_request_logs` FORMAT JSONEachRow",
    );
    expect(insertUrl.searchParams.get("database")).toBe("default");
    const row = JSON.parse(String(calls[1]!.init?.body));
    expect(row).toEqual({
      assistant_id: "asst-fixture-001",
      id: "log-1",
      conversation_id: "conv-1",
      message_id: "msg-1",
      provider: "anthropic",
      request_payload: '{"req":1}',
      response_payload: '{"res":1}',
      created_at: 1_700_000_000_123,
      agent_loop_exit_reason: "no_tool_calls",
      call_site: "mainAgent",
    });
    // Basic auth is sent.
    expect(
      (calls[1]!.init?.headers as Record<string, string>).Authorization,
    ).toStartWith("Basic ");
  });

  test("maps null string fields to the '' sentinel", async () => {
    const calls: FakeFetchCall[] = [];
    const sink = makeSink(calls);

    await sink.insert({
      id: "log-2",
      conversationId: "conv-2",
      messageId: null,
      provider: null,
      requestPayload: "{}",
      responsePayload: "{}",
      createdAt: 1,
      agentLoopExitReason: null,
      callSite: null,
    });

    const row = JSON.parse(String(calls[1]!.init?.body));
    expect(row.message_id).toBe("");
    expect(row.provider).toBe("");
    expect(row.agent_loop_exit_reason).toBe("");
    expect(row.call_site).toBe("");
  });

  test("insert rejects on a ClickHouse error status", async () => {
    const calls: FakeFetchCall[] = [];
    const sink = makeSink(calls, 500);
    await expect(
      sink.insert({
        id: "log-3",
        conversationId: "conv-3",
        messageId: null,
        provider: null,
        requestPayload: "{}",
        responsePayload: "{}",
        createdAt: 1,
        agentLoopExitReason: null,
        callSite: null,
      }),
    ).rejects.toThrow(/ClickHouse llm-request-log write failed/);
  });

  test("insertRequestLog never throws synchronously on a failing backend", () => {
    const calls: FakeFetchCall[] = [];
    const sink = makeSink(calls, 500);
    expect(() =>
      sink.insertRequestLog({
        id: "log-4",
        conversationId: "conv-4",
        messageId: null,
        provider: null,
        requestPayload: "{}",
        responsePayload: "{}",
        createdAt: 1,
        agentLoopExitReason: null,
        callSite: null,
      }),
    ).not.toThrow();
  });

  test("the post-hoc mutators are no-ops that never touch the backend", () => {
    // INSERT-only backend: the LlmRequestLogWriter mutation methods must not
    // issue any request (and must not throw) — the store relies on this to
    // keep stale local rows untouched while ClickHouse owns writes.
    const calls: FakeFetchCall[] = [];
    const sink = makeSink(calls);
    sink.setAgentLoopExitReasonOnLatestLog("conv-1", "no_tool_calls");
    sink.backfillMessageIdOnLogs("conv-1", "msg-1");
    sink.relinkLlmRequestLogs(["m1"], "m2");
    sink.backfillMessageIdOnRecoveredLogs(["log-1"], "msg-1");
    expect(calls).toHaveLength(0);
  });
});

describe("getClickHouseLlmRequestLogSink factory", () => {
  test("returns null when readSource is 'local'", () => {
    setConfig("llmRequestLogs", { readSource: "local" });
    expect(getClickHouseLlmRequestLogSink()).toBeNull();
  });

  test("returns null under the default config (readSource defaults to local)", () => {
    expect(getClickHouseLlmRequestLogSink()).toBeNull();
  });

  test("returns a sink when readSource is 'clickhouse'", () => {
    setConfig("llmRequestLogs", {
      readSource: "clickhouse",
      clickhouse: DEFAULT_CONFIG,
    });
    expect(getClickHouseLlmRequestLogSink()).toBeInstanceOf(
      ClickHouseLlmRequestLogSink,
    );
  });

  test("re-instantiates when the clickhouse config changes", () => {
    setConfig("llmRequestLogs", {
      readSource: "clickhouse",
      clickhouse: DEFAULT_CONFIG,
    });
    const first = getClickHouseLlmRequestLogSink();
    setConfig("llmRequestLogs", {
      readSource: "clickhouse",
      clickhouse: { ...DEFAULT_CONFIG, table: "other_logs" },
    });
    const second = getClickHouseLlmRequestLogSink();
    expect(second).not.toBe(first);
  });
});
