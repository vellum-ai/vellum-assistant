import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { AgentEvent } from "../agent/loop.js";
import { RiskLevel } from "../permissions/types.js";
import type {
  ContentBlock,
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
  ToolDefinition,
} from "../providers/types.js";

// ---------------------------------------------------------------------------
// Module mocks — must precede imports of the module under test
// ---------------------------------------------------------------------------

// Feature flag: defaults to disabled
let mockDeferralEnabled = false;
mock.module("../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: (key: string) => {
    if (key === "tool-deferral") return mockDeferralEnabled;
    return true;
  },
}));

// Config: provide toolDeferralThresholdSec (default 10s, overridable per test)
let mockThresholdSec = 10;
mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    timeouts: { toolDeferralThresholdSec: mockThresholdSec },
  }),
}));

// Background tool manager: real implementation for integration tests.
// Bun's mock.module() snapshots exports at registration time, so a getter
// won't re-evaluate dynamically. We create a stable instance up-front and
// return it directly. In beforeEach we swap the delegate to a fresh instance
// via our thin proxy wrapper, giving each test a clean slate.
import { BackgroundToolManager } from "../agent/background-tool-manager.js";

let testBgManager = new BackgroundToolManager();

// Proxy that delegates all property access to whichever BackgroundToolManager
// instance `testBgManager` currently points to. This lets mock.module()
// capture one stable reference while beforeEach can swap the underlying
// manager freely.
const bgManagerProxy = new Proxy({} as BackgroundToolManager, {
  get(_target, prop, _receiver) {
    const value = Reflect.get(testBgManager, prop, testBgManager);
    // Bind methods so `this` inside the real manager is correct
    if (typeof value === "function") {
      return value.bind(testBgManager);
    }
    return value;
  },
});

mock.module("../agent/background-tool-manager.js", () => ({
  backgroundToolManager: bgManagerProxy,
  BackgroundToolManager,
}));

// Hooks — no-op
mock.module("../hooks/manager.js", () => ({
  getHookManager: () => ({
    trigger: async () => ({ blocked: false }),
  }),
}));

// Logger — no-op
mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

// Token estimator — trivial
mock.module("../context/token-estimator.js", () => ({
  estimateToolsTokens: () => 0,
}));

// Tool result truncation — pass through
mock.module("../context/tool-result-truncation.js", () => ({
  truncateOversizedToolResults: (blocks: ContentBlock[]) => ({
    blocks,
    truncatedCount: 0,
  }),
}));

// Sensitive output placeholders — pass through
mock.module("../tools/sensitive-output-placeholders.js", () => ({
  applyStreamingSubstitution: (text: string) => ({ emit: text, pending: "" }),
  applySubstitutions: (text: string) => text,
}));

// Sentry — no-op
mock.module("@sentry/node", () => ({
  captureException: () => {},
}));

// Now import the module under test (after mocks are registered)
const { AgentLoop } = await import("../agent/loop.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockProvider(responses: ProviderResponse[]): {
  provider: Provider;
  calls: {
    messages: Message[];
    tools?: ToolDefinition[];
    systemPrompt?: string;
  }[];
} {
  const calls: {
    messages: Message[];
    tools?: ToolDefinition[];
    systemPrompt?: string;
  }[] = [];
  let callIndex = 0;

  const provider: Provider = {
    name: "mock",
    async sendMessage(
      messages: Message[],
      tools?: ToolDefinition[],
      systemPrompt?: string,
      options?: SendMessageOptions,
    ): Promise<ProviderResponse> {
      calls.push({ messages: [...messages], tools, systemPrompt });
      const response = responses[callIndex] ?? responses[responses.length - 1];
      callIndex++;
      if (options?.onEvent) {
        for (const block of response.content) {
          if (block.type === "text") {
            options.onEvent({ type: "text_delta", text: block.text });
          }
        }
      }
      return response;
    },
  };

  return { provider, calls };
}

