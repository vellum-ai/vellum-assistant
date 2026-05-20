import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Mutable mock state - set per test
let mockWebSearchProvider: string | undefined = "perplexity";
let mockBraveSecureKey: string | undefined;
let mockPerplexitySecureKey: string | undefined;
let mockTavilySecureKey: string | undefined;

// Capture the registered tool
let capturedTool: any = null;

mock.module("../../registry.js", () => ({
  registerTool: (tool: any) => {
    capturedTool = tool;
  },
}));

mock.module("../../../config/loader.js", () => ({
  getConfig: () => ({
    services: {
      "web-search": { provider: mockWebSearchProvider },
    },
  }),
}));

mock.module("../../../security/secure-keys.js", () => ({
  getProviderKeyAsync: async (provider: string) => {
    if (provider === "brave") return mockBraveSecureKey;
    if (provider === "perplexity") return mockPerplexitySecureKey;
    if (provider === "tavily") return mockTavilySecureKey;
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

describe("web_search activity metadata", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    mockWebSearchProvider = "perplexity";
    mockBraveSecureKey = undefined;
    mockPerplexitySecureKey = undefined;
    mockTavilySecureKey = undefined;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function execute(input: Record<string, unknown>) {
    return capturedTool.execute(input, {} as any);
  }

  // ---- Brave --------------------------------------------------------------

  test("Brave populates webSearch metadata on success", async () => {
    mockWebSearchProvider = "brave";
    mockBraveSecureKey = "brave-key";
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          web: {
            results: [
              {
                title: "Brave One",
                url: "https://example.com/one",
                description: "First Brave result",
                age: "1 day ago",
              },
              {
                title: "Brave Two",
                url: "https://other.example.org/two",
                description: "Second result",
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as any;

    const result = await execute({ query: "brave query" });
    const meta = result.activityMetadata?.webSearch;
    expect(meta).toBeDefined();
    expect(meta.provider).toBe("brave");
    expect(meta.query).toBe("brave query");
    expect(meta.resultCount).toBe(2);
    expect(typeof meta.durationMs).toBe("number");
    expect(meta.errorMessage).toBeUndefined();
    expect(meta.results[0].rank).toBe(1);
    expect(meta.results[0].title).toBe("Brave One");
    expect(meta.results[0].url).toBe("https://example.com/one");
    expect(meta.results[0].domain).toBe("example.com");
    expect(meta.results[0].snippet).toBe("First Brave result");
    expect(meta.results[0].age).toBe("1 day ago");
    expect(meta.results[1].rank).toBe(2);
    expect(meta.results[1].domain).toBe("other.example.org");
  });

  test("Brave populates errorMessage and empty results on auth failure", async () => {
    mockWebSearchProvider = "brave";
    mockBraveSecureKey = "bad-key";
    globalThis.fetch = (async () =>
      new Response("Forbidden", { status: 403 })) as any;

    const result = await execute({ query: "brave fail" });
    const meta = result.activityMetadata?.webSearch;
    expect(meta).toBeDefined();
    expect(meta.provider).toBe("brave");
    expect(meta.resultCount).toBe(0);
    expect(meta.results).toEqual([]);
    expect(meta.errorMessage).toContain("Invalid or expired Brave Search");
  });

  // ---- Perplexity ---------------------------------------------------------

  test("Perplexity populates webSearch metadata from citations", async () => {
    mockPerplexitySecureKey = "pplx-key";
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "answer text" } }],
          citations: [
            "https://typescriptlang.org/docs",
            "https://example.com/article",
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as any;

    const result = await execute({ query: "perplexity query" });
    const meta = result.activityMetadata?.webSearch;
    expect(meta).toBeDefined();
    expect(meta.provider).toBe("perplexity");
    expect(meta.query).toBe("perplexity query");
    expect(meta.resultCount).toBe(2);
    expect(meta.results[0].rank).toBe(1);
    expect(meta.results[0].url).toBe("https://typescriptlang.org/docs");
    expect(meta.results[0].domain).toBe("typescriptlang.org");
    expect(meta.results[0].title).toBe("");
    expect(meta.results[0].snippet).toBeUndefined();
    expect(meta.results[1].domain).toBe("example.com");
  });

  test("Perplexity populates errorMessage on rate-limit exhaustion", async () => {
    mockPerplexitySecureKey = "pplx-key";
    globalThis.fetch = (async () =>
      new Response("Too Many Requests", {
        status: 429,
        headers: { "retry-after": "0" },
      })) as any;

    const result = await execute({ query: "rate limited" });
    const meta = result.activityMetadata?.webSearch;
    expect(meta).toBeDefined();
    expect(meta.provider).toBe("perplexity");
    expect(meta.resultCount).toBe(0);
    expect(meta.results).toEqual([]);
    expect(meta.errorMessage).toContain("rate limit exceeded");
  });

  // ---- Tavily -------------------------------------------------------------

  test("Tavily populates webSearch metadata with favicon and score", async () => {
    mockWebSearchProvider = "tavily";
    mockTavilySecureKey = "tvly-key";
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          results: [
            {
              title: "Tavily One",
              url: "https://docs.example.com/page",
              content: "Tavily snippet text",
              score: 0.87,
              favicon: "https://docs.example.com/favicon.ico",
            },
            {
              title: "Tavily Two",
              url: "https://blog.example.org/post",
              content: "Second tavily content",
              score: 0.42,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as any;

    const result = await execute({ query: "tavily query" });
    const meta = result.activityMetadata?.webSearch;
    expect(meta).toBeDefined();
    expect(meta.provider).toBe("tavily");
    expect(meta.resultCount).toBe(2);
    expect(meta.results[0].rank).toBe(1);
    expect(meta.results[0].title).toBe("Tavily One");
    expect(meta.results[0].url).toBe("https://docs.example.com/page");
    expect(meta.results[0].domain).toBe("docs.example.com");
    expect(meta.results[0].faviconUrl).toBe(
      "https://docs.example.com/favicon.ico",
    );
    expect(meta.results[0].snippet).toBe("Tavily snippet text");
    expect(meta.results[0].score).toBe(0.87);
    expect(meta.results[1].faviconUrl).toBeUndefined();
    expect(meta.results[1].score).toBe(0.42);
  });

  test("Tavily falls back to url for missing title", async () => {
    mockWebSearchProvider = "tavily";
    mockTavilySecureKey = "tvly-key";
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          results: [
            {
              url: "https://example.net/article",
              content: "No title here",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as any;

    const result = await execute({ query: "no title" });
    const meta = result.activityMetadata?.webSearch;
    expect(meta).toBeDefined();
    expect(meta.results[0].title).toBe("https://example.net/article");
    expect(meta.results[0].domain).toBe("example.net");
  });

  test("Tavily populates errorMessage on auth failure", async () => {
    mockWebSearchProvider = "tavily";
    mockTavilySecureKey = "bad-key";
    globalThis.fetch = (async () =>
      new Response("Unauthorized", { status: 401 })) as any;

    const result = await execute({ query: "tavily fail" });
    const meta = result.activityMetadata?.webSearch;
    expect(meta).toBeDefined();
    expect(meta.provider).toBe("tavily");
    expect(meta.resultCount).toBe(0);
    expect(meta.results).toEqual([]);
    expect(meta.errorMessage).toContain("Invalid or expired Tavily");
  });
});
