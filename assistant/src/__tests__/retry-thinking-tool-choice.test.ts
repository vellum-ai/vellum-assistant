/**
 * Verifies that `RetryProvider.normalizeSendMessageOptions` strips `thinking`
 * when `tool_choice` forces tool use (`type: "tool"` or `"any"`), preventing
 * Anthropic 400 errors: "Thinking may not be enabled when tool_choice forces
 * tool use."
 *
 * This is the root cause of repeated failures in memory graph operations
 * (extraction, narrative, pattern-scan, consolidation) when the user's default
 * LLM config has `thinking.enabled: true` and the call site uses forced
 * `tool_choice` without explicitly disabling thinking.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

let mockLlmConfig: Record<string, unknown> = {};

mock.module("../config/loader.js", () => ({
  getConfig: () => ({ llm: mockLlmConfig }),
}));

import { LLMSchema } from "../config/schemas/llm.js";
import { RetryProvider } from "../providers/retry.js";
import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
  ToolDefinition,
} from "../providers/types.js";

function setLlmConfig(raw: unknown): void {
  mockLlmConfig = LLMSchema.parse(raw) as Record<string, unknown>;
}

beforeEach(() => {
  mockLlmConfig = LLMSchema.parse({}) as Record<string, unknown>;
});

function makePipeline(providerName: string): {
  provider: Provider;
  lastConfig: () => Record<string, unknown> | undefined;
} {
  let captured: Record<string, unknown> | undefined;
  const inner: Provider = {
    name: providerName,
    async sendMessage(
      _messages: Message[],
      _tools?: ToolDefinition[],
      _systemPrompt?: string,
      options?: SendMessageOptions,
    ): Promise<ProviderResponse> {
      captured = options?.config as Record<string, unknown> | undefined;
      return {
        content: [],
        model: "test",
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: "stop",
      };
    },
  };
  return {
    provider: new RetryProvider(inner),
    lastConfig: () => captured,
  };
}

const userMessage: Message = {
  role: "user",
  content: [{ type: "text", text: "hi" }],
};

describe("retry normalization: thinking + forced tool_choice", () => {
  test("strips thinking when tool_choice forces a specific tool (type: 'tool')", async () => {
    setLlmConfig({
      default: {
        provider: "anthropic",
        model: "claude-opus-4-7",
        thinking: { enabled: true, streamThinking: true },
      },
    });
    const { provider, lastConfig } = makePipeline("anthropic");
    await provider.sendMessage([userMessage], undefined, undefined, {
      config: {
        callSite: "memoryExtraction",
        tool_choice: { type: "tool", name: "extract_graph_diff" },
      },
    });
    // thinking must be stripped to avoid Anthropic 400 error
    expect(lastConfig()?.thinking).toBeUndefined();
    // tool_choice must be preserved
    expect(lastConfig()?.tool_choice).toEqual({
      type: "tool",
      name: "extract_graph_diff",
    });
  });

  test("strips thinking when tool_choice type is 'any'", async () => {
    setLlmConfig({
      default: {
        provider: "anthropic",
        model: "claude-opus-4-7",
        thinking: { enabled: true },
      },
    });
    const { provider, lastConfig } = makePipeline("anthropic");
    await provider.sendMessage([userMessage], undefined, undefined, {
      config: {
        callSite: "memoryExtraction",
        tool_choice: { type: "any" },
      },
    });
    expect(lastConfig()?.thinking).toBeUndefined();
  });

  test("preserves thinking when tool_choice type is 'auto'", async () => {
    setLlmConfig({
      default: {
        provider: "anthropic",
        model: "claude-opus-4-7",
        thinking: { enabled: true },
      },
    });
    const { provider, lastConfig } = makePipeline("anthropic");
    await provider.sendMessage([userMessage], undefined, undefined, {
      config: {
        callSite: "memoryExtraction",
        tool_choice: { type: "auto" },
      },
    });
    expect(lastConfig()?.thinking).toEqual({ type: "adaptive" });
  });

  test("preserves thinking when no tool_choice is set", async () => {
    setLlmConfig({
      default: {
        provider: "anthropic",
        model: "claude-opus-4-7",
        thinking: { enabled: true },
      },
    });
    const { provider, lastConfig } = makePipeline("anthropic");
    await provider.sendMessage([userMessage], undefined, undefined, {
      config: { callSite: "memoryExtraction" },
    });
    expect(lastConfig()?.thinking).toEqual({ type: "adaptive" });
  });

  test("preserves explicit thinking: disabled with forced tool_choice", async () => {
    // Callers like the retriever explicitly set thinking: { type: "disabled" }
    // alongside forced tool_choice. This should pass through unchanged since
    // disabled thinking is compatible with forced tool_choice.
    const { provider, lastConfig } = makePipeline("anthropic");
    await provider.sendMessage([userMessage], undefined, undefined, {
      config: {
        thinking: { type: "disabled" },
        tool_choice: { type: "tool", name: "select_memories" },
      },
    });
    expect(lastConfig()?.thinking).toEqual({ type: "disabled" });
  });

  test("normalizes raw { enabled: false } from pass-through callers to wire shape", async () => {
    // Pass-through callers (e.g. host.providers.llm.complete) may forward the
    // schema-shape `{ enabled: false }` without a callSite. The normalizer must
    // convert it to Anthropic's wire shape `{ type: "disabled" }`, otherwise
    // Anthropic rejects the request with a 400 on malformed `thinking`.
    const { provider, lastConfig } = makePipeline("anthropic");
    await provider.sendMessage([userMessage], undefined, undefined, {
      config: {
        thinking: { enabled: false },
        tool_choice: { type: "tool", name: "select_memories" },
      },
    });
    expect(lastConfig()?.thinking).toEqual({ type: "disabled" });
  });

  test("preserves resolved thinking: disabled with forced tool_choice", async () => {
    setLlmConfig({
      default: {
        provider: "anthropic",
        model: "claude-opus-4-7",
        thinking: { enabled: false },
      },
    });
    const { provider, lastConfig } = makePipeline("anthropic");
    await provider.sendMessage([userMessage], undefined, undefined, {
      config: {
        callSite: "memoryExtraction",
        tool_choice: { type: "tool", name: "extract_graph_diff" },
      },
    });
    expect(lastConfig()?.thinking).toEqual({ type: "disabled" });
  });

  test("strips thinking for openrouter with anthropic model and forced tool_choice", async () => {
    setLlmConfig({
      default: {
        provider: "openrouter",
        model: "anthropic/claude-opus-4.7",
        thinking: { enabled: true },
      },
    });
    const { provider, lastConfig } = makePipeline("openrouter");
    await provider.sendMessage([userMessage], undefined, undefined, {
      config: {
        callSite: "memoryExtraction",
        tool_choice: { type: "tool", name: "extract_graph_diff" },
      },
    });
    expect(lastConfig()?.thinking).toBeUndefined();
  });

  test("preserves thinking for openrouter with non-anthropic model and forced tool_choice", async () => {
    setLlmConfig({
      default: {
        provider: "openrouter",
        model: "x-ai/grok-3-mini",
        thinking: { enabled: true },
      },
    });
    const { provider, lastConfig } = makePipeline("openrouter");
    await provider.sendMessage([userMessage], undefined, undefined, {
      config: {
        callSite: "memoryExtraction",
        tool_choice: { type: "tool", name: "extract_graph_diff" },
      },
    });
    // Non-Anthropic models on OpenRouter translate thinking into the
    // `reasoning` parameter via buildExtraCreateParams — should not be stripped
    expect(lastConfig()?.thinking).toEqual({ type: "adaptive" });
  });

  test("does not strip thinking for non-thinking-aware providers", async () => {
    // For non-thinking-aware providers, thinking is already stripped by the
    // earlier provider check — this test ensures the tool_choice check
    // doesn't interfere with that path.
    const { provider, lastConfig } = makePipeline("openai");
    await provider.sendMessage([userMessage], undefined, undefined, {
      config: {
        thinking: { type: "adaptive" },
        tool_choice: { type: "tool", name: "some_tool" },
      },
    });
    // thinking is stripped by the non-thinking-aware provider check, not
    // the tool_choice check
    expect(lastConfig()?.thinking).toBeUndefined();
  });
});
