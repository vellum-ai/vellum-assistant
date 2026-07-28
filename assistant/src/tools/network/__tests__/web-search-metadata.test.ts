import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { setConfig } from "../../../__tests__/helpers/set-config.js";
import { WEB_SEARCH_BACKEND_FAILURE_MESSAGE } from "../web-search-error.js";

// Mutable mock state - set per test
let mockBraveSecureKey: string | undefined;
let mockPerplexitySecureKey: string | undefined;
let mockTavilySecureKey: string | undefined;

/** Seed the active web-search provider into the workspace config for real. */
function seedWebSearch(provider: string): void {
  setConfig("services", { "web-search": { provider } });
}

mock.module("../../../security/secure-keys.js", () => ({
  getProviderKeyAsync: async (provider: string) => {
    if (provider === "brave") return mockBraveSecureKey;
    if (provider === "perplexity") return mockPerplexitySecureKey;
    if (provider === "tavily") return mockTavilySecureKey;
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

// Import after the mocks above so the module under test sees them.
const { webSearchTool } = await import("../web-search.js");

describe("web_search activity metadata", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    seedWebSearch("perplexity");
    mockBraveSecureKey = undefined;
    mockPerplexitySecureKey = undefined;
    mockTavilySecureKey = undefined;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // Return type is `any` so assertions can poke at provider-specific
  // metadata shapes without narrowing at every site.
  function execute(input: Record<string, unknown>): any {
    return webSearchTool.execute(input, {} as any);
  }

  // ---- Brave --------------------------------------------------------------

  test("Brave populates webSearch metadata on success", async () => {
    seedWebSearch("brave");
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
    seedWebSearch("brave");
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
    // Post-retry rate limits now surface the centralized friendly recoverable
    // copy (ATL-727) rather than provider-specific rate-limit wording.
    expect(meta.errorMessage).toBe(WEB_SEARCH_BACKEND_FAILURE_MESSAGE);
  });

  // ---- Tavily -------------------------------------------------------------

  test("Tavily populates webSearch metadata with favicon and score", async () => {
    seedWebSearch("tavily");
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
    // PR 5 backfills a synthesized favicon URL via Google s2 when the
    // provider doesn't supply one, so this result now has a faviconUrl too.
    expect(meta.results[1].faviconUrl).toContain("google.com/s2/favicons");
    expect(meta.results[1].score).toBe(0.42);
  });

  test("Tavily falls back to url for missing title", async () => {
    seedWebSearch("tavily");
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

  test("Tavily falls back to url for empty string title", async () => {
    seedWebSearch("tavily");
    mockTavilySecureKey = "tvly-key";
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          results: [
            {
              title: "",
              url: "https://example.net/empty-title",
              content: "Empty title",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as any;

    const result = await execute({ query: "empty title" });
    const meta = result.activityMetadata?.webSearch;
    expect(meta).toBeDefined();
    expect(meta.results[0].title).toBe("https://example.net/empty-title");
  });

  test("Tavily falls back to url for whitespace-only title", async () => {
    seedWebSearch("tavily");
    mockTavilySecureKey = "tvly-key";
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          results: [
            {
              title: "   ",
              url: "https://example.net/whitespace-title",
              content: "Whitespace title",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as any;

    const result = await execute({ query: "whitespace title" });
    const meta = result.activityMetadata?.webSearch;
    expect(meta).toBeDefined();
    expect(meta.results[0].title).toBe("https://example.net/whitespace-title");
  });

  test("Tavily populates errorMessage on auth failure", async () => {
    seedWebSearch("tavily");
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

  // ---- Top-level error paths ---------------------------------------------

  test("top-level catch populates activityMetadata with errorMessage", async () => {
    seedWebSearch("perplexity");
    mockPerplexitySecureKey = "pplx-key";
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as any;

    const result = await execute({ query: "catch query" });
    expect(result.isError).toBe(true);
    const meta = result.activityMetadata?.webSearch;
    expect(meta).toBeDefined();
    expect(meta.provider).toBe("perplexity");
    expect(meta.query).toBe("catch query");
    expect(meta.resultCount).toBe(0);
    expect(meta.results).toEqual([]);
    expect(meta.errorMessage).toContain("network down");
    expect(typeof meta.durationMs).toBe("number");
  });

  test("no-API-key branch populates activityMetadata with errorMessage", async () => {
    seedWebSearch("perplexity");
    // All provider keys remain undefined from beforeEach.

    const result = await execute({ query: "no key query" });
    expect(result.isError).toBe(true);
    const meta = result.activityMetadata?.webSearch;
    expect(meta).toBeDefined();
    expect(meta.provider).toBe("perplexity");
    expect(meta.query).toBe("no key query");
    expect(meta.resultCount).toBe(0);
    expect(meta.results).toEqual([]);
    expect(meta.errorMessage).toContain("No web search API key configured");
    expect(typeof meta.durationMs).toBe("number");
  });
});
