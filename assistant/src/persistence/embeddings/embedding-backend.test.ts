import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { AssistantConfig } from "../../config/types.js";
import {
  clearEmbeddingBackendCache,
  customEmbeddingSpaceIdentity,
  embedWithBackend,
  isEmbeddingDimensionAvailable,
  resetLocalEmbeddingFailureState,
  resolveBackendDimension,
  selectEmbeddingBackend,
} from "./embedding-backend.js";
import {
  _resetEmbeddingBillingBreaker,
  recordBillingBlock,
} from "./embedding-billing-breaker.js";
import { _setBypassWorkerForTests } from "./embedding-gemini.js";
import { OpenAIEmbeddingBackend } from "./embedding-openai.js";

const getProviderKeyAsyncMock = mock(
  async (_provider: string): Promise<string | undefined> => undefined,
);
mock.module("../../security/secure-keys.js", () => ({
  getProviderKeyAsync: getProviderKeyAsyncMock,
}));

const DISABLED_PROXY_CONTEXT = {
  enabled: false,
  platformBaseUrl: "",
  assistantApiKey: "",
};
const resolveManagedProxyContextMock = mock(async () => DISABLED_PROXY_CONTEXT);
mock.module("../../providers/platform-proxy/context.js", () => ({
  resolveManagedProxyContext: resolveManagedProxyContextMock,
  hasManagedProxyPrereqs: mock(async () => false),
  buildManagedBaseUrl: mock(async () => undefined),
  managedFallbackEnabledFor: mock(async () => false),
}));

const LOCAL_CONFIG = {
  memory: {
    embeddings: {
      provider: "local",
      localModel: "BAAI/bge-small-en-v1.5",
    },
  },
} as unknown as AssistantConfig;

describe("embedding backend cache invalidation", () => {
  afterEach(() => {
    clearEmbeddingBackendCache();
  });

  test("clearEmbeddingBackendCache disposes cached backends before clearing", async () => {
    const firstSelection = await selectEmbeddingBackend(LOCAL_CONFIG);
    expect(firstSelection.backend).not.toBeNull();

    const dispose = mock();
    (firstSelection.backend as { dispose?: () => void }).dispose = dispose;

    clearEmbeddingBackendCache();

    expect(dispose).toHaveBeenCalledTimes(1);

    const secondSelection = await selectEmbeddingBackend(LOCAL_CONFIG);
    expect(secondSelection.backend).not.toBe(firstSelection.backend);
  });

  test("resetLocalEmbeddingFailureState preserves live cached backends", async () => {
    const firstSelection = await selectEmbeddingBackend(LOCAL_CONFIG);
    expect(firstSelection.backend).not.toBeNull();

    const dispose = mock();
    (firstSelection.backend as { dispose?: () => void }).dispose = dispose;

    resetLocalEmbeddingFailureState();

    expect(dispose).not.toHaveBeenCalled();

    const secondSelection = await selectEmbeddingBackend(LOCAL_CONFIG);
    expect(secondSelection.backend).toBe(firstSelection.backend);
  });

  test("resetLocalEmbeddingFailureState clears poisoned local backend retry state", async () => {
    const firstSelection = await selectEmbeddingBackend(LOCAL_CONFIG);
    expect(firstSelection.backend).not.toBeNull();

    const poisonedInitPromise = Promise.reject(new Error("poisoned"));
    poisonedInitPromise.catch(() => {});

    const backend = firstSelection.backend as unknown as {
      delegate: unknown;
      initPromise: Promise<unknown> | null;
    };
    backend.delegate = null;
    backend.initPromise = poisonedInitPromise;

    resetLocalEmbeddingFailureState();

    expect(backend.initPromise).toBeNull();

    const secondSelection = await selectEmbeddingBackend(LOCAL_CONFIG);
    expect(secondSelection.backend).toBe(firstSelection.backend);
  });
});

