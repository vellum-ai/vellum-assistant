import { beforeEach, describe, expect, mock, test } from "bun:test";

// Silence the logger.
mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Capture what the accumulator would buffer, isolating accumulator logic from
// the store's consent gate / DB (the gate is covered in trace-events-store.test.ts).
import type { TraceEventRecord } from "../memory/trace-events-store.js";

const recorded: TraceEventRecord[] = [];
mock.module("../memory/trace-events-store.js", () => ({
  recordTraceEvent: (record: TraceEventRecord) => {
    recorded.push(record);
  },
}));

// Controllable analytics gate. Drives whether the constructor warms the
// consent cache.
let collectUsageData = true;
mock.module("../config/loader.js", () => ({
  getConfig: () => ({ collectUsageData }),
}));

// The constructor warms the real consent cache via `refreshPlatformConsent`,
// which calls `VellumPlatformClient.create()`. Spy on `create` to observe the
// warm trigger without mocking `platform-consent` itself (which would leak the
// stub into platform-consent.test.ts in the shared test process).
let createCount = 0;
mock.module("../platform/client.js", () => ({
  VellumPlatformClient: {
    create: () => {
      createCount += 1;
      return Promise.resolve(null);
    },
  },
}));

import type { AgentEvent } from "../agent/loop.js";
import type { Message } from "../providers/types.js";
import { _resetPlatformConsentCacheForTests } from "./platform-consent.js";
import { TurnTraceAccumulator } from "./turn-trace-accumulator.js";

function assistantMessage(content: Message["content"]): Message {
  return { role: "assistant", content };
}

describe("TurnTraceAccumulator", () => {
  beforeEach(() => {
    recorded.length = 0;
    collectUsageData = true;
    createCount = 0;
    // Reset so each warming test sees a refresh as "due".
    _resetPlatformConsentCacheForTests();
  });

  describe("consent-cache warming", () => {
    test("warms the platform consent cache on construction when analytics is on", async () => {
      collectUsageData = true;
      new TurnTraceAccumulator("conv-1", "req-1");
      // The refresh is fire-and-forget; let the microtask drain.
      await Promise.resolve();
      await Promise.resolve();
      expect(createCount).toBe(1);
    });

    test("does not fetch consent when analytics is opted out", async () => {
      collectUsageData = false;
      new TurnTraceAccumulator("conv-1", "req-1");
      await Promise.resolve();
      await Promise.resolve();
      expect(createCount).toBe(0);
    });
  });

  test("assembles llm calls, tool calls, and usage into one buffered trace", () => {
    const acc = new TurnTraceAccumulator("conv-1", "req-1");
    const events: AgentEvent[] = [
      { type: "llm_call_started", callSite: "mainAgent" },
      {
        type: "message_complete",
        message: assistantMessage([
          { type: "text", text: "let me check" },
          {
            type: "tool_use",
            id: "tu-1",
            name: "web_fetch",
            input: { url: "https://example.com" },
          },
        ]),
      },
      {
        type: "usage",
        inputTokens: 100,
        outputTokens: 20,
        cacheCreationInputTokens: 5,
        cacheReadInputTokens: 3,
        model: "model-a",
        actualProvider: "anthropic",
        providerDurationMs: 10,
      },
      {
        type: "tool_use",
        id: "tu-1",
        name: "web_fetch",
        input: { url: "https://example.com" },
      },
      {
        type: "tool_result",
        toolUseId: "tu-1",
        content: "fetched body",
        isError: false,
      },
      { type: "agent_loop_exit", reason: "no_tool_calls" },
    ];
    for (const e of events) acc.observe(e);

    expect(recorded).toHaveLength(1);
    const { conversationId, requestId, trace } = recorded[0]!;
    expect(conversationId).toBe("conv-1");
    expect(requestId).toBe("req-1");
    expect(trace.exit_reason).toBe("no_tool_calls");
    expect(trace.started_at).toBeGreaterThan(0);
    expect(trace.ended_at).toBeGreaterThan(0);

    expect(trace.llm_calls).toHaveLength(1);
    const call = trace.llm_calls[0]!;
    expect(call).toMatchObject({
      index: 0,
      call_site: "mainAgent",
      model: "model-a",
      provider: "anthropic",
    });
    expect(call.usage).toEqual({
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 5,
      cache_read_input_tokens: 3,
    });
    expect(call.completion?.role).toBe("assistant");

    expect(trace.tool_calls).toHaveLength(1);
    expect(trace.tool_calls[0]).toMatchObject({
      tool_use_id: "tu-1",
      tool_name: "web_fetch",
      result: "fetched body",
      is_error: false,
    });
  });

  test("redacts secrets from tool inputs while preserving ordinary content", () => {
    const acc = new TurnTraceAccumulator("conv-1", "req-1");
    acc.observe({ type: "llm_call_started", callSite: "mainAgent" });
    acc.observe({
      type: "tool_use",
      id: "tu-secret",
      name: "http_request",
      input: {
        url: "https://api.example.com/data",
        headers: { Authorization: "Bearer sk-shouldnotleak" },
        access_token: "tok-shouldnotleak",
        body: { message: "ordinary user content stays" },
      },
    });
    acc.observe({
      type: "tool_result",
      toolUseId: "tu-secret",
      content: "ok",
      isError: false,
    });
    acc.observe({ type: "agent_loop_exit", reason: "no_tool_calls" });

    expect(recorded).toHaveLength(1);
    const tool = recorded[0]!.trace.tool_calls[0]!;
    const input = tool.input as Record<string, unknown>;
    const headers = input.headers as Record<string, unknown>;
    // Secrets scrubbed...
    expect(headers.Authorization).toBe("<redacted />");
    expect(input.access_token).toBe("<redacted />");
    // ...ordinary content preserved.
    expect(input.url).toBe("https://api.example.com/data");
    expect((input.body as Record<string, unknown>).message).toBe(
      "ordinary user content stays",
    );
  });

  test("redacts secrets echoed into the completion content blocks", () => {
    const acc = new TurnTraceAccumulator("conv-1", "req-1");
    acc.observe({ type: "llm_call_started", callSite: "mainAgent" });
    acc.observe({
      type: "message_complete",
      message: assistantMessage([
        {
          type: "tool_use",
          id: "tu-2",
          name: "configure",
          input: { api_key: "sk-leak", note: "keep me" },
        },
      ]),
    });
    acc.observe({ type: "agent_loop_exit", reason: "no_tool_calls" });

    const content = recorded[0]!.trace.llm_calls[0]!.completion!
      .content as Array<Record<string, unknown>>;
    const toolUseBlock = content[0]!;
    const blockInput = toolUseBlock.input as Record<string, unknown>;
    expect(blockInput.api_key).toBe("<redacted />");
    expect(blockInput.note).toBe("keep me");
  });

  test("finalizes exactly once even if agent_loop_exit is observed twice", () => {
    const acc = new TurnTraceAccumulator("conv-1", "req-1");
    acc.observe({ type: "llm_call_started", callSite: "mainAgent" });
    acc.observe({
      type: "agent_loop_exit",
      reason: "budget_yield_unrecovered",
    });
    acc.observe({
      type: "agent_loop_exit",
      reason: "budget_yield_unrecovered",
    });
    expect(recorded).toHaveLength(1);
  });

  test("buffers nothing when the turn produced no observable activity", () => {
    const acc = new TurnTraceAccumulator("conv-1", "req-1");
    acc.observe({ type: "agent_loop_exit", reason: "no_tool_calls" });
    expect(recorded).toHaveLength(0);
  });
});
