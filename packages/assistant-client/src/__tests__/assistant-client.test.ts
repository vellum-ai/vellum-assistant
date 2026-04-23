import { describe, expect, test } from "bun:test";

import {
  buildUpstreamUrl,
  stripHopByHop,
  prepareUpstreamHeaders,
  createTimeoutController,
  isTimeoutError,
  isConnectionError,
} from "../http-client.js";

import { proxyForward } from "../proxy-forward.js";

import {
  httpToWs,
  buildWsUpstreamUrl,
} from "../websocket-upstream.js";

// ---------------------------------------------------------------------------
// http-client: URL normalization
// ---------------------------------------------------------------------------

describe("buildUpstreamUrl", () => {
  test("joins base URL and path", () => {
    expect(buildUpstreamUrl("http://localhost:7821", "/v1/health")).toBe(
      "http://localhost:7821/v1/health",
    );
  });

  test("strips trailing slashes from base", () => {
    expect(buildUpstreamUrl("http://localhost:7821/", "/v1/health")).toBe(
      "http://localhost:7821/v1/health",
    );
  });

  test("strips multiple trailing slashes from base", () => {
    expect(buildUpstreamUrl("http://localhost:7821///", "/v1/health")).toBe(
      "http://localhost:7821/v1/health",
    );
  });

  test("adds leading slash to path if missing", () => {
    expect(buildUpstreamUrl("http://localhost:7821", "v1/health")).toBe(
      "http://localhost:7821/v1/health",
    );
  });

  test("appends search string", () => {
    expect(
      buildUpstreamUrl("http://localhost:7821", "/v1/channels", "?foo=bar"),
    ).toBe("http://localhost:7821/v1/channels?foo=bar");
  });

  test("omits search when undefined", () => {
    expect(buildUpstreamUrl("http://localhost:7821", "/v1/health")).toBe(
      "http://localhost:7821/v1/health",
    );
  });
});

// ---------------------------------------------------------------------------
// http-client: hop-by-hop header stripping
// ---------------------------------------------------------------------------

