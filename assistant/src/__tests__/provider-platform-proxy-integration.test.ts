import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { Services } from "../config/schemas/services.js";
import { PLATFORM_PROVIDER_META } from "../providers/platform-proxy/constants.js";
import { credentialKey } from "../security/credential-key.js";

// ---------------------------------------------------------------------------
// Mock @google/genai to capture constructor arguments for Gemini base URL
// assertions. Must be before importing the registry.
// ---------------------------------------------------------------------------
let lastGeminiConstructorOpts: Record<string, unknown> | null = null;
let lastGeminiGenerateContentStreamParams: Record<string, unknown> | null =
  null;

mock.module("@google/genai", () => ({
  GoogleGenAI: class MockGoogleGenAI {
    constructor(opts: Record<string, unknown>) {
      lastGeminiConstructorOpts = opts;
    }
    models = {
      generateContentStream: async (params: Record<string, unknown>) => {
        lastGeminiGenerateContentStreamParams = params;
        return {
          [Symbol.asyncIterator]: async function* () {
            /* no chunks */
          },
        };
      },
    };
  },
  ApiError: class FakeApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
      this.name = "ApiError";
    }
  },
}));

// ---------------------------------------------------------------------------
// Mock OpenAI SDK to capture OpenAI/Fireworks tool definitions and preserve
// constructor baseURL assertions. Must be before importing the registry.
// ---------------------------------------------------------------------------
let lastOpenAIChatParams: Record<string, unknown> | null = null;

mock.module("openai", () => {
  class FakeAPIError extends Error {
    status: number;
    headers: Record<string, string>;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
      this.headers = {};
      this.name = "APIError";
    }
  }

  class MockOpenAI {
    static APIError = FakeAPIError;
    clientOpts: Record<string, unknown>;
    baseURL: string;

    constructor(opts: Record<string, unknown>) {
      this.clientOpts = opts;
      this.baseURL = String(opts.baseURL ?? "");
    }

    chat = {
      completions: {
        create: (params: Record<string, unknown>) => {
          lastOpenAIChatParams = JSON.parse(JSON.stringify(params));
          return (async function* () {
            yield {
              choices: [
                {
                  delta: { content: "OK" },
                  finish_reason: "stop",
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 5 },
              model: "gpt-4o",
            };
          })();
        },
      },
    };
  }

  return {
    default: MockOpenAI,
  };
});

// ---------------------------------------------------------------------------
// Mock the underlying dependencies that the real context module relies on.
// This avoids mocking the context module directly and prevents mock conflicts
// with context.test.ts (which also mocks these same underlying deps).
// ---------------------------------------------------------------------------
let mockPlatformBaseUrl = "";
let mockPlatformAssistantId = "";
let mockAssistantApiKey: string | null = null;
let mockProviderKeys: Record<string, string> = {};
let mockLlmConfig: Record<string, unknown> = {};
let mockWebSearchService: Services["web-search"] = {
  mode: "your-own",
  provider: "inference-provider-native",
};

mock.module("../config/env.js", () => ({
  getPlatformBaseUrl: () => mockPlatformBaseUrl,
  getPlatformAssistantId: () => mockPlatformAssistantId,
}));

mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: async (key: string) => {
    if (key === credentialKey("vellum", "platform_base_url")) {
      return mockPlatformBaseUrl;
    }
    if (key === credentialKey("vellum", "assistant_api_key")) {
      return mockAssistantApiKey;
    }
    if (key === credentialKey("vellum", "platform_assistant_id")) {
      return mockPlatformAssistantId;
    }
    return mockProviderKeys[key] ?? null;
  },
  getProviderKeyAsync: async (provider: string) =>
    mockProviderKeys[credentialKey(provider, "api_key")] ??
    mockProviderKeys[provider] ??
    undefined,
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    llm: mockLlmConfig,
    services: {
      inference: {},
      "image-generation": {
        mode: "your-own",
        provider: "gemini",
        model: "gemini-3.1-flash-image-preview",
      },
      "web-search": mockWebSearchService,
    },
  }),
}));

mock.module("../platform/feature-gate.js", () => ({
  arePlatformFeaturesEnabled: () => true,
}));

