import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Mutable mock state - set per test
let mockWebSearchProvider: string | undefined = "perplexity";
let mockBraveSecureKey: string | undefined;
let mockPerplexitySecureKey: string | undefined;

// Capture the registered tool
let capturedTool: any = null;

mock.module("../../registry.js", () => ({
  registerTool: (tool: any) => {
    capturedTool = tool;
  },
}));

mock.module("../../../config/loader.js", () => ({
  getConfig: () => ({
    webSearchProvider: mockWebSearchProvider,
  }),
}));

mock.module("../../../security/secure-keys.js", () => ({
  getSecureKeyAsync: async (provider: string) => {
    if (provider === "brave") return mockBraveSecureKey;
    if (provider === "perplexity") return mockPerplexitySecureKey;
    return undefined;
  },
  getProviderKeyAsync: async (provider: string) => {
    if (provider === "brave") return mockBraveSecureKey;
    if (provider === "perplexity") return mockPerplexitySecureKey;
    return undefined;
  },
}));

mock.module("../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../../../permissions/types.js", () => ({
  RiskLevel: { Low: "low", Medium: "medium", High: "high" },
}));

// Force the module to load (triggers registerTool)
await import("../web-search.js");

describe("web_search tool", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    mockWebSearchProvider = "perplexity";
    mockBraveSecureKey = undefined;
    mockPerplexitySecureKey = undefined;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function execute(input: Record<string, unknown>) {
    return capturedTool.execute(input, {} as any);
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
    expect(result.content).toContain("rate limit exceeded");
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
    expect(result.content).toContain("status 500");
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
