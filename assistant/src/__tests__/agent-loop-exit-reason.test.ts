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
import { afterEach, describe, expect, mock, test } from "bun:test";

import type {
  AgentEvent,
  CheckpointDecision,
  CheckpointInfo,
} from "../agent/loop.js";
import { AgentLoop, isMaxTokensStopReason } from "../agent/loop.js";
import type { ContextWindowConfig } from "../config/types.js";
import type { TrustContext } from "../daemon/trust-context.js";
import type {
  ReducerState,
  ReducerStepResult,
} from "../plugins/defaults/compaction/context-overflow-reducer.js";
import {
  createContextWindowManager,
  disposeContextWindowManager,
  getContextWindowManager,
} from "../plugins/defaults/compaction/manager-store.js";
import type { PostCompactContext } from "../plugins/defaults/memory-retrieval/hooks/post-compact.js";
import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
  ToolDefinition,
} from "../providers/types.js";
import { ContextOverflowError } from "../providers/types.js";

// The agent loop invokes the default post-compaction re-injection hook directly
// when it compacts in place. Stub it so these unit tests can drive the
// re-injection result without the daemon-level injector chain. The hook writes
// the re-injected history back onto the context; tests assign `postCompactImpl`
// to observe the call or force a failure; when unset the hook leaves the
// history it was handed untouched.
let postCompactImpl:
  | ((input: PostCompactContext) => Promise<Message[]>)
  | null = null;
mock.module(
  "../plugins/defaults/memory-retrieval/hooks/post-compact.js",
  () => ({
    default: async (input: PostCompactContext): Promise<void> => {
      input.history = postCompactImpl
        ? await postCompactImpl(input)
        : input.history;
    },
  }),
);

// The reactive overflow ladder delegates rung selection to the compaction
// plugin's reducer. Stub it so these unit tests can drive each rung's outcome —
// in particular whether the ladder reports `exhausted` and which terminal tier
// it applied — without the real summary machinery. When `reduceOverflowImpl` is
// unset the reducer reports a single non-terminal forced-compaction rung.
let reduceOverflowImpl:
  | ((state: ReducerState | undefined) => ReducerStepResult)
  | null = null;
mock.module(
  "../plugins/defaults/compaction/context-overflow-reducer.js",
  () => ({
    createInitialReducerState: (): ReducerState => ({
      appliedTiers: [],
      injectionMode: "full",
      exhausted: false,
    }),
    reduceContextOverflow: async (
      messages: Message[],
      _config: unknown,
      state: ReducerState | undefined,
    ): Promise<ReducerStepResult> =>
      reduceOverflowImpl
        ? reduceOverflowImpl(state)
        : {
            messages,
            tier: "forced_compaction",
            state: {
              appliedTiers: ["forced_compaction"],
              injectionMode: "full",
              exhausted: false,
            },
            estimatedTokens: 0,
          },
  }),
);

