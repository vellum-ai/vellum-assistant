import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { executeWebFetch } from "../web-fetch.js";

type RequestExecutor = (
  url: URL,
  requestOptions: {
    signal: AbortSignal;
    headers: Record<string, string>;
    resolvedAddress?: string;
  },
) => Promise<Response>;

const executeWithMockFetch = (
  input: Record<string, unknown>,
  options?: {
    resolveHostAddresses?: (hostname: string) => Promise<string[]>;
    requestExecutor?: RequestExecutor;
  },
) =>
  executeWebFetch(input, {
    resolveHostAddresses:
      options?.resolveHostAddresses ?? (async () => ["93.184.216.34"]),
    requestExecutor:
      options?.requestExecutor ??
      ((url, requestOptions) =>
        globalThis.fetch(url.href, {
          method: "GET",
          redirect: "manual",
          signal: requestOptions.signal,
          headers: requestOptions.headers,
        }) as Promise<Response>),
  });

describe("web_fetch activityMetadata", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("populates metadata on a 200 HTML response with a <title>", async () => {
    const body =
      "<!doctype html><html><head><title>Example Domain</title></head>" +
      "<body><p>Hello, world.</p></body></html>";
    globalThis.fetch = (async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      })) as unknown as typeof globalThis.fetch;

    const result = await executeWithMockFetch({ url: "https://example.com/" });
    expect(result.isError).toBe(false);

    const meta = result.activityMetadata?.webFetch;
    expect(meta).toBeDefined();
    expect(meta?.url).toBe("https://example.com/");
    expect(meta?.finalUrl).toBe("https://example.com/");
    expect(meta?.status).toBe(200);
    expect(meta?.contentType).toContain("text/html");
    expect(meta?.title).toBe("Example Domain");
    expect(meta?.domain).toBe("example.com");
    expect(meta?.byteCount).toBe(Buffer.byteLength(body));
    expect(meta?.charCount).toBeGreaterThan(0);
    expect(meta?.redirectCount).toBe(0);
    expect(meta?.truncated).toBe(false);
    expect(meta?.durationMs).toBeGreaterThanOrEqual(0);
    expect(meta?.errorMessage).toBeUndefined();
  });

  test("tracks redirect chains in finalUrl and redirectCount", async () => {
    let callCount = 0;
    globalThis.fetch = (async (rawUrl: string) => {
      callCount++;
      if (callCount === 1) {
        expect(rawUrl).toBe("https://example.com/start");
        return new Response("", {
          status: 302,
          headers: { location: "https://example.com/middle" },
        });
      }
      if (callCount === 2) {
        return new Response("", {
          status: 301,
          headers: { location: "https://example.com/final" },
        });
      }
      return new Response("<!doctype html><title>Final</title><p>done</p>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }) as unknown as typeof globalThis.fetch;

    const result = await executeWithMockFetch({
      url: "https://example.com/start",
    });
    expect(result.isError).toBe(false);

    const meta = result.activityMetadata?.webFetch;
    expect(meta).toBeDefined();
    expect(meta?.url).toBe("https://example.com/start");
    expect(meta?.finalUrl).toBe("https://example.com/final");
    expect(meta?.finalUrl).not.toBe(meta?.url);
    expect(meta?.redirectCount).toBe(2);
    expect(meta?.title).toBe("Final");
  });

  test("flags truncation when content exceeds max_chars", async () => {
    const longBody = "x".repeat(50_000);
    globalThis.fetch = (async () =>
      new Response(longBody, {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      })) as unknown as typeof globalThis.fetch;

    const maxChars = 1_000;
    const result = await executeWithMockFetch({
      url: "https://example.com/large",
      max_chars: maxChars,
    });
    expect(result.isError).toBe(false);

    const meta = result.activityMetadata?.webFetch;
    expect(meta).toBeDefined();
    expect(meta?.truncated).toBe(true);
    expect(meta?.charCount).toBe(maxChars);
  });

  test("populates errorMessage and status on a 404 response", async () => {
    globalThis.fetch = (async () =>
      new Response("<title>Not Found</title>not here", {
        status: 404,
        statusText: "Not Found",
        headers: { "content-type": "text/html; charset=utf-8" },
      })) as unknown as typeof globalThis.fetch;

    const result = await executeWithMockFetch({
      url: "https://example.com/missing",
    });
    expect(result.isError).toBe(true);

    const meta = result.activityMetadata?.webFetch;
    expect(meta).toBeDefined();
    expect(meta?.status).toBe(404);
    expect(meta?.errorMessage).toBeDefined();
    expect(meta?.errorMessage).toContain("HTTP 404");
    expect(meta?.url).toBe("https://example.com/missing");
    expect(meta?.finalUrl).toBe("https://example.com/missing");
    expect(meta?.domain).toBe("example.com");
  });

  test("flags mayRequireJavaScript when HTML compresses to <5% text and exceeds 10KB", async () => {
    const scriptPayload = `var x = ${JSON.stringify("a".repeat(40_000))};`;
    const body =
      "<!doctype html><html><head><title>App</title></head>" +
      `<body><div id="root"></div><script>${scriptPayload}</script></body></html>`;
    globalThis.fetch = (async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      })) as unknown as typeof globalThis.fetch;

    const result = await executeWithMockFetch({ url: "https://example.com/" });
    expect(result.isError).toBe(false);

    const meta = result.activityMetadata?.webFetch;
    expect(meta?.mayRequireJavaScript).toBe(true);
    expect(result.status).toContain("Content may be JavaScript-rendered");
    expect(result.status).toContain(`${meta?.byteCount} bytes`);
  });

  test("flags mayRequireJavaScript when extracted text is under 200 chars", async () => {
    const body =
      '<!doctype html><html><head><title>Tiny</title></head><body><div id="app"></div></body></html>';
    globalThis.fetch = (async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      })) as unknown as typeof globalThis.fetch;

    const result = await executeWithMockFetch({ url: "https://example.com/" });
    expect(result.isError).toBe(false);

    const meta = result.activityMetadata?.webFetch;
    expect(meta?.mayRequireJavaScript).toBe(true);
    expect(result.status).toContain("Content may be JavaScript-rendered");
  });

  test("does not flag mayRequireJavaScript for content-heavy HTML", async () => {
    const paragraph =
      "<p>" +
      "The quick brown fox jumps over the lazy dog. ".repeat(20) +
      "</p>";
    const body =
      "<!doctype html><html><head><title>Article</title></head>" +
      `<body>${paragraph.repeat(40)}</body></html>`;
    globalThis.fetch = (async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      })) as unknown as typeof globalThis.fetch;

    const result = await executeWithMockFetch({ url: "https://example.com/" });
    expect(result.isError).toBe(false);

    const meta = result.activityMetadata?.webFetch;
    expect(meta?.mayRequireJavaScript).toBeUndefined();
    expect(result.status ?? "").not.toContain("JavaScript-rendered");
  });

  test("does not flag mayRequireJavaScript for markup-heavy pages that still yield substantial text", async () => {
    // Mirrors a server-rendered GitHub PR page: <5% text-to-byte ratio, yet
    // the extraction is complete — thousands of chars of real content.
    const paragraph =
      "<p>" +
      "The quick brown fox jumps over the lazy dog. ".repeat(140) +
      "</p>";
    const scriptPayload = `var x = ${JSON.stringify("a".repeat(200_000))};`;
    const body =
      "<!doctype html><html><head><title>Article</title></head>" +
      `<body>${paragraph}<script>${scriptPayload}</script></body></html>`;
    globalThis.fetch = (async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      })) as unknown as typeof globalThis.fetch;

    const result = await executeWithMockFetch({ url: "https://example.com/" });
    expect(result.isError).toBe(false);

    const meta = result.activityMetadata?.webFetch;
    expect(meta?.mayRequireJavaScript).toBeUndefined();
    expect(result.status ?? "").not.toContain("JavaScript-rendered");
  });

  test("populates metadata for blocked private-network targets", async () => {
    const result = await executeWithMockFetch({
      url: "http://127.0.0.1/admin",
    });
    expect(result.isError).toBe(true);

    const meta = result.activityMetadata?.webFetch;
    expect(meta).toBeDefined();
    expect(meta?.errorMessage).toContain(
      "Refusing to fetch local/private network target",
    );
    expect(meta?.domain).toBe("127.0.0.1");
    expect(meta?.status).toBe(0);
  });
});
