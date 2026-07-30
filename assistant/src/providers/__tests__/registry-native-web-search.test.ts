import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  setSystemTime,
  test,
} from "bun:test";

import { LLMSchema } from "../../config/schemas/llm.js";
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
  // Every test passes an explicit `opts.model`, so the llm config only needs
  // to be schema-valid — resolution is never consulted for the model here.
  return {
    services: {
      inference: {},
      "image-generation": {
        provider: "gemini",
        model: "gemini-3.1-flash-image-preview",
      },
      "web-search": {
        provider: "inference-provider-native",
      },
    },
    llm: LLMSchema.parse({}),
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

describe("resolveProviderFromConnection connection cache TTL", () => {
  beforeEach(() => {
    adapterCalls.length = 0;
    clearConnectionProviderCache();
    setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    // Restore the real clock so later suites are not frozen.
    setSystemTime();
  });

  test("serves a cached provider within the TTL, re-resolves after it expires", async () => {
    // First resolution: a cache miss builds an adapter.
    await resolveProviderFromConnection(openRouterConnection, makeConfig(), {
      model: "anthropic/claude-opus-4-7",
    });
    expect(adapterCalls).toHaveLength(1);

    // A second resolution 59s later is a cache hit — no new adapter, so the
    // baked-in credential is reused.
    setSystemTime(new Date("2026-01-01T00:00:59Z"));
    await resolveProviderFromConnection(openRouterConnection, makeConfig(), {
      model: "anthropic/claude-opus-4-7",
    });
    expect(adapterCalls).toHaveLength(1);

    // Past the 60s TTL the entry is stale: the next resolution re-reads the
    // credential and rebuilds the adapter, so a key rotated out-of-band is
    // picked up without any explicit cache invalidation.
    setSystemTime(new Date("2026-01-01T00:01:01Z"));
    await resolveProviderFromConnection(openRouterConnection, makeConfig(), {
      model: "anthropic/claude-opus-4-7",
    });
    expect(adapterCalls).toHaveLength(2);
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
