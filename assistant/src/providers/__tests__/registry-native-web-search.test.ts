import { beforeEach, describe, expect, mock, test } from "bun:test";

import { type LLMConfigBase, LLMSchema } from "../../config/schemas/llm.js";
import type { ProviderConnection } from "../inference/auth.js";
import type { ProvidersConfig } from "../registry.js";

const adapterCalls: Array<{
  connection: ProviderConnection;
  opts: { model: string; useNativeWebSearch?: boolean };
}> = [];

mock.module("../inference/resolve-auth.js", () => ({
  resolveAuth: async () => ({
    ok: true,
    resolved: {
      kind: "header",
      headers: { Authorization: "Bearer test-provider-key" },
    },
  }),
}));

mock.module("../inference/adapter-factory.js", () => ({
  buildProviderAdapter: () => null,
  createAdapterFromConnection: (
    connection: ProviderConnection,
    _resolvedAuth: unknown,
    opts: { model: string; useNativeWebSearch?: boolean },
  ) => {
    adapterCalls.push({ connection, opts });
    return {
      name: connection.provider,
      sendMessage: async () => ({
        content: [],
        model: opts.model,
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: "stop",
      }),
    };
  },
}));

import {
  clearConnectionProviderCache,
  isNativeWebSearchCapableProvider,
  resolveProviderFromConnection,
} from "../registry.js";

function makeConfig(): ProvidersConfig {
  const baseLlm = LLMSchema.parse({});
  return {
    services: {
      inference: {},
      "image-generation": {
        mode: "your-own",
        provider: "gemini",
        model: "gemini-3.1-flash-image-preview",
      },
      "web-search": {
        mode: "managed",
        provider: "inference-provider-native",
      },
    },
    llm: {
      ...baseLlm,
      default: {
        ...baseLlm.default,
        provider: "openrouter" as LLMConfigBase["provider"],
        model: "x-ai/grok-4.20",
      },
    },
  };
}

const openRouterConnection: ProviderConnection = {
  name: "openrouter-personal",
  provider: "openrouter",
  auth: { type: "api_key", credential: "credential/openrouter/api_key" },
  label: "OpenRouter",
  baseUrl: null,
  models: null,
  createdAt: 1,
  updatedAt: 1,
  isManaged: false,
};

describe("resolveProviderFromConnection native web search selection", () => {
  beforeEach(() => {
    adapterCalls.length = 0;
    clearConnectionProviderCache();
  });

  test("uses the routed OpenRouter Anthropic model when enabling native web search", async () => {
    await resolveProviderFromConnection(openRouterConnection, makeConfig(), {
      model: "anthropic/claude-opus-4-7",
    });

    expect(adapterCalls).toHaveLength(1);
    expect(adapterCalls[0].opts).toMatchObject({
      model: "anthropic/claude-opus-4-7",
      useNativeWebSearch: true,
    });
  });

  test("keeps OpenRouter native web search model-specific across cached connections", async () => {
    await resolveProviderFromConnection(openRouterConnection, makeConfig(), {
      model: "x-ai/grok-4.20",
    });
    await resolveProviderFromConnection(openRouterConnection, makeConfig(), {
      model: "anthropic/claude-opus-4-7",
    });

    expect(adapterCalls.map((call) => call.opts)).toEqual([
      expect.objectContaining({
        model: "x-ai/grok-4.20",
        useNativeWebSearch: false,
      }),
      expect.objectContaining({
        model: "anthropic/claude-opus-4-7",
        useNativeWebSearch: true,
      }),
    ]);
  });
});

describe("isNativeWebSearchCapableProvider gateway anthropic routing", () => {
  test("vercel-ai-gateway anthropic/* models are capable", () => {
    expect(
      isNativeWebSearchCapableProvider(
        "vercel-ai-gateway",
        "anthropic/claude-opus-4-7",
      ),
    ).toBe(true);
  });

  test("vercel-ai-gateway non-Anthropic models are not capable", () => {
    expect(
      isNativeWebSearchCapableProvider("vercel-ai-gateway", "x-ai/grok-4.20"),
    ).toBe(false);
  });
});
