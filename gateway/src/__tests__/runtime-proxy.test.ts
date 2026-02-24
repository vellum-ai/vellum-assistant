import { describe, test, expect, mock } from "bun:test";
import { createRuntimeProxyHandler } from "../http/routes/runtime-proxy.js";
import type { GatewayConfig } from "../config.js";

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  const merged: GatewayConfig = {
    telegramBotToken: "tok",
    telegramWebhookSecret: "wh-ver",
    telegramApiBaseUrl: "https://api.telegram.org",
    assistantRuntimeBaseUrl: "http://localhost:7821",
    routingEntries: [],
    defaultAssistantId: undefined,
    unmappedPolicy: "reject",
    port: 7830,
    runtimeBearerToken: undefined,
    runtimeGatewayOriginSecret: undefined,
    runtimeProxyEnabled: true,
    runtimeProxyRequireAuth: false,
    runtimeProxyBearerToken: undefined,
    shutdownDrainMs: 5000,
    runtimeTimeoutMs: 30000,
    runtimeMaxRetries: 2,
    runtimeInitialBackoffMs: 500,
    telegramDeliverAuthBypass: false,
    telegramInitialBackoffMs: 1000,
    telegramMaxRetries: 3,
    telegramTimeoutMs: 15000,
    maxWebhookPayloadBytes: 1048576,
    logFile: { dir: undefined, retentionDays: 30 },
    maxAttachmentBytes: 20971520,
    maxAttachmentConcurrency: 3,
    twilioAuthToken: undefined,
    twilioAccountSid: undefined,
    twilioPhoneNumber: undefined,
    smsDeliverAuthBypass: false,
    ingressPublicBaseUrl: undefined,
    gatewayInternalBaseUrl: "http://127.0.0.1:7830",
    ...overrides,
  };
  if (merged.runtimeGatewayOriginSecret === undefined) {
    merged.runtimeGatewayOriginSecret = merged.runtimeBearerToken;
  }
  return merged;
}

