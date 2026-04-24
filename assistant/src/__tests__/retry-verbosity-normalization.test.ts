/**
 * Verifies that `RetryProvider.normalizeSendMessageOptions` plumbs
 * `verbosity` only to providers that consume it (OpenAI) and strips it for
 * every other provider — so strict-schema clients (Anthropic, …) never see
 * the unknown field on the wire.
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

describe("retry normalization for verbosity", () => {
  test("forwards verbosity on the outbound config for openai", async () => {
    setLlmConfig({
      default: {
        provider: "openai",
        model: "gpt-5.5",
        verbosity: "high",
      },
    });
    const { provider, lastConfig } = makePipeline("openai");
    await provider.sendMessage([userMessage], undefined, undefined, {
      config: { callSite: "mainAgent" },
    });
    expect(lastConfig()?.verbosity).toBe("high");
  });

  test("strips verbosity from config for anthropic provider", async () => {
    const { provider, lastConfig } = makePipeline("anthropic");
    await provider.sendMessage([userMessage], undefined, undefined, {
      config: { verbosity: "low" },
    });
    expect(lastConfig()?.verbosity).toBe(undefined);
  });

  test("strips verbosity from config for openrouter provider", async () => {
    const { provider, lastConfig } = makePipeline("openrouter");
    await provider.sendMessage([userMessage], undefined, undefined, {
      config: { verbosity: "low" },
    });
    expect(lastConfig()?.verbosity).toBe(undefined);
  });

  test("call-site override replaces default verbosity", async () => {
    setLlmConfig({
      default: {
        provider: "openai",
        model: "gpt-5.5",
        verbosity: "low",
      },
      callSites: {
        mainAgent: { verbosity: "high" },
      },
    });
    const { provider, lastConfig } = makePipeline("openai");
    await provider.sendMessage([userMessage], undefined, undefined, {
      config: { callSite: "mainAgent" },
    });
    expect(lastConfig()?.verbosity).toBe("high");
  });

  test("per-call explicit verbosity overrides resolved call-site value", async () => {
    setLlmConfig({
      default: {
        provider: "openai",
        model: "gpt-5.5",
        verbosity: "low",
      },
      callSites: {
        mainAgent: { verbosity: "medium" },
      },
    });
    const { provider, lastConfig } = makePipeline("openai");
    await provider.sendMessage([userMessage], undefined, undefined, {
      config: { callSite: "mainAgent", verbosity: "high" },
    });
    expect(lastConfig()?.verbosity).toBe("high");
  });
});
