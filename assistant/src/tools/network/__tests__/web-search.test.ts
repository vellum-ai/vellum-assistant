import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { WEB_SEARCH_BACKEND_FAILURE_MESSAGE } from "../web-search-error.js";

// Mutable mock state - set per test
let mockWebSearchProvider: string | undefined = "perplexity";
let mockWebSearchMode: string | undefined = "your-own";
let mockBraveSecureKey: string | undefined;
let mockPerplexitySecureKey: string | undefined;
let mockTavilySecureKey: string | undefined;
let mockFirecrawlSecureKey: string | undefined;
let mockKeenableSecureKey: string | undefined;
let mockManagedSearchProxyResult: any;
let mockManagedSearchProxyCalls: Array<{
  provider: string;
  request: Record<string, unknown>;
  signal?: AbortSignal;
}> = [];

mock.module("../../../config/loader.js", () => ({
  getConfig: () => ({
    services: {
      "web-search": {
        mode: mockWebSearchMode,
        provider: mockWebSearchProvider,
      },
    },
  }),
}));

mock.module("../../../security/secure-keys.js", () => ({
  getProviderKeyAsync: async (provider: string) => {
    if (provider === "brave") return mockBraveSecureKey;
    if (provider === "perplexity") return mockPerplexitySecureKey;
    if (provider === "tavily") return mockTavilySecureKey;
    if (provider === "firecrawl") return mockFirecrawlSecureKey;
    if (provider === "keenable") return mockKeenableSecureKey;
    return undefined;
  },
}));

const realLogger = await import("../../../util/logger.js");
mock.module("../../../util/logger.js", () => ({
  ...realLogger,
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../../../permissions/types.js", () => ({
  RiskLevel: { Low: "low", Medium: "medium", High: "high" },
}));

mock.module("../managed-search-proxy.js", () => ({
  callManagedSearchProxy: async (
    provider: string,
    request: Record<string, unknown>,
    signal?: AbortSignal,
  ) => {
    mockManagedSearchProxyCalls.push({ provider, request, signal });
    return mockManagedSearchProxyResult;
  },
}));

// Import after the mocks above so the module under test sees them.
const { webSearchTool } = await import("../web-search.js");