import { type LLMConfigBase, LLMSchema } from "../config/schemas/llm.js";
import type { ProvidersConfig } from "../providers/registry.js";
import {
  getProvider,
  getProviderRoutingSource,
  initializeProviders,
  listProviders,
} from "../providers/registry.js";
import type { Message, ToolDefinition } from "../providers/types.js";

function makeProvidersConfig(
  provider: string,
  model: string,
  webSearch: Services["web-search"] = mockWebSearchService,
): ProvidersConfig {
  const baseLlm = LLMSchema.parse({});
  return {
    services: {
      inference: {},
      "image-generation": {
        mode: "your-own",
        provider: "gemini",
        model: "gemini-3.1-flash-image-preview",
      },
      "web-search": webSearch,
    },
    llm: {
      ...baseLlm,
      default: {
        ...baseLlm.default,
        provider: provider as LLMConfigBase["provider"],
        model,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PLATFORM_BASE = "https://platform.example.com";
const MANAGED_API_KEY = "ast-managed-key-123";
const PLATFORM_ASSISTANT_ID = "assistant-abc123";

const MANAGED_NATIVE_WEB_SEARCH: Services["web-search"] = {
  mode: "managed",
  provider: "inference-provider-native",
};

const DIRECT_OR_MANAGED_PROVIDER_KEYS: string[] = [
  "openai",
  "anthropic",
  "gemini",
  "fireworks",
  "openrouter",
];
const MANAGED_FALLBACK_PROVIDERS: string[] = [
  "anthropic",
  "gemini",
  "openai",
  "fireworks",
  "together",
];

function enableManagedProxy() {
  mockPlatformBaseUrl = PLATFORM_BASE;
  mockPlatformAssistantId = PLATFORM_ASSISTANT_ID;
  mockAssistantApiKey = MANAGED_API_KEY;
}

function disableManagedProxy() {
  mockPlatformBaseUrl = "";
  mockPlatformAssistantId = "";
  mockAssistantApiKey = null;
}

type ProviderWithClientBaseUrl = Record<string, unknown> & {
  client: { baseURL: string };
};

function unwrapInnermostProvider(provider: unknown): ProviderWithClientBaseUrl {
  let current = provider as Record<string, unknown>;
  while (current.inner) {
    current = current.inner as Record<string, unknown>;
  }
  return current as ProviderWithClientBaseUrl;
}

/**
 * Set mock secure keys with a user key for every provider in `names`.
 */
function setUserKeysFor(...names: string[]): void {
  mockProviderKeys = {};
  for (const n of names) {
    mockProviderKeys[credentialKey(n, "api_key")] = `user-key-${n}`;
  }
}

function userMsg(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

const sampleTools: ToolDefinition[] = [
  {
    name: "file_read",
    description: "Read a file",
    input_schema: { type: "object", properties: { path: { type: "string" } } },
  },
  {
    name: "web_search",
    description: "Search the web",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" } },
    },
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  disableManagedProxy();
  mockProviderKeys = {};
  mockWebSearchService = {
    mode: "your-own",
    provider: "inference-provider-native",
  };
  lastGeminiConstructorOpts = null;
  lastGeminiGenerateContentStreamParams = null;
  lastOpenAIChatParams = null;
  mockLlmConfig = LLMSchema.parse({}) as Record<string, unknown>;
});

describe("managed proxy integration — credential precedence", () => {
  describe("user keys present → providers use direct connections (not proxy)", () => {
    test.each(DIRECT_OR_MANAGED_PROVIDER_KEYS)(
      "%s routes via user-key when user key is provided regardless of managed context",
      async (provider: string) => {
        enableManagedProxy();
        setUserKeysFor(provider);
        await initializeProviders(makeProvidersConfig(provider, "test-model"));
        expect(listProviders()).toContain(provider);
        expect(getProviderRoutingSource(provider)).toBe("user-key");
      },
    );

    test("all five configured providers route via user-key when user keys exist", async () => {
      enableManagedProxy();
      setUserKeysFor(...DIRECT_OR_MANAGED_PROVIDER_KEYS);
      await initializeProviders(makeProvidersConfig("anthropic", "test-model"));
      const registered = listProviders();
      for (const p of DIRECT_OR_MANAGED_PROVIDER_KEYS) {
        expect(registered).toContain(p);
        expect(getProviderRoutingSource(p)).toBe("user-key");
      }
    });

    test("user keys still route via user-key when managed context is disabled", async () => {
      disableManagedProxy();
      setUserKeysFor(...DIRECT_OR_MANAGED_PROVIDER_KEYS);
      await initializeProviders(makeProvidersConfig("anthropic", "test-model"));
      const registered = listProviders();
      for (const p of DIRECT_OR_MANAGED_PROVIDER_KEYS) {
        expect(registered).toContain(p);
        expect(getProviderRoutingSource(p)).toBe("user-key");
      }
    });
  });

  describe("user keys absent + managed context available → providers use managed proxy", () => {
    test.each(MANAGED_FALLBACK_PROVIDERS)(
      "%s routes via managed-proxy when no user key",
      async (provider: string) => {
        enableManagedProxy();
        mockProviderKeys = {};
        await initializeProviders(
          makeProvidersConfig("anthropic", "test-model"),
        );
        expect(listProviders()).toContain(provider);
        expect(getProviderRoutingSource(provider)).toBe("managed-proxy");
      },
    );

    test("managed bootstrap registers anthropic, openai, gemini, fireworks, and together", async () => {
      enableManagedProxy();
      mockProviderKeys = {};
      await initializeProviders(makeProvidersConfig("anthropic", "test-model"));
      expect(listProviders()).toEqual(
        expect.arrayContaining([
          "anthropic",
          "openai",
          "gemini",
          "fireworks",
          "together",
        ]),
      );
      expect(listProviders()).toHaveLength(5);
      expect(getProviderRoutingSource("anthropic")).toBe("managed-proxy");
      expect(getProviderRoutingSource("openai")).toBe("managed-proxy");
      expect(getProviderRoutingSource("gemini")).toBe("managed-proxy");
      expect(getProviderRoutingSource("fireworks")).toBe("managed-proxy");
      expect(getProviderRoutingSource("together")).toBe("managed-proxy");
      expect(getProviderRoutingSource("openrouter")).toBeUndefined();
    });

    test("managed anthropic uses anthropic proxy path", async () => {
      enableManagedProxy();
      mockProviderKeys = {};
      await initializeProviders(
        makeProvidersConfig("anthropic", "claude-opus-4-6"),
      );

      const provider = getProvider("anthropic");

      const anthropicClient = unwrapInnermostProvider(provider).client;

      expect(anthropicClient).toBeDefined();
      const baseURL: string = anthropicClient.baseURL;
      expect(baseURL).toContain("/v1/runtime-proxy/anthropic");
    });

    test("managed openai uses openai proxy path", async () => {
      enableManagedProxy();
      mockProviderKeys = {};
      await initializeProviders(makeProvidersConfig("openai", "gpt-4o"));

      const provider = getProvider("openai");

      const openaiClient = unwrapInnermostProvider(provider).client;

      expect(openaiClient).toBeDefined();
      const baseURL: string = openaiClient.baseURL;
      expect(baseURL).toContain("/v1/runtime-proxy/openai");
    });

    test("managed gemini uses gemini proxy path", async () => {
      enableManagedProxy();
      mockProviderKeys = {};
      await initializeProviders(makeProvidersConfig("anthropic", "test-model"));

      expect(lastGeminiConstructorOpts).toBeDefined();
      const httpOptions = lastGeminiConstructorOpts!.httpOptions as
        | { baseUrl?: string }
        | undefined;
      expect(httpOptions).toBeDefined();
      expect(httpOptions!.baseUrl).toContain("/v1/runtime-proxy/gemini");
    });

    test("managed gemini receives attribution headers outside request JSON", async () => {
      enableManagedProxy();
      mockProviderKeys = {};
      mockLlmConfig = LLMSchema.parse({
        default: { provider: "gemini", model: "gemini-3.1-pro" },
        profiles: {
          "conversation-profile": {
            model: "gemini-3.1-flash",
            source: "user",
          },
        },
        callSites: {
          mainAgent: {},
        },
      }) as Record<string, unknown>;
      await initializeProviders(
        makeProvidersConfig("gemini", "gemini-3.1-pro"),
      );

      const provider = getProvider("gemini");
      const response = await provider.sendMessage(
        [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        {
          config: {
            callSite: "mainAgent",
            overrideProfile: "conversation-profile",
          },
        },
      );

      const constructorHttpOptions = lastGeminiConstructorOpts!.httpOptions as
        | { baseUrl?: string }
        | undefined;
      expect(constructorHttpOptions?.baseUrl).toContain(
        "/v1/runtime-proxy/gemini",
      );
      const sentConfig = lastGeminiGenerateContentStreamParams!.config as {
        httpOptions?: { headers?: Record<string, string> };
        usageAttributionHeaders?: Record<string, string>;
      };
      expect(sentConfig.httpOptions?.headers).toEqual({
        "X-Vellum-LLM-Call-Site": "mainAgent",
        "X-Vellum-Inference-Profile": "conversation-profile",
        "X-Vellum-Inference-Profile-Source": "conversation",
        "X-Vellum-Resolved-Provider": "gemini",
        "X-Vellum-Resolved-Model": "gemini-3.1-flash",
      });
      expect(sentConfig.usageAttributionHeaders).toBeUndefined();

      const rawRequest = response.rawRequest as {
        config?: Record<string, unknown>;
      };
      expect(rawRequest.config?.usageAttributionHeaders).toBeUndefined();
      expect(rawRequest.config?.httpOptions).toBeUndefined();
    });

    test("managed gemini omits attribution headers without callSite", async () => {
      enableManagedProxy();
      mockProviderKeys = {};
      mockLlmConfig = LLMSchema.parse({
        default: { provider: "gemini", model: "gemini-3.1-pro" },
      }) as Record<string, unknown>;
      await initializeProviders(
        makeProvidersConfig("gemini", "gemini-3.1-pro"),
      );

      const provider = getProvider("gemini");
      await provider.sendMessage(
        [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        { config: { model: "gemini-3.1-pro" } },
      );

      const sentConfig = lastGeminiGenerateContentStreamParams!.config as {
        httpOptions?: { headers?: Record<string, string> };
        usageAttributionHeaders?: Record<string, string>;
      };
      expect(sentConfig.httpOptions?.headers).toBeUndefined();
      expect(sentConfig.usageAttributionHeaders).toBeUndefined();
    });
  });

  describe("neither user keys nor managed context → providers not initialized", () => {
    test.each(DIRECT_OR_MANAGED_PROVIDER_KEYS)(
      "%s is NOT registered when no user key and no managed context",
      async (provider: string) => {
        disableManagedProxy();
        mockProviderKeys = {};
        await initializeProviders(
          makeProvidersConfig("anthropic", "test-model"),
        );
        expect(listProviders()).not.toContain(provider);
        expect(getProviderRoutingSource(provider)).toBeUndefined();
      },
    );

    test("registry is empty when no keys and no managed context (non-ollama primary)", async () => {
      disableManagedProxy();
      mockProviderKeys = {};
      await initializeProviders(makeProvidersConfig("anthropic", "test-model"));
      expect(listProviders()).toEqual([]);
    });
  });

  describe("mixed: some user keys + managed fallback fills gaps", () => {
    test("user key for anthropic routes direct and managed fallback fills openai, gemini, and fireworks", async () => {
      enableManagedProxy();
      setUserKeysFor("anthropic");
      await initializeProviders(makeProvidersConfig("anthropic", "test-model"));
      const registered = listProviders();
      expect(registered).toContain("anthropic");
      expect(getProviderRoutingSource("anthropic")).toBe("user-key");
      expect(registered).toContain("openai");
      expect(getProviderRoutingSource("openai")).toBe("managed-proxy");
      expect(registered).toContain("gemini");
      expect(getProviderRoutingSource("gemini")).toBe("managed-proxy");
      expect(registered).toContain("fireworks");
      expect(getProviderRoutingSource("fireworks")).toBe("managed-proxy");
      expect(registered).not.toContain("openrouter");
      expect(getProviderRoutingSource("openrouter")).toBeUndefined();
    });

    test("user key for openai routes direct while anthropic, gemini, and fireworks still bootstrap via managed proxy", async () => {
      enableManagedProxy();
      setUserKeysFor("openai");
      await initializeProviders(makeProvidersConfig("openai", "test-model"));
      const registered = listProviders();
      expect(registered).toContain("openai");
      expect(getProviderRoutingSource("openai")).toBe("user-key");
      expect(registered).toContain("anthropic");
      expect(getProviderRoutingSource("anthropic")).toBe("managed-proxy");
      expect(registered).toContain("gemini");
      expect(getProviderRoutingSource("gemini")).toBe("managed-proxy");
      expect(registered).toContain("fireworks");
      expect(getProviderRoutingSource("fireworks")).toBe("managed-proxy");
      expect(registered).not.toContain("openrouter");
      expect(getProviderRoutingSource("openrouter")).toBeUndefined();
    });
  });
});

describe("managed proxy integration — managed web search routing", () => {
  test("managed Fireworks/Kimi tool call completes through the platform Brave proxy", async () => {
    enableManagedProxy();
    mockProviderKeys = {};
    mockWebSearchService = MANAGED_NATIVE_WEB_SEARCH;

    const originalFetch = globalThis.fetch;
    const fetchUrls: string[] = [];
    globalThis.fetch = (async (url: URL | RequestInfo) => {
      fetchUrls.push(String(url));
      return new Response(
        JSON.stringify({
          status: 200,
          headers: { "content-type": "application/json" },
          body: {
            web: {
              results: [
                {
                  title: "Platform Result",
                  url: "https://example.com/platform-result",
                  description: "Returned by the managed Brave proxy.",
                  age: "1 day ago",
                },
              ],
            },
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as unknown as typeof fetch;

    try {
      await initializeProviders(
        makeProvidersConfig(
          "fireworks",
          "accounts/fireworks/models/kimi-k2p6",
          MANAGED_NATIVE_WEB_SEARCH,
        ),
      );

      const provider = getProvider("fireworks");
      await provider.sendMessage([userMsg("Search using managed Brave")], {
        tools: sampleTools,
      });

      const tools = lastOpenAIChatParams!.tools as Array<{
        type: string;
        function?: { name: string; description?: string };
      }>;
      expect(tools).toHaveLength(2);
      expect(tools[1]).toMatchObject({
        type: "function",
        function: {
          name: "web_search",
          description: "Search the web",
        },
      });

      const { webSearchTool } = await import("../tools/network/web-search.js");
      const result = await webSearchTool.execute(
        { query: "managed kimi query", count: 1, offset: 2, freshness: "pw" },
        {
          conversationId: "conv-123",
          workingDir: "/tmp",
          trustClass: "guardian",
        },
      );

      expect(result.isError).toBe(false);
      expect(result.content).toContain("Platform Result");
      expect(result.activityMetadata?.webSearch?.provider).toBe("brave");
      expect(result.activityMetadata?.webSearch?.resultCount).toBe(1);

      expect(fetchUrls).toEqual([
        `${PLATFORM_BASE}/v1/assistants/${PLATFORM_ASSISTANT_ID}/managed-search-proxy/brave/`,
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("managed proxy integration — ollama exclusion", () => {
  test("ollama is never registered via managed proxy fallback", async () => {
    enableManagedProxy();
    mockProviderKeys = {};
    await initializeProviders(makeProvidersConfig("anthropic", "test-model"));
    expect(listProviders()).not.toContain("ollama");
  });

  test("ollama registers only when explicitly configured as provider", async () => {
    enableManagedProxy();
    mockProviderKeys = {};
    const config = makeProvidersConfig("ollama", "test-model");
    // Disable the catalog default so resolution lands on llm.default.
    config.llm.profiles = {
      ...config.llm.profiles,
      balanced: { source: "managed", status: "disabled" },
    };
    await initializeProviders(config);
    expect(listProviders()).toContain("ollama");
  });

  test("ollama registers with explicit API key", async () => {
    enableManagedProxy();
    mockProviderKeys = { [credentialKey("ollama", "api_key")]: "ollama-key" };
    await initializeProviders(makeProvidersConfig("anthropic", "test-model"));
    expect(listProviders()).toContain("ollama");
  });

  test("ollama metadata is marked as non-managed", () => {
    const meta = PLATFORM_PROVIDER_META.ollama;
    expect(meta).toBeDefined();
    expect(meta.managed).toBe(false);
    expect(meta.proxyPath).toBeUndefined();
  });
});

describe("config mode flip → provider reinit", () => {
  test("re-running initializeProviders after managed→your-own flip switches gemini from managed-proxy to user-key", async () => {
    // Phase 1: managed mode without user key → gemini registered as managed-proxy.
    // This is the pre-patch state before PATCH /v1/config is called.
    enableManagedProxy();
    mockProviderKeys = {};
    await initializeProviders(makeProvidersConfig("gemini", "gemini-2.5-pro"));
    expect(getProviderRoutingSource("gemini")).toBe("managed-proxy");

    // Phase 2: user has now saved a key (POST /v1/secrets), then PATCHed config
    // to mode=your-own. handlePatchConfig calls initializeProviders(getConfig())
    // after saving, which should re-register gemini using the user key.
    setUserKeysFor("gemini");
    await initializeProviders(makeProvidersConfig("gemini", "gemini-2.5-pro"));
    expect(getProviderRoutingSource("gemini")).toBe("user-key");
  });

  test("without reinit after config patch, gemini source remains stale managed-proxy", async () => {
    // Demonstrates the bug: if initializeProviders is NOT called after saving
    // config, the routing source stays managed-proxy even after mode flip.
    enableManagedProxy();
    mockProviderKeys = {};
    await initializeProviders(makeProvidersConfig("gemini", "gemini-2.5-pro"));
    expect(getProviderRoutingSource("gemini")).toBe("managed-proxy");

    // Flip mode but do NOT re-initialize providers (simulates skipping reinit).
    setUserKeysFor("gemini");
    // Source stays managed-proxy because initializeProviders was not called.
    expect(getProviderRoutingSource("gemini")).toBe("managed-proxy");
  });
});

describe("managed proxy integration — constants integrity", () => {
  test("anthropic, openai, gemini, fireworks, and together have metadata with managed=true and a proxyPath", () => {
    for (const provider of [
      "anthropic",
      "openai",
      "gemini",
      "fireworks",
      "together",
    ]) {
      const meta = PLATFORM_PROVIDER_META[provider];
      expect(meta).toBeDefined();
      expect(meta.managed).toBe(true);
      expect(meta.proxyPath).toBeTruthy();
      expect(meta.proxyPath).toMatch(/^\/v1\/runtime-proxy\//);
    }
  });

  test("anthropic routes through anthropic proxy path", () => {
    expect(PLATFORM_PROVIDER_META.anthropic.proxyPath).toBe(
      "/v1/runtime-proxy/anthropic",
    );
  });

  test("gemini routes through gemini proxy path", () => {
    expect(PLATFORM_PROVIDER_META.gemini.proxyPath).toBe(
      "/v1/runtime-proxy/gemini",
    );
  });

  test("openai routes through openai proxy path", () => {
    expect(PLATFORM_PROVIDER_META.openai.proxyPath).toBe(
      "/v1/runtime-proxy/openai",
    );
  });

  test("fireworks routes through fireworks proxy path", () => {
    expect(PLATFORM_PROVIDER_META.fireworks.proxyPath).toBe(
      "/v1/runtime-proxy/fireworks",
    );
  });

  test("together routes through together proxy path", () => {
    expect(PLATFORM_PROVIDER_META.together.proxyPath).toBe(
      "/v1/runtime-proxy/together",
    );
  });

  test("openrouter is not managed proxy capable", () => {
    expect(PLATFORM_PROVIDER_META.openrouter.managed).toBe(false);
    expect(PLATFORM_PROVIDER_META.openrouter.proxyPath).toBeUndefined();
  });
});
