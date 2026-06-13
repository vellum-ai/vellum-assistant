/**
 * Verifies that `RetryProvider.normalizeSendMessageOptions` reroutes Claude
 * Fable (`claude-fable-5`) invocations to Claude Opus 4.8 (`claude-opus-4-8`)
 * when the `emergency-fable-reroute` feature flag is enabled, and leaves every
 * other model — and Fable itself while the flag is off — untouched.
 *
 * The reroute runs before the model-specific wire normalization, so the
 * rerouted (non-adaptive) Opus model keeps a `thinking: { disabled }` config
 * that Fable would otherwise have had stripped.
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

let rerouteFlagEnabled = false;

mock.module("../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: (key: string) =>
    key === "emergency-fable-reroute" ? rerouteFlagEnabled : false,
  getAssistantFeatureFlagValue: (key: string) =>
    key === "emergency-fable-reroute" ? rerouteFlagEnabled : false,
}));

import { LLMSchema } from "../config/schemas/llm.js";
import { RetryProvider } from "../providers/retry.js";
import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
} from "../providers/types.js";

function setLlmConfig(raw: unknown): void {
  mockLlmConfig = LLMSchema.parse(raw) as Record<string, unknown>;
}

beforeEach(() => {
  mockLlmConfig = LLMSchema.parse({}) as Record<string, unknown>;
  rerouteFlagEnabled = false;
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

describe("retry normalization: emergency fable reroute", () => {
  test("reroutes pass-through Fable to Opus 4.8 when the flag is enabled", async () => {
    // GIVEN the emergency reroute flag is enabled
    rerouteFlagEnabled = true;
    const { provider, lastConfig } = makePipeline("anthropic");

    // WHEN a pass-through caller targets Claude Fable directly
    await provider.sendMessage([userMessage], {
      config: { model: "claude-fable-5" },
    });

    // THEN the invocation is rerouted to Claude Opus 4.8
    expect(lastConfig()?.model).toBe("claude-opus-4-8");
  });

  test("reroutes call-site-resolved Fable to Opus 4.8 when the flag is enabled", async () => {
    // GIVEN a profile that resolves an adaptive-only Fable model
    rerouteFlagEnabled = true;
    setLlmConfig({
      default: { provider: "anthropic", model: "claude-fable-5" },
    });
    const { provider, lastConfig } = makePipeline("anthropic");

    // WHEN a request resolves the model through its call site
    await provider.sendMessage([userMessage], {
      config: { callSite: "memoryExtraction" },
    });

    // THEN the resolved Fable model is rerouted to Claude Opus 4.8
    expect(lastConfig()?.model).toBe("claude-opus-4-8");
  });

  test("leaves Fable untouched when the flag is disabled", async () => {
    // GIVEN the emergency reroute flag is disabled (registry default)
    const { provider, lastConfig } = makePipeline("anthropic");

    // WHEN a pass-through caller targets Claude Fable directly
    await provider.sendMessage([userMessage], {
      config: { model: "claude-fable-5" },
    });

    // THEN the invocation stays on Claude Fable
    expect(lastConfig()?.model).toBe("claude-fable-5");
  });

  test("leaves non-Fable models untouched when the flag is enabled", async () => {
    // GIVEN the emergency reroute flag is enabled
    rerouteFlagEnabled = true;
    const { provider, lastConfig } = makePipeline("anthropic");

    // WHEN a pass-through caller targets a non-Fable model
    await provider.sendMessage([userMessage], {
      config: { model: "claude-opus-4-7" },
    });

    // THEN the model is unchanged
    expect(lastConfig()?.model).toBe("claude-opus-4-7");
  });

  test("does not reroute the OpenRouter-proxied Fable id", async () => {
    // GIVEN the emergency reroute flag is enabled
    rerouteFlagEnabled = true;
    const { provider, lastConfig } = makePipeline("openrouter");

    // WHEN a caller targets the OpenRouter-proxied Fable id (no Opus 4.8 there)
    await provider.sendMessage([userMessage], {
      config: { model: "anthropic/claude-fable-5" },
    });

    // THEN the OpenRouter id is left untouched
    expect(lastConfig()?.model).toBe("anthropic/claude-fable-5");
  });

  test("preserves disabled thinking on the rerouted Opus model", async () => {
    // GIVEN the flag is enabled and a Fable call disables thinking — a config
    // Fable would normally have stripped because it is adaptive-thinking-only
    rerouteFlagEnabled = true;
    const { provider, lastConfig } = makePipeline("anthropic");

    // WHEN sending against Claude Fable with thinking disabled
    await provider.sendMessage([userMessage], {
      config: { model: "claude-fable-5", thinking: { type: "disabled" } },
    });

    // THEN the model is rerouted to Opus 4.8 AND the disabled thinking config
    // survives, since Opus 4.8 supports disabling thinking
    expect(lastConfig()?.model).toBe("claude-opus-4-8");
    expect(lastConfig()?.thinking).toEqual({ type: "disabled" });
  });
});