function textResponse(text: string): ProviderResponse {
  return {
    content: [{ type: "text", text }],
    model: "mock-model",
    usage: { inputTokens: 10, outputTokens: 5 },
    stopReason: "end_turn",
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
    name: "slow_tool",
    description: "A tool that takes a while",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "fast_tool",
    description: "A fast tool",
    input_schema: { type: "object", properties: {} },
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

describe("AgentLoop deferral", () => {
  beforeEach(() => {
    mockDeferralEnabled = false;
    mockThresholdSec = 10;
    testBgManager = new BackgroundToolManager();
  });

  // ── Feature flag disabled ────────────────────────────────────────────

  test("feature flag disabled: all tools use blocking Promise.all (no deferral)", async () => {
    mockDeferralEnabled = false;

    const { provider } = createMockProvider([
      toolUseResponse("t1", "slow_tool", {}),
      textResponse("Done"),
    ]);

    let toolExecuted = false;
    const toolExecutor = async () => {
      // Simulate a tool that takes "long" — but since deferral is off, it blocks
      await Bun.sleep(50);
      toolExecuted = true;
      return { content: "result", isError: false };
    };

    const loop = new AgentLoop(
      provider,
      "system",
      { minTurnIntervalMs: 0 },
      dummyTools,
      toolExecutor,
    );
    const events: AgentEvent[] = [];
    const history = await loop.run(
      [userMessage],
      collectEvents(events),
      undefined,
      undefined,
      undefined,
      "conv-1",
    );

    // Tool completed normally (blocking)
    expect(toolExecuted).toBe(true);

    // No deferral events
    const deferralEvents = events.filter(
      (e) => e.type === "tool_deferred_to_background",
    );
    expect(deferralEvents).toHaveLength(0);

    // History ends with assistant text
    expect(history[history.length - 1].role).toBe("assistant");
    expect(history[history.length - 1].content).toEqual([
      { type: "text", text: "Done" },
    ]);
  });

  // ── Feature flag enabled, all tools complete before threshold ──────

  test("feature flag enabled, all tools complete before threshold: normal flow", async () => {
    mockDeferralEnabled = true;
    // Set a very long threshold so tools always finish first
    mockThresholdSec = 60;

    const { provider } = createMockProvider([
      toolUseResponse("t1", "fast_tool", {}),
      textResponse("Done"),
    ]);

    const toolExecutor = async () => {
      return { content: "fast result", isError: false };
    };

    const loop = new AgentLoop(
      provider,
      "system",
      { minTurnIntervalMs: 0 },
      dummyTools,
      toolExecutor,
    );
    const events: AgentEvent[] = [];
    const history = await loop.run(
      [userMessage],
      collectEvents(events),
      undefined,
      undefined,
      undefined,
      "conv-1",
    );

    // No deferral events
    const deferralEvents = events.filter(
      (e) => e.type === "tool_deferred_to_background",
    );
    expect(deferralEvents).toHaveLength(0);

    // Normal tool_result event emitted
    const toolResultEvents = events.filter((e) => e.type === "tool_result");
    expect(toolResultEvents).toHaveLength(1);
    const toolResultEvent = toolResultEvents[0] as Extract<
      AgentEvent,
      { type: "tool_result" }
    >;
    expect(toolResultEvent.content).toBe("fast result");

    // History ends with assistant text
    expect(history[history.length - 1].content).toEqual([
      { type: "text", text: "Done" },
    ]);
  });

  // ── Feature flag enabled, one tool exceeds threshold ──────────────

  test("feature flag enabled, one tool exceeds threshold: placeholder result + system notice", async () => {
    mockDeferralEnabled = true;
    // Very short threshold so the slow tool definitely exceeds it
    mockThresholdSec = 0.05; // 50ms

    const { provider, calls } = createMockProvider([
      toolUseResponse("t1", "slow_tool", {}),
      textResponse("I see the tool is running in the background."),
    ]);

    const toolExecutor = async () => {
      // This tool takes longer than the 50ms threshold
      await Bun.sleep(200);
      return { content: "slow result", isError: false };
    };

    const loop = new AgentLoop(
      provider,
      "system",
      { minTurnIntervalMs: 0 },
      dummyTools,
      toolExecutor,
    );
    const events: AgentEvent[] = [];
    await loop.run(
      [userMessage],
      collectEvents(events),
      undefined,
      undefined,
      undefined,
      "conv-1",
    );

    // Should have emitted a tool_deferred_to_background event
    const deferralEvents = events.filter(
      (e) => e.type === "tool_deferred_to_background",
    );
    expect(deferralEvents).toHaveLength(1);
    const deferralEvent = deferralEvents[0] as Extract<
      AgentEvent,
      { type: "tool_deferred_to_background" }
    >;
    expect(deferralEvent.executionId).toBe("t1");
    expect(deferralEvent.toolName).toBe("slow_tool");

    // The provider should have been called twice: once for the tool_use, once after placeholder
    expect(calls).toHaveLength(2);

    // The second call's last user message should contain:
    // 1. A tool_result placeholder for the slow tool
    // 2. A system_notice text block
    const secondCallMsgs = calls[1].messages;
    const lastUserMsg = secondCallMsgs[secondCallMsgs.length - 1];
    expect(lastUserMsg.role).toBe("user");

    const toolResultBlock = lastUserMsg.content.find(
      (b) => b.type === "tool_result",
    );
    expect(toolResultBlock).toBeDefined();
    if (toolResultBlock && toolResultBlock.type === "tool_result") {
      expect(toolResultBlock.content).toContain(
        "still running in the background",
      );
      expect(toolResultBlock.content).toContain("execution_id: t1");
    }

    const systemNotice = lastUserMsg.content.find(
      (b) => b.type === "text" && b.text.includes("deferral threshold"),
    );
    expect(systemNotice).toBeDefined();
  });

  // ── Mix of fast and slow tools ─────────────────────────────────────

  test("feature flag enabled, mix of fast and slow tools: fast get real results, slow get placeholders", async () => {
    mockDeferralEnabled = true;
    mockThresholdSec = 0.1; // 100ms

    // Provider returns two tool_use blocks in one response
    const multiToolResponse: ProviderResponse = {
      content: [
        { type: "tool_use", id: "fast-1", name: "fast_tool", input: {} },
        { type: "tool_use", id: "slow-1", name: "slow_tool", input: {} },
      ],
      model: "mock-model",
      usage: { inputTokens: 10, outputTokens: 5 },
      stopReason: "tool_use",
    };

    const { provider, calls } = createMockProvider([
      multiToolResponse,
      textResponse("Background tool noted."),
    ]);

    const toolExecutor = async (name: string) => {
      if (name === "slow_tool") {
        await Bun.sleep(300);
        return { content: "slow result", isError: false };
      }
      // fast_tool completes instantly
      return { content: "fast result", isError: false };
    };

    const loop = new AgentLoop(
      provider,
      "system",
      { minTurnIntervalMs: 0 },
      dummyTools,
      toolExecutor,
    );
    const events: AgentEvent[] = [];
    await loop.run(
      [userMessage],
      collectEvents(events),
      undefined,
      undefined,
      undefined,
      "conv-1",
    );

    // fast_tool should have a real tool_result event
    const toolResultEvents = events.filter(
      (e) => e.type === "tool_result",
    ) as Extract<AgentEvent, { type: "tool_result" }>[];
    const fastResult = toolResultEvents.find((e) => e.toolUseId === "fast-1");
    expect(fastResult).toBeDefined();
    expect(fastResult!.content).toBe("fast result");

    // slow_tool should have a deferred event (no real tool_result)
    const deferralEvents = events.filter(
      (e) => e.type === "tool_deferred_to_background",
    ) as Extract<AgentEvent, { type: "tool_deferred_to_background" }>[];
    expect(deferralEvents).toHaveLength(1);
    expect(deferralEvents[0].toolName).toBe("slow_tool");
    expect(deferralEvents[0].executionId).toBe("slow-1");

    // Check that the user message sent to provider has both results
    const secondCallMsgs = calls[1].messages;
    const lastUserMsg = secondCallMsgs[secondCallMsgs.length - 1];
    const toolResults = lastUserMsg.content.filter(
      (b) => b.type === "tool_result",
    );
    expect(toolResults).toHaveLength(2);

    // First result (fast) should be real
    const fastBlock = toolResults.find(
      (b) => b.type === "tool_result" && b.tool_use_id === "fast-1",
    );
    expect(fastBlock).toBeDefined();
    if (fastBlock && fastBlock.type === "tool_result") {
      expect(fastBlock.content).toBe("fast result");
    }

    // Second result (slow) should be placeholder
    const slowBlock = toolResults.find(
      (b) => b.type === "tool_result" && b.tool_use_id === "slow-1",
    );
    expect(slowBlock).toBeDefined();
    if (slowBlock && slowBlock.type === "tool_result") {
      expect(slowBlock.content).toContain("still running in the background");
    }
  });

  // ── Auto-injection of completed background results ─────────────────

  test("auto-injection of completed background results on next loop iteration", async () => {
    mockDeferralEnabled = true;
    mockThresholdSec = 0.05; // 50ms

    // Setup: Pre-populate the background manager with a "completed" execution
    // that should be drained on the next iteration
    let resolveSlowTool: (v: { content: string; isError: boolean }) => void;
    const slowPromise = new Promise<{ content: string; isError: boolean }>(
      (resolve) => {
        resolveSlowTool = resolve;
      },
    );
    testBgManager.register({
      executionId: "bg-exec-1",
      toolName: "slow_tool",
      toolUseId: "bg-tu-1",
      conversationId: "conv-inject",
      startedAt: Date.now() - 5000,
      promise: slowPromise,
    });
    // Resolve it so it's drained as "completed"
    resolveSlowTool!({ content: "bg result done", isError: false });
    // Give the promise .then handler time to fire
    await Bun.sleep(10);

    const { provider, calls } = createMockProvider([
      textResponse("I see the background result."),
    ]);

    // No tool executor needed — this is a text-only turn, but background
    // results should be injected before the provider call.
    const loop = new AgentLoop(provider, "system", { minTurnIntervalMs: 0 });
    const events: AgentEvent[] = [];
    await loop.run(
      [userMessage],
      collectEvents(events),
      undefined,
      undefined,
      undefined,
      "conv-inject",
    );

    // Should have emitted a background_tool_completed event
    const bgCompleted = events.filter(
      (e) => e.type === "background_tool_completed",
    ) as Extract<AgentEvent, { type: "background_tool_completed" }>[];
    expect(bgCompleted).toHaveLength(1);
    expect(bgCompleted[0].executionId).toBe("bg-exec-1");
    expect(bgCompleted[0].result).toBe("bg result done");
    expect(bgCompleted[0].isError).toBe(false);

    // The injected content should appear in the user message sent to the provider
    const firstCallMsgs = calls[0].messages;
    const injectedUserMsg = firstCallMsgs[0]; // user message should have injected blocks
    const bgBlock = injectedUserMsg.content.find(
      (b) => b.type === "text" && b.text.includes("background_tool_result"),
    );
    expect(bgBlock).toBeDefined();
    if (bgBlock && bgBlock.type === "text") {
      expect(bgBlock.text).toContain("bg result done");
      expect(bgBlock.text).toContain("bg-exec-1");
    }
  });

  // ── Background executions survive across run() calls ────────────────

  test("background executions survive across run() calls", async () => {
    mockDeferralEnabled = true;
    mockThresholdSec = 60; // High threshold so no deferral happens

    // Pre-register a background execution
    const neverResolve = new Promise<{ content: string; isError: boolean }>(
      () => {},
    );
    testBgManager.register({
      executionId: "cleanup-exec",
      toolName: "slow_tool",
      toolUseId: "cleanup-tu",
      conversationId: "conv-cleanup",
      startedAt: Date.now(),
      promise: neverResolve,
    });

    expect(testBgManager.getActiveCount("conv-cleanup")).toBe(1);

    const { provider } = createMockProvider([textResponse("Done")]);
    const loop = new AgentLoop(provider, "system", { minTurnIntervalMs: 0 });
    const events: AgentEvent[] = [];
    await loop.run(
      [userMessage],
      collectEvents(events),
      undefined,
      undefined,
      undefined,
      "conv-cleanup",
    );

    // After loop exits, background executions should still be active —
    // cleanup is the conversation lifecycle's responsibility (abort/dispose),
    // not the agent loop's.
    expect(testBgManager.getActiveCount("conv-cleanup")).toBe(1);
  });

  // ── Deferral-exempt tools skip threshold ───────────────────────────

  test("all deferral-exempt tools skip threshold racing", async () => {
    mockDeferralEnabled = true;
    mockThresholdSec = 0.01; // 10ms — would normally trigger deferral

    const { provider } = createMockProvider([
      toolUseResponse("exempt-1", "exempt_tool", {}),
      textResponse("Done"),
    ]);

    const toolExecutor = async () => {
      // Takes longer than threshold, but tool is exempt
      await Bun.sleep(50);
      return { content: "exempt result", isError: false };
    };

    const exemptTools: ToolDefinition[] = [
      {
        name: "exempt_tool",
        description: "An exempt tool",
        input_schema: { type: "object", properties: {} },
      },
    ];

    const getToolByName = (name: string) => {
      if (name === "exempt_tool") {
        return {
          name: "exempt_tool",
          description: "An exempt tool",
          category: "test",
          defaultRiskLevel: RiskLevel.Low,
          deferralExempt: true,
          getDefinition: () => exemptTools[0],
          execute: async () => ({ content: "", isError: false }),
        };
      }
      return undefined;
    };

    const loop = new AgentLoop(
      provider,
      "system",
      { minTurnIntervalMs: 0 },
      exemptTools,
      toolExecutor,
      undefined,
      undefined,
      getToolByName,
    );
    const events: AgentEvent[] = [];
    await loop.run(
      [userMessage],
      collectEvents(events),
      undefined,
      undefined,
      undefined,
      "conv-exempt",
    );

    // Should NOT have deferred — exempt tools block regardless
    const deferralEvents = events.filter(
      (e) => e.type === "tool_deferred_to_background",
    );
    expect(deferralEvents).toHaveLength(0);

    // Should have a real tool_result
    const toolResultEvents = events.filter(
      (e) => e.type === "tool_result",
    ) as Extract<AgentEvent, { type: "tool_result" }>[];
    expect(toolResultEvents).toHaveLength(1);
    expect(toolResultEvents[0].content).toBe("exempt result");
  });
});