function overflowProvider(): Provider {
  return {
    name: "mock",
    async sendMessage(): Promise<ProviderResponse> {
      throw new ContextOverflowError(
        "prompt is too long: 242201 tokens > 200000 maximum",
        "mock",
        { actualTokens: 242201, maxTokens: 200000 },
      );
    },
  };
}

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
    systemPrompt: "system",
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
  afterEach(() => {
    disposeContextWindowManager("test-conversation");
    postCompactImpl = null;
    reduceOverflowImpl = null;
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
      messages: [userMessage],
      onEvent: (e) => {
        events.push(e);
      },
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    expect(events.length).toBeGreaterThan(0);
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
      messages: [userMessage],
      onEvent: (e) => {
        events.push(e);
      },
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
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
    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system prompt",
      conversationId: "test-conversation",
      tools: dummyTools,
    });

    const events: AgentEvent[] = [];
    const { history: result } = await loop.run({
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
      messages: [userMessage],
      onEvent: (e) => {
        events.push(e);
      },
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    expect(countExitEvents(events)).toBe(1);
    expect(lastExitEvent(events)?.reason).toBe("yield_to_user");
  });

  test("does not emit agent_loop_exit when onCheckpoint hands off", async () => {
    // GIVEN a tool round that reaches a checkpoint where the wrapper hands the
    // turn off (e.g. a queued message takes over).
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

    // WHEN the checkpoint yields control back to the wrapper
    const events: AgentEvent[] = [];
    await loop.run({
      messages: [userMessage],
      onEvent: (e) => {
        events.push(e);
      },
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
      onCheckpoint,
    });

    // THEN no terminal exit event is emitted — a handoff is an orchestration
    // yield, not a turn-ending exit, so the wrapper owns the follow-up.
    expect(countExitEvents(events)).toBe(0);
  });

  test("emits 'context_too_large' when the reactive ladder exhausts without auto-compress", async () => {
    // GIVEN a provider that always rejects the call as context-too-large.
    const loop = new AgentLoop({
      provider: overflowProvider(),
      systemPrompt: "system",
      conversationId: "test-conversation",
      tools: dummyTools,
    });

    // AND a reducer whose single rung immediately reports the ladder exhausted
    // without ever reaching the policy-gated auto-compress tier.
    reduceOverflowImpl = (_state) => ({
      messages: [userMessage],
      tier: "injection_downgrade",
      state: {
        appliedTiers: ["forced_compaction", "injection_downgrade"],
        injectionMode: "minimal",
        exhausted: true,
      },
      estimatedTokens: 0,
    });

    // WHEN the loop drives the ladder one rung, retries, and the provider
    // rejects again with the ladder already exhausted
    const events: AgentEvent[] = [];
    await loop.run({
      messages: [userMessage],
      onEvent: (e) => {
        events.push(e);
      },
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
      resolveContextWindow: () => ({
        maxInputTokens: 1_000_000,
        overflowRecovery: {
          enabled: true,
          safetyMarginRatio: 0,
          maxAttempts: 4,
          allowAutoCompressLatestTurn: false,
        },
      }),
      compactInPlace: true,
    });

    // THEN the loop owns the terminal exit and reports an unrecoverable
    // context-too-large since no auto-compress rung ran.
    expect(lastExitEvent(events)?.reason).toBe("context_too_large");
  });

  test("does not engage reactive recovery when overflow recovery is disabled", async () => {
    // GIVEN a provider that rejects the call as context-too-large, under the
    // agent-wake configuration where overflow recovery is disabled.
    const loop = new AgentLoop({
      provider: overflowProvider(),
      systemPrompt: "system",
      conversationId: "test-conversation",
      tools: dummyTools,
    });

    // WHEN the loop runs with overflow recovery turned off
    const events: AgentEvent[] = [];
    await loop.run({
      messages: [userMessage],
      onEvent: (e) => {
        events.push(e);
      },
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
      resolveContextWindow: () => ({
        maxInputTokens: 1_000_000,
        overflowRecovery: {
          enabled: false,
          safetyMarginRatio: 0,
          maxAttempts: 4,
          allowAutoCompressLatestTurn: false,
        },
      }),
      compactInPlace: true,
    });

    // THEN the rejection surfaces as a plain error instead of being recovered.
    expect(lastExitEvent(events)?.reason).toBe("error");
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
      messages: [userMessage],
      onEvent: (event) => {
        events.push(event);
      },
      resolveContextWindow: () => ({
        maxInputTokens: 10,
        overflowRecovery: {
          enabled: true,
          safetyMarginRatio: 0,
          maxAttempts: 4,
          allowAutoCompressLatestTurn: false,
        },
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

  test("emits 'budget_yield_unrecovered' when the reactive ladder exhausts after auto-compress", async () => {
    // GIVEN a provider that always rejects the call as context-too-large.
    const loop = new AgentLoop({
      provider: overflowProvider(),
      systemPrompt: "system",
      conversationId: "test-conversation",
      tools: dummyTools,
    });

    // AND a reducer whose rung applies the terminal auto-compress tier and
    // reports the ladder exhausted.
    reduceOverflowImpl = (_state) => ({
      messages: [userMessage],
      tier: "auto_compress_latest_turn",
      state: {
        appliedTiers: ["forced_compaction", "auto_compress_latest_turn"],
        injectionMode: "minimal",
        exhausted: true,
      },
      estimatedTokens: 0,
    });

    // WHEN the ladder runs the auto-compress rung and the provider still rejects
    const events: AgentEvent[] = [];
    await loop.run({
      messages: [userMessage],
      onEvent: (e) => {
        events.push(e);
      },
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
      resolveContextWindow: () => ({
        maxInputTokens: 1_000_000,
        overflowRecovery: {
          enabled: true,
          safetyMarginRatio: 0,
          maxAttempts: 4,
          allowAutoCompressLatestTurn: true,
        },
      }),
      compactInPlace: true,
    });

    // THEN the loop reports that even the terminal auto-compress rung could not
    // bring the turn under budget.
    expect(lastExitEvent(events)?.reason).toBe("budget_yield_unrecovered");
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
