/**
 * Verifies that `config.overrideProfile` on `SendMessageOptions` plumbs an
 * ad-hoc profile through both the `RetryProvider` normalization step (which
 * resolves model/maxTokens/effort/etc.) and the `CallSiteRoutingProvider`
 * provider-selection step.
 *
 * The end-to-end contract: a caller setting
 * `config.overrideProfile = "fast"` on a single send must see the request
 * land on the profile's provider with the profile's model — without
 * modifying the workspace's `activeProfile` or any call-site entry. This
 * makes per-conversation pinned profiles (PR 6+) work.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

// Mutable LLM config consumed by the resolver via `getConfig()`.
let mockLlmConfig: Record<string, unknown> = {};

mock.module("../config/loader.js", () => ({
  getConfig: () => ({ llm: mockLlmConfig }),
}));

import { LLMSchema } from "../config/schemas/llm.js";
import { CallSiteRoutingProvider } from "../providers/call-site-routing.js";
import { RetryProvider } from "../providers/retry.js";
import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
  ToolDefinition,
} from "../providers/types.js";

const DUMMY_MESSAGES: Message[] = [
  { role: "user", content: [{ type: "text", text: "hi" }] },
];

function makeResponse(model: string): ProviderResponse {
  return {
    content: [{ type: "text", text: "ok" }],
    model,
    usage: { inputTokens: 1, outputTokens: 1 },
    stopReason: "end_turn",
  };
}

function setLlmConfig(raw: unknown): void {
  mockLlmConfig = LLMSchema.parse(raw) as Record<string, unknown>;
}

beforeEach(() => {
  mockLlmConfig = LLMSchema.parse({}) as Record<string, unknown>;
});

describe("SendMessageOptions.config.overrideProfile", () => {
  test("RetryProvider resolves model from named profile when overrideProfile is set", async () => {
    setLlmConfig({
      default: { provider: "anthropic", model: "claude-opus-4-7" },
      profiles: {
        fast: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
      },
    });

    let captured: Record<string, unknown> | undefined;
    const inner: Provider = {
      name: "anthropic",
      async sendMessage(
        _messages: Message[],
        _tools?: ToolDefinition[],
        _systemPrompt?: string,
        options?: SendMessageOptions,
      ): Promise<ProviderResponse> {
        captured = options?.config as Record<string, unknown> | undefined;
        return makeResponse("anthropic");
      },
    };

    const provider = new RetryProvider(inner);
    await provider.sendMessage(DUMMY_MESSAGES, undefined, undefined, {
      config: { callSite: "mainAgent", overrideProfile: "fast" },
    });

    // The override profile's model should win over `llm.default.model`.
    expect(captured?.model).toBe("claude-haiku-4-5-20251001");
    // `overrideProfile` is a routing key — it must not leak to the provider.
    expect(captured?.overrideProfile).toBeUndefined();
    // `callSite` is also stripped post-resolve.
    expect(captured?.callSite).toBeUndefined();
  });

  test("CallSiteRoutingProvider switches transport when overrideProfile changes the provider", async () => {
    setLlmConfig({
      default: { provider: "anthropic", model: "claude-opus-4-7" },
      profiles: {
        fast: { provider: "openai", model: "gpt-5.4" },
      },
    });

    const calls = { default: 0, alt: 0 };
    const defaultProvider: Provider = {
      name: "anthropic",
      async sendMessage() {
        calls.default++;
        return makeResponse("anthropic");
      },
    };
    const altProvider: Provider = {
      name: "openai",
      async sendMessage() {
        calls.alt++;
        return makeResponse("openai");
      },
    };

    const wrapped = new CallSiteRoutingProvider(defaultProvider, (name) =>
      name === "openai" ? altProvider : undefined,
    );

    const response = await wrapped.sendMessage(
      DUMMY_MESSAGES,
      undefined,
      undefined,
      { config: { callSite: "mainAgent", overrideProfile: "fast" } },
    );

    expect(calls.default).toBe(0);
    expect(calls.alt).toBe(1);
    expect(response.model).toBe("openai");
  });

  test("missing overrideProfile name silently falls through to base resolution", async () => {
    setLlmConfig({
      default: { provider: "anthropic", model: "claude-opus-4-7" },
      profiles: {
        fast: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
      },
    });

    let captured: Record<string, unknown> | undefined;
    const inner: Provider = {
      name: "anthropic",
      async sendMessage(
        _messages: Message[],
        _tools?: ToolDefinition[],
        _systemPrompt?: string,
        options?: SendMessageOptions,
      ): Promise<ProviderResponse> {
        captured = options?.config as Record<string, unknown> | undefined;
        return makeResponse("anthropic");
      },
    };

    const provider = new RetryProvider(inner);
    await provider.sendMessage(DUMMY_MESSAGES, undefined, undefined, {
      config: { callSite: "mainAgent", overrideProfile: "does-not-exist" },
    });

    // Falls through to `llm.default.model` since the named profile isn't found.
    expect(captured?.model).toBe("claude-opus-4-7");
  });

  test("absent overrideProfile leaves prior resolution behavior intact", async () => {
    setLlmConfig({
      default: { provider: "anthropic", model: "claude-opus-4-7" },
      profiles: {
        fast: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
      },
    });

    let captured: Record<string, unknown> | undefined;
    const inner: Provider = {
      name: "anthropic",
      async sendMessage(
        _messages: Message[],
        _tools?: ToolDefinition[],
        _systemPrompt?: string,
        options?: SendMessageOptions,
      ): Promise<ProviderResponse> {
        captured = options?.config as Record<string, unknown> | undefined;
        return makeResponse("anthropic");
      },
    };

    const provider = new RetryProvider(inner);
    await provider.sendMessage(DUMMY_MESSAGES, undefined, undefined, {
      config: { callSite: "mainAgent" },
    });

    expect(captured?.model).toBe("claude-opus-4-7");
  });

  test("overrideProfile is stripped even when callSite is absent", async () => {
    let captured: Record<string, unknown> | undefined;
    const inner: Provider = {
      name: "anthropic",
      async sendMessage(
        _messages: Message[],
        _tools?: ToolDefinition[],
        _systemPrompt?: string,
        options?: SendMessageOptions,
      ): Promise<ProviderResponse> {
        captured = options?.config as Record<string, unknown> | undefined;
        return makeResponse("anthropic");
      },
    };

    const provider = new RetryProvider(inner);
    await provider.sendMessage(DUMMY_MESSAGES, undefined, undefined, {
      config: { overrideProfile: "fast" },
    });

    // `overrideProfile` must never leak as a wire-format field, even when no
    // callSite is set (the resolver never runs, but the leak guard still
    // applies).
    expect(captured?.overrideProfile).toBeUndefined();
  });
});
