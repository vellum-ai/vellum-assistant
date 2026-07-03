import { beforeEach, describe, expect, test } from "bun:test";

import type {
  AgentEvent,
  CheckpointDecision,
  CheckpointInfo,
} from "../agent/loop.js";
import { AgentLoop } from "../agent/loop.js";
import type { StopContext } from "../plugin-api/types.js";
import { REFUSAL_FALLBACK_TEXT } from "../plugins/defaults/empty-response/hooks/post-model-call.js";
import { resetPluginRegistryAndRegisterDefaults } from "../plugins/defaults/index.js";
import { registerPlugin } from "../plugins/registry.js";
import type {
  ContentBlock,
  Message,
  Provider,
  ProviderResponse,
  ToolDefinition,
} from "../providers/types.js";
import { ContextOverflowError } from "../providers/types.js";
import {
  createMockProvider,
  textResponse,
  toolUseResponse,
} from "./helpers/mock-provider.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function collectEvents(events: AgentEvent[]): (event: AgentEvent) => void {
  return (event) => events.push(event);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AgentLoop", () => {
  // The agent loop fires the `post-tool-use` hook for tool-result
  // truncation, which only runs when the default plugin is registered.
  // Register the defaults so the loop behaves as it does in production.
  beforeEach(() => {
    resetPluginRegistryAndRegisterDefaults();
  });

  // 1. Basic text response
  test("returns history with assistant message for simple text response", async () => {
    const { provider } = createMockProvider([textResponse("Hi there!")]);
    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system prompt",
      conversationId: "test-conversation",
    });

    const events: AgentEvent[] = [];
    const { history } = await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: collectEvents(events),
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    // History should contain original user message + assistant response
    expect(history).toHaveLength(2);
    expect(history[0]).toEqual(userMessage);
    expect(history[1].role).toBe("assistant");
    expect(history[1].content).toEqual([{ type: "text", text: "Hi there!" }]);
  });

  // 2. Tool execution — provider returns tool_use, verify tool executor is called
  test("executes tool and passes result back to provider", async () => {
    const toolCallId = "tool-1";
    const { provider, calls } = createMockProvider([
      toolUseResponse(toolCallId, "read_file", { path: "/tmp/test.txt" }),
      textResponse("File contents received."),
    ]);

    const toolCalls: { name: string; input: Record<string, unknown> }[] = [];
    const toolExecutor = async (
      name: string,
      input: Record<string, unknown>,
    ) => {
      toolCalls.push({ name, input });
      return { content: "file data here", isError: false };
    };

    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
      tools: dummyTools,
      toolExecutor: toolExecutor,
    });
    const events: AgentEvent[] = [];
    const { history } = await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: collectEvents(events),
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    // Tool executor was called with correct args
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe("read_file");
    expect(toolCalls[0].input).toEqual({ path: "/tmp/test.txt" });

    // Provider was called twice (initial + after tool result)
    expect(calls).toHaveLength(2);

    // Second call should include the tool result as a user message
    const secondCallMessages = calls[1].messages;
    const lastMsg = secondCallMessages[secondCallMessages.length - 1];
    expect(lastMsg.role).toBe("user");

    const toolResultBlock = lastMsg.content.find(
      (b): b is Extract<ContentBlock, { type: "tool_result" }> =>
        b.type === "tool_result",
    );
    expect(toolResultBlock).toBeDefined();
    expect(toolResultBlock!.tool_use_id).toBe(toolCallId);
    expect(toolResultBlock!.content).toBe("file data here");
    expect(toolResultBlock!.is_error).toBe(false);

    // Final history: user, assistant(tool_use), user(tool_result), assistant(text)
    expect(history).toHaveLength(4);
    expect(history[3].role).toBe("assistant");
    expect(history[3].content).toEqual([
      { type: "text", text: "File contents received." },
    ]);
  });

  test("re-resolves override profile before each provider call", async () => {
    const toolCallId = "tool-1";
    const { provider, calls } = createMockProvider([
      toolUseResponse(toolCallId, "read_file", { path: "/tmp/test.txt" }),
      textResponse("File contents received."),
    ]);

    let overrideProfile: string | undefined;
    const toolExecutor = async () => {
      overrideProfile = "quality-optimized";
      return { content: "ok", isError: false };
    };
    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
      tools: dummyTools,
      toolExecutor: toolExecutor,
    });

    await loop.run({
      messages: [userMessage],
      onEvent: collectEvents([]),
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
      requestId: "req-1",
      callSite: "mainAgent",
      resolveOverrideProfile: () => overrideProfile,
    });

    expect(calls).toHaveLength(2);
    expect(calls[0].options?.config?.overrideProfile).toBeUndefined();
    expect(calls[1].options?.config?.overrideProfile).toBe("quality-optimized");
  });

  test("re-resolves max input tokens before truncating tool results", async () => {
    const toolCallId = "tool-1";
    const toolOutput = "x".repeat(2_500);
    const { provider, calls } = createMockProvider([
      toolUseResponse(toolCallId, "read_file", { path: "/tmp/test.txt" }),
      textResponse("File contents received."),
    ]);

    let maxInputTokens = 1_000;
    const toolExecutor = async () => {
      maxInputTokens = 10_000;
      return { content: toolOutput, isError: false };
    };
    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
      tools: dummyTools,
      toolExecutor: toolExecutor,
    });

    await loop.run({
      messages: [userMessage],
      onEvent: collectEvents([]),
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
      requestId: "req-1",
      callSite: "mainAgent",
      modelProfileKey: "balanced",
      resolveContextWindow: () => ({
        maxInputTokens,
        overflowRecovery: { enabled: false, safetyMarginRatio: 0 },
      }),
    });

    const secondCallMessages = calls[1].messages;
    const lastMsg = secondCallMessages[secondCallMessages.length - 1];
    const toolResultBlock = lastMsg.content.find(
      (b): b is Extract<ContentBlock, { type: "tool_result" }> =>
        b.type === "tool_result",
    );
    expect(toolResultBlock?.content).toBe(toolOutput);
  });

  // 3. Multi-turn tool loop
  test("supports multi-turn tool execution", async () => {
    const { provider, calls } = createMockProvider([
      toolUseResponse("t1", "read_file", { path: "/a.txt" }),
      toolUseResponse("t2", "read_file", { path: "/b.txt" }),
      textResponse("Done reading both files."),
    ]);

    const toolExecutor = async (
      name: string,
      input: Record<string, unknown>,
    ) => {
      return {
        content: `contents of ${(input as { path: string }).path}`,
        isError: false,
      };
    };

    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
      tools: dummyTools,
      toolExecutor: toolExecutor,
    });
    const { history } = await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: () => {},
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    // Provider called 3 times (two tool rounds + final text)
    expect(calls).toHaveLength(3);

    // History: user, assistant(t1), user(result1), assistant(t2), user(result2), assistant(text)
    expect(history).toHaveLength(6);
    expect(history[5].content).toEqual([
      { type: "text", text: "Done reading both files." },
    ]);
  });

  // 4. Loop stops when provider returns tool_use but no executor is configured
  test("stops when tool_use returned but no tool executor configured", async () => {
    const { provider } = createMockProvider([
      toolUseResponse("t1", "read_file", { path: "/a.txt" }),
    ]);

    // No tool executor provided
    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
      tools: dummyTools,
    });
    const { history } = await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: () => {},
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    // Should stop after first response (no executor to handle tool use)
    expect(history).toHaveLength(2);
    expect(history[1].role).toBe("assistant");
  });

  // 5. Error handling — provider throws, verify error event and loop stops
  test("emits error event and stops when provider throws", async () => {
    const error = new Error("API rate limit exceeded");
    const provider: Provider = {
      name: "mock",
      async sendMessage(): Promise<ProviderResponse> {
        throw error;
      },
    };

    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
    });
    const events: AgentEvent[] = [];
    const { history } = await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: collectEvents(events),
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    // Only the original message remains (no assistant message added on error)
    expect(history).toHaveLength(1);

    // Error event was emitted
    const errorEvents = events.filter((e) => e.type === "error");
    expect(errorEvents).toHaveLength(1);
    expect(
      (errorEvents[0] as { type: "error"; error: Error }).error.message,
    ).toBe("API rate limit exceeded");
  });

  // 5b. Reactive context-overflow recovery
  //
  // When recovery is enabled the loop calibrates the estimator from the
  // rejection, loops back, and the budget gate forwards the overflow signal
  // into the compaction plugin's reduction ladder. That manager-owned path —
  // single-rung recovery, multi-rung escalation, and the terminal
  // `context_too_large` / `budget_yield_unrecovered` exit on exhaustion — is
  // exercised end-to-end against a manager harness in
  // `conversation-agent-loop-overflow.test.ts`. Loop-level coverage against a
  // manager-store stub lands with the suite migration.
  test.todo(
    "drives the reduction ladder on a context-overflow rejection",
    () => {},
  );

  test("surfaces a context-overflow error when recovery is unavailable", async () => {
    /**
     * Overflow recovery is gated on the budget gate being active. When it is
     * disabled (e.g. agent wakes pass `overflowRecovery.enabled = false`, or no
     * context window resolves) there is no ladder to drive, so a context
     * overflow surfaces as an error on the first call rather than looping.
     */

    // GIVEN a provider that rejects every call as too large and a loop with no
    // overflow-recovery budget gate
    const { provider, calls } = createMockProvider([
      new ContextOverflowError("prompt is too long", "mock", {
        actualTokens: 250_000,
      }),
    ]);
    const loop = new AgentLoop({
      provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
    });
    const events: AgentEvent[] = [];

    // WHEN the loop runs
    await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: collectEvents(events),
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    // THEN it surfaced the error on the first call without retrying
    expect(calls).toHaveLength(1);
    expect(events.filter((e) => e.type === "error")).toHaveLength(1);
  });

  // 5c. Reactive ordering-error recovery
  //
  // When the provider rejects a call because the history violates
  // tool-use/tool-result pairing or role-alternation rules, the loop runs
  // `deepRepairHistory` directly and re-issues the call. It is bounded to a
  // single repair pass per provider call, so a second consecutive ordering
  // rejection falls through to the error path instead of looping forever.
  test("repairs the history and re-issues on a provider ordering rejection", async () => {
    // GIVEN a provider that rejects the first call with an ordering error and
    // succeeds on the retry
    const { provider, calls } = createMockProvider([
      new Error(
        "tool_result blocks that are not immediately after a tool_use block",
      ),
      textResponse("recovered"),
    ]);
    const loop = new AgentLoop({
      provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
    });
    const events: AgentEvent[] = [];

    // WHEN the loop runs
    const { history } = await loop.run({
      messages: [userMessage],
      onEvent: collectEvents(events),
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
      requestId: "test-request",
    });

    // THEN it re-issued the call after repairing, surfaced no error, and
    // appended the recovered assistant response
    expect(calls).toHaveLength(2);
    expect(events.filter((e) => e.type === "error")).toHaveLength(0);
    expect(history[history.length - 1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "recovered" }],
    });
  });

  test("surfaces an ordering error after a single repair fails to recover", async () => {
    // GIVEN a provider that rejects every call with an ordering error
    const { provider, calls } = createMockProvider([
      new Error("tool_use_id provided without a matching tool_result"),
    ]);
    const loop = new AgentLoop({
      provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
    });
    const events: AgentEvent[] = [];

    // WHEN the loop runs
    await loop.run({
      messages: [userMessage],
      onEvent: collectEvents(events),
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
      requestId: "test-request",
    });

    // THEN it repaired once, re-issued once, then surfaced the error rather
    // than retrying again
    expect(calls).toHaveLength(2);
    expect(events.filter((e) => e.type === "error")).toHaveLength(1);
  });

  test("reports only the retry's output as new messages when deep-repair shrinks the base", async () => {
    // The wrapper reconstructs the persisted transcript from the loop's
    // `newMessages` tail, so after `deepRepairHistory` removes a base message
    // the new-message boundary must track the re-normalized history — otherwise
    // the recovered assistant response is sliced off and lost.

    // GIVEN an input whose leading assistant message deep-repair strips, a
    // provider that rejects the first call on ordering grounds, then succeeds
    const leadingAssistantMessage: Message = {
      role: "assistant",
      content: [{ type: "text", text: "stale leading turn" }],
    };
    const { provider } = createMockProvider([
      new Error(
        "tool_result blocks that are not immediately after a tool_use block",
      ),
      textResponse("recovered"),
    ]);
    const loop = new AgentLoop({
      provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
    });

    // WHEN the loop runs
    const { history, newMessages } = await loop.run({
      messages: [leadingAssistantMessage, userMessage],
      onEvent: () => {},
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
      requestId: "test-request",
    });

    // THEN deep-repair dropped the leading assistant from the base, and
    // `newMessages` is exactly the retry's appended response
    expect(history).toEqual([
      userMessage,
      { role: "assistant", content: [{ type: "text", text: "recovered" }] },
    ]);
    expect(newMessages).toEqual([
      { role: "assistant", content: [{ type: "text", text: "recovered" }] },
    ]);
  });

  test("repairs a fresh ordering rejection on a later run after a prior run left the bound spent", async () => {
    // The ordering-repair bound is owned by the history-repair plugin's
    // per-conversation state. A run scopes that bound, so the loop clears it on
    // entry — otherwise a direct `run` caller that bypasses the daemon
    // orchestrator (e.g. an agent wake) inherits a spent bound from a prior run
    // on the same conversation and surfaces a repairable rejection instead of
    // repairing it.

    // GIVEN a first run that rejects on ordering grounds, repairs once, then
    // rejects again — ending with the bound spent and the error surfaced
    const { provider: firstProvider, calls: firstCalls } = createMockProvider([
      new Error("tool_use_id provided without a matching tool_result"),
      new Error("tool_use_id provided without a matching tool_result"),
    ]);
    const conversationId = "ordering-bound-across-runs";
    const firstLoop = new AgentLoop({
      provider: firstProvider,
      systemPrompt: "system",
      conversationId,
    });
    const firstEvents: AgentEvent[] = [];
    await firstLoop.run({
      messages: [userMessage],
      onEvent: collectEvents(firstEvents),
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
      requestId: "test-request",
    });
    expect(firstCalls).toHaveLength(2);
    expect(firstEvents.filter((e) => e.type === "error")).toHaveLength(1);

    // AND a second run on the same conversation whose first call rejects on
    // ordering grounds, then succeeds on the retry
    const { provider: secondProvider, calls: secondCalls } = createMockProvider(
      [
        new Error(
          "tool_result blocks that are not immediately after a tool_use block",
        ),
        textResponse("recovered"),
      ],
    );
    const secondLoop = new AgentLoop({
      provider: secondProvider,
      systemPrompt: "system",
      conversationId,
    });
    const secondEvents: AgentEvent[] = [];

    // WHEN the second run executes
    const { history } = await secondLoop.run({
      messages: [userMessage],
      onEvent: collectEvents(secondEvents),
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
      requestId: "test-request",
    });

    // THEN it repaired and re-issued (the bound did not leak across runs),
    // surfaced no error, and appended the recovered response
    expect(secondCalls).toHaveLength(2);
    expect(secondEvents.filter((e) => e.type === "error")).toHaveLength(0);
    expect(history[history.length - 1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "recovered" }],
    });
  });

  test("isolates a throwing stop hook on a successful stop and still emits the terminal exit", async () => {
    // The `stop` chain is the loop's terminal teardown: a throwing teardown
    // hook (e.g. a third-party plugin) is logged and contained, never escalated
    // into a turn error. The turn's real outcome stands — a successful no-tool
    // stop — and the terminal `agent_loop_exit` still fires so the run stays
    // observable.

    // GIVEN a registered stop hook that always throws, and a provider that
    // returns a successful no-tool response (a successful stop)
    registerPlugin({
      manifest: { name: "throwing-stop", version: "0.0.1" },
      hooks: {
        stop: async () => {
          throw new Error("stop hook boom");
        },
      },
    });
    const { provider, calls } = createMockProvider([textResponse("done")]);
    const loop = new AgentLoop({
      provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
    });
    const events: AgentEvent[] = [];

    // WHEN the loop runs
    let rejected = false;
    await loop
      .run({
        messages: [userMessage],
        onEvent: collectEvents(events),
        trust: { sourceChannel: "vellum", trustClass: "unknown" },
        requestId: "test-request",
      })
      .catch(() => {
        rejected = true;
      });

    // THEN the loop did not reject, did not re-issue the call, surfaced no
    // error event, and still emitted the terminal exit with the real reason
    expect(rejected).toBe(false);
    expect(calls).toHaveLength(1);
    expect(events.filter((e) => e.type === "error")).toHaveLength(0);
    const exitEvents = events.filter((e) => e.type === "agent_loop_exit");
    expect(exitEvents).toHaveLength(1);
    expect(exitEvents[0]).toMatchObject({ reason: "no_tool_calls" });
  });

  test("fires the stop teardown chain on a checkpoint handoff without emitting agent_loop_exit", async () => {
    // A handoff pauses this run so the orchestrator can drain a queued message,
    // then re-enters with a fresh run. It still ends *this* turn, so the
    // terminal `stop` chain must fire — that is what runs per-turn teardown
    // (e.g. clearing the recovery bounds the post-model-call hooks set) before
    // the queued message is processed. But `agent_loop_exit` must NOT be
    // emitted, because the handoff is a control transfer, not a terminal exit.

    // GIVEN a stop hook recording every exit reason it observes, and a provider
    // whose first reply requests a tool so the loop reaches a checkpoint
    const stopReasons: string[] = [];
    registerPlugin({
      manifest: { name: "recording-stop", version: "0.0.1" },
      hooks: {
        stop: async (ctx: StopContext) => {
          stopReasons.push(ctx.exitReason);
        },
      },
    });
    const { provider } = createMockProvider([
      toolUseResponse("t1", "read_file", { path: "/a.txt" }),
      textResponse("never reached"),
    ]);
    const toolExecutor = async () => ({ content: "ok", isError: false });
    const loop = new AgentLoop({
      provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
      tools: dummyTools,
      toolExecutor,
    });
    const events: AgentEvent[] = [];

    // AND a checkpoint callback that hands off at the first opportunity
    const onCheckpoint = (_info: CheckpointInfo): CheckpointDecision =>
      "handoff";

    // WHEN the loop runs and yields control at the checkpoint
    const { exitReason } = await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: collectEvents(events),
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
      onCheckpoint,
    });

    // THEN the terminal stop chain fired exactly once with the handoff reason
    // (teardown ran), the run reported the handoff, and no agent_loop_exit was
    // emitted
    expect(stopReasons).toEqual(["checkpoint_handoff"]);
    expect(exitReason).toBe("handoff");
    expect(events.filter((e) => e.type === "agent_loop_exit")).toHaveLength(0);
  });

  // 6. Abort signal — verify the loop respects AbortSignal
  test("stops when abort signal is triggered before provider call", async () => {
    const controller = new AbortController();
    controller.abort(); // abort immediately

    const { provider } = createMockProvider([textResponse("Should not reach")]);
    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
    });
    const { history } = await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: () => {},
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
      signal: controller.signal,
    });

    // Loop should exit immediately, returning only original messages
    expect(history).toHaveLength(1);
  });

  test("stops when abort signal is triggered between turns", async () => {
    const controller = new AbortController();
    let turnCount = 0;

    const { provider } = createMockProvider([
      toolUseResponse("t1", "read_file", { path: "/a.txt" }),
      toolUseResponse("t2", "read_file", { path: "/b.txt" }),
      textResponse("Should not reach"),
    ]);

    const toolExecutor = async () => {
      turnCount++;
      if (turnCount === 1) {
        // Abort after the first tool turn completes
        controller.abort();
      }
      return { content: "data", isError: false };
    };

    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
      tools: dummyTools,
      toolExecutor: toolExecutor,
    });
    const { history } = await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: () => {},
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
      signal: controller.signal,
    });

    // After the first tool turn, abort fires. The while loop checks signal at the
    // top and breaks. History: user, assistant(t1), user(result1)
    // The second provider call may or may not happen depending on when the abort
    // check triggers, but the loop should eventually stop.
    // At minimum, verify it doesn't run all 3 provider calls.
    expect(history.length).toBeLessThanOrEqual(4);

    // Verify the loop didn't reach the final text response
    const lastAssistant = [...history]
      .reverse()
      .find((m) => m.role === "assistant");
    expect(lastAssistant).toBeDefined();
    const hasToolUse = lastAssistant!.content.some(
      (b) => b.type === "tool_use",
    );
    // The last assistant message should be a tool_use, not the final text
    expect(hasToolUse).toBe(true);
  });

  // 6b. Abort signal during long-running tool execution — loop exits immediately
  test("stops immediately when abort fires during a stuck tool execution", async () => {
    const controller = new AbortController();

    const { provider } = createMockProvider([
      toolUseResponse("t1", "read_file", { path: "/stuck.txt" }),
      textResponse("Should not reach"),
    ]);

    // Simulate a stuck tool that never resolves — abort fires while it's running
    const toolExecutor = async () => {
      // Abort from a timer while this tool is "stuck"
      setTimeout(() => controller.abort(), 50);
      // Simulate being stuck for a long time — must be well above the
      // assertion threshold (2000ms) so the test catches abort regressions
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      return { content: "should never return", isError: false };
    };

    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
      tools: dummyTools,
      toolExecutor: toolExecutor,
    });
    const start = Date.now();
    const { history } = await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: () => {},
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
      signal: controller.signal,
    });
    const elapsed = Date.now() - start;

    // The loop should exit quickly (~50ms for abort), not wait 10s for the tool
    expect(elapsed).toBeLessThan(2000);

    // User message + assistant tool_use + synthesized cancellation tool_result
    expect(history).toHaveLength(3);
    const lastMsg = history[2];
    expect(lastMsg.role).toBe("user");
    expect(lastMsg.content).toHaveLength(1);
    expect(lastMsg.content[0].type).toBe("tool_result");
    expect(
      (
        lastMsg.content[0] as {
          type: "tool_result";
          tool_use_id: string;
          content: string;
          is_error: boolean;
        }
      ).content,
    ).toBe("Cancelled by user");
    expect(
      (
        lastMsg.content[0] as {
          type: "tool_result";
          tool_use_id: string;
          content: string;
          is_error: boolean;
        }
      ).is_error,
    ).toBe(true);
  });

  // 7. Events — verify text_delta and other events are emitted
  test("emits text_delta events during streaming", async () => {
    const { provider } = createMockProvider([textResponse("Hello world")]);
    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
    });

    const events: AgentEvent[] = [];
    await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: collectEvents(events),
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    const textDeltas = events.filter((e) => e.type === "text_delta");
    expect(textDeltas).toHaveLength(1);
    expect((textDeltas[0] as { type: "text_delta"; text: string }).text).toBe(
      "Hello world",
    );
  });

  test("emits usage events", async () => {
    const { provider } = createMockProvider([textResponse("Hi")]);
    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
    });

    const events: AgentEvent[] = [];
    await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: collectEvents(events),
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    const usageEvents = events.filter((e) => e.type === "usage");
    expect(usageEvents).toHaveLength(1);
    const usage = usageEvents[0] as Extract<AgentEvent, { type: "usage" }>;
    expect(usage.type).toBe("usage");
    expect(usage.inputTokens).toBe(10);
    expect(usage.outputTokens).toBe(5);
    expect(usage.model).toBe("mock-model");
    expect(typeof usage.providerDurationMs).toBe("number");
    expect(usage.providerDurationMs).toBeGreaterThanOrEqual(0);
  });

  test("emits message_complete events", async () => {
    const { provider } = createMockProvider([textResponse("Done")]);
    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
    });

    const events: AgentEvent[] = [];
    await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: collectEvents(events),
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    const completeEvents = events.filter((e) => e.type === "message_complete");
    expect(completeEvents).toHaveLength(1);
    expect(
      (completeEvents[0] as { type: "message_complete"; message: Message })
        .message.role,
    ).toBe("assistant");
  });

  test("emits tool_use and tool_result events during tool execution", async () => {
    const { provider } = createMockProvider([
      toolUseResponse("t1", "read_file", { path: "/test.txt" }),
      textResponse("Done"),
    ]);

    const toolExecutor = async () => ({ content: "file data", isError: false });
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
      onEvent: collectEvents(events),
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    const toolUseEvents = events.filter((e) => e.type === "tool_use");
    expect(toolUseEvents).toHaveLength(1);
    expect(toolUseEvents[0]).toEqual({
      type: "tool_use",
      id: "t1",
      name: "read_file",
      input: { path: "/test.txt" },
    });

    const toolResultEvents = events.filter((e) => e.type === "tool_result");
    expect(toolResultEvents).toHaveLength(1);
    expect(
      (toolResultEvents[0] as Extract<AgentEvent, { type: "tool_result" }>)
        .toolUseId,
    ).toBe("t1");
    expect(
      (toolResultEvents[0] as Extract<AgentEvent, { type: "tool_result" }>)
        .content,
    ).toBe("file data");
    expect(
      (toolResultEvents[0] as Extract<AgentEvent, { type: "tool_result" }>)
        .isError,
    ).toBe(false);
  });

  // 9. Tool executor error results are forwarded correctly
  test("forwards tool error results to provider", async () => {
    const { provider, calls } = createMockProvider([
      toolUseResponse("t1", "read_file", { path: "/nonexistent.txt" }),
      textResponse("File not found, sorry."),
    ]);

    const toolExecutor = async () => ({
      content: "ENOENT: file not found",
      isError: true,
    });
    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
      tools: dummyTools,
      toolExecutor: toolExecutor,
    });

    await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: () => {},
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    const secondCallMessages = calls[1].messages;
    const lastMsg = secondCallMessages[secondCallMessages.length - 1];
    const toolResultBlock = lastMsg.content.find(
      (b): b is Extract<ContentBlock, { type: "tool_result" }> =>
        b.type === "tool_result",
    );
    expect(toolResultBlock).toBeDefined();
    expect(toolResultBlock!.is_error).toBe(true);
    expect(toolResultBlock!.content).toBe("ENOENT: file not found");
  });

  // 10. Tool output chunks are forwarded via onEvent
  test("emits tool_output_chunk events during tool execution", async () => {
    const { provider } = createMockProvider([
      toolUseResponse("t1", "read_file", { path: "/test.txt" }),
      textResponse("Done"),
    ]);

    const toolExecutor = async (
      _name: string,
      _input: Record<string, unknown>,
      onOutput?: (chunk: string) => void,
    ) => {
      onOutput?.("chunk1");
      onOutput?.("chunk2");
      return { content: "full output", isError: false };
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
      onEvent: collectEvents(events),
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    const chunkEvents = events.filter((e) => e.type === "tool_output_chunk");
    expect(chunkEvents).toHaveLength(2);
    expect(
      (chunkEvents[0] as Extract<AgentEvent, { type: "tool_output_chunk" }>)
        .chunk,
    ).toBe("chunk1");
    expect(
      (chunkEvents[1] as Extract<AgentEvent, { type: "tool_output_chunk" }>)
        .chunk,
    ).toBe("chunk2");
  });

  // 11. System prompt and tools are passed to provider
  test("passes system prompt and tools to provider", async () => {
    const { provider, calls } = createMockProvider([textResponse("Hi")]);
    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "My system prompt",
      conversationId: "test-conversation",
      tools: dummyTools,
    });

    await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: () => {},
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    expect(calls[0].systemPrompt).toBe("My system prompt");
    expect(calls[0].tools).toEqual(dummyTools);
  });

  // 12. No tools configured — tools are not passed to provider
  test("does not pass tools to provider when none are configured", async () => {
    const { provider, calls } = createMockProvider([textResponse("Hi")]);
    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
    });

    await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: () => {},
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    expect(calls[0].tools).toBeUndefined();
  });

  // 13. Parallel tool execution — multiple tool_use blocks in a single response
  test("executes multiple tools in parallel", async () => {
    const { provider, calls } = createMockProvider([
      // Provider returns 3 tool_use blocks in a single response
      {
        content: [
          {
            type: "tool_use" as const,
            id: "t1",
            name: "read_file",
            input: { path: "/a.txt" },
          },
          {
            type: "tool_use" as const,
            id: "t2",
            name: "read_file",
            input: { path: "/b.txt" },
          },
          {
            type: "tool_use" as const,
            id: "t3",
            name: "read_file",
            input: { path: "/c.txt" },
          },
        ],
        model: "mock-model",
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: "tool_use" as const,
      },
      textResponse("Got all three files."),
    ]);

    const executionLog: { path: string; start: number; end: number }[] = [];
    const toolExecutor = async (
      _name: string,
      input: Record<string, unknown>,
    ) => {
      const start = Date.now();
      // Simulate async work — all tools should overlap in time
      await new Promise((resolve) => setTimeout(resolve, 50));
      const end = Date.now();
      executionLog.push({ path: (input as { path: string }).path, start, end });
      return {
        content: `contents of ${(input as { path: string }).path}`,
        isError: false,
      };
    };

    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
      tools: dummyTools,
      toolExecutor: toolExecutor,
    });
    const events: AgentEvent[] = [];
    const { history } = await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: collectEvents(events),
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    // All 3 tools should have been called
    expect(executionLog).toHaveLength(3);

    // Verify parallel execution: all tools should start before any finishes
    // (with 50ms delay each, sequential would take 150ms+, parallel ~50ms)
    const allStarts = executionLog.map((e) => e.start);
    const allEnds = executionLog.map((e) => e.end);
    const firstEnd = Math.min(...allEnds);
    const lastStart = Math.max(...allStarts);
    // In parallel execution, the last tool starts before the first tool ends
    expect(lastStart).toBeLessThanOrEqual(firstEnd);

    // Provider should have been called twice (tool batch + final text)
    expect(calls).toHaveLength(2);

    // Second call should contain 3 tool_result blocks in order
    const secondCallMessages = calls[1].messages;
    const lastMsg = secondCallMessages[secondCallMessages.length - 1];
    const toolResultBlocks = lastMsg.content.filter(
      (b): b is Extract<ContentBlock, { type: "tool_result" }> =>
        b.type === "tool_result",
    );
    expect(toolResultBlocks).toHaveLength(3);
    expect(toolResultBlocks[0].tool_use_id).toBe("t1");
    expect(toolResultBlocks[1].tool_use_id).toBe("t2");
    expect(toolResultBlocks[2].tool_use_id).toBe("t3");

    // All tool_use events should be emitted before any tool_result events
    let lastToolUseIdx = -1;
    let firstToolResultIdx = events.length;
    events.forEach((e, i) => {
      if (e.type === "tool_use") lastToolUseIdx = i;
      if (e.type === "tool_result" && i < firstToolResultIdx)
        firstToolResultIdx = i;
    });
    expect(lastToolUseIdx).toBeLessThan(firstToolResultIdx);

    // Final history: user, assistant(3 tool_use), user(3 tool_result), assistant(text)
    expect(history).toHaveLength(4);
  });

  // 14. Abort before parallel tool execution synthesizes cancelled results
  test("synthesizes cancelled results when aborted before tool execution", async () => {
    const controller = new AbortController();

    const { provider } = createMockProvider([
      {
        content: [
          {
            type: "tool_use" as const,
            id: "t1",
            name: "read_file",
            input: { path: "/a.txt" },
          },
          {
            type: "tool_use" as const,
            id: "t2",
            name: "read_file",
            input: { path: "/b.txt" },
          },
        ],
        model: "mock-model",
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: "tool_use" as const,
      },
    ]);

    // Abort during the provider call so the signal is already aborted
    // before tool execution begins
    const originalSendMessage = provider.sendMessage.bind(provider);
    provider.sendMessage = async (
      ...args: Parameters<typeof provider.sendMessage>
    ) => {
      const result = await originalSendMessage(...args);
      controller.abort();
      return result;
    };

    const toolCalls: string[] = [];
    const toolExecutor = async (
      _name: string,
      input: Record<string, unknown>,
    ) => {
      toolCalls.push((input as { path: string }).path);
      return { content: "data", isError: false };
    };

    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
      tools: dummyTools,
      toolExecutor: toolExecutor,
    });
    const events: AgentEvent[] = [];
    const { history } = await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: collectEvents(events),
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
      signal: controller.signal,
    });

    // No tools should have been executed
    expect(toolCalls).toHaveLength(0);

    // History should contain cancelled tool_result blocks
    const lastMsg = history[history.length - 1];
    expect(lastMsg.role).toBe("user");
    const toolResultBlocks = lastMsg.content.filter(
      (b): b is Extract<ContentBlock, { type: "tool_result" }> =>
        b.type === "tool_result",
    );
    expect(toolResultBlocks).toHaveLength(2);
    expect(toolResultBlocks[0].tool_use_id).toBe("t1");
    expect(toolResultBlocks[0].content).toBe("Cancelled by user");
    expect(toolResultBlocks[0].is_error).toBe(true);
    expect(toolResultBlocks[1].tool_use_id).toBe("t2");
    expect(toolResultBlocks[1].content).toBe("Cancelled by user");
    expect(toolResultBlocks[1].is_error).toBe(true);
  });

  // 15. Parallel tool_result events are emitted in deterministic tool_use order
  test("emits tool_result events in tool_use order regardless of completion timing", async () => {
    const { provider } = createMockProvider([
      {
        content: [
          {
            type: "tool_use" as const,
            id: "t1",
            name: "read_file",
            input: { path: "/slow.txt" },
          },
          {
            type: "tool_use" as const,
            id: "t2",
            name: "read_file",
            input: { path: "/fast.txt" },
          },
          {
            type: "tool_use" as const,
            id: "t3",
            name: "read_file",
            input: { path: "/medium.txt" },
          },
        ],
        model: "mock-model",
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: "tool_use" as const,
      },
      textResponse("Done"),
    ]);

    // Tools complete in different order than they were called: t2 first, t3 second, t1 last
    const toolExecutor = async (
      _name: string,
      input: Record<string, unknown>,
    ) => {
      const path = (input as { path: string }).path;
      const delays: Record<string, number> = {
        "/slow.txt": 80,
        "/fast.txt": 10,
        "/medium.txt": 40,
      };
      await new Promise((resolve) => setTimeout(resolve, delays[path] ?? 10));
      return { content: `contents of ${path}`, isError: false };
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
      onEvent: collectEvents(events),
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    // Collect tool_result events in order
    const toolResultEvents = events.filter(
      (e): e is Extract<AgentEvent, { type: "tool_result" }> =>
        e.type === "tool_result",
    );
    expect(toolResultEvents).toHaveLength(3);

    // Results must be in tool_use order (t1, t2, t3), NOT completion order (t2, t3, t1)
    expect(toolResultEvents[0].toolUseId).toBe("t1");
    expect(toolResultEvents[1].toolUseId).toBe("t2");
    expect(toolResultEvents[2].toolUseId).toBe("t3");
  });

  // ---------------------------------------------------------------------------
  // Checkpoint callback tests
  // ---------------------------------------------------------------------------

  // 16. Checkpoint callback is called after tool results with correct info
  test("checkpoint callback is called after tool results with correct info", async () => {
    const { provider } = createMockProvider([
      toolUseResponse("t1", "read_file", { path: "/test.txt" }),
      textResponse("Done"),
    ]);

    const toolExecutor = async () => ({ content: "file data", isError: false });
    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
      tools: dummyTools,
      toolExecutor: toolExecutor,
    });

    const checkpoints: CheckpointInfo[] = [];
    const onCheckpoint = (checkpoint: CheckpointInfo): CheckpointDecision => {
      checkpoints.push(checkpoint);
      return "continue";
    };

    await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: () => {},
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
      onCheckpoint,
    });

    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({
      turnIndex: 0,
      toolCount: 1,
      hasToolUse: true,
    });
    // history should contain the full conversation at checkpoint time
    expect(checkpoints[0].history.length).toBeGreaterThanOrEqual(3);
  });

  // 17. Returning 'continue' lets the loop proceed normally
  test("checkpoint returning continue lets the loop proceed normally", async () => {
    const { provider, calls } = createMockProvider([
      toolUseResponse("t1", "read_file", { path: "/a.txt" }),
      toolUseResponse("t2", "read_file", { path: "/b.txt" }),
      textResponse("All done"),
    ]);

    const toolExecutor = async () => ({ content: "data", isError: false });
    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
      tools: dummyTools,
      toolExecutor: toolExecutor,
    });

    const onCheckpoint = (): CheckpointDecision => "continue";

    const { history } = await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: () => {},
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
      onCheckpoint,
    });

    // All 3 provider calls should happen (2 tool turns + final text)
    expect(calls).toHaveLength(3);
    // Full history: user, assistant(t1), user(result1), assistant(t2), user(result2), assistant(text)
    expect(history).toHaveLength(6);
    expect(history[5].content).toEqual([{ type: "text", text: "All done" }]);
  });

  // 18. Returning 'yield' causes the loop to stop after that turn
  test("checkpoint returning yield causes the loop to stop", async () => {
    const { provider, calls } = createMockProvider([
      toolUseResponse("t1", "read_file", { path: "/a.txt" }),
      toolUseResponse("t2", "read_file", { path: "/b.txt" }),
      textResponse("Should not reach"),
    ]);

    const toolExecutor = async () => ({ content: "data", isError: false });
    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
      tools: dummyTools,
      toolExecutor: toolExecutor,
    });

    const onCheckpoint = (): CheckpointDecision => "handoff";

    const { history } = await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: () => {},
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
      onCheckpoint,
    });

    // Only 1 provider call should happen — loop yields after first tool turn
    expect(calls).toHaveLength(1);
    // History: user, assistant(t1), user(result1)
    expect(history).toHaveLength(3);
    expect(history[1].role).toBe("assistant");
    expect(history[2].role).toBe("user");
  });

  // 19. Without a checkpoint callback, behavior is unchanged
  test("without checkpoint callback behavior is unchanged", async () => {
    const { provider, calls } = createMockProvider([
      toolUseResponse("t1", "read_file", { path: "/a.txt" }),
      textResponse("Done"),
    ]);

    const toolExecutor = async () => ({ content: "data", isError: false });
    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
      tools: dummyTools,
      toolExecutor: toolExecutor,
    });

    const { history } = await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: () => {},
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    // Normal behavior: 2 provider calls, full history
    expect(calls).toHaveLength(2);
    expect(history).toHaveLength(4);
    expect(history[3].content).toEqual([{ type: "text", text: "Done" }]);
  });

  // 20. turnIndex increments correctly across turns
  test("turnIndex increments correctly across multiple turns", async () => {
    const { provider } = createMockProvider([
      toolUseResponse("t1", "read_file", { path: "/a.txt" }),
      toolUseResponse("t2", "read_file", { path: "/b.txt" }),
      toolUseResponse("t3", "read_file", { path: "/c.txt" }),
      textResponse("Done"),
    ]);

    const toolExecutor = async () => ({ content: "data", isError: false });
    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
      tools: dummyTools,
      toolExecutor: toolExecutor,
    });

    const checkpoints: CheckpointInfo[] = [];
    const onCheckpoint = (checkpoint: CheckpointInfo): CheckpointDecision => {
      checkpoints.push(checkpoint);
      return "continue";
    };

    await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: () => {},
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
      onCheckpoint,
    });

    expect(checkpoints).toHaveLength(3);
    expect(checkpoints[0].turnIndex).toBe(0);
    expect(checkpoints[1].turnIndex).toBe(1);
    expect(checkpoints[2].turnIndex).toBe(2);
  });

  // 21. Checkpoint is NOT called when there's no tool use
  test("checkpoint is not called when assistant responds with text only", async () => {
    const { provider } = createMockProvider([
      textResponse("Just a text response"),
    ]);
    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
      tools: dummyTools,
    });

    const checkpoints: CheckpointInfo[] = [];
    const onCheckpoint = (checkpoint: CheckpointInfo): CheckpointDecision => {
      checkpoints.push(checkpoint);
      return "continue";
    };

    const { history } = await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: () => {},
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
      onCheckpoint,
    });

    // Checkpoint should never be called for a text-only response
    expect(checkpoints).toHaveLength(0);
    // Normal response
    expect(history).toHaveLength(2);
    expect(history[1].content).toEqual([
      { type: "text", text: "Just a text response" },
    ]);
  });

  // 22. Checkpoint reports correct toolCount for parallel tool execution
  test("checkpoint reports correct toolCount for parallel tools", async () => {
    const { provider } = createMockProvider([
      {
        content: [
          {
            type: "tool_use" as const,
            id: "t1",
            name: "read_file",
            input: { path: "/a.txt" },
          },
          {
            type: "tool_use" as const,
            id: "t2",
            name: "read_file",
            input: { path: "/b.txt" },
          },
          {
            type: "tool_use" as const,
            id: "t3",
            name: "read_file",
            input: { path: "/c.txt" },
          },
        ],
        model: "mock-model",
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: "tool_use" as const,
      },
      textResponse("Got all three"),
    ]);

    const toolExecutor = async () => ({ content: "data", isError: false });
    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
      tools: dummyTools,
      toolExecutor: toolExecutor,
    });

    const checkpoints: CheckpointInfo[] = [];
    const onCheckpoint = (checkpoint: CheckpointInfo): CheckpointDecision => {
      checkpoints.push(checkpoint);
      return "continue";
    };

    await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: () => {},
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
      onCheckpoint,
    });

    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0].toolCount).toBe(3);
    expect(checkpoints[0].hasToolUse).toBe(true);
  });

  // 23. Multiple checkpoints across a multi-turn run with selective yield on turn 3
  test("multiple checkpoints with selective yield — executes turns 0-2, yields at turn 3, never runs 4+", async () => {
    // Mock provider to return tool_use for 5 turns, then text
    const responses: ProviderResponse[] = [];
    for (let i = 0; i < 5; i++) {
      responses.push(
        toolUseResponse(`t${i}`, "read_file", { path: `/file${i}.txt` }),
      );
    }
    responses.push(textResponse("Should never reach this"));

    const { provider, calls } = createMockProvider(responses);
    const toolExecutor = async () => ({ content: "data", isError: false });
    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
      tools: dummyTools,
      toolExecutor: toolExecutor,
    });

    const checkpoints: CheckpointInfo[] = [];
    const onCheckpoint = (checkpoint: CheckpointInfo): CheckpointDecision => {
      checkpoints.push(checkpoint);
      // Yield on turn 3 (0-indexed)
      return checkpoint.turnIndex === 3 ? "handoff" : "continue";
    };

    const events: AgentEvent[] = [];
    const { history } = await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: collectEvents(events),
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
      onCheckpoint,
    });

    // Turns 0, 1, 2, 3 execute (4 provider calls). Turn 3 yields, so turns 4+ never execute.
    expect(calls).toHaveLength(4);

    // Checkpoints should have been called for turns 0 through 3
    expect(checkpoints).toHaveLength(4);
    expect(checkpoints[0].turnIndex).toBe(0);
    expect(checkpoints[1].turnIndex).toBe(1);
    expect(checkpoints[2].turnIndex).toBe(2);
    expect(checkpoints[3].turnIndex).toBe(3);

    // History should contain results from turns 0-3:
    // user, assistant(t0), user(result0), assistant(t1), user(result1),
    // assistant(t2), user(result2), assistant(t3), user(result3)
    // = 1 original + 4*(assistant + user) = 9
    expect(history).toHaveLength(9);

    // Verify the last two messages are from turn 3
    expect(history[7].role).toBe("assistant");
    const lastAssistantToolUse = history[7].content.find(
      (b) => b.type === "tool_use",
    );
    expect(lastAssistantToolUse).toBeDefined();
    if (lastAssistantToolUse && lastAssistantToolUse.type === "tool_use") {
      expect(lastAssistantToolUse.id).toBe("t3");
    }
    expect(history[8].role).toBe("user");
    const lastToolResult = history[8].content.find(
      (b): b is Extract<ContentBlock, { type: "tool_result" }> =>
        b.type === "tool_result",
    );
    expect(lastToolResult).toBeDefined();
    expect(lastToolResult!.tool_use_id).toBe("t3");

    // Verify turns 4+ never executed — no tool_use event for t4
    const toolUseEvents = events.filter(
      (e): e is Extract<AgentEvent, { type: "tool_use" }> =>
        e.type === "tool_use",
    );
    const toolUseNames = toolUseEvents.map((e) => e.id);
    expect(toolUseNames).toEqual(["t0", "t1", "t2", "t3"]);
    expect(toolUseNames).not.toContain("t4");
  });

  // 24. Yield on second turn — first turn proceeds, second stops
  test("yield on second turn lets first turn proceed and stops on second", async () => {
    const { provider, calls } = createMockProvider([
      toolUseResponse("t1", "read_file", { path: "/a.txt" }),
      toolUseResponse("t2", "read_file", { path: "/b.txt" }),
      textResponse("Should not reach"),
    ]);

    const toolExecutor = async () => ({ content: "data", isError: false });
    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
      tools: dummyTools,
      toolExecutor: toolExecutor,
    });

    const onCheckpoint = (checkpoint: CheckpointInfo): CheckpointDecision => {
      // Yield on the second turn (turnIndex 1)
      return checkpoint.turnIndex === 1 ? "handoff" : "continue";
    };

    const { history } = await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: () => {},
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
      onCheckpoint,
    });

    // 2 provider calls: first tool turn + second tool turn (yield after second)
    expect(calls).toHaveLength(2);
    // History: user, assistant(t1), user(result1), assistant(t2), user(result2)
    expect(history).toHaveLength(5);
  });

  // ---------------------------------------------------------------------------
  // Dynamic tool resolver (resolveTools) tests
  // ---------------------------------------------------------------------------

  // 25. Without resolveTools, static tools are used
  test("without resolveTools, static tools are passed to provider", async () => {
    const { provider, calls } = createMockProvider([textResponse("Hi")]);
    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
      tools: dummyTools,
    });

    await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: () => {},
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    expect(calls[0].tools).toEqual(dummyTools);
  });

  // 26. resolveTools callback is invoked before each provider call
  test("resolveTools is invoked before each provider call", async () => {
    const resolverCalls: Message[][] = [];
    const resolvedTools: ToolDefinition[] = [
      {
        name: "search",
        description: "Search files",
        input_schema: {
          type: "object",
          properties: { query: { type: "string" } },
        },
      },
    ];

    const { provider } = createMockProvider([
      toolUseResponse("t1", "search", { query: "foo" }),
      textResponse("Found it"),
    ]);

    const toolExecutor = async () => ({ content: "result", isError: false });

    const resolveTools = (history: Message[]): ToolDefinition[] => {
      resolverCalls.push([...history]);
      return resolvedTools;
    };

    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
      toolExecutor: toolExecutor,
      resolveTools: resolveTools,
    });
    await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: () => {},
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    // resolveTools should be called once per provider turn (2 turns total)
    expect(resolverCalls).toHaveLength(2);

    // First call receives just the initial user message
    expect(resolverCalls[0]).toHaveLength(1);
    expect(resolverCalls[0][0]).toEqual(userMessage);

    // Second call receives the accumulated history (user + assistant + tool_result)
    expect(resolverCalls[1].length).toBeGreaterThan(1);
  });

  // 27. Resolved tool list is passed to the provider
  test("resolved tools are passed to the provider instead of static tools", async () => {
    const dynamicTools: ToolDefinition[] = [
      {
        name: "dynamic_tool",
        description: "Dynamic",
        input_schema: { type: "object" },
      },
    ];

    const { provider, calls } = createMockProvider([textResponse("Hi")]);

    const resolveTools = (): ToolDefinition[] => dynamicTools;

    // Pass different static tools to verify they are overridden
    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
      tools: dummyTools,
      resolveTools: resolveTools,
    });
    await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: () => {},
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    // Provider should receive the dynamically resolved tools, not the static ones
    expect(calls[0].tools).toEqual(dynamicTools);
    expect(calls[0].tools).not.toEqual(dummyTools);
  });

  // 28. Tool list can change between turns
  test("resolveTools can return different tools on each turn", async () => {
    const toolsPerTurn: ToolDefinition[][] = [
      [
        {
          name: "tool_a",
          description: "Tool A",
          input_schema: { type: "object" },
        },
      ],
      [
        {
          name: "tool_a",
          description: "Tool A",
          input_schema: { type: "object" },
        },
        {
          name: "tool_b",
          description: "Tool B",
          input_schema: { type: "object" },
        },
      ],
      [
        {
          name: "tool_c",
          description: "Tool C",
          input_schema: { type: "object" },
        },
      ],
    ];

    let turnIndex = 0;
    const resolveTools = (): ToolDefinition[] => {
      const tools =
        toolsPerTurn[turnIndex] ?? toolsPerTurn[toolsPerTurn.length - 1];
      turnIndex++;
      return tools;
    };

    const { provider, calls } = createMockProvider([
      toolUseResponse("t1", "tool_a", {}),
      toolUseResponse("t2", "tool_a", {}),
      textResponse("Done"),
    ]);

    const toolExecutor = async () => ({ content: "ok", isError: false });
    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
      toolExecutor: toolExecutor,
      resolveTools: resolveTools,
    });
    await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: () => {},
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    // Provider should have been called 3 times
    expect(calls).toHaveLength(3);

    // Each call should have received different tools
    expect(calls[0].tools).toEqual(toolsPerTurn[0]);
    expect(calls[1].tools).toEqual(toolsPerTurn[1]);
    expect(calls[2].tools).toEqual(toolsPerTurn[2]);
  });

  // 29. resolveTools returning empty array means no tools passed to provider
  test("resolveTools returning empty array sends no tools to provider", async () => {
    const resolveTools = (): ToolDefinition[] => [];

    const { provider, calls } = createMockProvider([
      textResponse("No tools available"),
    ]);

    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
      tools: dummyTools,
      resolveTools: resolveTools,
    });
    await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: () => {},
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    // Empty array should result in undefined tools (same as no-tools behavior)
    expect(calls[0].tools).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Tool result truncation tests
  // ---------------------------------------------------------------------------

  // 30. Oversized tool results are truncated before entering history
  test("truncates oversized tool results before adding to history", async () => {
    const toolCallId = "tool-large";
    const largeContent = "x".repeat(500_000);

    const { provider, calls } = createMockProvider([
      toolUseResponse(toolCallId, "read_file", { path: "/huge.txt" }),
      textResponse("Got it."),
    ]);

    const toolExecutor = async () => {
      return { content: largeContent, isError: false };
    };

    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
      config: { maxInputTokens: 180_000 },
      tools: dummyTools,
      toolExecutor: toolExecutor,
    });
    const events: AgentEvent[] = [];
    const { history } = await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: collectEvents(events),
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    // The tool result user message is at index 2 in history
    const toolResultMsg = history[2];
    expect(toolResultMsg.role).toBe("user");

    const toolResultBlock = toolResultMsg.content.find(
      (b): b is Extract<ContentBlock, { type: "tool_result" }> =>
        b.type === "tool_result",
    );
    expect(toolResultBlock).toBeDefined();

    // Content should have been truncated (much shorter than the original 500K)
    expect(toolResultBlock!.content.length).toBeLessThan(500_000);

    // Content should end with the truncation suffix
    expect(toolResultBlock!.content).toContain("[Content truncated");

    // The second provider call should also have the truncated content in messages
    const secondCallMessages = calls[1].messages;
    const lastMsg = secondCallMessages[secondCallMessages.length - 1];
    const sentBlock = lastMsg.content.find(
      (b): b is Extract<ContentBlock, { type: "tool_result" }> =>
        b.type === "tool_result",
    );
    expect(sentBlock).toBeDefined();
    expect(sentBlock!.content.length).toBeLessThan(500_000);
  });

  // 31. Non-oversized tool results pass through unchanged
  test("non-oversized tool results pass through unchanged", async () => {
    const toolCallId = "tool-small";
    const smallContent = "small content";

    const { provider, calls } = createMockProvider([
      toolUseResponse(toolCallId, "read_file", { path: "/small.txt" }),
      textResponse("Got it."),
    ]);

    const toolExecutor = async () => {
      return { content: smallContent, isError: false };
    };

    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
      config: { maxInputTokens: 180_000 },
      tools: dummyTools,
      toolExecutor: toolExecutor,
    });
    const events: AgentEvent[] = [];
    const { history } = await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: collectEvents(events),
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    // The tool result user message is at index 2 in history
    const toolResultMsg = history[2];
    expect(toolResultMsg.role).toBe("user");

    const toolResultBlock = toolResultMsg.content.find(
      (b): b is Extract<ContentBlock, { type: "tool_result" }> =>
        b.type === "tool_result",
    );
    expect(toolResultBlock).toBeDefined();

    // Content should be exactly the original small content — no truncation
    expect(toolResultBlock!.content).toBe(smallContent);

    // The second provider call should also have the unchanged content
    const secondCallMessages = calls[1].messages;
    const lastMsg = secondCallMessages[secondCallMessages.length - 1];
    const sentBlock = lastMsg.content.find(
      (b): b is Extract<ContentBlock, { type: "tool_result" }> =>
        b.type === "tool_result",
    );
    expect(sentBlock).toBeDefined();
    expect(sentBlock!.content).toBe(smallContent);
  });

  // ---------------------------------------------------------------------------
  // Sensitive output placeholder substitution tests
  // ---------------------------------------------------------------------------

  // 32. Tool results with sensitiveBindings populate substitution map and
  //     final assistant message text is resolved with real values.
  test("resolves sensitive output placeholders in final assistant message", async () => {
    const placeholder = "VELLUM_ASSISTANT_INVITE_CODE_TEST1234";
    const realToken = "realInviteToken999";

    const { provider, calls } = createMockProvider([
      toolUseResponse("t1", "bash", { command: "create invite" }),
      // The LLM responds using the placeholder (it never saw the real token)
      textResponse(
        `Here is your invite link: https://t.me/bot?start=iv_${placeholder}`,
      ),
    ]);

    const toolExecutor = async () => ({
      content: `https://t.me/bot?start=iv_${placeholder}`,
      isError: false,
      sensitiveBindings: [
        { kind: "invite_code" as const, placeholder, value: realToken },
      ],
    });

    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
      tools: dummyTools,
      toolExecutor: toolExecutor,
    });
    const events: AgentEvent[] = [];
    const { history } = await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: collectEvents(events),
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    // The final assistant message in HISTORY should retain placeholders
    // (so the model never sees real values on subsequent turns)
    const lastAssistant = history[history.length - 1];
    expect(lastAssistant.role).toBe("assistant");
    const historyTextBlock = lastAssistant.content.find(
      (b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text",
    );
    expect(historyTextBlock).toBeDefined();
    expect(historyTextBlock!.text).toContain(placeholder);
    expect(historyTextBlock!.text).not.toContain(realToken);

    // The message_complete EVENT should also retain placeholders (persisted
    // to conversation store; real values leak on session reload otherwise)
    const completeEvents = events.filter(
      (e): e is Extract<AgentEvent, { type: "message_complete" }> =>
        e.type === "message_complete",
    );
    const lastComplete = completeEvents[completeEvents.length - 1];
    const completeText = lastComplete.message.content.find(
      (b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text",
    );
    expect(completeText!.text).toContain(placeholder);
    expect(completeText!.text).not.toContain(realToken);

    // The tool result content in provider history should contain the PLACEHOLDER,
    // NOT the raw token (model never sees the real value)
    const secondCallMessages = calls[1].messages;
    const toolResultMsg = secondCallMessages.find(
      (m) =>
        m.role === "user" && m.content.some((b) => b.type === "tool_result"),
    );
    expect(toolResultMsg).toBeDefined();
    const toolResultBlock = toolResultMsg!.content.find(
      (b): b is Extract<ContentBlock, { type: "tool_result" }> =>
        b.type === "tool_result",
    );
    expect(toolResultBlock!.content).toContain(placeholder);
    expect(toolResultBlock!.content).not.toContain(realToken);
  });

  // 33. Streamed text_delta events have placeholders resolved to real values
  test("resolves sensitive output placeholders in streamed text_delta events", async () => {
    const placeholder = "VELLUM_ASSISTANT_INVITE_CODE_STRM5678";
    const realToken = "streamedRealToken";

    const { provider } = createMockProvider([
      toolUseResponse("t1", "bash", { command: "invite" }),
      // Response text includes the placeholder
      textResponse(`Link: https://t.me/bot?start=iv_${placeholder}`),
    ]);

    const toolExecutor = async () => ({
      content: `https://t.me/bot?start=iv_${placeholder}`,
      isError: false,
      sensitiveBindings: [
        { kind: "invite_code" as const, placeholder, value: realToken },
      ],
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
      onEvent: collectEvents(events),
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    // Collect all text_delta events from the final turn (after tool result)
    const textDeltas = events.filter(
      (e): e is Extract<AgentEvent, { type: "text_delta" }> =>
        e.type === "text_delta",
    );
    const allStreamedText = textDeltas.map((e) => e.text).join("");

    // Streamed text should contain the real token, not the placeholder
    expect(allStreamedText).toContain(realToken);
    expect(allStreamedText).not.toContain(placeholder);
  });

  // 34. Without sensitive bindings, text passes through unchanged
  test("text passes through unchanged when no sensitive bindings exist", async () => {
    const { provider } = createMockProvider([
      toolUseResponse("t1", "read_file", { path: "/test.txt" }),
      textResponse("Normal response with no placeholders."),
    ]);

    const toolExecutor = async () => ({
      content: "file contents",
      isError: false,
      // No sensitiveBindings
    });

    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
      tools: dummyTools,
      toolExecutor: toolExecutor,
    });
    const events: AgentEvent[] = [];
    const { history } = await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: collectEvents(events),
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    const lastAssistant = history[history.length - 1];
    const textBlock = lastAssistant.content.find(
      (b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text",
    );
    expect(textBlock!.text).toBe("Normal response with no placeholders.");
  });

  // Tool error retry coaching — when a tool returns isError: true, the coaching
  // notice is appended as a separate text block in the tool-result user message
  // (not into the tool_result content), nudging the LLM to retry instead of
  // ending the turn while keeping the tool's actual output clean.
  test("appends retry coaching as a separate block when a tool returns an error", async () => {
    const { provider, calls } = createMockProvider([
      // First turn: LLM calls a tool that errors
      toolUseResponse("t1", "read_file", { path: "/missing.txt" }),
      // Second turn: LLM retries after seeing the error + nudge
      toolUseResponse("t2", "read_file", { path: "/existing.txt" }),
      // Third turn: LLM responds with success
      textResponse("Got the file."),
    ]);

    let callCount = 0;
    const toolExecutor = async (
      _name: string,
      _input: Record<string, unknown>,
    ) => {
      callCount++;
      if (callCount === 1) {
        return {
          content:
            '{"error":"name is required and must be a non-empty string"}',
          isError: true,
        };
      }
      return { content: "file contents", isError: false };
    };

    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
      tools: dummyTools,
      toolExecutor: toolExecutor,
    });
    await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: () => {},
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    // Provider should have been called 3 times (error -> retry -> final text)
    expect(calls).toHaveLength(3);

    // The second call's messages should carry the retry coaching as a separate
    // text block, with the tool_result's own content left untouched.
    const secondCallMessages = calls[1].messages;
    const toolResultMessage = secondCallMessages[secondCallMessages.length - 1];
    expect(toolResultMessage.role).toBe("user");

    const retryNudge = toolResultMessage.content.find(
      (b): b is Extract<ContentBlock, { type: "text" }> =>
        b.type === "text" && b.text.includes("looks recoverable"),
    );
    expect(retryNudge).toBeDefined();

    // The errored tool_result itself stays the tool's actual output.
    const erroredToolResult = toolResultMessage.content.find(
      (b): b is Extract<ContentBlock, { type: "tool_result" }> =>
        b.type === "tool_result",
    );
    expect(erroredToolResult?.content).not.toContain("looks recoverable");

    // The third call should NOT have the retry coaching (successful tool result)
    const thirdCallMessages = calls[2].messages;
    const thirdToolResultMessage =
      thirdCallMessages[thirdCallMessages.length - 1];
    const noRetryNudge = thirdToolResultMessage.content.find(
      (b): b is Extract<ContentBlock, { type: "text" }> =>
        b.type === "text" && b.text.includes("looks recoverable"),
    );
    expect(noRetryNudge).toBeUndefined();
  });

  // Retry coaching stops after a tool fails 3 times in a row — past that the
  // error is likely unrecoverable and further coaching only burns tokens.
  test("stops appending retry coaching after 3 consecutive failures of a tool", async () => {
    const { provider, calls } = createMockProvider([
      // 4 consecutive error turns, then final text
      toolUseResponse("t1", "read_file", { path: "/a" }),
      toolUseResponse("t2", "read_file", { path: "/b" }),
      toolUseResponse("t3", "read_file", { path: "/c" }),
      toolUseResponse("t4", "read_file", { path: "/d" }),
      textResponse("Giving up."),
    ]);

    const toolExecutor = async (
      _name: string,
      _input: Record<string, unknown>,
    ) => {
      return { content: "service unavailable", isError: true };
    };

    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
      tools: dummyTools,
      toolExecutor: toolExecutor,
    });
    await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: () => {},
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    expect(calls).toHaveLength(5);

    // Helper to check if a call's last user message has the retry coaching
    // (a separate text block, not part of the tool_result content).
    const hasRetryNudge = (callIndex: number): boolean => {
      const msgs = calls[callIndex].messages;
      const lastMsg = msgs[msgs.length - 1];
      return lastMsg.content.some(
        (b) => b.type === "text" && b.text.includes("looks recoverable"),
      );
    };

    // Turns 1-3 should have the coaching
    expect(hasRetryNudge(1)).toBe(true);
    expect(hasRetryNudge(2)).toBe(true);
    expect(hasRetryNudge(3)).toBe(true);
    // Turn 4 should NOT have the coaching (exceeded limit)
    expect(hasRetryNudge(4)).toBe(false);
  });

  // Empty response retry — model returns no text and no tool_use after tool results
  test("retries once when model returns empty response after tool results", async () => {
    const emptyResponse: ProviderResponse = {
      content: [],
      model: "mock-model",
      usage: { inputTokens: 10, outputTokens: 0 },
      stopReason: "end_turn",
    };

    const { provider, calls } = createMockProvider([
      toolUseResponse("t1", "read_file", { path: "/a.txt" }),
      emptyResponse, // First response after tool result: empty
      textResponse("Here is what I found in the file."), // Retry response: has text
    ]);

    const toolExecutor = async () => ({
      content: "file contents here",
      isError: false,
    });

    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
      tools: dummyTools,
      toolExecutor: toolExecutor,
    });
    const events: AgentEvent[] = [];
    const { history } = await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: collectEvents(events),
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
      callSite: "mainAgent",
    });

    // Provider should be called 3 times: initial, empty response, retry
    expect(calls).toHaveLength(3);

    // The retry call should include the nudge message
    const retryMessages = calls[2].messages;
    const lastMsg = retryMessages[retryMessages.length - 1];
    expect(lastMsg.role).toBe("user");
    expect(
      lastMsg.content.some(
        (b) =>
          b.type === "text" &&
          "text" in b &&
          (b as { text: string }).text.includes("previous response was empty"),
      ),
    ).toBe(true);

    // Final history should have the successful text response
    const lastAssistant = [...history]
      .reverse()
      .find((m) => m.role === "assistant");
    expect(lastAssistant).toBeDefined();
    expect(lastAssistant!.content).toEqual([
      { type: "text", text: "Here is what I found in the file." },
    ]);

    // message_complete emitted for tool_use response + retry text response (not the empty one)
    const messageCompletes = events.filter(
      (e) => e.type === "message_complete",
    );
    expect(messageCompletes).toHaveLength(2);
  });

  // Regression: when the model emits [text, tool_use] in a single turn and then
  // returns an empty response after the tool result, the loop must NOT nudge —
  // the model already delivered its reply before the tool call, and nudging
  // would trick it into re-sending the same text verbatim.
  test("does not nudge empty response when prior turn had visible text", async () => {
    const textPlusToolUseResponse: ProviderResponse = {
      content: [
        { type: "text", text: "your move, husband." },
        {
          type: "tool_use",
          id: "t1",
          name: "read_file",
          input: { path: "/note.txt" },
        },
      ],
      model: "mock-model",
      usage: { inputTokens: 10, outputTokens: 5 },
      stopReason: "tool_use",
    };
    const emptyResponse: ProviderResponse = {
      content: [],
      model: "mock-model",
      usage: { inputTokens: 10, outputTokens: 0 },
      stopReason: "end_turn",
    };

    const { provider, calls } = createMockProvider([
      textPlusToolUseResponse,
      emptyResponse,
    ]);

    const toolExecutor = async () => ({
      content: "noted",
      isError: false,
    });

    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
      tools: dummyTools,
      toolExecutor: toolExecutor,
    });
    const events: AgentEvent[] = [];
    const { history } = await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: collectEvents(events),
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
      callSite: "mainAgent",
    });

    // Provider called exactly 2 times: initial [text+tool_use], then empty.
    // No third (retry) call because the prior turn had visible text.
    expect(calls).toHaveLength(2);

    // No nudge message should appear anywhere in history.
    const nudgeInHistory = history.some(
      (m) =>
        m.role === "user" &&
        m.content.some(
          (b) =>
            b.type === "text" &&
            "text" in b &&
            (b as { text: string }).text.includes(
              "previous response was empty",
            ),
        ),
    );
    expect(nudgeInHistory).toBe(false);

    // The [text, tool_use] assistant message is preserved in history.
    const firstAssistant = history.find((m) => m.role === "assistant");
    expect(firstAssistant).toBeDefined();
    expect(firstAssistant!.content).toEqual([
      { type: "text", text: "your move, husband." },
      {
        type: "tool_use",
        id: "t1",
        name: "read_file",
        input: { path: "/note.txt" },
      },
    ]);
  });

  test("gives up after max empty response retries", async () => {
    const emptyResponse: ProviderResponse = {
      content: [],
      model: "mock-model",
      usage: { inputTokens: 10, outputTokens: 0 },
      stopReason: "end_turn",
    };

    const { provider, calls } = createMockProvider([
      toolUseResponse("t1", "read_file", { path: "/a.txt" }),
      emptyResponse, // First response after tool result: empty
      emptyResponse, // Retry also empty — should give up
    ]);

    const toolExecutor = async () => ({
      content: "file contents here",
      isError: false,
    });

    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
      tools: dummyTools,
      toolExecutor: toolExecutor,
    });
    const events: AgentEvent[] = [];
    const { history } = await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: collectEvents(events),
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
      callSite: "mainAgent",
    });

    // Provider called 3 times: initial, empty, retry (also empty)
    expect(calls).toHaveLength(3);

    // message_complete: tool_use response + final empty response (retry exhausted)
    const messageCompletes = events.filter(
      (e) => e.type === "message_complete",
    );
    expect(messageCompletes).toHaveLength(2);

    // An organic empty `end_turn` (not a refusal) is left as-is — the fallback
    // is refusal-specific, so the exhausted empty turn stays empty.
    const lastAssistant = [...history]
      .reverse()
      .find((m) => m.role === "assistant");
    expect(lastAssistant).toBeDefined();
    expect(lastAssistant!.content).toEqual([]);

    // AND no fallback text is streamed for a non-refusal empty turn.
    const textDeltas = events.filter((e) => e.type === "text_delta");
    expect(
      textDeltas.some(
        (e) =>
          (e as { type: "text_delta"; text: string }).text ===
          REFUSAL_FALLBACK_TEXT,
      ),
    ).toBe(false);
  });

  test("does not retry empty response on first turn (no prior tool use)", async () => {
    const emptyResponse: ProviderResponse = {
      content: [],
      model: "mock-model",
      usage: { inputTokens: 10, outputTokens: 0 },
      stopReason: "end_turn",
    };

    const { provider, calls } = createMockProvider([emptyResponse]);

    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
    });
    const events: AgentEvent[] = [];
    const { history } = await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: collectEvents(events),
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    // Should NOT retry — this is the first turn with no tool use history
    expect(calls).toHaveLength(1);
    // user + assistant; an organic empty `end_turn` is left as-is (the fallback
    // is refusal-specific), so the empty turn stays empty.
    expect(history).toHaveLength(2);
    expect(history[1].content).toEqual([]);
  });

  // Refusal stop boundary — the provider zeroed the response with
  // `stopReason: "refusal"`. The default `stop` hook rewrites the empty turn
  // into a user-facing fallback (no retry — a safety-classifier refusal
  // re-fires on a re-query), and the loop persists + streams it rather than the
  // empty assistant bubble the user would otherwise see.
  test("rewrites a refusal into a user-facing fallback without retrying", async () => {
    // GIVEN a provider that refuses (empty content, stopReason "refusal").
    const refusalResponse: ProviderResponse = {
      content: [],
      model: "mock-model",
      usage: { inputTokens: 10, outputTokens: 0 },
      stopReason: "refusal",
    };
    const { provider, calls } = createMockProvider([
      refusalResponse,
      refusalResponse,
    ]);
    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
    });

    // WHEN the loop runs.
    const events: AgentEvent[] = [];
    const { history } = await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: collectEvents(events),
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    // THEN the loop calls the provider once: the refusal is rewritten in place
    // with no nudge-driven retry.
    expect(calls).toHaveLength(1);

    // AND the user-visible assistant turn is the fallback, not an empty bubble.
    const lastAssistant = [...history]
      .reverse()
      .find((m) => m.role === "assistant");
    expect(lastAssistant!.content).toEqual([
      { type: "text", text: REFUSAL_FALLBACK_TEXT },
    ]);

    // AND the fallback is streamed so the client renders it.
    const textDeltas = events.filter((e) => e.type === "text_delta");
    expect(
      textDeltas.some(
        (e) =>
          (e as { type: "text_delta"; text: string }).text ===
          REFUSAL_FALLBACK_TEXT,
      ),
    ).toBe(true);
  });

  // The fallback must not pile a spurious apology beneath a real answer: when
  // an earlier turn this run already produced visible text (text alongside a
  // tool call), a refusal on the trailing turn after the tool result must not
  // rewrite the turn even though a refusal would normally trigger it.
  test("does not substitute a fallback when the run already produced visible text", async () => {
    // GIVEN a first turn with text + a tool call, then a refusal after the
    // tool result.
    const textPlusToolUse: ProviderResponse = {
      content: [
        { type: "text", text: "Here is your answer." },
        {
          type: "tool_use",
          id: "t1",
          name: "read_file",
          input: { path: "/a" },
        },
      ],
      model: "mock-model",
      usage: { inputTokens: 10, outputTokens: 5 },
      stopReason: "tool_use",
    };
    const refusalResponse: ProviderResponse = {
      content: [],
      model: "mock-model",
      usage: { inputTokens: 10, outputTokens: 0 },
      stopReason: "refusal",
    };
    const { provider } = createMockProvider([textPlusToolUse, refusalResponse]);
    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
      tools: dummyTools,
      toolExecutor: async () => ({ content: "data", isError: false }),
    });

    // WHEN the loop runs.
    const events: AgentEvent[] = [];
    const { history } = await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: collectEvents(events),
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    // THEN no fallback text is emitted or persisted — the real answer stands
    // alone and the trailing empty turn stays empty.
    const fallbackEmitted = events.some(
      (e) =>
        e.type === "text_delta" &&
        (e as { type: "text_delta"; text: string }).text ===
          REFUSAL_FALLBACK_TEXT,
    );
    expect(fallbackEmitted).toBe(false);
    const fallbackInHistory = history.some(
      (m) =>
        m.role === "assistant" &&
        m.content.some(
          (b) =>
            b.type === "text" &&
            "text" in b &&
            (b as { text: string }).text === REFUSAL_FALLBACK_TEXT,
        ),
    );
    expect(fallbackInHistory).toBe(false);
  });

  // A native web-search turn lands at the stop boundary with no `tool_use` and
  // no visible text, but with `stopReason: "end_turn"` (not a refusal) and
  // `server_tool_use`/`web_search_tool_result` blocks that render the search
  // card. Because the fallback is refusal-specific, it must not fire here and
  // the server-tool blocks must persist untouched.
  test("does not substitute a fallback for a server-tool turn with no text", async () => {
    // GIVEN a turn carrying only native web-search blocks (no text, no
    // client-side tool_use).
    const serverToolBlocks: ContentBlock[] = [
      {
        type: "server_tool_use",
        id: "srv1",
        name: "web_search",
        input: { query: "weather" },
      },
      {
        type: "web_search_tool_result",
        tool_use_id: "srv1",
        content: [{ title: "result" }],
      },
    ];
    const webSearchResponse: ProviderResponse = {
      content: serverToolBlocks,
      model: "mock-model",
      usage: { inputTokens: 10, outputTokens: 5 },
      stopReason: "end_turn",
    };
    const { provider, calls } = createMockProvider([webSearchResponse]);
    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
    });

    // WHEN the loop runs.
    const events: AgentEvent[] = [];
    const { history } = await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: collectEvents(events),
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    // THEN the provider is called once (no nudge for a non-refusal turn) and
    // the server-tool blocks are persisted untouched, with no fallback added.
    expect(calls).toHaveLength(1);
    const lastAssistant = [...history]
      .reverse()
      .find((m) => m.role === "assistant");
    expect(lastAssistant!.content).toEqual(serverToolBlocks);

    const fallbackEmitted = events.some(
      (e) =>
        e.type === "text_delta" &&
        (e as { type: "text_delta"; text: string }).text ===
          REFUSAL_FALLBACK_TEXT,
    );
    expect(fallbackEmitted).toBe(false);
  });

  // PR 6: callSite threading from AgentLoop.run() into provider config.
  // Verifies the per-call config exposes `callSite` so RetryProvider can route
  // through `resolveCallSiteConfig` instead of the legacy `modelIntent` path.
  test("threads callSite from AgentLoop.run() into per-call provider config", async () => {
    const { provider, calls } = createMockProvider([textResponse("ok")]);

    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
    });
    await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: () => {},
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
      callSite: "heartbeatAgent",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].options?.config?.callSite).toBe("heartbeatAgent");
  });

  test("omits callSite from provider config when not supplied", async () => {
    const { provider, calls } = createMockProvider([textResponse("ok")]);

    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
    });
    await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: () => {},
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].options?.config?.callSite).toBeUndefined();
  });
});