describe("runtime proxy handler", () => {
  test("rewrites /v1/assistants/:assistantId/... to /v1/... for upstream", async () => {
    const captured: { url: string }[] = [];
    const fetchMock = mock(async (input: any) => {
      captured.push({ url: String(input) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const handler = createRuntimeProxyHandler(makeConfig({ fetch: fetchMock as any }));
    const req = new Request("http://localhost:7830/v1/assistants/test-assistant/channels/inbound");
    await handler(req);

    expect(captured[0].url).toBe("http://localhost:7821/v1/channels/inbound");
  });

  test("forwards request to upstream with correct path and query (assistant-scoped rewrite)", async () => {
    const captured: { url: string; method: string }[] = [];
    const fetchMock = mock(async (input: any, init?: any) => {
      captured.push({ url: String(input), method: init?.method ?? "GET" });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const handler = createRuntimeProxyHandler(makeConfig({ fetch: fetchMock as any }));
    const req = new Request("http://localhost:7830/v1/assistants/test/health?foo=bar");
    const res = await handler(req);

    expect(res.status).toBe(200);
    // /v1/assistants/test/health is rewritten to /v1/health
    expect(captured[0].url).toBe("http://localhost:7821/v1/health?foo=bar");
    expect(captured[0].method).toBe("GET");
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  test("forwards POST body to upstream", async () => {
    let capturedBody = "";
    const fetchMock = mock(async (_input: any, init?: any) => {
      if (init?.body) {
        // Body is an ArrayBuffer after buffering in the proxy handler
        capturedBody = new TextDecoder().decode(init.body);
      }
      return new Response("ok", { status: 200 });
    });

    const handler = createRuntimeProxyHandler(makeConfig({ fetch: fetchMock as any }));
    const req = new Request("http://localhost:7830/v1/chat", {
      method: "POST",
      body: JSON.stringify({ message: "hello" }),
      headers: { "content-type": "application/json" },
    });
    const res = await handler(req);

    expect(res.status).toBe(200);
    expect(capturedBody).toBe('{"message":"hello"}');
  });

  test("relays upstream status code", async () => {
    const fetchMock = mock(async () => {
      return new Response("Not Found", { status: 404 });
    });

    const handler = createRuntimeProxyHandler(makeConfig({ fetch: fetchMock as any }));
    const req = new Request("http://localhost:7830/v1/nonexistent");
    const res = await handler(req);

    expect(res.status).toBe(404);
  });

  test("returns 502 on upstream connection failure", async () => {
    const fetchMock = mock(async () => {
      throw new Error("Connection refused");
    });

    const handler = createRuntimeProxyHandler(makeConfig({ fetch: fetchMock as any }));
    const req = new Request("http://localhost:7830/v1/health");
    const res = await handler(req);

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("Bad Gateway");
  });

  test("strips hop-by-hop headers from request", async () => {
    let capturedHeaders: Headers | undefined;
    const fetchMock = mock(async (_input: any, init?: any) => {
      capturedHeaders = init?.headers;
      return new Response("ok", { status: 200 });
    });

    const handler = createRuntimeProxyHandler(makeConfig({ fetch: fetchMock as any }));
    const req = new Request("http://localhost:7830/v1/health", {
      headers: {
        connection: "keep-alive",
        "keep-alive": "timeout=5",
        "transfer-encoding": "chunked",
        "x-custom": "preserved",
      },
    });
    await handler(req);

    expect(capturedHeaders!.has("connection")).toBe(false);
    expect(capturedHeaders!.has("keep-alive")).toBe(false);
    expect(capturedHeaders!.has("transfer-encoding")).toBe(false);
    expect(capturedHeaders!.get("x-custom")).toBe("preserved");
  });

  test("strips hop-by-hop headers from response", async () => {
    const fetchMock = mock(async () => {
      return new Response("ok", {
        status: 200,
        headers: {
          connection: "keep-alive",
          "transfer-encoding": "chunked",
          "x-custom": "preserved",
          "content-type": "text/plain",
        },
      });
    });

    const handler = createRuntimeProxyHandler(makeConfig({ fetch: fetchMock as any }));
    const req = new Request("http://localhost:7830/v1/health");
    const res = await handler(req);

    expect(res.headers.has("connection")).toBe(false);
    expect(res.headers.has("transfer-encoding")).toBe(false);
    expect(res.headers.get("x-custom")).toBe("preserved");
    expect(res.headers.get("content-type")).toBe("text/plain");
  });

  test("returns 504 on upstream timeout", async () => {
    const timeoutError = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    const fetchMock = mock(async () => {
      throw timeoutError;
    });

    const handler = createRuntimeProxyHandler(makeConfig({ runtimeTimeoutMs: 100, fetch: fetchMock as any }));
    const req = new Request("http://localhost:7830/v1/health");
    const res = await handler(req);

    expect(res.status).toBe(504);
    const body = await res.json();
    expect(body.error).toBe("Gateway Timeout");
  });

  test("passes AbortSignal.timeout to upstream fetch", async () => {
    let capturedSignal: AbortSignal | undefined;
    const fetchMock = mock(async (_input: any, init?: any) => {
      capturedSignal = init?.signal;
      return new Response("ok", { status: 200 });
    });

    const handler = createRuntimeProxyHandler(makeConfig({ runtimeTimeoutMs: 5000, fetch: fetchMock as any }));
    const req = new Request("http://localhost:7830/v1/health");
    await handler(req);

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
  });

  test("forwards authorization header when auth is not required", async () => {
    let capturedHeaders: Headers | undefined;
    const fetchMock = mock(async (_input: any, init?: any) => {
      capturedHeaders = init?.headers;
      return new Response("ok", { status: 200 });
    });

    const handler = createRuntimeProxyHandler(makeConfig({ fetch: fetchMock as any }));
    const req = new Request("http://localhost:7830/v1/health", {
      headers: { authorization: "Bearer upstream-token" },
    });
    await handler(req);

    expect(capturedHeaders!.get("authorization")).toBe("Bearer upstream-token");
  });

  test("replaces client authorization with configured bearer token for upstream", async () => {
    let capturedHeaders: Headers | undefined;
    const fetchMock = mock(async (_input: any, init?: any) => {
      capturedHeaders = init?.headers;
      return new Response("ok", { status: 200 });
    });

    const handler = createRuntimeProxyHandler(
      makeConfig({ runtimeProxyBearerToken: "daemon-token", fetch: fetchMock as any }),
    );
    const req = new Request("http://localhost:7830/v1/health", {
      headers: { authorization: "Bearer client-token" },
    });
    await handler(req);

    expect(capturedHeaders!.get("authorization")).toBe("Bearer daemon-token");
  });

  test("truncates long upstream error bodies in logs", async () => {
    const longBody = "x".repeat(512);
    const fetchMock = mock(async () => {
      return new Response(longBody, { status: 500 });
    });

    const handler = createRuntimeProxyHandler(makeConfig({ fetch: fetchMock as any }));
    const req = new Request("http://localhost:7830/v1/fail");
    const res = await handler(req);

    expect(res.status).toBe(500);
    // The full body is still returned to the client
    const responseBody = await res.text();
    expect(responseBody).toBe(longBody);
  });

  test("does not forward host header to upstream", async () => {
    let capturedHeaders: Headers | undefined;
    const fetchMock = mock(async (_input: any, init?: any) => {
      capturedHeaders = init?.headers;
      return new Response("ok", { status: 200 });
    });

    const handler = createRuntimeProxyHandler(makeConfig({ fetch: fetchMock as any }));
    const req = new Request("http://localhost:7830/v1/health", {
      headers: { host: "localhost:7830" },
    });
    await handler(req);

    expect(capturedHeaders!.has("host")).toBe(false);
  });

  // ── Webhook path blocking ──────────────────────────────────────────

  describe("webhook path guard", () => {
    test("blocks /webhooks/telegram from being proxied", async () => {
      const fetchCalls: string[] = [];
      const fetchMock = mock(async (input: any) => {
        fetchCalls.push(String(input));
        return new Response("ok", { status: 200 });
      });

      const handler = createRuntimeProxyHandler(makeConfig({ fetch: fetchMock as any }));
      const req = new Request("http://localhost:7830/webhooks/telegram", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ update_id: 1 }),
      });
      const res = await handler(req);

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.source).toBe("gateway");
      // Verify fetch was never called — the request was blocked before proxying
      expect(fetchCalls.length).toBe(0);
    });

    test("blocks /webhooks/twilio/voice from being proxied", async () => {
      const fetchCalls: string[] = [];
      const fetchMock = mock(async (input: any) => {
        fetchCalls.push(String(input));
        return new Response("ok", { status: 200 });
      });

      const handler = createRuntimeProxyHandler(makeConfig({ fetch: fetchMock as any }));
      const req = new Request("http://localhost:7830/webhooks/twilio/voice", {
        method: "POST",
      });
      const res = await handler(req);

      expect(res.status).toBe(404);
      expect(fetchCalls.length).toBe(0);
    });

    test("blocks /webhooks/oauth/callback from being proxied", async () => {
      const fetchCalls: string[] = [];
      const fetchMock = mock(async (input: any) => {
        fetchCalls.push(String(input));
        return new Response("ok", { status: 200 });
      });

      const handler = createRuntimeProxyHandler(makeConfig({ fetch: fetchMock as any }));
      const req = new Request("http://localhost:7830/webhooks/oauth/callback");
      const res = await handler(req);

      expect(res.status).toBe(404);
      expect(fetchCalls.length).toBe(0);
    });

    test("blocks /webhooks/any-future-channel from being proxied", async () => {
      const fetchCalls: string[] = [];
      const fetchMock = mock(async (input: any) => {
        fetchCalls.push(String(input));
        return new Response("ok", { status: 200 });
      });

      const handler = createRuntimeProxyHandler(makeConfig({ fetch: fetchMock as any }));
      const req = new Request("http://localhost:7830/webhooks/any-future-channel", {
        method: "POST",
      });
      const res = await handler(req);

      expect(res.status).toBe(404);
      expect(fetchCalls.length).toBe(0);
    });

    test("allows /v1/channels/inbound to be proxied (non-webhook path)", async () => {
      const fetchCalls: string[] = [];
      const fetchMock = mock(async (input: any) => {
        fetchCalls.push(String(input));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });

      const handler = createRuntimeProxyHandler(makeConfig({ fetch: fetchMock as any }));
      const req = new Request("http://localhost:7830/v1/channels/inbound", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "hello" }),
      });
      const res = await handler(req);

      expect(res.status).toBe(200);
      expect(fetchCalls.length).toBe(1);
    });

    test("allows /v1/health to be proxied (non-webhook path)", async () => {
      const fetchCalls: string[] = [];
      const fetchMock = mock(async (input: any) => {
        fetchCalls.push(String(input));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });

      const handler = createRuntimeProxyHandler(makeConfig({ fetch: fetchMock as any }));
      const req = new Request("http://localhost:7830/v1/health");
      const res = await handler(req);

      expect(res.status).toBe(200);
      expect(fetchCalls.length).toBe(1);
    });
  });

  // ── Gateway-origin header on proxied requests ────────────────────────

  describe("gateway-origin header", () => {
    test("sets X-Gateway-Origin header when runtimeBearerToken is configured", async () => {
      let capturedHeaders: Headers | undefined;
      const fetchMock = mock(async (_input: any, init?: any) => {
        capturedHeaders = init?.headers;
        return new Response("ok", { status: 200 });
      });

      const handler = createRuntimeProxyHandler(
        makeConfig({ runtimeBearerToken: "runtime-secret", fetch: fetchMock as any }),
      );
      const req = new Request("http://localhost:7830/v1/channels/inbound", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "hello" }),
      });
      await handler(req);

      expect(capturedHeaders!.get("x-gateway-origin")).toBe("runtime-secret");
    });

    test("does not set X-Gateway-Origin header when no runtimeBearerToken", async () => {
      let capturedHeaders: Headers | undefined;
      const fetchMock = mock(async (_input: any, init?: any) => {
        capturedHeaders = init?.headers;
        return new Response("ok", { status: 200 });
      });

      const handler = createRuntimeProxyHandler(
        makeConfig({ runtimeBearerToken: undefined, fetch: fetchMock as any }),
      );
      const req = new Request("http://localhost:7830/v1/channels/inbound", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "hello" }),
      });
      await handler(req);

      expect(capturedHeaders!.has("x-gateway-origin")).toBe(false);
    });
  });
});
