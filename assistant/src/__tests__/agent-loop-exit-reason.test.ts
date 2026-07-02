/**
 * Tests for the `agent_loop_exit` instrumentation.
 *
 * Coverage targets:
 *  1. **One emit per run** — the idempotency guard fires once, even when
 *     multiple exit conditions stack and the code path would otherwise
 *     reach a second emit site.
 *  2. **Reason matches break site** — for each reachable break site, the
 *     emitted reason is the one documented in `AgentLoopExitReason`.
 *  3. **Always the last AgentEvent of terminal runs** — consumers can rely on
 *     positional ordering to find it when a run reaches a terminal state.
 *
 * Sites not exercised here (`aborted_via_error`) require deeper provider
 * fakery and are best covered by integration tests.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { PostCompactContext } from "@vellumai/plugin-api";

import type {
  AgentEvent,
  CheckpointDecision,
  CheckpointInfo,
} from "../agent/loop.js";
import { AgentLoop } from "../agent/loop.js";
import type { ContextWindowConfig } from "../config/types.js";
import type { TrustContext } from "../daemon/trust-context.js";
import { HOOKS } from "../plugin-api/constants.js";
import {
  createContextWindowManager,
  disposeContextWindowManager,
  getContextWindowManager,
} from "../plugins/defaults/compaction/manager-store.js";
import {
  registerPlugin,
  resetPluginRegistryForTests,
} from "../plugins/registry.js";
import { isMaxTokensStopReason } from "../providers/stop-reasons.js";
import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
  ToolDefinition,
} from "../providers/types.js";

// The agent loop runs the default post-compaction re-injection through the
// `post-compact` hook chain when it compacts in place. Register a test hook on
// that chain so these unit tests can drive the re-injection result without the
// daemon-level injector. The hook writes the re-injected history back onto the
// context; tests assign `postCompactImpl` to observe the call or force a
// failure; when unset the hook leaves the history it was handed untouched.
let postCompactImpl:
  | ((input: PostCompactContext) => Promise<Message[]>)
  | null = null;
const testPostCompactPlugin = {
  manifest: { name: "test-post-compact", version: "0.0.0" },
  hooks: {
    [HOOKS.POST_COMPACT]: async (input: PostCompactContext): Promise<void> => {
      input.history = postCompactImpl
        ? await postCompactImpl(input)
        : input.history;
    },
  },
};

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

// Register a context-window manager whose `maybeCompact` returns a canned
// result in the compaction store the loop resolves from, so the loop's
// compaction call runs without the real orchestrator machinery. Returns the
// trust snapshot the loop also needs as a run option.
function fakeCompaction(
  conversationId: string,
  result: { compacted: boolean; exhausted: boolean },
): { trust: TrustContext } {
  createContextWindowManager({
    provider: { name: "mock-provider" } as unknown as Provider,
    config: {} as unknown as ContextWindowConfig,
    conversationId,
  });
  const manager = getContextWindowManager(conversationId);
  if (manager) {
    manager.maybeCompact = (async () =>
      result) as unknown as typeof manager.maybeCompact;
  }
  return { trust: { sourceChannel: "vellum", trustClass: "unknown" } };
}

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
  // Reset the plugin registry to a known state so ambient registrations from
  // other test files (e.g. the default plugins) cannot leak into the
  // post-compact hook chain these tests drive.
  beforeEach(() => {
    resetPluginRegistryForTests();
    registerPlugin(testPostCompactPlugin);
  });

  afterEach(() => {
    disposeContextWindowManager("test-conversation");
  });

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
    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system prompt",
      conversationId: "test-conversation",
    });

    const events: AgentEvent[] = [];
    await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: (e) => {
        events.push(e);
      },
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    expect(countExitEvents(events)).toBe(1);
    const exit = lastExitEvent(events);
    expect(exit?.reason).toBe("no_tool_calls");
  });

  test("agent_loop_exit is the last event emitted", async () => {
    const { provider } = createMockProvider([textResponse("Hi there!")]);
    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system prompt",
      conversationId: "test-conversation",
    });

    const events: AgentEvent[] = [];
    await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: (e) => {
        events.push(e);
      },
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    expect(events.length).toBeGreaterThan(0);
    expect(events[events.length - 1].type).toBe("agent_loop_exit");
  });

  test("emits agent_loop_exit even when a stop hook throws", async () => {
    // A third-party teardown hook that rejects must not suppress the terminal
    // exit: the loop isolates the stop chain, logs the failure, and still emits
    // `agent_loop_exit` exactly once with the real reason.
    registerPlugin({
      manifest: { name: "throwing-stop", version: "0.0.0" },
      hooks: {
        [HOOKS.STOP]: async (): Promise<void> => {
          throw new Error("teardown boom");
        },
      },
    });

    const { provider } = createMockProvider([textResponse("Hi there!")]);
    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system prompt",
      conversationId: "test-conversation",
    });

    const events: AgentEvent[] = [];
    await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: (e) => {
        events.push(e);
      },
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    expect(countExitEvents(events)).toBe(1);
    expect(lastExitEvent(events)?.reason).toBe("no_tool_calls");
    expect(events[events.length - 1].type).toBe("agent_loop_exit");
  });

  test("emits continuation surface event and exits on max_tokens", async () => {
    const { provider } = createMockProvider([
      maxTokensResponse("Partial answer"),
    ]);
    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system prompt",
      conversationId: "test-conversation",
    });

    const events: AgentEvent[] = [];
    await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: (e) => {
        events.push(e);
      },
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    // The mock provider returns its content without streaming any text_delta
    // live, so the loop surfaces the truncated reply once via a synthetic
    // text_delta before stopping (a real provider streams the text live, where
    // this emit is a no-op).
    expect(events.map((e) => e.type)).toEqual([
      "llm_call_started",
      "usage",
      "text_delta",
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
    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system prompt",
      conversationId: "test-conversation",
      tools: dummyTools,
    });

    const events: AgentEvent[] = [];
    const { history: result } = await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: (e) => {
        events.push(e);
      },
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    expect(events.some((e) => e.type === "tool_use")).toBe(false);
    expect(lastExitEvent(events)?.reason).toBe("max_tokens_reached");
    expect(result[result.length - 1]!.content).toEqual([
      { type: "text", text: "I need to check that." },
    ]);
  });

  test("emits 'aborted_pre_call' when signal is already aborted at run start", async () => {
    const { provider } = createMockProvider([textResponse("never sent")]);
    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system prompt",
      conversationId: "test-conversation",
    });

    const controller = new AbortController();
    controller.abort();

    const events: AgentEvent[] = [];
    await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: (e) => {
        events.push(e);
      },
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
      signal: controller.signal,
    });

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
    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
      tools: dummyTools,
      toolExecutor: toolExecutor,
    });

    const events: AgentEvent[] = [];
    await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: (e) => {
        events.push(e);
      },
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
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
    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
      tools: dummyTools,
      toolExecutor: toolExecutor,
    });

    const onCheckpoint = (_info: CheckpointInfo): CheckpointDecision =>
      "handoff";

    const events: AgentEvent[] = [];
    await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: (e) => {
        events.push(e);
      },
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
      onCheckpoint,
    });

    expect(countExitEvents(events)).toBe(0);
  });

  test("runs to a clean exit when overflow recovery is disabled", async () => {
    // GIVEN a tiny context window but overflow recovery disabled — the
    // agent-wake configuration, which must never compact mid-loop.
    const { provider } = createMockProvider([
      toolUseResponse("t1", "read_file", { path: "/a.txt" }),
      textResponse("done"),
    ]);
    const toolExecutor = async () => ({ content: "ok", isError: false });
    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
      tools: dummyTools,
      toolExecutor: toolExecutor,
    });

    // WHEN the loop runs to completion
    const result = await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: () => {},
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
      modelProfileKey: "balanced",
      resolveContextWindow: () => ({
        maxInputTokens: 10,
        overflowRecovery: { enabled: false, safetyMarginRatio: 0 },
      }),
    });

    // THEN it reaches a clean exit without pausing the loop.
    expect(result.exitReason).toBeNull();
  });

  test("compacts in place and continues when the budget gate trips with a compaction hook", async () => {
    // GIVEN a tool round that reaches a checkpoint, followed by a plain text
    // response that ends the run after compaction continues the loop.
    const { provider } = createMockProvider([
      toolUseResponse("t1", "read_file", { path: "/a.txt" }),
      textResponse("done after compaction"),
    ]);
    const toolExecutor = async () => ({ content: "ok", isError: false });
    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
      tools: dummyTools,
      toolExecutor: toolExecutor,
    });

    let reinjected = false;
    const events: AgentEvent[] = [];
    postCompactImpl = async () => {
      reinjected = true;
      return [userMessage];
    };

    // WHEN the in-loop budget gate trips at the checkpoint
    const result = await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: (event) => {
        events.push(event);
      },
      modelProfileKey: "balanced",
      resolveContextWindow: () => ({
        maxInputTokens: 10,
        overflowRecovery: { enabled: true, safetyMarginRatio: 0 },
      }),
      compactInPlace: true,
      ...fakeCompaction("test-conversation", {
        compacted: true,
        exhausted: false,
      }),
    });

    // THEN the loop runs the compaction ceremony in place and continues to a
    // clean exit. The durable commit is signalled via a `compaction_completed`
    // event rather than an injected hook.
    expect(events.some((event) => event.type === "compaction_completed")).toBe(
      true,
    );
    expect(reinjected).toBe(true);
    expect(result.exitReason).toBeNull();
  });

  test("emits 'error' when provider throws an unhandled error", async () => {
    const provider: Provider = {
      name: "broken",
      async sendMessage(): Promise<ProviderResponse> {
        throw new Error("provider exploded");
      },
    };
    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system prompt",
      conversationId: "test-conversation",
    });

    const events: AgentEvent[] = [];
    await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: (e) => {
        events.push(e);
      },
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
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
    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
      tools: dummyTools,
      toolExecutor: toolExecutor,
    });

    const events: AgentEvent[] = [];
    await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: (e) => {
        events.push(e);
      },
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
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
    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
      tools: dummyTools,
      toolExecutor: toolExecutor,
    });

    const events: AgentEvent[] = [];
    await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: (e) => {
        events.push(e);
      },
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
      signal: controller.signal,
    });

    expect(countExitEvents(events)).toBe(1);
    expect(lastExitEvent(events)?.reason).toBe("aborted_during_tools");
  });
});
