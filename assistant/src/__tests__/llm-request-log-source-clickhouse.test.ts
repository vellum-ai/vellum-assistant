import { describe, expect, test } from "bun:test";

import { ClickHouseLlmRequestLogSource } from "../persistence/llm-request-log-source-clickhouse.js";

const DEFAULT_CONFIG = {
  database: "default",
  table: "llm_request_logs",
  user: "default",
};

interface FakeFetchCall {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetchReturning(
  body: string,
  status = 200,
  recorder?: FakeFetchCall[],
): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) => {
    recorder?.push({
      url: typeof url === "string" ? url : url.toString(),
      init,
    });
    return Promise.resolve(
      new Response(body, {
        status,
        headers: { "content-type": "application/x-ndjson" },
      }),
    );
  }) as typeof fetch;
}

function makeSource(opts: {
  body?: string;
  status?: number;
  recorder?: FakeFetchCall[];
  resolveTurnMessageIds?: (messageId: string) => string[];
  resolveMessage?: (messageId: string) => { metadata: string | null } | null;
}) {
  return new ClickHouseLlmRequestLogSource(DEFAULT_CONFIG, {
    resolveUrl: async () => "https://ch.example.test:8443",
    resolvePassword: async () => "hunter2",
    resolveAssistantId: async () => "asst-fixture-001",
    resolveTurnMessageIds: opts.resolveTurnMessageIds ?? (() => []),
    resolveMessage: opts.resolveMessage ?? (() => null),
    fetchImpl: fakeFetchReturning(
      opts.body ?? "",
      opts.status ?? 200,
      opts.recorder,
    ),
  });
}

const SAMPLE_ROW = {
  id: "log-1",
  conversation_id: "conv-1",
  message_id: "msg-1",
  provider: "anthropic",
  request_payload: '{"foo":1}',
  response_payload: '{"bar":2}',
  // ClickHouse emits Int64 as a quoted string under JSONEachRow by default.
  created_at: "1778465138786",
  agent_loop_exit_reason: "no_tool_calls",
  call_site: "mainAgent",
};

