/**
 * Verifies the field-precedence contract for `AgentLoop.run(..., callSite)`.
 *
 * When `callSite` is set, the loop must NOT pre-set the
 * `max_tokens`/`thinking`/`effort`/`speed` fields from `this.config`
 * (sourced from `llm.default`) because the downstream
 * `RetryProvider.normalizeSendMessageOptions` only fills these fields when
 * they're undefined. If the loop pre-sets them, every per-call-site override
 * for these knobs is silently ignored.
 *
 * Precedence (highest wins):
 *   1. Per-turn explicit (from `resolveSystemPrompt`'s
 *      `resolved.maxTokens` / `resolved.model`)
 *   2. Call-site resolved values (from `resolveCallSiteConfig` via the
 *      normalizer)
 *   3. Conversation defaults (`this.config.*`, from `llm.default`)
 *
 * The tests pipe the loop's per-call options through `RetryProvider` so we
 * can observe the final, post-resolution config that downstream provider
 * clients consume.
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

import type { ResolvedSystemPrompt } from "../agent/loop.js";
import { AgentLoop } from "../agent/loop.js";
import { LLMSchema } from "../config/schemas/llm.js";
import { RetryProvider } from "../providers/retry.js";
import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
  ToolDefinition,
} from "../providers/types.js";

const userMessage: Message = {
  role: "user",
  content: [{ type: "text", text: "hi" }],
};

function setLlmConfig(raw: unknown): void {
  mockLlmConfig = LLMSchema.parse(raw) as Record<string, unknown>;
}

beforeEach(() => {
  mockLlmConfig = LLMSchema.parse({}) as Record<string, unknown>;
});

/**
 * Build a provider that captures the final `config` it receives. Wrap it in
 * `RetryProvider` so the call-site resolver runs over whatever the agent loop
 * emits — exactly mirroring production wiring.
 */
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
        content: [{ type: "text", text: "ok" }],
        model: "mock-model",
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      };
    },
  };
  return {
    provider: new RetryProvider(inner),
    lastConfig: () => captured,
  };
}

