/**
 * Verifies that `RetryProvider.normalizeSendMessageOptions` drops a disabled
 * thinking config for adaptive-thinking-only models (Claude Fable), preventing
 * an Anthropic 400: Fable always reasons with always-on adaptive thinking and
 * rejects `thinking: { type: "disabled" }`.
 *
 * Effort and other parameters are unaffected, and models that genuinely support
 * disabling thinking (e.g. Opus) keep their disabled config.
 */

import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { setOverridesForTesting } from "./feature-flag-test-helpers.js";

// Legacy-shaped fixtures (llm.default-centric resolution): pinned to the
// flag-off cascade. Override-or-default (flag-on) semantics are pinned by
// llm-resolver-override-or-default.test.ts and its companion suites.
beforeAll(() => {
  setOverridesForTesting({ "override-or-default-resolution": false });
});

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

describe("retry normalization: adaptive-only thinking models", () => {
  test("drops resolved thinking: disabled for Claude Fable", async () => {
    // GIVEN a profile that disables thinking for an adaptive-only Fable model
    setLlmConfig({
      default: {
        provider: "anthropic",
        model: "claude-fable-5",
        thinking: { enabled: false },
        effort: "high",
      },
      // Disable the catalog default so resolution lands on llm.default.
      profiles: { "cost-optimized": { source: "managed", status: "disabled" } },
    });
    const { provider, lastConfig } = makePipeline("anthropic");

    // WHEN a request resolves through the call-site config
    await provider.sendMessage([userMessage], {
      config: { callSite: "memoryExtraction" },
    });

    // THEN the disabled thinking config is dropped so Fable falls back to its
    // always-on adaptive thinking instead of 400-ing
    expect(lastConfig()?.thinking).toBeUndefined();
    // AND effort is still forwarded
    expect(lastConfig()?.effort).toBe("high");
  });

  test("drops explicit thinking: disabled from pass-through callers for Fable", async () => {
    // GIVEN a pass-through caller supplying the wire-shape disabled config
    const { provider, lastConfig } = makePipeline("anthropic");

    // WHEN sending against a Fable model
    await provider.sendMessage([userMessage], {
      config: {
        model: "claude-fable-5",
        thinking: { type: "disabled" },
      },
    });

    // THEN the disabled thinking config is dropped
    expect(lastConfig()?.thinking).toBeUndefined();
  });

  test("drops disabled thinking for OpenRouter-proxied Fable", async () => {
    // GIVEN a profile disabling thinking on the OpenRouter-proxied Fable id
    setLlmConfig({
      default: {
        provider: "openrouter",
        model: "anthropic/claude-fable-5",
        thinking: { enabled: false },
      },
      // Disable the catalog default so resolution lands on llm.default.
      profiles: { "cost-optimized": { source: "managed", status: "disabled" } },
    });
    const { provider, lastConfig } = makePipeline("openrouter");

    // WHEN a request resolves through the call-site config
    await provider.sendMessage([userMessage], {
      config: { callSite: "memoryExtraction" },
    });

    // THEN the disabled thinking config is dropped
    expect(lastConfig()?.thinking).toBeUndefined();
  });

  test("preserves adaptive thinking for Fable", async () => {
    // GIVEN a profile that enables thinking for a Fable model
    setLlmConfig({
      default: {
        provider: "anthropic",
        model: "claude-fable-5",
        thinking: { enabled: true },
      },
      // Disable the catalog default so resolution lands on llm.default.
      profiles: { "cost-optimized": { source: "managed", status: "disabled" } },
    });
    const { provider, lastConfig } = makePipeline("anthropic");

    // WHEN a request resolves through the call-site config
    await provider.sendMessage([userMessage], {
      config: { callSite: "memoryExtraction" },
    });

    // THEN adaptive thinking is preserved (only disabled is dropped)
    expect(lastConfig()?.thinking).toEqual({ type: "adaptive" });
  });

  test("preserves disabled thinking for models that support disabling it", async () => {
    // GIVEN a profile disabling thinking for a non-adaptive-only model
    setLlmConfig({
      default: {
        provider: "anthropic",
        model: "claude-opus-4-7",
        thinking: { enabled: false },
      },
      // Disable the catalog default so resolution lands on llm.default.
      profiles: { "cost-optimized": { source: "managed", status: "disabled" } },
    });
    const { provider, lastConfig } = makePipeline("anthropic");

    // WHEN a request resolves through the call-site config
    await provider.sendMessage([userMessage], {
      config: { callSite: "memoryExtraction" },
    });

    // THEN the disabled thinking config is preserved for Opus
    expect(lastConfig()?.thinking).toEqual({ type: "disabled" });
  });

  test("drops non-1 temperature for Fable when thinking is disabled", async () => {
    // GIVEN a Fable profile that disables thinking and sets a non-1 temperature
    setLlmConfig({
      default: {
        provider: "anthropic",
        model: "claude-fable-5",
        thinking: { enabled: false },
        temperature: 0.7,
      },
      // Disable the catalog default so resolution lands on llm.default.
      profiles: { "cost-optimized": { source: "managed", status: "disabled" } },
    });
    const { provider, lastConfig } = makePipeline("anthropic");

    // WHEN a request resolves through the call-site config
    await provider.sendMessage([userMessage], {
      config: { callSite: "memoryExtraction" },
    });

    // THEN the disabled thinking is dropped (Fable falls back to adaptive) AND
    // the non-1 temperature is dropped, since adaptive mode requires
    // temperature: 1 — leaving it would 400 the request
    expect(lastConfig()?.thinking).toBeUndefined();
    expect(lastConfig()?.temperature).toBeUndefined();
  });

  test("drops non-1 temperature for Fable with no explicit thinking config", async () => {
    // GIVEN a pass-through caller that sets a non-1 temperature and no thinking
    const { provider, lastConfig } = makePipeline("anthropic");

    // WHEN sending against a Fable model
    await provider.sendMessage([userMessage], {
      config: {
        model: "claude-fable-5",
        temperature: 0.5,
      },
    });

    // THEN the temperature is dropped: Fable is always in adaptive mode, so the
    // temperature: 1 constraint applies even without an explicit thinking config
    expect(lastConfig()?.temperature).toBeUndefined();
  });

  test("drops non-1 temperature for OpenRouter-proxied Fable", async () => {
    // GIVEN a pass-through caller on the OpenRouter-proxied Fable id
    const { provider, lastConfig } = makePipeline("openrouter");

    // WHEN sending with a non-1 temperature and no explicit thinking config
    await provider.sendMessage([userMessage], {
      config: {
        model: "anthropic/claude-fable-5",
        temperature: 0.2,
      },
    });

    // THEN the temperature is dropped for the Anthropic-fronted Fable model
    expect(lastConfig()?.temperature).toBeUndefined();
  });

  test("preserves temperature: 1 for Fable", async () => {
    // GIVEN a Fable profile with the only adaptive-mode-valid temperature
    const { provider, lastConfig } = makePipeline("anthropic");

    // WHEN sending against a Fable model
    await provider.sendMessage([userMessage], {
      config: {
        model: "claude-fable-5",
        temperature: 1,
      },
    });

    // THEN temperature: 1 is preserved (it is valid in adaptive mode)
    expect(lastConfig()?.temperature).toBe(1);
  });
});
