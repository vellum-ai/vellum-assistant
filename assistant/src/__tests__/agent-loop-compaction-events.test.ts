/**
 * Tests for the loop's compaction start/end event pair.
 *
 * The compaction pipeline between `context_compacting` (start) and
 * `compaction_completed` (end) is plugin-owned, so consumers reconstruct a
 * compaction attempt purely from the pair — correlated by `compactionId`.
 * These tests pin the pairing contract: shared id, trigger, timestamps,
 * pre-compaction state on the start event, and the unnested
 * `ContextWindowResult` fields on the end event.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { PostCompactContext } from "@vellumai/plugin-api";

import type { AgentEvent } from "../agent/loop.js";
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
import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
  ToolDefinition,
} from "../providers/types.js";

// Identity post-compact hook: keeps the history the loop handed in, standing
// in for the daemon-level re-injector these unit tests do not run.
const testPostCompactPlugin = {
  manifest: { name: "test-post-compact", version: "0.0.0" },
  hooks: {
    [HOOKS.POST_COMPACT]: async (
      _input: PostCompactContext,
    ): Promise<void> => {},
  },
};

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

type StartEvent = Extract<AgentEvent, { type: "context_compacting" }>;
type EndEvent = Extract<AgentEvent, { type: "compaction_completed" }>;

describe("AgentLoop compaction start/end event pair", () => {
  beforeEach(() => {
    resetPluginRegistryForTests();
    registerPlugin(testPostCompactPlugin);
  });

  afterEach(() => {
    disposeContextWindowManager("test-conversation");
  });

  test("budget-gate compaction emits a correlated start/end pair with full data", async () => {
    const { provider } = createMockProvider([
      toolUseResponse("t1", "read_file", { path: "/a.txt" }),
      textResponse("done after compaction"),
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
    const before = Date.now();
    await loop.run({
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
    const after = Date.now();

    const start = events.find(
      (e): e is StartEvent => e.type === "context_compacting",
    );
    const end = events.find(
      (e): e is EndEvent => e.type === "compaction_completed",
    );
    expect(start).toBeDefined();
    expect(end).toBeDefined();

    // Pair correlation: shared id, trigger, and start timestamp.
    expect(start!.compactionId).toBe(end!.compactionId);
    expect(start!.compactionId.length).toBeGreaterThan(0);
    expect(start!.requestId).toBe("test-request");
    expect(end!.requestId).toBe("test-request");
    expect(start!.trigger).toBe("budget");
    expect(end!.trigger).toBe("budget");
    expect(end!.startedAt).toBe(start!.startedAt);

    // Timestamps bound the attempt within the run.
    expect(start!.startedAt).toBeGreaterThanOrEqual(before);
    expect(end!.finishedAt).toBeGreaterThanOrEqual(end!.startedAt);
    expect(end!.finishedAt).toBeLessThanOrEqual(after);

    // Start carries the pre-compaction history; end carries the
    // ContextWindowResult fields unnested on the event.
    expect(start!.messages.length).toBeGreaterThan(0);
    expect(end!.compacted).toBe(true);
    expect(end!.exhausted).toBe(false);

    // Start precedes end in the event stream.
    expect(events.indexOf(start!)).toBeLessThan(events.indexOf(end!));
  });
});
