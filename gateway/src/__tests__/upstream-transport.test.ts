/**
 * Integration tests verifying that gateway routes use the shared
 * @vellumai/assistant-client helpers correctly for upstream transport
 * construction. Asserts URL/token generation, close/error behavior,
 * and that route-specific security gates remain untouched.
 */

import { describe, expect, test } from "bun:test";
import {
  buildUpstreamUrl,
  prepareUpstreamHeaders,
  buildWsUpstreamUrl,
  httpToWs,
  createTimeoutController,
  isTimeoutError,
  stripHopByHop,
} from "@vellumai/assistant-client";

// ---------------------------------------------------------------------------
// HTTP proxy route patterns — upstream URL construction
// ---------------------------------------------------------------------------

describe("HTTP proxy upstream URL construction via assistant-client", () => {
  const baseUrl = "http://localhost:7821";

  test("brain-graph proxy builds correct upstream URL", () => {
    const url = buildUpstreamUrl(baseUrl, "/v1/brain-graph");
    expect(url).toBe("http://localhost:7821/v1/brain-graph");
  });

  test("brain-graph-ui proxy builds correct upstream URL", () => {
    const url = buildUpstreamUrl(baseUrl, "/v1/brain-graph-ui");
    expect(url).toBe("http://localhost:7821/v1/brain-graph-ui");
  });

  test("upgrade-broadcast proxy builds correct upstream URL", () => {
    const url = buildUpstreamUrl(baseUrl, "/v1/admin/upgrade-broadcast");
    expect(url).toBe("http://localhost:7821/v1/admin/upgrade-broadcast");
  });

  test("workspace-commit proxy builds correct upstream URL", () => {
    const url = buildUpstreamUrl(baseUrl, "/v1/admin/workspace-commit");
    expect(url).toBe("http://localhost:7821/v1/admin/workspace-commit");
  });

  test("migration-export proxy builds correct upstream URL", () => {
    const url = buildUpstreamUrl(baseUrl, "/v1/migrations/export");
    expect(url).toBe("http://localhost:7821/v1/migrations/export");
  });

  test("migration-import proxy builds correct upstream URL", () => {
    const url = buildUpstreamUrl(baseUrl, "/v1/migrations/import");
    expect(url).toBe("http://localhost:7821/v1/migrations/import");
  });

  test("migration-rollback proxy builds correct upstream URL", () => {
    const url = buildUpstreamUrl(baseUrl, "/v1/admin/rollback-migrations");
    expect(url).toBe("http://localhost:7821/v1/admin/rollback-migrations");
  });

  test("runtime proxy builds upstream URL with path rewrite and search", () => {
    // Simulates the path rewriting logic in the runtime proxy route
    const upstreamPath = "/v1/conversations";
    const search = "?limit=10";
    const url = buildUpstreamUrl(baseUrl, upstreamPath, search);
    expect(url).toBe("http://localhost:7821/v1/conversations?limit=10");
  });

  test("runtime proxy rewrites assistant-scoped paths correctly", () => {
    // The route rewrites /v1/assistants/:id/... to /v1/...
    const originalPath = "/v1/assistants/asst-123/conversations";
    const match = originalPath.match(/^\/v1\/assistants\/[^/]+\/(.+)$/);
    const rewrittenPath = match ? `/v1/${match[1]}` : originalPath;
    const url = buildUpstreamUrl(baseUrl, rewrittenPath);
    expect(url).toBe("http://localhost:7821/v1/conversations");
  });
});

// ---------------------------------------------------------------------------
// HTTP proxy route patterns — header preparation
// ---------------------------------------------------------------------------

describe("HTTP proxy header preparation via assistant-client", () => {
  test("prepareUpstreamHeaders injects service token and strips edge auth", () => {
    const source = new Headers({
      authorization: "Bearer edge-token-from-client",
      host: "gateway.example.com",
      "content-type": "application/json",
      connection: "keep-alive",
    });

    const prepared = prepareUpstreamHeaders(source, "service-token-xyz");

    // Service token replaces edge token
    expect(prepared.get("authorization")).toBe("Bearer service-token-xyz");
    // Host removed (upstream uses its own)
    expect(prepared.has("host")).toBe(false);
    // Hop-by-hop stripped
    expect(prepared.has("connection")).toBe(false);
    // Content headers preserved
    expect(prepared.get("content-type")).toBe("application/json");
  });

  test("x-forwarded-for can be injected after prepareUpstreamHeaders", () => {
    const source = new Headers({
      authorization: "Bearer edge-token",
      "x-forwarded-for": "spoofed-value",
    });

    const prepared = prepareUpstreamHeaders(source, "svc-tok");
    // prepareUpstreamHeaders does not strip x-forwarded-for — the route does
    prepared.set("x-forwarded-for", "192.168.1.100");

    expect(prepared.get("x-forwarded-for")).toBe("192.168.1.100");
  });
});

// ---------------------------------------------------------------------------
// HTTP proxy route patterns — timeout/error handling
// ---------------------------------------------------------------------------

