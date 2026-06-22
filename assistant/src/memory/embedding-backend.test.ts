import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { AssistantConfig } from "../config/types.js";
import {
  clearEmbeddingBackendCache,
  embedWithBackend,
  resetLocalEmbeddingFailureState,
  selectEmbeddingBackend,
} from "./embedding-backend.js";

const getProviderKeyAsyncMock = mock(
  async (_provider: string): Promise<string | undefined> => undefined,
);
mock.module("../security/secure-keys.js", () => ({
  getProviderKeyAsync: getProviderKeyAsyncMock,
}));

const DISABLED_PROXY_CONTEXT = {
  enabled: false,
  platformBaseUrl: "",
  assistantApiKey: "",
};
const resolveManagedProxyContextMock = mock(async () => DISABLED_PROXY_CONTEXT);
mock.module("../providers/platform-proxy/context.js", () => ({
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