describe("isEmbeddingDimensionAvailable", () => {
  afterEach(() => {
    clearEmbeddingBackendCache();
    _resetEmbeddingBillingBreaker();
    getProviderKeyAsyncMock.mockReset();
    getProviderKeyAsyncMock.mockImplementation(async () => undefined);
  });

  function localConfigWithVectorSize(vectorSize: number): AssistantConfig {
    return {
      memory: {
        enabled: true,
        embeddings: {
          provider: "local",
          localModel: "BAAI/bge-small-en-v1.5",
          required: false,
        },
        qdrant: { vectorSize },
      },
    } as unknown as AssistantConfig;
  }

  /** Stub the selected backend's `embed` so the dimension probe is deterministic. */
  async function stubSelectedBackendProbeDim(
    config: AssistantConfig,
    dim: number,
  ): Promise<ReturnType<typeof mock>> {
    const { backend } = await selectEmbeddingBackend(config);
    if (!backend) {
      throw new Error("expected a backend to be selected");
    }
    const embedMock = mock(async () => [new Array(dim).fill(0)]);
    (backend as { embed: typeof backend.embed }).embed =
      embedMock as unknown as typeof backend.embed;
    return embedMock;
  }

  test("returns true when the reachable backend matches the committed dimension", async () => {
    const config = localConfigWithVectorSize(384);
    await stubSelectedBackendProbeDim(config, 384);

    expect(await isEmbeddingDimensionAvailable(config)).toBe(true);
  });

  test("returns false when the reachable backend's dimension differs from the committed one", async () => {
    // 3072-dim collection committed, but only a 384-dim backend is reachable.
    const config = localConfigWithVectorSize(3072);
    await stubSelectedBackendProbeDim(config, 384);

    expect(await isEmbeddingDimensionAvailable(config)).toBe(false);
  });

  test("returns false when the backend probe throws (unreachable)", async () => {
    const config = localConfigWithVectorSize(384);
    const { backend } = await selectEmbeddingBackend(config);
    if (!backend) {
      throw new Error("expected a backend to be selected");
    }
    (backend as { embed: typeof backend.embed }).embed = (async () => {
      throw new Error("backend unreachable");
    }) as unknown as typeof backend.embed;

    expect(await isEmbeddingDimensionAvailable(config)).toBe(false);
  });

  test("memoizes the probe so repeated calls embed only once", async () => {
    const config = localConfigWithVectorSize(384);
    const embedMock = await stubSelectedBackendProbeDim(config, 384);

    expect(await isEmbeddingDimensionAvailable(config)).toBe(true);
    expect(await isEmbeddingDimensionAvailable(config)).toBe(true);

    expect(embedMock).toHaveBeenCalledTimes(1);
  });

  test("returns false when memory is disabled", async () => {
    const config = {
      memory: {
        enabled: false,
        embeddings: { provider: "local", localModel: "m", required: false },
        qdrant: { vectorSize: 384 },
      },
    } as unknown as AssistantConfig;

    expect(await isEmbeddingDimensionAvailable(config)).toBe(false);
  });

  test("under auto, returns true when a configured fallback matches the committed dimension", async () => {
    // Primary (local) produces 384, the committed collection is 3072, and a
    // configured OpenAI fallback produces 3072. `embedWithBackend` would fall
    // through to the fallback, so dense recall must stay available rather than
    // being disabled because only the primary mismatches.
    getProviderKeyAsyncMock.mockImplementation(async (p: string) =>
      p === "openai" ? "sk-test" : undefined,
    );
    const config = {
      // `selectFallbackBackends` probes ollama via `resolveCallSiteConfig`, which
      // reads `llm.default`; provide a minimal one so the fallback chain builds.
      llm: { default: {} },
      memory: {
        enabled: true,
        embeddings: {
          provider: "auto",
          localModel: "BAAI/bge-small-en-v1.5",
          openaiModel: "text-embedding-3-small",
          required: false,
        },
        qdrant: { vectorSize: 3072 },
      },
    } as unknown as AssistantConfig;

    // Stub the primary (local) → 384.
    const { backend: primary } = await selectEmbeddingBackend(config);
    if (!primary) {
      throw new Error("expected a primary backend");
    }
    (primary as { embed: typeof primary.embed }).embed = mock(async () => [
      new Array(384).fill(0),
    ]) as unknown as typeof primary.embed;

    // Warm + stub the OpenAI fallback instance (cached by provider:model, so the
    // chain probe inside isEmbeddingDimensionAvailable reuses this stub) → 3072.
    const { backend: openai } = await selectEmbeddingBackend({
      memory: {
        embeddings: {
          provider: "openai",
          openaiModel: "text-embedding-3-small",
        },
        qdrant: { vectorSize: 3072 },
      },
    } as unknown as AssistantConfig);
    if (!openai) {
      throw new Error("expected an openai fallback backend");
    }
    (openai as { embed: typeof openai.embed }).embed = mock(async () => [
      new Array(3072).fill(0),
    ]) as unknown as typeof openai.embed;

    expect(await isEmbeddingDimensionAvailable(config)).toBe(true);
  });

  test("returns false (and does not probe) when the billing breaker is open", async () => {
    const config = localConfigWithVectorSize(384);
    const embedMock = await stubSelectedBackendProbeDim(config, 384);

    recordBillingBlock(); // open the breaker

    expect(await isEmbeddingDimensionAvailable(config)).toBe(false);
    // The probe is skipped entirely so a depleted-billing breaker is not
    // hammered with per-lane dimension probes.
    expect(embedMock).toHaveBeenCalledTimes(0);
  });
});

