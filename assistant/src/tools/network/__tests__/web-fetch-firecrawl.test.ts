import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { setConfig } from "../../../__tests__/helpers/set-config.js";

// --- Mutable mock state (per test) -----------------------------------------
let mockFirecrawlSecureKey: string | undefined;

/** Seed the active web-fetch provider into the workspace config for real. */
function seedWebFetch(provider: string): void {
  setConfig("services", { "web-fetch": { provider } });
}

mock.module("../../../security/secure-keys.js", () => ({
  getProviderKeyAsync: async (provider: string) =>
    provider === "firecrawl" ? mockFirecrawlSecureKey : undefined,
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

// Keep real url-safety helpers (parseUrl, sanitize*, isPrivateOrLocalHost,
// resolveRequestAddress) but stub DNS resolution. The returned address list is
// mutable per test: an empty list makes the built-in fallback path
// short-circuit ("Unable to resolve host") before any socket is opened, while a
// public address lets a Firecrawl-routed request through the dispatcher's DNS
// safety gate. A private address exercises the "don't leak to Firecrawl" guard.
let mockResolveAddresses: string[] = [];
const realUrlSafety = await import("../url-safety.js");
mock.module("../url-safety.js", () => ({
  ...realUrlSafety,
  resolveHostAddresses: async () => mockResolveAddresses,
}));

const { executeFirecrawlScrape, webFetchTool } =
  await import("../web-fetch.js");

const SCRAPE_URL = "api.firecrawl.dev/v2/scrape";

function scrapeResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("executeFirecrawlScrape", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns markdown content + metadata on success", async () => {
    globalThis.fetch = (async () =>
      scrapeResponse({
        success: true,
        data: {
          markdown: "# Example\n\nHello from Firecrawl.",
          metadata: {
            title: "Example Domain",
            description: "An example page",
            url: "https://example.com/",
            statusCode: 200,
            contentType: "text/html",
          },
        },
      })) as any;

    const result = await executeFirecrawlScrape(
      { url: "https://example.com" },
      { apiKey: "fc-test-key" },
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Hello from Firecrawl.");
    expect(result.content).toContain("Mode: markdown");
    expect(result.content).toContain("Title: Example Domain");
    const meta = result.activityMetadata?.webFetch;
    expect(meta?.provider).toBe("firecrawl");
    expect(meta?.status).toBe(200);
    expect(meta?.title).toBe("Example Domain");
    expect(meta?.finalUrl).toContain("example.com");
  });

  test("sends the correct request shape", async () => {
    let capturedUrl = "";
    let capturedBody: any = null;
    let capturedHeaders: Headers | null = null;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init?.body as string);
      capturedHeaders = new Headers(init?.headers);
      return scrapeResponse({ success: true, data: { markdown: "ok" } });
    }) as any;

    await executeFirecrawlScrape(
      { url: "https://example.com/docs" },
      { apiKey: "fc-test-key" },
    );

    expect(capturedUrl).toContain(SCRAPE_URL);
    expect(capturedBody.url).toBe("https://example.com/docs");
    expect(capturedBody.formats).toEqual(["markdown"]);
    expect(capturedBody.onlyMainContent).toBe(true);
    expect(capturedHeaders!.get("authorization")).toBe("Bearer fc-test-key");
    expect(capturedHeaders!.get("x-client-source")).toBe("vellum-assistant");
  });

  test("honors max_chars windowing and emits a truncation notice", async () => {
    globalThis.fetch = (async () =>
      scrapeResponse({
        success: true,
        data: { markdown: "abcdefghij", metadata: { statusCode: 200 } },
      })) as any;

    const result = await executeFirecrawlScrape(
      { url: "https://example.com", max_chars: 4 },
      { apiKey: "fc-key" },
    );
    expect(result.isError).toBe(false);
    expect(result.activityMetadata?.webFetch?.truncated).toBe(true);
    expect(result.status).toContain("truncated");
  });

  test("empty markdown yields a no-content marker, not an error", async () => {
    globalThis.fetch = (async () =>
      scrapeResponse({ success: true, data: { markdown: "" } })) as any;

    const result = await executeFirecrawlScrape(
      { url: "https://example.com" },
      { apiKey: "fc-key" },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("<no_content />");
  });

  test("rejects URLs with embedded credentials instead of forwarding them", async () => {
    let hit = false;
    globalThis.fetch = (async () => {
      hit = true;
      return scrapeResponse({ success: true, data: { markdown: "x" } });
    }) as any;

    const result = await executeFirecrawlScrape(
      { url: "https://user:secret@example.com/page" },
      { apiKey: "fc-key" },
    );
    expect(hit).toBe(false); // never sent to Firecrawl
    expect(result.isError).toBe(true);
    expect(result.content).toContain("embedded credentials");
    // The secret must not leak into the surfaced url/metadata.
    expect(result.content).not.toContain("secret");
  });

  test("surfaces a payload-level failure on a 200 (success:false / error)", async () => {
    globalThis.fetch = (async () =>
      scrapeResponse({
        success: false,
        error: "This website is no longer supported",
        data: {},
      })) as any;

    const result = await executeFirecrawlScrape(
      { url: "https://example.com" },
      { apiKey: "fc-key" },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("no longer supported");
  });

  test("surfaces invalid JSON as a clean error", async () => {
    globalThis.fetch = (async () =>
      new Response("<html>not json</html>", {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as any;

    const result = await executeFirecrawlScrape(
      { url: "https://example.com" },
      { apiKey: "fc-key" },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("invalid JSON");
  });

  test.each([401, 403])(
    "surfaces %d as an invalid-key error",
    async (status) => {
      globalThis.fetch = (async () =>
        new Response("Unauthorized", { status })) as any;

      const result = await executeFirecrawlScrape(
        { url: "https://example.com" },
        { apiKey: "bad-key" },
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Invalid or expired Firecrawl API key");
      expect(result.activityMetadata?.webFetch?.provider).toBe("firecrawl");
    },
  );

  test("retries 429 then surfaces a rate-limit error", async () => {
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount++;
      return new Response("Too Many Requests", {
        status: 429,
        headers: { "retry-after": "0" },
      });
    }) as any;

    const result = await executeFirecrawlScrape(
      { url: "https://example.com" },
      { apiKey: "fc-key" },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("rate limit");
    expect(callCount).toBe(4); // 1 + DEFAULT_MAX_RETRIES
  });
});

describe("web_fetch provider dispatch", () => {
  let originalFetch: typeof globalThis.fetch;

  const execute = (input: Record<string, unknown>, ctx: any = {}) =>
    webFetchTool.execute(input, ctx);

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    seedWebFetch("default");
    mockFirecrawlSecureKey = undefined;
    mockResolveAddresses = [];
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("routes to Firecrawl when provider=firecrawl and a key is set", async () => {
    seedWebFetch("firecrawl");
    mockFirecrawlSecureKey = "fc-key";
    mockResolveAddresses = ["93.184.216.34"]; // public → passes the DNS safety gate
    let hitUrl = "";
    globalThis.fetch = (async (url: string) => {
      hitUrl = url;
      return scrapeResponse({
        success: true,
        data: { markdown: "routed", metadata: { statusCode: 200 } },
      });
    }) as any;

    const result = await execute({ url: "https://example.com" });
    expect(hitUrl).toContain(SCRAPE_URL);
    expect(result.activityMetadata?.webFetch?.provider).toBe("firecrawl");
  });

  test("falls back to the built-in fetcher when provider=firecrawl but no key", async () => {
    seedWebFetch("firecrawl");
    mockFirecrawlSecureKey = undefined;
    let firecrawlHit = false;
    globalThis.fetch = (async (url: string) => {
      if (typeof url === "string" && url.includes(SCRAPE_URL)) {
        firecrawlHit = true;
      }
      return new Response("", { status: 200 });
    }) as any;

    const result = await execute({ url: "https://example.com" });
    // Built-in path runs (DNS stubbed to empty → resolve error), Firecrawl not hit.
    expect(firecrawlHit).toBe(false);
    expect(result.activityMetadata?.webFetch?.provider).toBe("default");
  });

  test("provider=default never touches Firecrawl", async () => {
    seedWebFetch("default");
    mockFirecrawlSecureKey = "fc-key";
    let firecrawlHit = false;
    globalThis.fetch = (async (url: string) => {
      if (typeof url === "string" && url.includes(SCRAPE_URL)) {
        firecrawlHit = true;
      }
      return new Response("", { status: 200 });
    }) as any;

    const result = await execute({ url: "https://example.com" });
    expect(firecrawlHit).toBe(false);
    expect(result.activityMetadata?.webFetch?.provider).toBe("default");
  });

  test("private/local targets bypass Firecrawl and use the built-in fetcher", async () => {
    seedWebFetch("firecrawl");
    mockFirecrawlSecureKey = "fc-key";
    let firecrawlHit = false;
    globalThis.fetch = (async (url: string) => {
      if (typeof url === "string" && url.includes(SCRAPE_URL)) {
        firecrawlHit = true;
      }
      return new Response("", { status: 200 });
    }) as any;

    const result = await execute({ url: "http://localhost:8080/admin" });
    expect(firecrawlHit).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.content.toLowerCase()).toContain("private");
    expect(result.activityMetadata?.webFetch?.provider).toBe("default");
  });

  test("a public host that DNS-resolves to a private IP is not sent to Firecrawl", async () => {
    seedWebFetch("firecrawl");
    mockFirecrawlSecureKey = "fc-key";
    mockResolveAddresses = ["10.0.0.5"]; // public name, private address → blocked
    let firecrawlHit = false;
    globalThis.fetch = (async (url: string) => {
      if (typeof url === "string" && url.includes(SCRAPE_URL)) {
        firecrawlHit = true;
      }
      return new Response("", { status: 200 });
    }) as any;

    const result = await execute({
      url: "https://internal.example/secret?token=abc",
    });
    expect(firecrawlHit).toBe(false); // internal URL never leaked to Firecrawl
    expect(result.isError).toBe(true);
    expect(result.activityMetadata?.webFetch?.provider).toBe("default");
  });

  test("non-http(s) schemes are not sent to Firecrawl", async () => {
    seedWebFetch("firecrawl");
    mockFirecrawlSecureKey = "fc-key";
    mockResolveAddresses = ["93.184.216.34"];
    let firecrawlHit = false;
    globalThis.fetch = (async (url: string) => {
      if (typeof url === "string" && url.includes(SCRAPE_URL)) {
        firecrawlHit = true;
      }
      return new Response("", { status: 200 });
    }) as any;

    const result = await execute({ url: "ftp://example.com/file" });
    expect(firecrawlHit).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.activityMetadata?.webFetch?.provider).toBe("default");
  });
});