describe("ClickHouseLlmRequestLogSource", () => {
  test("getRequestLogById returns null on empty response", async () => {
    const src = makeSource({ body: "" });
    expect(await src.getRequestLogById("missing")).toBeNull();
  });

  test("getRequestLogById parses a single JSONEachRow row into LogRow", async () => {
    const src = makeSource({ body: JSON.stringify(SAMPLE_ROW) + "\n" });
    const row = await src.getRequestLogById("log-1");
    expect(row).toEqual({
      id: "log-1",
      conversationId: "conv-1",
      messageId: "msg-1",
      provider: "anthropic",
      requestPayload: '{"foo":1}',
      responsePayload: '{"bar":2}',
      createdAt: 1778465138786,
      agentLoopExitReason: "no_tool_calls",
      callSite: "mainAgent",
      latencyBreakdown: null,
    });
  });

  test("maps empty-string message_id and provider back to null", async () => {
    const src = makeSource({
      body:
        JSON.stringify({
          ...SAMPLE_ROW,
          message_id: "",
          provider: "",
        }) + "\n",
    });
    const row = await src.getRequestLogById("log-1");
    expect(row?.messageId).toBeNull();
    expect(row?.provider).toBeNull();
  });

  test("sets the database URL param + assistant_id query param + Basic auth", async () => {
    const recorder: FakeFetchCall[] = [];
    const src = makeSource({
      body: JSON.stringify(SAMPLE_ROW) + "\n",
      recorder,
    });
    await src.getRequestLogById("log-1");
    expect(recorder).toHaveLength(1);
    const call = recorder[0]!;
    const parsed = new URL(call.url);
    expect(parsed.searchParams.get("database")).toBe("default");
    expect(parsed.searchParams.get("param_assistant_id")).toBe(
      "asst-fixture-001",
    );
    expect(parsed.searchParams.get("param_log_id")).toBe("log-1");
    expect(call.init?.method).toBe("POST");
    const auth = (call.init?.headers as Record<string, string>).Authorization;
    expect(auth).toMatch(/^Basic /);
    const decoded = Buffer.from(auth.slice("Basic ".length), "base64").toString(
      "utf8",
    );
    expect(decoded).toBe("default:hunter2");
    // The SQL body should reference the configured table and the parameterized
    // placeholders ClickHouse will substitute from `param_*`.
    expect(call.init?.body).toContain("`llm_request_logs`");
    expect(call.init?.body).toContain("{assistant_id:String}");
    expect(call.init?.body).toContain("{log_id:String}");
  });

  test("throws a descriptive error on non-2xx", async () => {
    const src = makeSource({ body: "boom", status: 503 });
    await expect(src.getRequestLogById("log-1")).rejects.toThrow(
      /ClickHouse query failed \(HTTP 503\): boom/,
    );
  });

  test("getRequestLogsByMessageId returns [] when turn resolution yields no message IDs", async () => {
    // The module-level mock of conversation-crud returns [] for the turn,
    // and null for fork-source resolution, so this exercises the empty path
    // without any database setup.
    const src = makeSource({ body: "" });
    const rows = await src.getRequestLogsByMessageId("msg-x");
    expect(rows).toEqual([]);
  });

  test("getRequestLogsByConversationId binds conversation id via parameterized placeholder", async () => {
    // Regression guard: the conversation id flows from user-controlled
    // input (conversationKey → conversations.id), so it must travel as a
    // typed parameter, never as an inline string literal.
    const recorder: FakeFetchCall[] = [];
    const malicious = "conv-1' OR 1=1 --";
    const src = makeSource({
      body: JSON.stringify(SAMPLE_ROW) + "\n",
      recorder,
    });
    const rows = await src.getRequestLogsByConversationId(malicious);
    expect(rows).toHaveLength(1);
    expect(recorder).toHaveLength(1);
    const call = recorder[0]!;
    const parsed = new URL(call.url);
    expect(parsed.searchParams.get("param_assistant_id")).toBe(
      "asst-fixture-001",
    );
    expect(parsed.searchParams.get("param_conversation_id")).toBe(malicious);
    const body = String(call.init?.body ?? "");
    expect(body).toContain("conversation_id = {conversation_id:String}");
    expect(body).not.toContain(`'${malicious}'`);
  });

  test("getRequestLogsByMessageId binds message ids via parameterized placeholders", async () => {
    // Regression for ATL-537. `getAssistantMessageIdsInTurn` returns the
    // caller-supplied id straight through when the message lookup misses,
    // so the value passed in here is what the IN clause receives. The id
    // ends in a backslash on purpose: with the old inline-literal approach
    // (quote-doubling only), ClickHouse would honor `\'` as an escaped
    // quote and the string literal would break out of the IN clause.
    // The fix binds each id as a typed `{id_N:String}` parameter, so the
    // hostile content flows as data, never syntax.
    const recorder: FakeFetchCall[] = [];
    const malicious = "foo\\";
    const src = makeSource({
      body: "",
      recorder,
      resolveTurnMessageIds: () => [malicious, "msg-b"],
    });
    await src.getRequestLogsByMessageId(malicious);
    expect(recorder).toHaveLength(1);
    const call = recorder[0]!;
    const parsed = new URL(call.url);
    expect(parsed.searchParams.get("param_assistant_id")).toBe(
      "asst-fixture-001",
    );
    expect(parsed.searchParams.get("param_id_0")).toBe(malicious);
    expect(parsed.searchParams.get("param_id_1")).toBe("msg-b");
    const body = String(call.init?.body ?? "");
    expect(body).toContain("message_id IN ({id_0:String},{id_1:String})");
    // No inline single-quoted literal should appear for the IN clause:
    // if any caller-supplied id surfaces unbound in the SQL, that's the
    // injection surface the regression test guards against.
    expect(body).not.toContain(`'${malicious}'`);
    expect(body).not.toContain(`'msg-b'`);
  });

  test("getRequestLogMetaById returns metadata without selecting either payload column", async () => {
    // GIVEN a stored row in ClickHouse
    const recorder: FakeFetchCall[] = [];
    const metaRow = {
      id: "log-1",
      conversation_id: "conv-1",
      message_id: "msg-1",
      provider: "anthropic",
      created_at: "1778465138786",
      agent_loop_exit_reason: "no_tool_calls",
      call_site: "compactionAgent",
    };
    const src = makeSource({
      body: JSON.stringify(metaRow) + "\n",
      recorder,
    });

    // WHEN looking it up by id
    const row = await src.getRequestLogMetaById("log-1");

    // THEN the metadata comes back without payload fields
    expect(row).toEqual({
      id: "log-1",
      conversationId: "conv-1",
      messageId: "msg-1",
      provider: "anthropic",
      createdAt: 1778465138786,
      agentLoopExitReason: "no_tool_calls",
      callSite: "compactionAgent",
    });
    // AND the query never selects the payload columns (a single request
    // payload can be a full context window)
    const body = String(recorder[0]!.init?.body ?? "");
    expect(body).not.toContain("request_payload");
    expect(body).not.toContain("response_payload");
  });

  test("getCompactionLogsBetween computes message count in SQL and skips the request payload", async () => {
    // GIVEN compaction rows whose message count ClickHouse computed via
    // JSONLength (Int64 arrives as a quoted string under JSONEachRow)
    const recorder: FakeFetchCall[] = [];
    const compactionRow = {
      id: "log-1",
      conversation_id: "conv-1",
      message_id: "",
      provider: "anthropic",
      response_payload: '{"bar":2}',
      request_message_count: "42",
      created_at: "1778465138786",
      agent_loop_exit_reason: "",
      call_site: "compactionAgent",
    };
    const src = makeSource({
      body:
        JSON.stringify(compactionRow) +
        "\n" +
        JSON.stringify({
          ...compactionRow,
          id: "log-2",
          request_message_count: null,
        }) +
        "\n",
      recorder,
    });

    // WHEN querying the trail window
    const rows = await src.getCompactionLogsBetween("conv-1", 100, 500);

    // THEN each row carries the numeric message count (null when the
    // payload had no known message array) and no request payload
    expect(rows).toHaveLength(2);
    expect(rows[0]!.requestMessageCount).toBe(42);
    expect(rows[1]!.requestMessageCount).toBeNull();
    expect(rows[0]!.responsePayload).toBe('{"bar":2}');
    expect("requestPayload" in rows[0]!).toBe(false);
    // AND the SQL only touches request_payload inside JSONLength —
    // it is never selected as a column
    const body = String(recorder[0]!.init?.body ?? "");
    expect(body).toContain("JSONLength(request_payload");
    expect(body.match(/request_payload/g)).toHaveLength(
      body.match(/JSONLength\(request_payload/g)!.length,
    );
  });

  test("missing clickhouse:url credential surfaces a clear error", async () => {
    const src = new ClickHouseLlmRequestLogSource(DEFAULT_CONFIG, {
      resolveUrl: async () => null,
      resolvePassword: async () => "x",
      resolveAssistantId: async () => "asst-1",
      fetchImpl: fakeFetchReturning(""),
    });
    await expect(src.getRequestLogById("log-1")).rejects.toThrow(
      /clickhouse:url credential is required/,
    );
  });

  test("missing vellum:platform_assistant_id surfaces a clear error", async () => {
    const src = new ClickHouseLlmRequestLogSource(DEFAULT_CONFIG, {
      resolveUrl: async () => "https://ch.example.test",
      resolvePassword: async () => "x",
      resolveAssistantId: async () => null,
      fetchImpl: fakeFetchReturning(""),
    });
    await expect(src.getRequestLogById("log-1")).rejects.toThrow(
      /vellum:platform_assistant_id credential is required/,
    );
  });
});
