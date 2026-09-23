import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";

import { setConfig } from "../../../__tests__/helpers/set-config.js";

let mockTinyfishSecureKey: string | undefined;
let mockResolveAddresses: string[] = [];

function seedWebFetch(provider: string, apiBase?: string): void {
  const entry: Record<string, string> = { provider };
  if (apiBase !== undefined) {
    entry.apiBase = apiBase;
  }
  setConfig("services", { "web-fetch": entry });
}

mock.module("../../../security/secure-keys.js", () => ({
  getProviderKeyAsync: async (provider: string) =>
    provider === "tinyfish" ? mockTinyfishSecureKey : undefined,
}));

const realLogger = await import("../../../util/logger.js");
mock.module("../../../util/logger.js", () => ({
  ...realLogger,
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

mock.module("../../../permissions/types.js", () => ({
  RiskLevel: { Low: "low", Medium: "medium", High: "high" },
}));

const realUrlSafety = await import("../url-safety.js");
mock.module("../url-safety.js", () => ({
  ...realUrlSafety,
  resolveHostAddresses: async () => mockResolveAddresses,
}));

const { executeTinyfishFetch, webFetchTool } = await import("../web-fetch.js");

function fetchResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("executeTinyfishFetch", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    seedWebFetch("tinyfish");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("posts the URL and returns markdown with metadata", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> = {};
    let capturedApiKey = "";
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedBody = JSON.parse(String(init?.body));
      capturedApiKey = new Headers(init?.headers).get("x-api-key") ?? "";
      return fetchResponse({
        results: [
          {
            url: "https://example.com/",
            final_url: "https://www.example.com/",
            title: "Example",
            description: "An example page",
            text: "# Example\n\nHello from TinyFish.",
            format: "markdown",
            latency_ms: 120,
          },
        ],
        errors: [],
      });
    }) as typeof fetch;

    const result = await executeTinyfishFetch(
      { url: "https://example.com", timeout_seconds: 45 },
      { apiKey: "tf_test" },
    );

    expect(result.isError).toBe(false);
    expect(capturedUrl).toBe("https://api.fetch.tinyfish.ai/");
    expect(capturedBody).toEqual({
      urls: ["https://example.com/"],
      format: "markdown",
      per_url_timeout_ms: 45_000,
    });
    expect(capturedApiKey).toBe("tf_test");
    expect(result.content).toContain("Hello from TinyFish.");
    expect(result.content).toContain("Title: Example");
    expect(result.activityMetadata?.webFetch?.provider).toBe("tinyfish");
    expect(result.activityMetadata?.webFetch?.finalUrl).toBe(
      "https://www.example.com/",
    );
  });

  test("an empty upstream title is no title", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(
      fetchResponse({
        results: [
          {
            url: "https://example.com/",
            final_url: "https://example.com/",
            title: "  ",
            text: "# Example",
            format: "markdown",
          },
        ],
        errors: [],
      }),
    );

    const result = await executeTinyfishFetch(
      { url: "https://example.com" },
      { apiKey: "tf_test" },
    );

    expect(result.isError).toBe(false);
    expect(result.activityMetadata?.webFetch?.title).toBeUndefined();
    expect(result.content).not.toContain("Title:");
  });

  test("uses a custom API base and applies character windows", async () => {
    seedWebFetch("tinyfish", "https://fetch.example.com/api/");
    let capturedUrl = "";
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url;
      return fetchResponse({
        results: [
          {
            url: "https://example.com/",
            final_url: "https://example.com/",
            text: "0123456789",
            format: "markdown",
          },
        ],
        errors: [],
      });
    }) as typeof fetch;

    const result = await executeTinyfishFetch(
      { url: "https://example.com", start_index: 2, max_chars: 4 },
      { apiKey: "tf_test" },
    );

    expect(capturedUrl).toBe("https://fetch.example.com/api/");
    expect(result.content).toContain("Character Window: 2-6 of 10");
    expect(result.content).toContain("2345");
    expect(result.activityMetadata?.webFetch?.truncated).toBe(true);
  });

  test("surfaces per-URL errors from a successful HTTP response", async () => {
    globalThis.fetch = (async () =>
      fetchResponse({
        results: [],
        errors: [
          {
            url: "https://example.com/",
            error: "bot_blocked",
            status: 403,
          },
        ],
      })) as unknown as typeof fetch;

    const result = await executeTinyfishFetch(
      { url: "https://example.com" },
      { apiKey: "tf_test" },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("bot_blocked");
    expect(result.content).toContain("HTTP 403");
    expect(result.activityMetadata?.webFetch?.provider).toBe("tinyfish");
    expect(result.activityMetadata?.webFetch?.status).toBe(403);
  });

  test("rejects URL-embedded credentials before calling TinyFish", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return fetchResponse({ results: [], errors: [] });
    }) as unknown as typeof fetch;

    const result = await executeTinyfishFetch(
      { url: "https://user:pass@example.com/private" },
      { apiKey: "tf_test" },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("embedded credentials");
    expect(fetchCalls).toBe(0);
  });
});

describe("webFetchTool TinyFish dispatch", () => {
  let originalFetch: typeof globalThis.fetch;

  const execute = (input: Record<string, unknown>, context: any = {}) =>
    webFetchTool.execute(input, context);

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    seedWebFetch("tinyfish");
    mockTinyfishSecureKey = "tf_test";
    mockResolveAddresses = ["93.184.216.34"];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("routes public URLs to TinyFish when a key is stored", async () => {
    let tinyfishHit = false;
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes("api.fetch.tinyfish.ai")) {
        tinyfishHit = true;
      }
      return fetchResponse({
        results: [
          {
            url: "https://example.com/",
            final_url: "https://example.com/",
            text: "routed",
            format: "markdown",
          },
        ],
        errors: [],
      });
    }) as typeof fetch;

    const result = await execute({ url: "https://example.com" });

    expect(tinyfishHit).toBe(true);
    expect(result.activityMetadata?.webFetch?.provider).toBe("tinyfish");
  });

  test("does not send private targets to TinyFish", async () => {
    let tinyfishHit = false;
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes("api.fetch.tinyfish.ai")) {
        tinyfishHit = true;
      }
      return new Response("", { status: 200 });
    }) as typeof fetch;

    const result = await execute({ url: "http://localhost:8080/admin" });

    expect(tinyfishHit).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.activityMetadata?.webFetch?.provider).toBe("default");
  });

  test("falls back to the built-in fetcher when no TinyFish key is stored", async () => {
    mockTinyfishSecureKey = undefined;
    mockResolveAddresses = [];
    let tinyfishHit = false;
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes("api.fetch.tinyfish.ai")) {
        tinyfishHit = true;
      }
      return new Response("", { status: 200 });
    }) as typeof fetch;

    const result = await execute({ url: "https://example.com" });

    expect(tinyfishHit).toBe(false);
    expect(result.activityMetadata?.webFetch?.provider).toBe("default");
  });
});