const GEMINI_CONFIG = {
  memory: {
    embeddings: {
      provider: "gemini",
      geminiModel: "test-model",
    },
    qdrant: {
      vectorSize: 3,
    },
  },
} as unknown as AssistantConfig;

const ENABLED_PROXY_CONTEXT = {
  enabled: true,
  platformBaseUrl: "https://proxy.example.com",
  assistantApiKey: "stale-platform-key",
};

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("managed-proxy Gemini fallback to direct key", () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof mock>;

  beforeEach(() => {
    // Force in-process HTTP so globalThis.fetch mocks are visible to the backend.
    _setBypassWorkerForTests(true);
    clearEmbeddingBackendCache();
    // Managed-proxy requests (proxy.example.com) are rejected like a platform
    // proxy with a bad credential; direct Google API requests succeed.
    fetchMock = mock(async (url: string | URL) => {
      if (String(url).startsWith("https://proxy.example.com/")) {
        return jsonResponse({ detail: "Invalid or revoked API key." }, 403);
      }
      return jsonResponse({ embedding: { values: [0.1, 0.2, 0.3] } }, 200);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _setBypassWorkerForTests(false);
    clearEmbeddingBackendCache();
    getProviderKeyAsyncMock.mockReset();
    getProviderKeyAsyncMock.mockImplementation(async () => undefined);
    resolveManagedProxyContextMock.mockReset();
    resolveManagedProxyContextMock.mockImplementation(
      async () => DISABLED_PROXY_CONTEXT,
    );
  });

  test("falls back to the direct key when the managed-proxy primary fails", async () => {
    resolveManagedProxyContextMock.mockImplementation(
      async () => ENABLED_PROXY_CONTEXT,
    );
    getProviderKeyAsyncMock.mockImplementation(async (provider) =>
      provider === "gemini" ? "direct-key" : undefined,
    );

    const result = await embedWithBackend(GEMINI_CONFIG, ["hello world"]);

    expect(result.provider).toBe("gemini");
    expect(result.vectors).toEqual([[0.1, 0.2, 0.3]]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [managedUrl, managedInit] = fetchMock.mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(managedUrl).toBe(
      "https://proxy.example.com/v1/runtime-proxy/gemini/v1beta/models/test-model:embedContent",
    );
    expect(
      (managedInit.headers as Record<string, string>)["Authorization"],
    ).toBe("Bearer stale-platform-key");
    const [directUrl] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(directUrl).toContain("generativelanguage.googleapis.com");
    expect(directUrl).toContain("key=direct-key");
  });

  test("surfaces the managed-proxy error when no direct key exists", async () => {
    resolveManagedProxyContextMock.mockImplementation(
      async () => ENABLED_PROXY_CONTEXT,
    );

    await expect(
      embedWithBackend(GEMINI_CONFIG, ["hello world"]),
    ).rejects.toThrow(/403/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("uses the direct key as primary when the managed proxy is disabled", async () => {
    getProviderKeyAsyncMock.mockImplementation(async (provider) =>
      provider === "gemini" ? "direct-key" : undefined,
    );

    const result = await embedWithBackend(GEMINI_CONFIG, ["another input"]);

    expect(result.vectors).toEqual([[0.1, 0.2, 0.3]]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [directUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(directUrl).toContain("generativelanguage.googleapis.com");
    expect(directUrl).toContain("key=direct-key");
  });
});

function customConfig(overrides: {
  baseUrl?: string;
  customModel?: string;
  customDimensions?: number;
}): AssistantConfig {
  return {
    memory: {
      embeddings: {
        provider: "custom",
        customModel: overrides.customModel ?? "text-embedding-3-small",
        baseUrl: overrides.baseUrl,
        customDimensions: overrides.customDimensions,
      },
    },
  } as unknown as AssistantConfig;
}

describe("custom OpenAI-compatible embedding backend selection", () => {
  afterEach(() => {
    clearEmbeddingBackendCache();
    getProviderKeyAsyncMock.mockReset();
    getProviderKeyAsyncMock.mockImplementation(async () => undefined);
  });

  test("selects a custom backend with a trimmed baseUrl", async () => {
    getProviderKeyAsyncMock.mockImplementation(async (provider) =>
      provider === "custom" ? "gw-key" : undefined,
    );
    const { backend, reason } = await selectEmbeddingBackend(
      customConfig({
        baseUrl: "http://127.0.0.1:4000/v1/",
        customModel: "embed-mistral",
        customDimensions: 1024,
      }),
    );
    expect(reason).toBeNull();
    expect(backend).toBeInstanceOf(OpenAIEmbeddingBackend);
    expect(backend?.provider).toBe("custom");
    expect(backend?.model).toBe("embed-mistral");
    expect((backend as OpenAIEmbeddingBackend).baseURL).toBe(
      "http://127.0.0.1:4000/v1",
    );
    expect((backend as OpenAIEmbeddingBackend).dimensions).toBe(1024);
  });

  test("selects a custom backend without an API key", async () => {
    const { backend, reason } = await selectEmbeddingBackend(
      customConfig({ baseUrl: "http://127.0.0.1:1234/v1" }),
    );
    expect(reason).toBeNull();
    expect(backend?.provider).toBe("custom");
  });

  test("is not configured when baseUrl is missing", async () => {
    const { backend, reason } = await selectEmbeddingBackend(customConfig({}));
    expect(backend).toBeNull();
    expect(reason).toMatch(/baseUrl/);
  });

  test("is not configured when baseUrl is not http(s)", async () => {
    const { backend, reason } = await selectEmbeddingBackend(
      customConfig({ baseUrl: "not-a-url" }),
    );
    expect(backend).toBeNull();
    expect(reason).toMatch(/baseUrl/);
  });

  test("is not selected by auto even when baseUrl is set", async () => {
    const { backend } = await selectEmbeddingBackend({
      memory: {
        embeddings: {
          provider: "auto",
          localModel: "BAAI/bge-small-en-v1.5",
          baseUrl: "http://127.0.0.1:4000/v1",
          customModel: "embed-mistral",
        },
      },
    } as unknown as AssistantConfig);
    expect(backend?.provider).toBe("local");
  });

  test("caches custom backends by baseUrl", async () => {
    const first = await selectEmbeddingBackend(
      customConfig({ baseUrl: "http://127.0.0.1:4000/v1" }),
    );
    const second = await selectEmbeddingBackend(
      customConfig({ baseUrl: "http://127.0.0.1:4001/v1" }),
    );
    const firstAgain = await selectEmbeddingBackend(
      customConfig({ baseUrl: "http://127.0.0.1:4000/v1" }),
    );
    expect(first.backend).not.toBe(second.backend);
    expect(firstAgain.backend).toBe(first.backend);
  });

  test("caches custom backends by requested dimensions", async () => {
    const first = await selectEmbeddingBackend(
      customConfig({
        baseUrl: "http://127.0.0.1:4000/v1",
        customDimensions: 1024,
      }),
    );
    const second = await selectEmbeddingBackend(
      customConfig({
        baseUrl: "http://127.0.0.1:4000/v1",
        customDimensions: 1536,
      }),
    );
    expect(first.backend).not.toBe(second.backend);
  });

  test("dimension probes for custom backends are keyed by baseUrl", async () => {
    const { backend: first } = await selectEmbeddingBackend(
      customConfig({ baseUrl: "http://127.0.0.1:4000/v1" }),
    );
    const { backend: second } = await selectEmbeddingBackend(
      customConfig({ baseUrl: "http://127.0.0.1:4001/v1" }),
    );
    if (!first || !second) {
      throw new Error("expected custom backends");
    }
    (first as { embed: typeof first.embed }).embed = mock(async () => [
      new Array(1536).fill(0),
    ]) as unknown as typeof first.embed;
    (second as { embed: typeof second.embed }).embed = mock(async () => [
      new Array(1024).fill(0),
    ]) as unknown as typeof second.embed;

    expect(await resolveBackendDimension(first)).toBe(1536);
    expect(await resolveBackendDimension(second)).toBe(1024);
  });

  test("customEmbeddingSpaceIdentity includes model, url, and dimensions", () => {
    expect(
      customEmbeddingSpaceIdentity(
        customConfig({
          baseUrl: "http://127.0.0.1:4000/v1/",
          customModel: "embed-mistral",
          customDimensions: 1024,
        }),
      ),
    ).toBe("custom\0embed-mistral\0url=http://127.0.0.1:4000/v1\0dim=1024");
  });

  test("customEmbeddingSpaceIdentity is null when the provider is not custom", () => {
    expect(
      customEmbeddingSpaceIdentity({
        memory: {
          embeddings: {
            provider: "openai",
            openaiModel: "text-embedding-3-small",
            baseUrl: "http://127.0.0.1:4000/v1",
          },
        },
      } as unknown as AssistantConfig),
    ).toBeNull();
  });
});
