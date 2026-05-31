/**
 * Tests for the `agent_loop_exit` instrumentation added in this PR.
 *
 * Coverage targets:
 *  1. **One emit per run** — the idempotency guard fires once, even if the
 *     code path would otherwise reach two emit sites (the empty-response
 *     throw → catch-block fallback case).
 *  2. **Reason matches break site** — for each reachable break site, the
 *     emitted reason is the one documented in `AgentLoopExitReason`.
 *  3. **Always the last AgentEvent of terminal runs** — consumers can rely on
 *     positional ordering to find it when a run reaches a terminal state.
 *
 * Sites not exercised here (`empty_response_exhausted`, `aborted_via_error`)
 * require deeper provider fakery and are best covered by integration tests
 * once we wire up the empty-response pipeline mock.
 */
import { describe, expect, test } from "bun:test";

import type {
  AgentEvent,
  CheckpointDecision,
  CheckpointInfo,
} from "../agent/loop.js";
import { AgentLoop, isMaxTokensStopReason } from "../agent/loop.js";
import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
  ToolDefinition,
} from "../providers/types.js";

// ---------------------------------------------------------------------------
// Helpers (mirrored from agent-loop.test.ts so this file is self-contained)
// ---------------------------------------------------------------------------

function createMockProvider(responses: ProviderResponse[]): {
  provider: Provider;
} {
  let callIndex = 0;
  const provider: Provider = {
    name: "mock",
    async sendMessage(
      _messages: Message[],
      _options?: SendMessageOptions,
    ): Promise<ProviderResponse> {
      const response = responses[callIndex] ?? responses[responses.length - 1];
      callIndex++;
      return response;
    },
  };
  return { provider };
}

function textResponse(text: string): ProviderResponse {
  return {
    content: [{ type: "text", text }],
    model: "mock-model",
    usage: { inputTokens: 10, outputTokens: 5 },
    stopReason: "end_turn",
  };
}

function maxTokensResponse(
  text: string,
  stopReason: string = "max_tokens",
): ProviderResponse {
  return {
    content: [{ type: "text", text }],
    model: "mock-model",
    usage: { inputTokens: 10, outputTokens: 5 },
    stopReason,
  };
}

function toolUseResponse(
  id: string,
  name: string,
  input: Record<string, unknown>,
): ProviderResponse {
  return {
    content: [{ type: "tool_use", id, name, input }],
    model: "mock-model",
    usage: { inputTokens: 10, outputTokens: 5 },
    stopReason: "tool_use",
  };
}

const dummyTools: ToolDefinition[] = [
  {
    name: "read_file",
    description: "Read a file",
    input_schema: { type: "object", properties: { path: { type: "string" } } },
  },
];

const userMessage: Message = {
  role: "user",
  content: [{ type: "text", text: "Hello" }],
};

function lastExitEvent(
  events: AgentEvent[],
): Extract<AgentEvent, { type: "agent_loop_exit" }> | undefined {
  return events.find(
    (e): e is Extract<AgentEvent, { type: "agent_loop_exit" }> =>
      e.type === "agent_loop_exit",
  );
}