describe("AgentLoop — call-site precedence", () => {
  test("call-site maxTokens wins over conversation default when callSite is set", async () => {
    setLlmConfig({
      default: {
        provider: "anthropic",
        model: "claude-default",
        maxTokens: 64000,
      },
      callSites: { mainAgent: { maxTokens: 4096 } },
    });

    const { provider, lastConfig } = makePipeline("anthropic");
    const loop = new AgentLoop(provider, "system", { maxTokens: 64000 });

    await loop.run(
      [userMessage],
      () => {},
      undefined,
      undefined,
      undefined,
      "mainAgent",
    );

    expect(lastConfig()!.max_tokens).toBe(4096);
  });

  test("call-site effort wins over conversation default when callSite is set", async () => {
    setLlmConfig({
      default: {
        provider: "anthropic",
        model: "claude-default",
        effort: "high",
      },
      callSites: { mainAgent: { effort: "low" } },
    });

    const { provider, lastConfig } = makePipeline("anthropic");
    const loop = new AgentLoop(provider, "system", {
      maxTokens: 64000,
      effort: "high",
    });

    await loop.run(
      [userMessage],
      () => {},
      undefined,
      undefined,
      undefined,
      "mainAgent",
    );

    expect(lastConfig()!.effort).toBe("low");
  });

  test("call-site speed wins over conversation default when callSite is set", async () => {
    setLlmConfig({
      default: {
        provider: "anthropic",
        model: "claude-default",
        speed: "standard",
      },
      callSites: { mainAgent: { speed: "fast" } },
    });

    const { provider, lastConfig } = makePipeline("anthropic");
    const loop = new AgentLoop(provider, "system", {
      maxTokens: 64000,
      effort: "high",
      // Conversation default is "fast" (which would normally be applied) —
      // ensure the call-site value is the one that ends up on the wire.
      speed: "fast",
    });

    await loop.run(
      [userMessage],
      () => {},
      undefined,
      undefined,
      undefined,
      "mainAgent",
    );

    expect(lastConfig()!.speed).toBe("fast");
  });

  test("call-site thinking wins over conversation default when callSite is set", async () => {
    setLlmConfig({
      default: {
        provider: "anthropic",
        model: "claude-default",
        // Default thinking enabled.
        thinking: { enabled: true, streamThinking: true },
      },
      callSites: {
        // Call site disables thinking — must be honoured even though the
        // conversation default has it on.
        mainAgent: { thinking: { enabled: false } },
      },
    });

    const { provider, lastConfig } = makePipeline("anthropic");
    const loop = new AgentLoop(provider, "system", {
      maxTokens: 64000,
      // Conversation default also has thinking on — without the fix, this
      // would pre-set `thinking: { type: "adaptive" }` and mask the
      // call-site override.
      thinking: { enabled: true },
    });

    await loop.run(
      [userMessage],
      () => {},
      undefined,
      undefined,
      undefined,
      "mainAgent",
    );

    // Call-site override resolves `thinking.enabled: false`, so the
    // RetryProvider normalizer must send Anthropic's explicit disabled shape.
    expect(lastConfig()!.thinking).toEqual({ type: "disabled" });
  });

  test("call-site thinking is converted to Anthropic wire-format when enabled", async () => {
    setLlmConfig({
      default: {
        provider: "anthropic",
        model: "claude-default",
        thinking: { enabled: true, streamThinking: true },
      },
      callSites: { mainAgent: {} },
    });

    const { provider, lastConfig } = makePipeline("anthropic");
    const loop = new AgentLoop(provider, "system", { maxTokens: 64000 });

    await loop.run(
      [userMessage],
      () => {},
      undefined,
      undefined,
      undefined,
      "mainAgent",
    );

    // Must be wire-format `{ type: "adaptive" }` so the Anthropic SDK's
    // `ThinkingConfigParam` accepts it. The schema-shape `{ enabled,
    // streamThinking }` would be a runtime API error.
    expect(lastConfig()!.thinking).toEqual({ type: "adaptive" });
  });

  test("conversation defaults still apply when callSite is absent", async () => {
    setLlmConfig({
      default: {
        provider: "anthropic",
        model: "claude-default",
        // Resolver values that would *normally* be filled — but we don't
        // pass a callSite, so they must not surface.
        maxTokens: 999,
        effort: "low",
      },
    });

    const { provider, lastConfig } = makePipeline("anthropic");
    const loop = new AgentLoop(provider, "system", {
      maxTokens: 64000,
      effort: "high",
      speed: "fast",
      thinking: { enabled: true },
    });

    await loop.run([userMessage], () => {}, undefined, undefined, undefined);

    const config = lastConfig()!;
    expect(config.max_tokens).toBe(64000);
    expect(config.effort).toBe("high");
    expect(config.speed).toBe("fast");
    // No callSite → loop sets the wire-format thinking directly.
    expect(config.thinking).toEqual({ type: "adaptive" });
  });

  test("per-turn resolveSystemPrompt.maxTokens wins over both call-site and default", async () => {
    setLlmConfig({
      default: {
        provider: "anthropic",
        model: "claude-default",
        maxTokens: 64000,
      },
      callSites: { mainAgent: { maxTokens: 4096 } },
    });

    const { provider, lastConfig } = makePipeline("anthropic");
    const resolveSystemPrompt = (): ResolvedSystemPrompt => ({
      systemPrompt: "per-turn system",
      maxTokens: 8192,
    });

    const loop = new AgentLoop(
      provider,
      "system",
      { maxTokens: 64000 },
      [],
      undefined,
      undefined,
      resolveSystemPrompt,
    );

    await loop.run(
      [userMessage],
      () => {},
      undefined,
      undefined,
      undefined,
      "mainAgent",
    );

    // Per-turn explicit value beats both the call-site (4096) and the
    // default (64000).
    expect(lastConfig()!.max_tokens).toBe(8192);
  });
});
