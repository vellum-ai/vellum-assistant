/**
 * Unit tests for the `llmCall` pipeline wrapping (PR 15).
 *
 * Exercises the three behaviors the plan calls out:
 *
 * 1. The default `llmCall` pipeline delegates to `provider.sendMessage(...)`
 *    and returns its response unchanged.
 * 2. A spy middleware registered for `llmCall` observes the full argument
 *    payload before the provider is called.
 * 3. A short-circuit middleware synthesizes a `ProviderResponse` and prevents
 *    the real `provider.sendMessage` from running.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import type { TrustContext } from "../daemon/conversation-runtime-assembly.js";
import { defaultLlmCallPlugin } from "../plugins/defaults/llm-call.js";
import { DEFAULT_TIMEOUTS, runPipeline } from "../plugins/pipeline.js";
import {
  getMiddlewaresFor,
  registerPlugin,
  resetPluginRegistryForTests,
} from "../plugins/registry.js";
import type {
  LLMCallArgs,
  LLMCallResult,
  Middleware,
  Plugin,
  TurnContext,
} from "../plugins/types.js";
import type {
  Message,
  Provider,
  ProviderResponse,
  ToolDefinition,
} from "../providers/types.js";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const trust: TrustContext = {
  sourceChannel: "vellum",
  trustClass: "guardian",
};

function makeCtx(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    requestId: "req-test",
    conversationId: "conv-test",
    turnIndex: 0,
    trust,
    ...overrides,
  };
}

function makeResponse(
  overrides: Partial<ProviderResponse> = {},
): ProviderResponse {
  return {
    content: [{ type: "text", text: "hello from provider" }],
    model: "fake-model",
    usage: {
      inputTokens: 10,
      outputTokens: 5,
    },
    stopReason: "end_turn",
    ...overrides,
  };
}

type FakeProviderCall = {
  messages: Message[];
  tools?: ToolDefinition[];
  systemPrompt?: string;
};

function makeFakeProvider(
  response: ProviderResponse = makeResponse(),
): Provider & { calls: FakeProviderCall[] } {
  const calls: FakeProviderCall[] = [];
  return {
    name: "fake-provider",
    calls,
    async sendMessage(messages, tools, systemPrompt, _options) {
      calls.push({ messages, tools, systemPrompt });
      return response;
    },
  };
}

function makeArgs(
  provider: Provider,
  overrides: Partial<LLMCallArgs> = {},
): LLMCallArgs {
  return {
    provider,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: undefined,
    systemPrompt: "you are a helpful assistant",
    options: { config: {} },
    ...overrides,
  };
}

// The terminal passed into `runPipeline` matches the one in `agent/loop.ts`:
// it delegates straight to `args.provider.sendMessage(...)` with no
// transformation. Keeping it identical here means the test exercises the
// exact call shape the real loop uses.
const terminal = (args: LLMCallArgs): Promise<LLMCallResult> =>
  args.provider.sendMessage(
    args.messages,
    args.tools,
    args.systemPrompt,
    args.options,
  );

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("llmCall pipeline", () => {
  beforeEach(() => {
    resetPluginRegistryForTests();
  });

  // Clear the registry on the way out too so later test files in the same
  // `bun test` run don't inherit `llmCall` middleware from our final test.
  // Bun runs files sequentially within a process; `beforeEach` only clears
  // at the start of each case, leaving whatever the final test registered
  // in place for the next file.
  afterAll(() => {
    resetPluginRegistryForTests();
  });

  test("default pipeline invokes provider.sendMessage and returns its response", async () => {
    registerPlugin(defaultLlmCallPlugin);

    const expected = makeResponse({ model: "expected-model" });
    const provider = makeFakeProvider(expected);
    const args = makeArgs(provider);

    const result = await runPipeline<LLMCallArgs, LLMCallResult>(
      "llmCall",
      getMiddlewaresFor("llmCall"),
      terminal,
      args,
      makeCtx(),
      DEFAULT_TIMEOUTS.llmCall,
    );

    expect(result).toBe(expected);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]!.messages).toBe(args.messages);
    expect(provider.calls[0]!.systemPrompt).toBe("you are a helpful assistant");
  });

  test("spy middleware records the full invocation arguments", async () => {
    const observed: LLMCallArgs[] = [];
    const spyPlugin: Plugin = {
      manifest: {
        name: "spy-llm",
        version: "0.0.1",
        requires: { pluginRuntime: "v1" },
      },
      middleware: {
        llmCall: async (args, next, _ctx) => {
          observed.push(args);
          return next(args);
        },
      },
    };

    registerPlugin(spyPlugin);
    registerPlugin(defaultLlmCallPlugin);

    const provider = makeFakeProvider();
    const tools: ToolDefinition[] = [
      {
        name: "echo",
        description: "echoes its input",
        input_schema: { type: "object" },
      },
    ];
    const args = makeArgs(provider, { tools });

    await runPipeline<LLMCallArgs, LLMCallResult>(
      "llmCall",
      getMiddlewaresFor("llmCall"),
      terminal,
      args,
      makeCtx(),
      DEFAULT_TIMEOUTS.llmCall,
    );

    expect(observed).toHaveLength(1);
    expect(observed[0]!.provider).toBe(provider);
    expect(observed[0]!.messages).toBe(args.messages);
    expect(observed[0]!.tools).toBe(tools);
    expect(observed[0]!.systemPrompt).toBe("you are a helpful assistant");
    expect(provider.calls).toHaveLength(1);
  });

  test("short-circuit middleware prevents the real provider call", async () => {
    const synthetic = makeResponse({
      model: "synthetic-model",
      content: [{ type: "text", text: "synthesized" }],
    });

    const shortCircuit: Middleware<LLMCallArgs, LLMCallResult> = async (
      _args,
      _next,
      _ctx,
    ) => synthetic;

    const shortCircuitPlugin: Plugin = {
      manifest: {
        name: "short-circuit-llm",
        version: "0.0.1",
        requires: { pluginRuntime: "v1" },
      },
      middleware: { llmCall: shortCircuit },
    };

    registerPlugin(shortCircuitPlugin);
    registerPlugin(defaultLlmCallPlugin);

    const provider = makeFakeProvider();
    const args = makeArgs(provider);

    const result = await runPipeline<LLMCallArgs, LLMCallResult>(
      "llmCall",
      getMiddlewaresFor("llmCall"),
      terminal,
      args,
      makeCtx(),
      DEFAULT_TIMEOUTS.llmCall,
    );

    expect(result).toBe(synthetic);
    // The short-circuit middleware never calls `next`, so the terminal and
    // every downstream middleware (including the default) are skipped and
    // the provider is never contacted.
    expect(provider.calls).toHaveLength(0);
  });
});