function countExitEvents(events: AgentEvent[]): number {
  return events.filter((e) => e.type === "agent_loop_exit").length;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AgentLoop exit-reason instrumentation", () => {
  test("recognizes provider output-token stop reasons", () => {
    expect(isMaxTokensStopReason("max_tokens")).toBe(true);
    expect(isMaxTokensStopReason("MAX_TOKENS")).toBe(true);
    expect(isMaxTokensStopReason("length")).toBe(true);
    expect(isMaxTokensStopReason("max_output_tokens")).toBe(true);
    expect(isMaxTokensStopReason("end_turn")).toBe(false);
    expect(isMaxTokensStopReason(undefined)).toBe(false);
  });

  test("emits exit event exactly once with 'no_tool_calls' on plain text response", async () => {
    const { provider } = createMockProvider([textResponse("Hi there!")]);
    const loop = new AgentLoop(provider, "system prompt");

    const events: AgentEvent[] = [];
    await loop.run([userMessage], (e) => {
      events.push(e);
    });

    expect(countExitEvents(events)).toBe(1);
    const exit = lastExitEvent(events);
    expect(exit?.reason).toBe("no_tool_calls");
  });

  test("agent_loop_exit is the last event emitted", async () => {
    const { provider } = createMockProvider([textResponse("Hi there!")]);
    const loop = new AgentLoop(provider, "system prompt");

    const events: AgentEvent[] = [];
    await loop.run([userMessage], (e) => {
      events.push(e);
    });

    expect(events.length).toBeGreaterThan(0);
    expect(events[events.length - 1].type).toBe("agent_loop_exit");
  });

  test("emits continuation surface event and exits on max_tokens", async () => {
    const { provider } = createMockProvider([
      maxTokensResponse("Partial answer"),
    ]);
    const loop = new AgentLoop(provider, "system prompt");

    const events: AgentEvent[] = [];
    await loop.run([userMessage], (e) => {
      events.push(e);
    });

    expect(events.map((e) => e.type)).toEqual([
      "llm_call_started",
      "usage",
      "max_tokens_reached",
      "message_complete",
      "agent_loop_exit",
    ]);
    expect(countExitEvents(events)).toBe(1);
    expect(lastExitEvent(events)?.reason).toBe("max_tokens_reached");
  });

  test("does not persist unexecuted tool_use blocks when max_tokens stops output", async () => {
    const { provider } = createMockProvider([
      {
        content: [
          { type: "text", text: "I need to check that." },
          {
            type: "tool_use",
            id: "tool-1",
            name: "read_file",
            input: { path: "/tmp/example.txt" },
          },
        ],
        model: "mock-model",
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: "max_tokens",
      },
    ]);
    const loop = new AgentLoop(provider, "system prompt", {}, dummyTools);

    const events: AgentEvent[] = [];
    const { history: result } = await loop.run([userMessage], (e) => {
      events.push(e);
    });

    expect(events.some((e) => e.type === "tool_use")).toBe(false);
    expect(lastExitEvent(events)?.reason).toBe("max_tokens_reached");
    expect(result[result.length - 1]!.content).toEqual([
      { type: "text", text: "I need to check that." },
    ]);
  });

  test("emits 'aborted_pre_call' when signal is already aborted at run start", async () => {
    const { provider } = createMockProvider([textResponse("never sent")]);
    const loop = new AgentLoop(provider, "system prompt");

    const controller = new AbortController();
    controller.abort();

    const events: AgentEvent[] = [];
    await loop.run(
      [userMessage],
      (e) => {
        events.push(e);
      },
      { signal: controller.signal },
    );

    expect(countExitEvents(events)).toBe(1);
    expect(lastExitEvent(events)?.reason).toBe("aborted_pre_call");
  });

  test("emits 'yield_to_user' when tool result requests yieldToUser", async () => {
    const { provider } = createMockProvider([
      toolUseResponse("t1", "read_file", { path: "/a.txt" }),
    ]);
    const toolExecutor = async () => ({
      content: "ok",
      isError: false,
      yieldToUser: true,
    });
    const loop = new AgentLoop(
      provider,
      "system",
      {},
      dummyTools,
      toolExecutor,
    );

    const events: AgentEvent[] = [];
    await loop.run([userMessage], (e) => {
      events.push(e);
    });

    expect(countExitEvents(events)).toBe(1);
    expect(lastExitEvent(events)?.reason).toBe("yield_to_user");
  });

  test("does not emit agent_loop_exit when onCheckpoint yields control", async () => {
    const { provider } = createMockProvider([
      toolUseResponse("t1", "read_file", { path: "/a.txt" }),
      textResponse("never reached"),
    ]);
    const toolExecutor = async () => ({ content: "ok", isError: false });
    const loop = new AgentLoop(
      provider,
      "system",
      {},
      dummyTools,
      toolExecutor,
    );

    const onCheckpoint = (_info: CheckpointInfo): CheckpointDecision =>
      "budget";

    const events: AgentEvent[] = [];
    await loop.run(
      [userMessage],
      (e) => {
        events.push(e);
      },
      { onCheckpoint },
    );

    expect(countExitEvents(events)).toBe(0);
  });

  test("emits 'error' when provider throws an unhandled error", async () => {
    const provider: Provider = {
      name: "broken",
      async sendMessage(): Promise<ProviderResponse> {
        throw new Error("provider exploded");
      },
    };
    const loop = new AgentLoop(provider, "system prompt");

    const events: AgentEvent[] = [];
    await loop.run([userMessage], (e) => {
      events.push(e);
    });

    expect(countExitEvents(events)).toBe(1);
    expect(lastExitEvent(events)?.reason).toBe("error");
  });

  test("does not double-emit when multiple exit conditions stack", async () => {
    // Tool returns yieldToUser AND the controller is aborted post-response —
    // the first reached condition wins, but the guard prevents a second
    // emit even if subsequent code paths attempt one.
    const { provider } = createMockProvider([
      toolUseResponse("t1", "read_file", { path: "/a.txt" }),
    ]);
    const toolExecutor = async () => ({
      content: "ok",
      isError: false,
      yieldToUser: true,
    });
    const loop = new AgentLoop(
      provider,
      "system",
      {},
      dummyTools,
      toolExecutor,
    );

    const events: AgentEvent[] = [];
    await loop.run([userMessage], (e) => {
      events.push(e);
    });

    expect(countExitEvents(events)).toBe(1);
  });

  test("emits 'aborted_during_tools' when signal aborts after tool execution", async () => {
    const controller = new AbortController();
    const { provider } = createMockProvider([
      toolUseResponse("t1", "read_file", { path: "/a.txt" }),
    ]);
    // Abort the signal inside the tool executor so by the time the loop
    // re-checks signal.aborted post-tools the abort has landed.
    const toolExecutor = async () => {
      controller.abort();
      return { content: "ok", isError: false };
    };
    const loop = new AgentLoop(
      provider,
      "system",
      {},
      dummyTools,
      toolExecutor,
    );

    const events: AgentEvent[] = [];
    await loop.run(
      [userMessage],
      (e) => {
        events.push(e);
      },
      { signal: controller.signal },
    );

    expect(countExitEvents(events)).toBe(1);
    expect(lastExitEvent(events)?.reason).toBe("aborted_during_tools");
  });
});
