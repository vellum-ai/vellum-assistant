/**
 * Verifies that `RetryProvider.normalizeSendMessageOptions` drops an adaptive
 * thinking config for pre-adaptive Claude models (Haiku 4.5, Opus 4.5,
 * Sonnet 4.5), preventing an Anthropic 400: these models reject
 * `thinking: { type: "adaptive" }` and only support the legacy
 * `{ type: "enabled", budget_tokens }` form, which Vellum never sends.
 *
 * The legacy budget_tokens form supplied by pass-through callers is preserved,
 * as is adaptive thinking on models that support it.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { RetryProvider } from "../providers/retry.js";
import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
} from "../providers/types.js";
import { setConfig } from "./helpers/set-config.js";

function setLlmConfig(raw: unknown): void {
  setConfig("llm", raw);
}

beforeEach(() => {
  setConfig("llm", {});
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

describe("retry normalization: pre-adaptive thinking models", () => {
  test("drops resolved thinking: enabled for Haiku 4.5", async () => {
    // GIVEN a call-site config that enables thinking for Haiku 4.5, which
    // rejects the adaptive wire shape the config normalizes to
    setLlmConfig({
      callSites: {
        memoryExtraction: {
          provider: "anthropic",
          model: "claude-haiku-4-5-20251001",
          thinking: { enabled: true },
          effort: "high",
        },
      },
    });
    const { provider, lastConfig } = makePipeline("anthropic");

    // WHEN a request resolves through the call-site config
    await provider.sendMessage([userMessage], {
      config: { callSite: "memoryExtraction" },
    });

    // THEN the adaptive thinking config is dropped so the request goes out
    // without thinking instead of 400-ing
    expect(lastConfig()?.thinking).toBeUndefined();
    // AND effort is still forwarded
    expect(lastConfig()?.effort).toBe("high");
  });

  test("drops explicit wire-shape adaptive thinking from pass-through callers for Haiku 4.5", async () => {
    // GIVEN a pass-through caller supplying the wire-shape adaptive config
    const { provider, lastConfig } = makePipeline("anthropic");

    // WHEN sending against Haiku 4.5
    await provider.sendMessage([userMessage], {
      config: {
        model: "claude-haiku-4-5-20251001",
        thinking: { type: "adaptive" },
      },
    });

    // THEN the adaptive thinking config is dropped
    expect(lastConfig()?.thinking).toBeUndefined();
  });

  test("preserves legacy budget_tokens thinking for Haiku 4.5", async () => {
    // GIVEN a pass-through caller supplying the legacy budget form, which
    // Haiku 4.5 does support
    const { provider, lastConfig } = makePipeline("anthropic");

    // WHEN sending against Haiku 4.5
    await provider.sendMessage([userMessage], {
      config: {
        model: "claude-haiku-4-5-20251001",
        thinking: { type: "enabled", budget_tokens: 4096 },
      },
    });

    // THEN the legacy config is forwarded untouched
    expect(lastConfig()?.thinking).toEqual({
      type: "enabled",
      budget_tokens: 4096,
    });
  });

  test("drops adaptive thinking for OpenRouter-proxied Haiku 4.5", async () => {
    // GIVEN a call-site config enabling thinking on the OpenRouter-proxied
    // Haiku id
    setLlmConfig({
      callSites: {
        memoryExtraction: {
          provider: "openrouter",
          model: "anthropic/claude-haiku-4.5",
          thinking: { enabled: true },
        },
      },
    });
    const { provider, lastConfig } = makePipeline("openrouter");

    // WHEN a request resolves through the call-site config
    await provider.sendMessage([userMessage], {
      config: { callSite: "memoryExtraction" },
    });

    // THEN the adaptive thinking config is dropped
    expect(lastConfig()?.thinking).toBeUndefined();
  });

  test("drops adaptive thinking for Opus 4.5 and Sonnet 4.5", async () => {
    for (const model of [
      "claude-opus-4-5-20251101",
      "claude-sonnet-4-5-20250929",
    ]) {
      const { provider, lastConfig } = makePipeline("anthropic");

      await provider.sendMessage([userMessage], {
        config: { model, thinking: { type: "adaptive" } },
      });

      expect(lastConfig()?.thinking).toBeUndefined();
    }
  });

  test("drops adaptive thinking for undated model aliases", async () => {
    // Anthropic serves undated aliases for dated catalog IDs, and profiles
    // and the CLI accept either form (inference.help.ts advertises
    // `--model claude-haiku-4-5`)
    for (const model of [
      "claude-haiku-4-5",
      "claude-opus-4-5",
      "claude-sonnet-4-5",
    ]) {
      const { provider, lastConfig } = makePipeline("anthropic");

      await provider.sendMessage([userMessage], {
        config: { model, thinking: { type: "adaptive" } },
      });

      expect(lastConfig()?.thinking).toBeUndefined();
    }
  });

  test("preserves adaptive thinking for models that support it", async () => {
    // GIVEN a call-site config that enables thinking for Opus 4.8
    setLlmConfig({
      callSites: {
        memoryExtraction: {
          provider: "anthropic",
          model: "claude-opus-4-8",
          thinking: { enabled: true },
        },
      },
    });
    const { provider, lastConfig } = makePipeline("anthropic");

    // WHEN a request resolves through the call-site config
    await provider.sendMessage([userMessage], {
      config: { callSite: "memoryExtraction" },
    });

    // THEN adaptive thinking is preserved
    expect(lastConfig()?.thinking).toEqual({ type: "adaptive" });
  });
});
