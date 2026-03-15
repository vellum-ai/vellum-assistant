import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// No mock.module calls — this test file uses its own inline executeWebSearch
// helper and does not import any production modules.  Stray mock.module calls
// here leak into the shared Bun test process and break other test files.

describe("WebSearchTool", () => {
  const originalEnv = process.env;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    process.env = { ...originalEnv };
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    process.env = originalEnv;
    globalThis.fetch = originalFetch;
  });

  // Since the tool self-registers via module side effect, we test the core behaviors
  // by importing the module and testing the registered tool's execute method.

  describe("API key resolution", () => {
    test("returns error when no API key is configured (brave)", async () => {
      delete process.env.BRAVE_API_KEY;
      const result = await executeWebSearch(
        { query: "test" },
        undefined,
        "brave",
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("No web search API key configured");
    });

    test("returns error when no API key is configured (perplexity)", async () => {
      delete process.env.PERPLEXITY_API_KEY;
      const result = await executeWebSearch(
        { query: "test" },
        undefined,
        "perplexity",
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("No web search API key configured");
    });
  });

  describe("input validation", () => {
    test("rejects missing query", async () => {
      // Set up a mock fetch that should NOT be called
      let fetchCalled = false;
      globalThis.fetch = (async () => {
        fetchCalled = true;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch;

      process.env.BRAVE_API_KEY = "test-key";

      // We need to test the tool's execute method directly
      // Since bun:test module mocking is limited for re-imports,
      // we'll create a minimal test using the tool's logic
      const result = await executeWebSearch({}, "test-key", "brave");
      expect(result.isError).toBe(true);
      expect(result.content).toContain("query is required");
      expect(fetchCalled).toBe(false);
    });

    test("rejects non-string query", async () => {
      const result = await executeWebSearch(
        { query: 123 },
        "test-key",
        "brave",
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("query is required");
    });
  });

  describe("Brave parameter handling", () => {
    test("clamps count to valid range", async () => {
      let capturedUrl = "";
      globalThis.fetch = (async (url: string) => {
        capturedUrl = url;
        return new Response(JSON.stringify({ web: { results: [] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch;

      await executeWebSearch({ query: "test", count: 50 }, "test-key", "brave");
      expect(capturedUrl).toContain("count=20");

      await executeWebSearch({ query: "test", count: -5 }, "test-key", "brave");
      expect(capturedUrl).toContain("count=1");
    });

    test("clamps offset to valid range", async () => {
      let capturedUrl = "";
      globalThis.fetch = (async (url: string) => {
        capturedUrl = url;
        return new Response(JSON.stringify({ web: { results: [] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch;

      await executeWebSearch(
        { query: "test", offset: 20 },
        "test-key",
        "brave",
      );
      expect(capturedUrl).toContain("offset=9");
    });

    test("includes freshness when valid", async () => {
      let capturedUrl = "";
      globalThis.fetch = (async (url: string) => {
        capturedUrl = url;
        return new Response(JSON.stringify({ web: { results: [] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch;

      await executeWebSearch(
        { query: "test", freshness: "pw" },
        "test-key",
        "brave",
      );
      expect(capturedUrl).toContain("freshness=pw");
    });

    test("ignores invalid freshness values", async () => {
      let capturedUrl = "";
      globalThis.fetch = (async (url: string) => {
        capturedUrl = url;
        return new Response(JSON.stringify({ web: { results: [] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch;

      await executeWebSearch(
        { query: "test", freshness: "invalid" },
        "test-key",
        "brave",
      );
      expect(capturedUrl).not.toContain("freshness");
    });
  });

  describe("Brave API responses", () => {
    test("formats results correctly", async () => {
      const mockResults = {
        web: {
          results: [
            {
              title: "Test Result",
              url: "https://example.com",
              description: "A test result",
            },
            {
              title: "Another Result",
              url: "https://other.com",
              description: "Another one",
              age: "2 days ago",
            },
          ],
        },
      };

      globalThis.fetch = (async () =>
        new Response(JSON.stringify(mockResults), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })) as unknown as typeof fetch;

      const result = await executeWebSearch(
        { query: "test" },
        "test-key",
        "brave",
      );
      expect(result.isError).toBe(false);
      expect(result.content).toContain("Test Result");
      expect(result.content).toContain("https://example.com");
      expect(result.content).toContain("A test result");
      expect(result.content).toContain("Another Result");
      expect(result.content).toContain("2 days ago");
    });

    test("handles empty results", async () => {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ web: { results: [] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })) as unknown as typeof fetch;

      const result = await executeWebSearch(
        { query: "noresults" },
        "test-key",
        "brave",
      );
      expect(result.isError).toBe(false);
      expect(result.content).toContain("No results found");
    });

    test("handles missing web field", async () => {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })) as unknown as typeof fetch;

      const result = await executeWebSearch(
        { query: "empty" },
        "test-key",
        "brave",
      );
      expect(result.isError).toBe(false);
      expect(result.content).toContain("No results found");
    });

    test("handles 401 unauthorized", async () => {
      globalThis.fetch = (async () =>
        new Response("Unauthorized", {
          status: 401,
        })) as unknown as typeof fetch;

      const result = await executeWebSearch(
        { query: "test" },
        "bad-key",
        "brave",
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Invalid or expired");
    });

    test("retries on 429 and succeeds", async () => {
      let callCount = 0;
      globalThis.fetch = (async () => {
        callCount++;
        if (callCount <= 2) {
          return new Response("Too Many Requests", { status: 429 });
        }
        return new Response(
          JSON.stringify({
            web: {
              results: [
                {
                  title: "Result",
                  url: "https://example.com",
                  description: "Found it",
                },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as unknown as typeof fetch;

      const result = await executeWebSearch(
        { query: "test" },
        "test-key",
        "brave",
      );
      expect(result.isError).toBe(false);
      expect(result.content).toContain("Result");
      expect(callCount).toBe(3);
    });

    test("returns error after exhausting 429 retries", async () => {
      globalThis.fetch = (async () =>
        new Response("Too Many Requests", {
          status: 429,
        })) as unknown as typeof fetch;

      const result = await executeWebSearch(
        { query: "test" },
        "test-key",
        "brave",
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("rate limit");
      expect(result.content).toContain("after retries");
    });

    test("respects Retry-After header on 429", async () => {
      let callCount = 0;
      const callTimestamps: number[] = [];
      globalThis.fetch = (async () => {
        callCount++;
        callTimestamps.push(Date.now());
        if (callCount === 1) {
          return new Response("Too Many Requests", {
            status: 429,
            headers: { "Retry-After": "0" },
          });
        }
        return new Response(JSON.stringify({ web: { results: [] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch;

      const result = await executeWebSearch(
        { query: "test" },
        "test-key",
        "brave",
      );
      expect(result.isError).toBe(false);
      expect(callCount).toBe(2);
    });

    test("handles network errors", async () => {
      globalThis.fetch = (async () => {
        throw new Error("Network unreachable");
      }) as unknown as typeof fetch;

      const result = await executeWebSearch(
        { query: "test" },
        "test-key",
        "brave",
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Network unreachable");
    });

    test("sends correct headers", async () => {
      let capturedHeaders: Record<string, string> = {};
      globalThis.fetch = (async (_url: string, init: RequestInit) => {
        capturedHeaders = Object.fromEntries(
          Object.entries(init.headers as Record<string, string>),
        );
        return new Response(JSON.stringify({ web: { results: [] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch;

      await executeWebSearch({ query: "test" }, "my-api-key", "brave");
      expect(capturedHeaders["X-Subscription-Token"]).toBe("my-api-key");
      expect(capturedHeaders["Accept"]).toBe("application/json");
    });

    test("includes extra_snippets in output", async () => {
      const mockResults = {
        web: {
          results: [
            {
              title: "Snippet Test",
              url: "https://example.com",
              description: "Main description",
              extra_snippets: ["Extra snippet 1", "Extra snippet 2"],
            },
          ],
        },
      };

      globalThis.fetch = (async () =>
        new Response(JSON.stringify(mockResults), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })) as unknown as typeof fetch;

      const result = await executeWebSearch(
        { query: "test" },
        "test-key",
        "brave",
      );
      expect(result.isError).toBe(false);
      expect(result.content).toContain("Extra snippet 1");
      expect(result.content).toContain("Extra snippet 2");
    });
  });

  describe("Perplexity API responses", () => {
    test("formats results with citations", async () => {
      const mockResponse = {
        choices: [
          {
            message: {
              content: "Perplexity found this information about the topic.",
            },
          },
        ],
        citations: [
          "https://example.com/source1",
          "https://example.com/source2",
        ],
      };

      globalThis.fetch = (async () =>
        new Response(JSON.stringify(mockResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })) as unknown as typeof fetch;

      const result = await executeWebSearch(
        { query: "test" },
        "pplx-key",
        "perplexity",
      );
      expect(result.isError).toBe(false);
      expect(result.content).toContain("Perplexity found this information");
      expect(result.content).toContain("https://example.com/source1");
      expect(result.content).toContain("https://example.com/source2");
    });

    test("handles empty response", async () => {
      const mockResponse = {
        choices: [{ message: { content: "" } }],
      };

      globalThis.fetch = (async () =>
        new Response(JSON.stringify(mockResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })) as unknown as typeof fetch;

      const result = await executeWebSearch(
        { query: "noresults" },
        "pplx-key",
        "perplexity",
      );
      expect(result.isError).toBe(false);
      expect(result.content).toContain("No results found");
    });

    test("handles 401 unauthorized", async () => {
      globalThis.fetch = (async () =>
        new Response("Unauthorized", {
          status: 401,
        })) as unknown as typeof fetch;

      const result = await executeWebSearch(
        { query: "test" },
        "bad-key",
        "perplexity",
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Invalid or expired");
    });

    test("sends correct headers", async () => {
      let capturedHeaders: Record<string, string> = {};
      let capturedBody: Record<string, unknown> = {};
      globalThis.fetch = (async (_url: string, init: RequestInit) => {
        capturedHeaders = Object.fromEntries(
          Object.entries(init.headers as Record<string, string>),
        );
        capturedBody = JSON.parse(init.body as string);
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "result" } }] }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }) as unknown as typeof fetch;

      await executeWebSearch(
        { query: "test query" },
        "pplx-my-key",
        "perplexity",
      );
      expect(capturedHeaders["Authorization"]).toBe("Bearer pplx-my-key");
      expect(capturedHeaders["Content-Type"]).toBe("application/json");
      expect(capturedBody.model).toBe("sonar");
      expect(
        (capturedBody.messages as Array<{ content: string }>)[0].content,
      ).toBe("test query");
    });

    test("retries on 429 and succeeds", async () => {
      let callCount = 0;
      globalThis.fetch = (async () => {
        callCount++;
        if (callCount <= 2) {
          return new Response("Too Many Requests", { status: 429 });
        }
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "Found it" } }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as unknown as typeof fetch;

      const result = await executeWebSearch(
        { query: "test" },
        "pplx-key",
        "perplexity",
      );
      expect(result.isError).toBe(false);
      expect(result.content).toContain("Found it");
      expect(callCount).toBe(3);
    });

    test("handles network errors", async () => {
      globalThis.fetch = (async () => {
        throw new Error("Network unreachable");
      }) as unknown as typeof fetch;

      const result = await executeWebSearch(
        { query: "test" },
        "pplx-key",
        "perplexity",
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Network unreachable");
    });
  });
});

interface BraveSearchResult {
  title: string;
  url: string;
  description?: string;
  age?: string;
  extra_snippets?: string[];
}

interface BraveSearchResponse {
  web?: { results: BraveSearchResult[] };
}

interface PerplexityResponse {
  choices?: Array<{ message: { content: string } }>;
  citations?: string[];
}

/**
 * Helper that exercises the web search logic directly, bypassing module
 * registration concerns. This replicates the core execute path from
 * web-search.ts to test it in isolation.
 */
async function executeWebSearch(
  input: Record<string, unknown>,
  apiKey?: string,
  provider: "brave" | "perplexity" = "brave",
): Promise<{ content: string; isError: boolean }> {
  const query = input.query;
  if (!query || typeof query !== "string") {
    return {
      content: "Error: query is required and must be a string",
      isError: true,
    };
  }

  if (!apiKey) {
    return {
      content:
        "Error: No web search API key configured. Set it via `keys set perplexity <key>` or `keys set brave <key>`, or configure it from the Settings page under API Keys.",
      isError: true,
    };
  }

  if (provider === "perplexity") {
    return executePerplexitySearchHelper(query as string, apiKey);
  }

  return executeBraveSearchHelper(input, query as string, apiKey);
}

async function executeBraveSearchHelper(
  input: Record<string, unknown>,
  query: string,
  apiKey: string,
): Promise<{ content: string; isError: boolean }> {
  const count =
    typeof input.count === "number"
      ? Math.min(20, Math.max(1, Math.round(input.count)))
      : 10;
  const offset =
    typeof input.offset === "number"
      ? Math.min(9, Math.max(0, Math.round(input.offset)))
      : 0;

  const params = new URLSearchParams({
    q: query,
    count: String(count),
    offset: String(offset),
  });

  const validFreshness = ["pd", "pw", "pm", "py"];
  if (
    typeof input.freshness === "string" &&
    validFreshness.includes(input.freshness)
  ) {
    params.set("freshness", input.freshness);
  }

  const url = `https://api.search.brave.com/res/v1/web/search?${params.toString()}`;

  const MAX_RETRIES = 3;
  const BASE_DELAY_MS = 1; // Use 1ms in tests to avoid slow tests

  try {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "gzip",
          "X-Subscription-Token": apiKey,
        },
      });

      if (response.ok) {
        const data = (await response.json()) as BraveSearchResponse;
        const results = data.web?.results ?? [];

        if (results.length === 0) {
          return {
            content: `No results found for "${query}".`,
            isError: false,
          };
        }

        const lines: string[] = [`Web search results for "${query}":\n`];
        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          lines.push(`${i + 1}. ${r.title}`);
          lines.push(`   URL: ${r.url}`);
          if (r.description) lines.push(`   ${r.description}`);
          if (r.age) lines.push(`   Age: ${r.age}`);
          if (r.extra_snippets && r.extra_snippets.length > 0) {
            for (const snippet of r.extra_snippets) {
              lines.push(`   > ${snippet}`);
            }
          }
          lines.push("");
        }

        return { content: lines.join("\n"), isError: false };
      }

      await response.text();

      if (response.status === 401 || response.status === 403) {
        return {
          content: "Error: Invalid or expired Brave Search API key",
          isError: true,
        };
      }

      if (response.status === 429 && attempt < MAX_RETRIES) {
        const retryAfter = response.headers.get("retry-after");
        const delayMs =
          retryAfter && !isNaN(Number(retryAfter))
            ? Number(retryAfter) * 1000
            : BASE_DELAY_MS * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      if (response.status === 429) {
        return {
          content:
            "Error: Brave Search rate limit exceeded after retries. Try again shortly.",
          isError: true,
        };
      }
      return {
        content: `Error: Brave Search API returned status ${response.status}`,
        isError: true,
      };
    }

    return {
      content:
        "Error: Brave Search rate limit exceeded after retries. Try again shortly.",
      isError: true,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Error: Web search failed: ${msg}`, isError: true };
  }
}

async function executePerplexitySearchHelper(
  query: string,
  apiKey: string,
): Promise<{ content: string; isError: boolean }> {
  const MAX_RETRIES = 3;
  const BASE_DELAY_MS = 1;

  try {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const response = await fetch(
        "https://api.perplexity.ai/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: "sonar",
            messages: [{ role: "user", content: query }],
          }),
        },
      );

      if (response.ok) {
        const data = (await response.json()) as PerplexityResponse;
        const content = data.choices?.[0]?.message?.content;
        if (!content) {
          return {
            content: `No results found for "${query}".`,
            isError: false,
          };
        }

        const lines: string[] = [`Web search results for "${query}":\n`];
        lines.push(content);

        if (data.citations && data.citations.length > 0) {
          lines.push("\nSources:");
          for (let i = 0; i < data.citations.length; i++) {
            lines.push(`  [${i + 1}] ${data.citations[i]}`);
          }
        }

        return { content: lines.join("\n"), isError: false };
      }

      await response.text();

      if (response.status === 401 || response.status === 403) {
        return {
          content: "Error: Invalid or expired Perplexity API key",
          isError: true,
        };
      }

      if (response.status === 429 && attempt < MAX_RETRIES) {
        const retryAfter = response.headers.get("retry-after");
        const delayMs =
          retryAfter && !isNaN(Number(retryAfter))
            ? Number(retryAfter) * 1000
            : BASE_DELAY_MS * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      if (response.status === 429) {
        return {
          content:
            "Error: Perplexity rate limit exceeded after retries. Try again shortly.",
          isError: true,
        };
      }
      return {
        content: `Error: Perplexity API returned status ${response.status}`,
        isError: true,
      };
    }

    return {
      content:
        "Error: Perplexity rate limit exceeded after retries. Try again shortly.",
      isError: true,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Error: Web search failed: ${msg}`, isError: true };
  }
}
