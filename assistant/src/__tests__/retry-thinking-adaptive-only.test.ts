/**
 * Verifies that `RetryProvider.normalizeSendMessageOptions` drops a disabled
 * thinking config for adaptive-thinking-only models (Claude Fable), preventing
 * an Anthropic 400: Fable always reasons with always-on adaptive thinking and
 * rejects `thinking: { type: "disabled" }`.
 *
 * Effort and other parameters are unaffected, and models that genuinely support
 * disabling thinking (e.g. Opus) keep their disabled config.
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

describe("retry normalization: non-adaptive thinking models", () => {
  test("rewrites enabled thinking to budgeted shape for Sonnet 4.5", async () => {
    // GIVEN a pass-through caller enabling thinking on Sonnet 4.5, which does
    // NOT support adaptive thinking (Anthropic 400s the adaptive shape)
    const { provider, lastConfig } = makePipeline("anthropic");

    // WHEN sending with an explicit max_tokens so the budget is deterministic
    await provider.sendMessage([userMessage], {
      config: {
        model: "claude-sonnet-4-5-20250929",
        thinking: { enabled: true },
        max_tokens: 64000,
      },
    });

    // THEN the adaptive shape is rewritten to Anthropic's classic budgeted
    // shape, with a budget strictly below max_tokens
    expect(lastConfig()?.thinking).toEqual({
      type: "enabled",
      budget_tokens: 16000,
    });
  });

  test("caps the budget at half of max_tokens to preserve response headroom", async () => {
    // GIVEN a max_tokens equal to the standard 16000 budget: Anthropic counts
    // the thinking budget against max_tokens, so taking (nearly) all of it
    // would leave no room for the visible response
    const { provider, lastConfig } = makePipeline("anthropic");

    // WHEN thinking is enabled on a non-adaptive model
    await provider.sendMessage([userMessage], {
      config: {
        model: "claude-sonnet-4-5-20250929",
        thinking: { enabled: true },
        max_tokens: 16000,
      },
    });

    // THEN the budget is capped at half of max_tokens, reserving the other
    // half for the response
    expect(lastConfig()?.thinking).toEqual({
      type: "enabled",
      budget_tokens: 8000,
    });
  });

  test("clamps budget below a small max_tokens", async () => {
    // GIVEN a caller with a max_tokens below twice the default thinking budget
    const { provider, lastConfig } = makePipeline("anthropic");

    // WHEN thinking is enabled on a non-adaptive model
    await provider.sendMessage([userMessage], {
      config: {
        model: "claude-sonnet-4-5-20250929",
        thinking: { enabled: true },
        max_tokens: 4000,
      },
    });

    // THEN the budget is half of max_tokens — valid (>= 1024, < max_tokens)
    // and with headroom for the response
    expect(lastConfig()?.thinking).toEqual({
      type: "enabled",
      budget_tokens: 2000,
    });
  });

  test("emits the minimum budget at the exact-fit boundary (max_tokens 2048)", async () => {
    // GIVEN the smallest max_tokens whose half still meets Anthropic's 1024
    // minimum budget
    const { provider, lastConfig } = makePipeline("anthropic");

    // WHEN thinking is enabled on a non-adaptive model
    await provider.sendMessage([userMessage], {
      config: {
        model: "claude-sonnet-4-5-20250929",
        thinking: { enabled: true },
        max_tokens: 2048,
      },
    });

    // THEN the budget is exactly the 1024 minimum, strictly below max_tokens
    expect(lastConfig()?.thinking).toEqual({
      type: "enabled",
      budget_tokens: 1024,
    });
  });

  test("drops thinking when max_tokens cannot fit the minimum budget (1024)", async () => {
    // GIVEN max_tokens: 1024 — the old clamp produced budget_tokens: 1024 ==
    // max_tokens, which Anthropic 400s (budget must be strictly < max_tokens)
    const { provider, lastConfig } = makePipeline("anthropic");

    // WHEN thinking is enabled on a non-adaptive model
    await provider.sendMessage([userMessage], {
      config: {
        model: "claude-sonnet-4-5-20250929",
        thinking: { enabled: true },
        max_tokens: 1024,
      },
    });

    // THEN thinking is dropped: a working non-thinking response beats a
    // guaranteed 400 from an invalid budget
    expect(lastConfig()?.thinking).toBeUndefined();
  });

  test("drops thinking when max_tokens is below the minimum budget", async () => {
    // GIVEN max_tokens: 500 — no valid budget exists at all (min is 1024)
    const { provider, lastConfig } = makePipeline("anthropic");

    // WHEN thinking is enabled on a non-adaptive model
    await provider.sendMessage([userMessage], {
      config: {
        model: "claude-sonnet-4-5-20250929",
        thinking: { enabled: true },
        max_tokens: 500,
      },
    });

    // THEN thinking is dropped instead of sending an invalid shape
    expect(lastConfig()?.thinking).toBeUndefined();
  });

  test("rewrites enabled thinking to budgeted shape for OpenRouter-proxied Sonnet 4.5", async () => {
    // GIVEN the OpenRouter-proxied Sonnet 4.5 id, which delegates to the
    // Anthropic Messages API and hits the same adaptive-thinking rejection
    const { provider, lastConfig } = makePipeline("openrouter");

    // WHEN thinking is enabled
    await provider.sendMessage([userMessage], {
      config: {
        model: "anthropic/claude-sonnet-4.5",
        thinking: { enabled: true },
        max_tokens: 64000,
      },
    });

    // THEN the adaptive shape is rewritten to the budgeted shape
    expect(lastConfig()?.thinking).toEqual({
      type: "enabled",
      budget_tokens: 16000,
    });
  });

  test("preserves adaptive thinking for Opus 4.8", async () => {
    // GIVEN Opus 4.8, one of the newer families that DOES support adaptive
    // thinking
    const { provider, lastConfig } = makePipeline("anthropic");

    // WHEN thinking is enabled
    await provider.sendMessage([userMessage], {
      config: {
        model: "claude-opus-4-8",
        thinking: { enabled: true },
        max_tokens: 64000,
      },
    });

    // THEN the adaptive shape is preserved (no budgeted downgrade)
    expect(lastConfig()?.thinking).toEqual({ type: "adaptive" });
  });

  test("preserves adaptive thinking for an unknown model", async () => {
    // GIVEN a model not in the catalog: behavior must be conservative and
    // leave the adaptive shape untouched rather than guessing it needs a budget
    const { provider, lastConfig } = makePipeline("anthropic");

    // WHEN thinking is enabled
    await provider.sendMessage([userMessage], {
      config: {
        model: "claude-some-future-model",
        thinking: { enabled: true },
        max_tokens: 64000,
      },
    });

    // THEN the adaptive shape is preserved
    expect(lastConfig()?.thinking).toEqual({ type: "adaptive" });
  });

  test("rewrites enabled thinking to budgeted shape via resolved call-site config (Sonnet 4.5)", async () => {
    // GIVEN a profile mirroring the production incident: a `balanced` profile
    // pointing Sonnet 4.5 at thinking: enabled, resolved through a call site
    setLlmConfig({
      default: {
        provider: "anthropic",
        model: "claude-sonnet-4-5-20250929",
        thinking: { enabled: true },
      },
    });
    const { provider, lastConfig } = makePipeline("anthropic");

    // WHEN a request resolves through the call-site config
    await provider.sendMessage([userMessage], {
      config: { callSite: "memoryExtraction" },
    });

    // THEN thinking resolves to the budgeted shape (not adaptive), with a valid
    // budget strictly below the resolved max_tokens
    const thinking = lastConfig()?.thinking as Record<string, unknown>;
    const maxTokens = lastConfig()?.max_tokens as number;
    expect(thinking.type).toBe("enabled");
    expect(typeof thinking.budget_tokens).toBe("number");
    expect(thinking.budget_tokens as number).toBeGreaterThanOrEqual(1024);
    expect(thinking.budget_tokens as number).toBeLessThan(maxTokens);
  });

  test("preserves disabled thinking for a non-adaptive model (no budgeted rewrite)", async () => {
    // GIVEN a non-adaptive model with thinking explicitly disabled: the mirror
    // rewrite must only touch the enabled/adaptive shape, never a disabled one
    const { provider, lastConfig } = makePipeline("anthropic");

    // WHEN thinking is disabled
    await provider.sendMessage([userMessage], {
      config: {
        model: "claude-sonnet-4-5-20250929",
        thinking: { enabled: false },
        max_tokens: 64000,
      },
    });

    // THEN the disabled shape is preserved unchanged
    expect(lastConfig()?.thinking).toEqual({ type: "disabled" });
  });
});