describe("web_search tool", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    mockWebSearchProvider = "perplexity";
    mockWebSearchMode = "your-own";
    mockBraveSecureKey = undefined;
    mockPerplexitySecureKey = undefined;
    mockTavilySecureKey = undefined;
    mockFirecrawlSecureKey = undefined;
    mockKeenableSecureKey = undefined;
    mockManagedSearchProxyCalls = [];
    mockManagedSearchProxyResult = {
      ok: true,
      status: 200,
      headers: { "content-type": "application/json" },
      body: { web: { results: [] } },
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // Return type is `any` so assertions can poke at provider-specific
  // metadata shapes without narrowing at every site.
  function execute(input: Record<string, unknown>, context: any = {}): any {
    return webSearchTool.execute(input, context);
  }

  // ---- Input validation ---------------------------------------------------

  test("rejects missing query", async () => {
    const result = await execute({});
    expect(result.isError).toBe(true);
    expect(result.content).toContain("query is required");
  });

  test("rejects non-string query", async () => {
    const result = await execute({ query: 42 });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("query is required");
  });

  // ---- No API key configured ----------------------------------------------

  test("returns error when no API key is available", async () => {
    const result = await execute({ query: "test" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("No web search API key configured");
  });

  // ---- Perplexity provider ------------------------------------------------

  test("executes Perplexity search successfully", async () => {
    mockPerplexitySecureKey = "pplx-test-key";
    globalThis.fetch = (async (_url: string, _init?: RequestInit) => {
      return new Response(
        JSON.stringify({
          choices: [
            { message: { content: "Perplexity answer about TypeScript" } },
          ],
          citations: ["https://typescriptlang.org", "https://example.com/ts"],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as any;

    const result = await execute({ query: "what is TypeScript" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Perplexity answer about TypeScript");
    expect(result.content).toContain("Sources:");
    expect(result.content).toContain("typescriptlang.org");
  });

  test("Perplexity sends correct request format", async () => {
    mockPerplexitySecureKey = "pplx-test-key";
    let capturedUrl = "";
    let capturedBody: any = null;
    let capturedHeaders: any = null;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init?.body as string);
      capturedHeaders = new Headers(init?.headers);
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "answer" } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as any;

    await execute({ query: "test query" });
    expect(capturedUrl).toContain("perplexity.ai");
    expect(capturedBody.model).toBe("sonar");
    expect(capturedBody.messages[0].content).toBe("test query");
    expect(capturedHeaders.get("authorization")).toBe("Bearer pplx-test-key");
  });

  test("Perplexity returns no results message when response is empty", async () => {
    mockPerplexitySecureKey = "pplx-test-key";
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ choices: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as any;

    const result = await execute({ query: "obscure query" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("No results found");
  });

  test("Perplexity handles 401/403 auth errors", async () => {
    mockPerplexitySecureKey = "bad-key";
    globalThis.fetch = (async () => {
      return new Response("Unauthorized", { status: 401 });
    }) as any;

    const result = await execute({ query: "test" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Invalid or expired Perplexity API key");
  });

  test("Perplexity handles 429 rate limit after max retries", async () => {
    mockPerplexitySecureKey = "pplx-key";
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount++;
      return new Response("Too Many Requests", {
        status: 429,
        headers: { "retry-after": "0" },
      });
    }) as any;

    const result = await execute({ query: "test" });
    expect(result.isError).toBe(true);
    // Post-retry rate limits surface the friendly recoverable copy (ATL-727).
    expect(result.content).toBe(WEB_SEARCH_BACKEND_FAILURE_MESSAGE);
    // 1 initial + 3 retries = 4 calls
    expect(callCount).toBe(4);
  });

  test("Perplexity handles generic server error", async () => {
    mockPerplexitySecureKey = "pplx-key";
    globalThis.fetch = (async () => {
      return new Response("Internal Server Error", { status: 500 });
    }) as any;

    const result = await execute({ query: "test" });
    expect(result.isError).toBe(true);
    // 5xx is a backend failure -> friendly recoverable copy, no raw status.
    expect(result.content).toBe(WEB_SEARCH_BACKEND_FAILURE_MESSAGE);
    expect(result.content).not.toContain("500");
  });

  // ---- Brave provider -----------------------------------------------------

  test("executes Brave search successfully", async () => {
    mockWebSearchProvider = "brave";
    mockBraveSecureKey = "brave-test-key";
    globalThis.fetch = (async (_url: string) => {
      return new Response(
        JSON.stringify({
          web: {
            results: [
              {
                title: "Result 1",
                url: "https://example.com/1",
                description: "First result",
                age: "2 days ago",
              },
              {
                title: "Result 2",
                url: "https://example.com/2",
                description: "Second result",
                extra_snippets: ["Extra info"],
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as any;

    const result = await execute({ query: "test search" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Result 1");
    expect(result.content).toContain("https://example.com/1");
    expect(result.content).toContain("2 days ago");
    expect(result.content).toContain("Result 2");
    expect(result.content).toContain("Extra info");
  });

  test("Brave sends correct query parameters", async () => {
    mockWebSearchProvider = "brave";
    mockBraveSecureKey = "brave-key";
    let capturedUrl = "";
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ web: { results: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as any;

    await execute({
      query: "test query",
      count: 5,
      offset: 2,
      freshness: "pw",
    });
    const parsed = new URL(capturedUrl);
    expect(parsed.searchParams.get("q")).toBe("test query");
    expect(parsed.searchParams.get("count")).toBe("5");
    expect(parsed.searchParams.get("offset")).toBe("2");
    expect(parsed.searchParams.get("freshness")).toBe("pw");
  });

  test("Brave clamps count and offset", async () => {
    mockWebSearchProvider = "brave";
    mockBraveSecureKey = "brave-key";
    let capturedUrl = "";
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ web: { results: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as any;

    await execute({ query: "test", count: 100, offset: 50 });
    const parsed = new URL(capturedUrl);
    expect(parsed.searchParams.get("count")).toBe("20");
    expect(parsed.searchParams.get("offset")).toBe("9");
  });

  test("Brave skips invalid freshness values", async () => {
    mockWebSearchProvider = "brave";
    mockBraveSecureKey = "brave-key";
    let capturedUrl = "";
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ web: { results: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as any;

    await execute({ query: "test", freshness: "invalid" });
    const parsed = new URL(capturedUrl);
    expect(parsed.searchParams.has("freshness")).toBe(false);
  });

  test("Brave handles empty results", async () => {
    mockWebSearchProvider = "brave";
    mockBraveSecureKey = "brave-key";
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ web: { results: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as any;

    const result = await execute({ query: "no results for this" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("No results found");
  });

  test("Brave handles 401 auth error", async () => {
    mockWebSearchProvider = "brave";
    mockBraveSecureKey = "bad-key";
    globalThis.fetch = (async () => {
      return new Response("Forbidden", { status: 403 });
    }) as any;

    const result = await execute({ query: "test" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Invalid or expired Brave Search API key");
  });

  test("Brave handles 429 rate limit with Retry-After header", async () => {
    mockWebSearchProvider = "brave";
    mockBraveSecureKey = "brave-key";
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount++;
      if (callCount <= 3) {
        return new Response("Rate Limited", {
          status: 429,
          headers: { "retry-after": "0" },
        });
      }
      return new Response(
        JSON.stringify({
          web: {
            results: [
              {
                title: "Success",
                url: "https://example.com",
                description: "Got it",
              },
            ],
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as any;

    const result = await execute({ query: "test" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Success");
    expect(callCount).toBe(4);
  });

  // ---- Managed Brave provider -------------------------------------------

  test("managed mode uses Brave proxy without BYOK provider keys", async () => {
    mockWebSearchMode = "managed";
    mockWebSearchProvider = "inference-provider-native";
    mockManagedSearchProxyResult = {
      ok: true,
      status: 200,
      headers: { "content-type": "application/json" },
      body: {
        web: {
          results: [
            {
              title: "Managed Result",
              url: "https://example.com/managed",
              description: "Managed Brave result",
            },
          ],
        },
      },
    };

    const result = await execute({
      query: "managed query",
      count: 5,
      offset: 2,
      freshness: "pw",
    });

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Managed Result");
    expect(mockManagedSearchProxyCalls).toHaveLength(1);
    expect(mockManagedSearchProxyCalls[0]).toMatchObject({
      provider: "brave",
      request: {
        method: "GET",
        path: "/res/v1/web/search",
        query: {
          q: "managed query",
          count: "5",
          offset: "2",
          freshness: "pw",
        },
        headers: {
          Accept: "application/json",
        },
        body: null,
      },
    });
  });

  test("managed Brave formats results like direct Brave", async () => {
    const braveBody = {
      web: {
        results: [
          {
            title: "Same Result",
            url: "https://example.com/same",
            description: "Same description",
            age: "1 day ago",
            extra_snippets: ["Same snippet"],
          },
        ],
      },
    };

    mockWebSearchMode = "your-own";
    mockWebSearchProvider = "brave";
    mockBraveSecureKey = "brave-key";
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify(braveBody), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as any;

    const directResult = await execute({ query: "same query" });

    mockWebSearchMode = "managed";
    mockBraveSecureKey = undefined;
    mockManagedSearchProxyResult = {
      ok: true,
      status: 200,
      headers: { "content-type": "application/json" },
      body: braveBody,
    };

    const managedResult = await execute({ query: "same query" });

    expect(managedResult.isError).toBe(false);
    expect(managedResult.content).toBe(directResult.content);
    expect(managedResult.activityMetadata.webSearch.results).toEqual(
      directResult.activityMetadata.webSearch.results,
    );
  });

  test("managed mode passes abort signal to the platform proxy", async () => {
    mockWebSearchMode = "managed";
    const controller = new AbortController();

    await execute({ query: "abortable query" }, { signal: controller.signal });

    expect(mockManagedSearchProxyCalls).toHaveLength(1);
    expect(mockManagedSearchProxyCalls[0].signal).toBe(controller.signal);
  });

  test("managed mode maps insufficient balance to a managed usage error", async () => {
    mockWebSearchMode = "managed";
    mockManagedSearchProxyResult = {
      ok: false,
      kind: "platform-error",
      status: 402,
      headers: { "content-type": "application/json" },
      body: { detail: "Insufficient balance" },
      message: "Managed search proxy returned status 402: Insufficient balance",
    };

    const result = await execute({ query: "billing query" });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Managed web search");
    expect(result.content).toContain("account balance");
    expect(result.content).toContain("Your Own mode");
  });

  test("managed mode maps proxied provider errors to a tool error", async () => {
    mockWebSearchMode = "managed";
    mockManagedSearchProxyResult = {
      ok: true,
      status: 400,
      headers: { "content-type": "application/json" },
      body: { error: "Bad upstream request" },
    };

    const result = await execute({ query: "provider error query" });

    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Managed Brave Search provider returned status 400",
    );
  });

  test("managed mode returns a clear error when platform context is unavailable", async () => {
    mockWebSearchMode = "managed";
    mockManagedSearchProxyResult = {
      ok: false,
      kind: "unavailable",
      message: "Managed search proxy is unavailable in this environment.",
    };

    const result = await execute({ query: "local managed query" });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Managed search proxy is unavailable");
    expect(result.content).toContain("Log in to Vellum");
  });

  test("your-own mode keeps direct Brave BYOK behavior unchanged", async () => {
    mockWebSearchMode = "your-own";
    mockWebSearchProvider = "brave";
    mockBraveSecureKey = "brave-direct-key";
    let capturedHeaders: Headers | undefined;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ web: { results: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as any;

    const result = await execute({ query: "direct query" });

    expect(result.isError).toBe(false);
    expect(mockManagedSearchProxyCalls).toHaveLength(0);
    expect(capturedHeaders!.get("X-Subscription-Token")).toBe(
      "brave-direct-key",
    );
  });

  // ---- Tavily provider ----------------------------------------------------

  test("executes Tavily search successfully", async () => {
    mockWebSearchProvider = "tavily";
    mockTavilySecureKey = "tvly-test-key";
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          results: [
            {
              title: "Tavily Result 1",
              url: "https://example.com/tavily-1",
              content: "First Tavily result",
              score: 0.91,
            },
            {
              title: "Tavily Result 2",
              url: "https://example.com/tavily-2",
              content: "Second Tavily result",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as any;

    const result = await execute({ query: "what is TypeScript" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Tavily Result 1");
    expect(result.content).toContain("https://example.com/tavily-1");
    expect(result.content).toContain("Score: 0.910");
  });

  test("Tavily sends correct request format", async () => {
    mockWebSearchProvider = "tavily";
    mockTavilySecureKey = "tvly-test-key";
    let capturedUrl = "";
    let capturedBody: any = null;
    let capturedHeaders: any = null;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init?.body as string);
      capturedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as any;

    await execute({ query: "test query", count: 50, freshness: "pm" });
    expect(capturedUrl).toContain("api.tavily.com/search");
    expect(capturedBody.query).toBe("test query");
    expect(capturedBody.search_depth).toBe("advanced");
    expect(capturedBody.max_results).toBe(20);
    expect(capturedBody.time_range).toBe("month");
    expect(capturedHeaders.get("authorization")).toBe("Bearer tvly-test-key");
  });

  test("Tavily skips invalid freshness values", async () => {
    mockWebSearchProvider = "tavily";
    mockTavilySecureKey = "tvly-key";
    let capturedBody: any = null;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as any;

    await execute({ query: "test", freshness: "invalid" });
    expect(capturedBody.time_range).toBeUndefined();
  });

  test("Tavily returns no results message when response is empty", async () => {
    mockWebSearchProvider = "tavily";
    mockTavilySecureKey = "tvly-key";
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as any;

    const result = await execute({ query: "obscure query" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("No results found");
  });

  test.each([401, 403])("Tavily handles %d auth error", async (status) => {
    mockWebSearchProvider = "tavily";
    mockTavilySecureKey = "bad-key";
    globalThis.fetch = (async () => {
      return new Response("Auth error", { status });
    }) as any;

    const result = await execute({ query: "test" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Invalid or expired Tavily API key");
  });

  test("Tavily handles 429 rate limit after max retries", async () => {
    mockWebSearchProvider = "tavily";
    mockTavilySecureKey = "tvly-key";
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount++;
      return new Response("Too Many Requests", {
        status: 429,
        headers: { "retry-after": "0" },
      });
    }) as any;

    const result = await execute({ query: "test" });
    expect(result.isError).toBe(true);
    // Post-retry rate limits surface the friendly recoverable copy (ATL-727).
    expect(result.content).toBe(WEB_SEARCH_BACKEND_FAILURE_MESSAGE);
    expect(callCount).toBe(4);
  });

  // ---- Keenable provider (keyless by default) -----------------------------

  test("executes Keenable search keyless (no key configured)", async () => {
    mockWebSearchProvider = "keenable";
    // No key set — keyless must still run instead of erroring on a missing key.
    let capturedUrl = "";
    let capturedHeaders: any = null;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedHeaders = new Headers(init?.headers);
      return new Response(
        JSON.stringify({
          results: [
            {
              title: "Keenable Result 1",
              url: "https://example.com/keenable-1",
              description: "First Keenable result",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as any;

    const result = await execute({ query: "what is RAG" });
    expect(result.isError).toBe(false);
    expect(capturedUrl).toContain("api.keenable.ai/v1/search/public");
    expect(capturedHeaders.get("x-api-key")).toBeNull();
    expect(capturedHeaders.get("x-keenable-title")).toBe("Vellum Assistant");
    expect(result.content).toContain("Keenable Result 1");
    expect(result.content).toContain("https://example.com/keenable-1");
  });

  test("Keenable uses the authenticated endpoint when a key is set", async () => {
    mockWebSearchProvider = "keenable";
    mockKeenableSecureKey = "keen_test";
    let capturedUrl = "";
    let capturedBody: any = null;
    let capturedHeaders: any = null;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init?.body as string);
      capturedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as any;

    await execute({ query: "test query", count: 3, freshness: "pm" });
    expect(capturedUrl).toContain("api.keenable.ai/v1/search");
    expect(capturedUrl).not.toContain("/search/public");
    expect(capturedHeaders.get("x-api-key")).toBe("keen_test");
    expect(capturedBody.query).toBe("test query");
    expect(capturedBody.mode).toBe("pro");
    expect(typeof capturedBody.published_after).toBe("string");
  });

  test("Keenable trims results to the requested count", async () => {
    mockWebSearchProvider = "keenable";
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          results: [
            { title: "A", url: "https://a.com", description: "a" },
            { title: "B", url: "https://b.com", description: "b" },
            { title: "C", url: "https://c.com", description: "c" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as any;

    const result = await execute({ query: "test", count: 2 });
    expect(result.content).toContain("A");
    expect(result.content).toContain("B");
    expect(result.content).not.toContain("https://c.com");
  });

  test.each([401, 403])("Keenable handles %d auth error", async (status) => {
    mockWebSearchProvider = "keenable";
    mockKeenableSecureKey = "bad-key";
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ message: "unauthorized" }), {
        status,
        headers: { "content-type": "application/json" },
      });
    }) as any;

    const result = await execute({ query: "test" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Invalid or expired Keenable API key");
  });

  // ---- Firecrawl provider -------------------------------------------------

  test("executes Firecrawl search successfully", async () => {
    mockWebSearchProvider = "firecrawl";
    mockFirecrawlSecureKey = "fc-test-key";
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            web: [
              {
                title: "Firecrawl Result 1",
                url: "https://example.com/fc-1",
                description: "First Firecrawl result",
              },
              {
                title: "Firecrawl Result 2",
                url: "https://example.com/fc-2",
                description: "Second Firecrawl result",
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as any;

    const result = await execute({ query: "what is TypeScript" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Firecrawl Result 1");
    expect(result.content).toContain("https://example.com/fc-1");
    expect(result.content).toContain("First Firecrawl result");
  });

  test("Firecrawl sends correct request format", async () => {
    mockWebSearchProvider = "firecrawl";
    mockFirecrawlSecureKey = "fc-test-key";
    let capturedUrl = "";
    let capturedBody: any = null;
    let capturedHeaders: any = null;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init?.body as string);
      capturedHeaders = new Headers(init?.headers);
      return new Response(
        JSON.stringify({ success: true, data: { web: [] } }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as any;

    await execute({ query: "test query", count: 50, freshness: "pm" });
    expect(capturedUrl).toContain("api.firecrawl.dev/v2/search");
    expect(capturedBody.query).toBe("test query");
    expect(capturedBody.limit).toBe(20);
    expect(capturedBody.sources).toEqual(["web"]);
    expect(capturedBody.tbs).toBe("qdr:m");
    expect(capturedHeaders.get("authorization")).toBe("Bearer fc-test-key");
    expect(capturedHeaders.get("x-client-source")).toBe("vellum-assistant");
  });

  test("Firecrawl skips invalid freshness values", async () => {
    mockWebSearchProvider = "firecrawl";
    mockFirecrawlSecureKey = "fc-key";
    let capturedBody: any = null;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify({ success: true, data: { web: [] } }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as any;

    await execute({ query: "test", freshness: "invalid" });
    expect(capturedBody.tbs).toBeUndefined();
  });

  test("Firecrawl returns no results message when response is empty", async () => {
    mockWebSearchProvider = "firecrawl";
    mockFirecrawlSecureKey = "fc-key";
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({ success: true, data: { web: [] } }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as any;

    const result = await execute({ query: "obscure query" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("No results found");
  });

  test.each([401, 403])("Firecrawl handles %d auth error", async (status) => {
    mockWebSearchProvider = "firecrawl";
    mockFirecrawlSecureKey = "bad-key";
    globalThis.fetch = (async () => {
      return new Response("Auth error", { status });
    }) as any;

    const result = await execute({ query: "test" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Invalid or expired Firecrawl API key");
  });

  test("Firecrawl handles 429 rate limit after max retries", async () => {
    mockWebSearchProvider = "firecrawl";
    mockFirecrawlSecureKey = "fc-key";
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount++;
      return new Response("Too Many Requests", {
        status: 429,
        headers: { "retry-after": "0" },
      });
    }) as any;

    const result = await execute({ query: "test" });
    expect(result.isError).toBe(true);
    // Post-retry rate limits surface the friendly recoverable copy (ATL-727).
    expect(result.content).toBe(WEB_SEARCH_BACKEND_FAILURE_MESSAGE);
    expect(callCount).toBe(4);
  });

  // ---- Provider fallback --------------------------------------------------

  test("falls back from perplexity to brave when perplexity has no key", async () => {
    mockWebSearchProvider = "perplexity";
    mockBraveSecureKey = "brave-fallback-key";
    let capturedUrl = "";
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ web: { results: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as any;

    const result = await execute({ query: "fallback test" });
    expect(result.isError).toBe(false);
    expect(capturedUrl).toContain("brave");
  });

  test("falls back from brave to perplexity when brave has no key", async () => {
    mockWebSearchProvider = "brave";
    mockPerplexitySecureKey = "pplx-fallback-key";
    let capturedUrl = "";
    globalThis.fetch = (async (url: string, _init?: RequestInit) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "fallback result" } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as any;

    const result = await execute({ query: "fallback test" });
    expect(result.isError).toBe(false);
    expect(capturedUrl).toContain("perplexity");
  });

  test("falls back to tavily when earlier providers have no key", async () => {
    mockWebSearchProvider = "perplexity";
    mockTavilySecureKey = "tvly-fallback-key";
    let capturedUrl = "";
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as any;

    const result = await execute({ query: "fallback test" });
    expect(result.isError).toBe(false);
    expect(capturedUrl).toContain("tavily");
  });

  test("falls back to firecrawl when all earlier providers have no key", async () => {
    mockWebSearchProvider = "perplexity";
    mockFirecrawlSecureKey = "fc-fallback-key";
    let capturedUrl = "";
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({ success: true, data: { web: [] } }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as any;

    const result = await execute({ query: "fallback test" });
    expect(result.isError).toBe(false);
    expect(capturedUrl).toContain("firecrawl");
  });

  test("falls back from tavily to perplexity when tavily has no key", async () => {
    mockWebSearchProvider = "tavily";
    mockPerplexitySecureKey = "pplx-fallback-key";
    let capturedUrl = "";
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "fallback" } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as any;

    const result = await execute({ query: "fallback test" });
    expect(result.isError).toBe(false);
    expect(capturedUrl).toContain("perplexity");
  });

  test("maps inference-provider-native to perplexity", async () => {
    mockWebSearchProvider = "inference-provider-native";
    mockPerplexitySecureKey = "pplx-key";
    let capturedUrl = "";
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "result" } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as any;

    const result = await execute({ query: "test" });
    expect(result.isError).toBe(false);
    expect(capturedUrl).toContain("perplexity");
  });

  // ---- Network errors -----------------------------------------------------

  test("handles fetch exceptions", async () => {
    mockPerplexitySecureKey = "pplx-key";
    globalThis.fetch = (async () => {
      throw new Error("Network error: connection refused");
    }) as any;

    const result = await execute({ query: "test" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Web search failed");
    expect(result.content).toContain("connection refused");
  });
});