describe("stripHopByHop", () => {
  test("removes standard hop-by-hop headers", () => {
    const headers = new Headers({
      connection: "keep-alive",
      "keep-alive": "timeout=5",
      "transfer-encoding": "chunked",
      "content-type": "application/json",
    });
    const cleaned = stripHopByHop(headers);
    expect(cleaned.has("connection")).toBe(false);
    expect(cleaned.has("keep-alive")).toBe(false);
    expect(cleaned.has("transfer-encoding")).toBe(false);
    expect(cleaned.get("content-type")).toBe("application/json");
  });

  test("removes headers listed in Connection value", () => {
    const headers = new Headers({
      connection: "x-custom-hop",
      "x-custom-hop": "value",
      "x-keep": "preserved",
    });
    const cleaned = stripHopByHop(headers);
    expect(cleaned.has("x-custom-hop")).toBe(false);
    expect(cleaned.get("x-keep")).toBe("preserved");
  });

  test("does not mutate the original headers", () => {
    const original = new Headers({ connection: "keep-alive" });
    stripHopByHop(original);
    expect(original.has("connection")).toBe(true);
  });

  test("handles empty headers gracefully", () => {
    const cleaned = stripHopByHop(new Headers());
    expect([...cleaned.entries()]).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// http-client: auth header injection
// ---------------------------------------------------------------------------

describe("prepareUpstreamHeaders", () => {
  test("injects service token as Bearer authorization", () => {
    const source = new Headers({ "content-type": "application/json" });
    const prepared = prepareUpstreamHeaders(source, "test-token-123");
    expect(prepared.get("authorization")).toBe("Bearer test-token-123");
  });

  test("removes incoming host header", () => {
    const source = new Headers({ host: "gateway.example.com" });
    const prepared = prepareUpstreamHeaders(source, "token");
    expect(prepared.has("host")).toBe(false);
  });

  test("replaces incoming authorization header", () => {
    const source = new Headers({ authorization: "Bearer old-edge-token" });
    const prepared = prepareUpstreamHeaders(source, "new-service-token");
    expect(prepared.get("authorization")).toBe("Bearer new-service-token");
  });

  test("strips hop-by-hop headers from source", () => {
    const source = new Headers({
      connection: "keep-alive",
      "keep-alive": "timeout=5",
      "x-custom": "preserved",
    });
    const prepared = prepareUpstreamHeaders(source, "token");
    expect(prepared.has("connection")).toBe(false);
    expect(prepared.has("keep-alive")).toBe(false);
    expect(prepared.get("x-custom")).toBe("preserved");
  });
});

// ---------------------------------------------------------------------------
// http-client: timeout helpers
// ---------------------------------------------------------------------------

describe("createTimeoutController", () => {
  test("returns a controller and clear function", () => {
    const { controller, clear } = createTimeoutController(5000);
    expect(controller).toBeInstanceOf(AbortController);
    expect(typeof clear).toBe("function");
    // Clean up timer to avoid leaks
    clear();
  });

  test("abort signal fires with TimeoutError after timeout", async () => {
    const { controller } = createTimeoutController(10);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(controller.signal.aborted).toBe(true);
    expect(isTimeoutError(controller.signal.reason)).toBe(true);
  });

  test("clear prevents abort", async () => {
    const { controller, clear } = createTimeoutController(10);
    clear();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(controller.signal.aborted).toBe(false);
  });
});

describe("isTimeoutError", () => {
  test("returns true for TimeoutError DOMException", () => {
    const err = new DOMException("timeout", "TimeoutError");
    expect(isTimeoutError(err)).toBe(true);
  });

  test("returns false for regular Error", () => {
    expect(isTimeoutError(new Error("connection refused"))).toBe(false);
  });

  test("returns false for non-error values", () => {
    expect(isTimeoutError("timeout")).toBe(false);
    expect(isTimeoutError(null)).toBe(false);
  });
});

describe("isConnectionError", () => {
  test("returns true for regular Error", () => {
    expect(isConnectionError(new Error("ECONNREFUSED"))).toBe(true);
  });

  test("returns false for TimeoutError", () => {
    const err = new DOMException("timeout", "TimeoutError");
    expect(isConnectionError(err)).toBe(false);
  });

  test("returns false for non-Error values", () => {
    expect(isConnectionError("error string")).toBe(false);
    expect(isConnectionError(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// proxy-forward: timeout-to-504 and connection-failure-to-502 mapping
// ---------------------------------------------------------------------------

describe("proxyForward", () => {
  test("maps timeout to 504 Gateway Timeout", async () => {
    const req = new Request("http://gateway/v1/health", { method: "GET" });
    const result = await proxyForward(req, {
      baseUrl: "http://localhost:7821",
      path: "/v1/health",
      serviceToken: "tok",
      timeoutMs: 5000,
      fetchImpl: () => {
        throw new DOMException("timeout", "TimeoutError");
      },
    });
    expect(result.status).toBe(504);
    expect(result.gatewayError).toBe(true);
    expect(result.body).toContain("Gateway Timeout");
  });

  test("maps connection failure to 502 Bad Gateway", async () => {
    const req = new Request("http://gateway/v1/health", { method: "GET" });
    const result = await proxyForward(req, {
      baseUrl: "http://localhost:7821",
      path: "/v1/health",
      serviceToken: "tok",
      timeoutMs: 5000,
      fetchImpl: () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(result.status).toBe(502);
    expect(result.gatewayError).toBe(true);
    expect(result.body).toContain("Bad Gateway");
  });

  test("forwards successful response with stripped hop-by-hop headers", async () => {
    const req = new Request("http://gateway/v1/data", { method: "GET" });
    const result = await proxyForward(req, {
      baseUrl: "http://localhost:7821",
      path: "/v1/data",
      serviceToken: "tok",
      timeoutMs: 5000,
      fetchImpl: async () =>
        new Response('{"ok":true}', {
          status: 200,
          headers: {
            "content-type": "application/json",
            connection: "keep-alive",
          },
        }),
    });
    expect(result.status).toBe(200);
    expect(result.gatewayError).toBe(false);
    expect(result.headers.has("connection")).toBe(false);
    expect(result.headers.get("content-type")).toBe("application/json");
  });

  test("returns upstream error body for 4xx/5xx responses", async () => {
    const req = new Request("http://gateway/v1/missing", { method: "GET" });
    const result = await proxyForward(req, {
      baseUrl: "http://localhost:7821",
      path: "/v1/missing",
      serviceToken: "tok",
      timeoutMs: 5000,
      fetchImpl: async () =>
        new Response("Not Found", { status: 404 }),
    });
    expect(result.status).toBe(404);
    expect(result.gatewayError).toBe(false);
    expect(result.body).toBe("Not Found");
  });

  test("buffers POST body and sets content-length", async () => {
    let capturedHeaders: Headers | undefined;
    let capturedBody: ArrayBuffer | null = null;

    const req = new Request("http://gateway/v1/inbound", {
      method: "POST",
      body: JSON.stringify({ message: "hello" }),
      headers: { "content-type": "application/json" },
    });

    await proxyForward(req, {
      baseUrl: "http://localhost:7821",
      path: "/v1/inbound",
      serviceToken: "tok",
      timeoutMs: 5000,
      fetchImpl: async (_url, init) => {
        capturedHeaders = new Headers(init?.headers as HeadersInit);
        if (init?.body instanceof ArrayBuffer) {
          capturedBody = init.body;
        }
        return new Response("ok", { status: 200 });
      },
    });

    expect(capturedHeaders?.get("content-length")).toBe(
      String(JSON.stringify({ message: "hello" }).length),
    );
    expect(capturedHeaders?.get("authorization")).toBe("Bearer tok");
    expect(capturedBody).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// websocket-upstream: protocol conversion
// ---------------------------------------------------------------------------

describe("httpToWs", () => {
  test("converts http to ws", () => {
    expect(httpToWs("http://localhost:7821")).toBe("ws://localhost:7821");
  });

  test("converts https to wss", () => {
    expect(httpToWs("https://runtime.example.com")).toBe(
      "wss://runtime.example.com",
    );
  });

  test("preserves path and port", () => {
    expect(httpToWs("http://localhost:7821/prefix")).toBe(
      "ws://localhost:7821/prefix",
    );
  });
});

// ---------------------------------------------------------------------------
// websocket-upstream: URL construction
// ---------------------------------------------------------------------------

describe("buildWsUpstreamUrl", () => {
  test("builds URL with token query parameter", () => {
    const result = buildWsUpstreamUrl({
      baseUrl: "http://localhost:7821",
      path: "/v1/browser-relay",
      serviceToken: "service-jwt-123",
    });
    expect(result.url).toContain("ws://localhost:7821/v1/browser-relay?");
    expect(result.url).toContain("token=service-jwt-123");
  });

  test("includes extra params in URL", () => {
    const result = buildWsUpstreamUrl({
      baseUrl: "http://localhost:7821",
      path: "/v1/browser-relay",
      serviceToken: "tok",
      extraParams: {
        guardianId: "guardian-abc",
        clientInstanceId: "inst-xyz",
      },
    });
    expect(result.url).toContain("guardianId=guardian-abc");
    expect(result.url).toContain("clientInstanceId=inst-xyz");
  });

  test("produces log-safe URL with redacted token", () => {
    const result = buildWsUpstreamUrl({
      baseUrl: "http://localhost:7821",
      path: "/v1/calls/relay",
      serviceToken: "secret-jwt-value",
      extraParams: { callSessionId: "sess-1" },
    });
    expect(result.logSafeUrl).toContain("token=%3Credacted%3E");
    expect(result.logSafeUrl).not.toContain("secret-jwt-value");
    expect(result.logSafeUrl).toContain("callSessionId=sess-1");
  });

  test("ignores token key in extraParams", () => {
    const result = buildWsUpstreamUrl({
      baseUrl: "http://localhost:7821",
      path: "/v1/stt/stream",
      serviceToken: "real-token",
      extraParams: { token: "should-be-ignored", mimeType: "audio/webm" },
    });
    // The token should be the service token, not the extra param
    const url = new URL(result.url);
    expect(url.searchParams.get("token")).toBe("real-token");
    expect(url.searchParams.get("mimeType")).toBe("audio/webm");
  });

  test("strips trailing slashes from base URL", () => {
    const result = buildWsUpstreamUrl({
      baseUrl: "http://localhost:7821/",
      path: "/v1/browser-relay",
      serviceToken: "tok",
    });
    expect(result.url).toContain("ws://localhost:7821/v1/browser-relay?");
    expect(result.url).not.toContain("//v1");
  });

  test("converts https to wss", () => {
    const result = buildWsUpstreamUrl({
      baseUrl: "https://runtime.example.com",
      path: "/v1/calls/media-stream",
      serviceToken: "tok",
    });
    expect(result.url).toStartWith("wss://runtime.example.com/v1/calls/media-stream?");
  });
});
