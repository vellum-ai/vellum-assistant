import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { GatewayConfig } from "../../config.js";

// --- Mocks -------------------------------------------------------------------

let capturedFetchHeaders: Headers | undefined;
let capturedFetchUrl: string | undefined;
let fetchResponse = new Response(JSON.stringify({ ok: true }), { status: 200 });

// Mock mintServiceToken before importing the module under test
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

mock.module("../../paths.js", () => ({
  getGatewaySecurityDir: () => "/tmp/test-gateway-sec",
  getWorkspaceDir: () => "/tmp/test-workspace",
}));

mock.module("../../auth/guardian-bootstrap.js", () => ({
  bootstrapGuardian: () => ({
    guardianPrincipalId: "vellum-principal-test",
    accessToken: "test-jwt",
    accessTokenExpiresAt: Date.now() + 86400_000,
    refreshToken: "test-rt",
    refreshTokenExpiresAt: Date.now() + 86400_000 * 30,
    refreshAfter: Date.now() + 86400_000 * 15,
    isNew: true,
  }),
}));

// Import after mocks are registered
const { createChannelVerificationSessionProxyHandler } =
  await import("./channel-verification-session-proxy.js");

// --- Helpers -----------------------------------------------------------------

function makeConfig(overrides?: Partial<GatewayConfig>): GatewayConfig {
  return {
    assistantRuntimeBaseUrl: "http://localhost:7821",
    runtimeTimeoutMs: 30_000,
    ...overrides,
  } as GatewayConfig;
}

// --- Tests -------------------------------------------------------------------

describe("channel-verification-session-proxy x-forwarded-for handling", () => {
  beforeEach(() => {
    capturedFetchHeaders = undefined;
    capturedFetchUrl = undefined;
    fetchResponse = new Response(JSON.stringify({ ok: true }), { status: 200 });
  });

  it("strips x-forwarded-for for loopback client IP", async () => {
    const config = makeConfig();
    const handler = createChannelVerificationSessionProxyHandler(config);

    const req = new Request("http://gateway/v1/channel-verification-sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "should-be-stripped",
      },
      body: JSON.stringify({ channel: "test" }),
    });

    // proxyToRuntime is called without clientIp from handleCreateVerificationSession,
    // so x-forwarded-for should be stripped
    await handler.handleCreateVerificationSession(req);

    expect(capturedFetchHeaders).toBeDefined();
    expect(capturedFetchHeaders!.has("x-forwarded-for")).toBe(false);
  });

  it("injects service token as Bearer authorization", async () => {
    const config = makeConfig();
    const handler = createChannelVerificationSessionProxyHandler(config);

    const req = new Request("http://gateway/v1/channel-verification-sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: "test" }),
    });

    await handler.handleCreateVerificationSession(req);

    expect(capturedFetchHeaders).toBeDefined();
    expect(capturedFetchHeaders!.get("authorization")).toBe(
      "Bearer test-service-token",
    );
  });

  it("forwards query params for status endpoint", async () => {
    const config = makeConfig();
    const handler = createChannelVerificationSessionProxyHandler(config);

    const req = new Request(
      "http://gateway/v1/channel-verification-sessions/status?channel=telegram&id=123",
      { method: "GET" },
    );

    await handler.handleGetVerificationStatus(req);

    expect(capturedFetchUrl).toBeDefined();
    expect(capturedFetchUrl).toContain(
      "/v1/channel-verification-sessions/status",
    );
    expect(capturedFetchUrl).toContain("channel=telegram");
    expect(capturedFetchUrl).toContain("id=123");
  });

  it("strips hop-by-hop headers from forwarded request", async () => {
    const config = makeConfig();
    const handler = createChannelVerificationSessionProxyHandler(config);

    const req = new Request("http://gateway/v1/channel-verification-sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        connection: "keep-alive",
        "keep-alive": "timeout=5",
      },
      body: JSON.stringify({ channel: "test" }),
    });

    await handler.handleCreateVerificationSession(req);

    expect(capturedFetchHeaders).toBeDefined();
    expect(capturedFetchHeaders!.has("connection")).toBe(false);
    expect(capturedFetchHeaders!.has("keep-alive")).toBe(false);
    expect(capturedFetchHeaders!.get("content-type")).toBe("application/json");
  });

  it("removes incoming host and authorization headers", async () => {
    const config = makeConfig();
    const handler = createChannelVerificationSessionProxyHandler(config);

    const req = new Request("http://gateway/v1/channel-verification-sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "gateway.example.com",
        authorization: "Bearer old-edge-token",
      },
      body: JSON.stringify({ channel: "test" }),
    });

    await handler.handleCreateVerificationSession(req);

    expect(capturedFetchHeaders).toBeDefined();
    expect(capturedFetchHeaders!.has("host")).toBe(false);
    // authorization should be the service token, not the edge token
    expect(capturedFetchHeaders!.get("authorization")).toBe(
      "Bearer test-service-token",
    );
  });
});

describe("channel-verification-session-proxy guardian init", () => {
  beforeEach(() => {
    capturedFetchHeaders = undefined;
    capturedFetchUrl = undefined;
    fetchResponse = new Response(JSON.stringify({ ok: true }), { status: 200 });
    // Clear bootstrap secret env
    delete process.env.GUARDIAN_BOOTSTRAP_SECRET;
  });

  it("rejects handleResetBootstrap from non-loopback IP", async () => {
    const config = makeConfig();
    const handler = createChannelVerificationSessionProxyHandler(config);

    const response = await handler.handleResetBootstrap("192.168.1.100");

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe("Loopback-only endpoint");
  });

  it("allows handleResetBootstrap from loopback IP", async () => {
    const config = makeConfig();
    const handler = createChannelVerificationSessionProxyHandler(config);

    const response = await handler.handleResetBootstrap("127.0.0.1");

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
  });

  it("allows handleResetBootstrap from IPv6 loopback", async () => {
    const config = makeConfig();
    const handler = createChannelVerificationSessionProxyHandler(config);

    const response = await handler.handleResetBootstrap("::1");

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
  });

  it("rejects handleResetBootstrap in containerized mode", async () => {
    process.env.GUARDIAN_BOOTSTRAP_SECRET = "secret-abc";
    const config = makeConfig();
    const handler = createChannelVerificationSessionProxyHandler(config);

    const response = await handler.handleResetBootstrap("127.0.0.1");

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe("Reset not available in containerized mode");
  });
});
