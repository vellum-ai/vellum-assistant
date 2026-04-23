import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { GatewayConfig } from "../../config.js";

// --- Mocks -------------------------------------------------------------------

let capturedFetchHeaders: Headers | undefined;
let capturedFetchUrl: string | undefined;
let fetchResponse = new Response(JSON.stringify({ ok: true }), { status: 200 });

mock.module("../../auth/token-exchange.js", () => ({
  mintServiceToken: () => "test-service-token",
}));

mock.module("../../fetch.js", () => ({
  fetchImpl: async (url: string | URL | Request, init?: RequestInit) => {
    capturedFetchUrl = String(url);
    capturedFetchHeaders = new Headers(init?.headers as HeadersInit);
    return fetchResponse;
  },
}));

// Import after mocks are registered
const { createPairingProxyHandler } = await import("./pairing-proxy.js");

// --- Helpers -----------------------------------------------------------------

function makeConfig(overrides?: Partial<GatewayConfig>): GatewayConfig {
  return {
    assistantRuntimeBaseUrl: "http://localhost:7821",
    runtimeTimeoutMs: 30_000,
    ...overrides,
  } as GatewayConfig;
}

// --- Tests -------------------------------------------------------------------

describe("pairing-proxy", () => {
  beforeEach(() => {
    capturedFetchHeaders = undefined;
    capturedFetchUrl = undefined;
    fetchResponse = new Response(JSON.stringify({ ok: true }), { status: 200 });
  });

  it("proxies POST /pairing/register to runtime", async () => {
    const config = makeConfig();
    const handler = createPairingProxyHandler(config);

    const body = JSON.stringify({ pairingSecret: "abc123" });
    const req = new Request("http://gateway/v1/pairing/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    const response = await handler.handlePairingRegister(req);

    expect(response.status).toBe(200);
    expect(capturedFetchUrl).toContain("/v1/pairing/register");
    expect(capturedFetchHeaders!.get("authorization")).toBe(
      "Bearer test-service-token",
    );
  });

  it("forwards query params for status endpoint", async () => {
    const config = makeConfig();
    const handler = createPairingProxyHandler(config);

    const req = new Request(
      "http://gateway/v1/pairing/status?pairingSecret=abc123",
      { method: "GET" },
    );

    await handler.handlePairingStatus(req);

    expect(capturedFetchUrl).toBeDefined();
    expect(capturedFetchUrl).toContain("/v1/pairing/status");
    expect(capturedFetchUrl).toContain("pairingSecret=abc123");
  });

  it("rejects payloads exceeding size limit via Content-Length", async () => {
    const config = makeConfig();
    const handler = createPairingProxyHandler(config);

    const req = new Request("http://gateway/v1/pairing/register", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(128 * 1024), // 128 KB > 64 KB limit
      },
      body: JSON.stringify({ data: "x" }),
    });

    const response = await handler.handlePairingRegister(req);

    expect(response.status).toBe(413);
    const body = await response.json();
    expect(body.error).toBe("Payload too large");
    // Should NOT have forwarded to upstream
    expect(capturedFetchUrl).toBeUndefined();
  });

  it("allows payloads within size limit", async () => {
    const config = makeConfig();
    const handler = createPairingProxyHandler(config);

    const payload = JSON.stringify({ pairingSecret: "abc123" });
    const req = new Request("http://gateway/v1/pairing/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });

    const response = await handler.handlePairingRegister(req);

    expect(response.status).toBe(200);
    expect(capturedFetchUrl).toContain("/v1/pairing/register");
  });

  it("strips hop-by-hop headers from forwarded request", async () => {
    const config = makeConfig();
    const handler = createPairingProxyHandler(config);

    const req = new Request("http://gateway/v1/pairing/status?secret=abc", {
      method: "GET",
      headers: {
        connection: "keep-alive",
        "keep-alive": "timeout=5",
      },
    });

    await handler.handlePairingStatus(req);

    expect(capturedFetchHeaders).toBeDefined();
    expect(capturedFetchHeaders!.has("connection")).toBe(false);
    expect(capturedFetchHeaders!.has("keep-alive")).toBe(false);
  });

  it("removes incoming host and authorization headers", async () => {
    const config = makeConfig();
    const handler = createPairingProxyHandler(config);

    const req = new Request("http://gateway/v1/pairing/status?secret=abc", {
      method: "GET",
      headers: {
        host: "gateway.example.com",
        authorization: "Bearer old-token",
      },
    });

    await handler.handlePairingStatus(req);

    expect(capturedFetchHeaders).toBeDefined();
    expect(capturedFetchHeaders!.has("host")).toBe(false);
    expect(capturedFetchHeaders!.get("authorization")).toBe(
      "Bearer test-service-token",
    );
  });
});