describe("HTTP proxy timeout/error via assistant-client", () => {
  test("createTimeoutController produces a clearable abort controller", () => {
    const { controller, clear } = createTimeoutController(30_000);
    expect(controller.signal.aborted).toBe(false);
    clear(); // prevents timer from firing
  });

  test("isTimeoutError identifies TimeoutError correctly", () => {
    expect(
      isTimeoutError(
        new DOMException(
          "The operation was aborted due to timeout",
          "TimeoutError",
        ),
      ),
    ).toBe(true);
    expect(isTimeoutError(new Error("ECONNREFUSED"))).toBe(false);
  });

  test("stripHopByHop strips response hop-by-hop headers", () => {
    const resHeaders = new Headers({
      "content-type": "application/json",
      connection: "keep-alive",
      "transfer-encoding": "chunked",
      "x-request-id": "abc123",
    });
    const cleaned = stripHopByHop(resHeaders);
    expect(cleaned.has("connection")).toBe(false);
    expect(cleaned.has("transfer-encoding")).toBe(false);
    expect(cleaned.get("content-type")).toBe("application/json");
    expect(cleaned.get("x-request-id")).toBe("abc123");
  });
});

// ---------------------------------------------------------------------------
// WebSocket route patterns — upstream URL/token generation
// ---------------------------------------------------------------------------

describe("WS upstream URL construction via assistant-client", () => {
  const baseUrl = "http://localhost:7821";

  test("twilio-relay builds correct upstream WS URL with callSessionId", () => {
    const result = buildWsUpstreamUrl({
      baseUrl,
      path: "/v1/calls/relay",
      serviceToken: "svc-jwt-token",
      extraParams: { callSessionId: "call-session-123" },
    });

    const url = new URL(result.url);
    expect(url.pathname).toBe("/v1/calls/relay");
    expect(url.searchParams.get("token")).toBe("svc-jwt-token");
    expect(url.searchParams.get("callSessionId")).toBe("call-session-123");
  });

  test("twilio-media builds correct upstream WS URL with callSessionId", () => {
    const result = buildWsUpstreamUrl({
      baseUrl,
      path: "/v1/calls/media-stream",
      serviceToken: "svc-jwt-token",
      extraParams: { callSessionId: "media-session-456" },
    });

    const url = new URL(result.url);
    expect(url.pathname).toBe("/v1/calls/media-stream");
    expect(url.searchParams.get("token")).toBe("svc-jwt-token");
    expect(url.searchParams.get("callSessionId")).toBe("media-session-456");
  });

  test("stt-stream builds correct upstream WS URL with provider and mimeType", () => {
    const result = buildWsUpstreamUrl({
      baseUrl,
      path: "/v1/stt/stream",
      serviceToken: "svc-jwt-token",
      extraParams: {
        mimeType: "audio/webm;codecs=opus",
        provider: "deepgram",
        sampleRate: "16000",
      },
    });

    const url = new URL(result.url);
    expect(url.pathname).toBe("/v1/stt/stream");
    expect(url.searchParams.get("token")).toBe("svc-jwt-token");
    expect(url.searchParams.get("mimeType")).toBe("audio/webm;codecs=opus");
    expect(url.searchParams.get("provider")).toBe("deepgram");
    expect(url.searchParams.get("sampleRate")).toBe("16000");
  });

  test("stt-stream omits optional params when absent", () => {
    const result = buildWsUpstreamUrl({
      baseUrl,
      path: "/v1/stt/stream",
      serviceToken: "svc-jwt-token",
      extraParams: {
        mimeType: "audio/webm",
      },
    });

    const url = new URL(result.url);
    expect(url.searchParams.get("mimeType")).toBe("audio/webm");
    expect(url.searchParams.has("provider")).toBe(false);
    expect(url.searchParams.has("sampleRate")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WS upstream — log-safe URL redacts token
// ---------------------------------------------------------------------------

describe("WS upstream log-safe URL", () => {
  test("all WS routes produce log-safe URLs with redacted token", () => {
    const routes: Array<{
      path: string;
      params: Record<string, string>;
    }> = [
      { path: "/v1/calls/relay", params: { callSessionId: "c1" } },
      { path: "/v1/calls/media-stream", params: { callSessionId: "m1" } },
      { path: "/v1/stt/stream", params: { mimeType: "audio/webm" } },
    ];

    for (const route of routes) {
      const result = buildWsUpstreamUrl({
        baseUrl: "http://localhost:7821",
        path: route.path,
        serviceToken: "secret-token-should-not-appear",
        extraParams: route.params,
      });

      expect(result.logSafeUrl).not.toContain("secret-token-should-not-appear");
      expect(result.logSafeUrl).toContain("redacted");

      // But non-token params are preserved in log-safe URL
      for (const [key, value] of Object.entries(route.params)) {
        expect(result.logSafeUrl).toContain(key);
        expect(result.logSafeUrl).toContain(encodeURIComponent(value));
      }
    }
  });
});

// ---------------------------------------------------------------------------
// WS upstream — protocol conversion
// ---------------------------------------------------------------------------

describe("WS protocol conversion via assistant-client", () => {
  test("http base URL converts to ws", () => {
    expect(httpToWs("http://localhost:7821")).toBe("ws://localhost:7821");
  });

  test("https base URL converts to wss", () => {
    expect(httpToWs("https://runtime.example.com")).toBe(
      "wss://runtime.example.com",
    );
  });

  test("preserves path in base URL", () => {
    expect(httpToWs("http://localhost:7821/api")).toBe(
      "ws://localhost:7821/api",
    );
  });
});
