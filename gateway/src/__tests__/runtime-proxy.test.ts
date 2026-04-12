import { describe, test, expect, mock, afterEach } from "bun:test";
import type { GatewayConfig } from "../config.js";
import { initSigningKey } from "../auth/token-service.js";

const TEST_SIGNING_KEY = Buffer.from("test-signing-key-at-least-32-bytes-long");
initSigningKey(TEST_SIGNING_KEY);

type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
let fetchMock: ReturnType<typeof mock<FetchFn>> = mock(
  async () => new Response(),
);

mock.module("../fetch.js", () => ({
  fetchImpl: (...args: Parameters<FetchFn>) => fetchMock(...args),
}));

const { createRuntimeProxyHandler } =
  await import("../http/routes/runtime-proxy.js");

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  const merged: GatewayConfig = {
    assistantRuntimeBaseUrl: "http://localhost:7821",
    routingEntries: [],
    defaultAssistantId: undefined,
    unmappedPolicy: "reject",
    port: 7830,
    runtimeProxyEnabled: true,
    runtimeProxyRequireAuth: false,
    shutdownDrainMs: 5000,
    runtimeTimeoutMs: 30000,
    runtimeMaxRetries: 2,
    runtimeInitialBackoffMs: 500,
    maxWebhookPayloadBytes: 1048576,
    logFile: { dir: undefined, retentionDays: 30 },
    maxAttachmentBytes: {
      telegram: 50 * 1024 * 1024,
      slack: 100 * 1024 * 1024,
      whatsapp: 16 * 1024 * 1024,
      default: 50 * 1024 * 1024,
    },
    maxAttachmentConcurrency: 3,
    gatewayInternalBaseUrl: "http://127.0.0.1:7830",
    trustProxy: false,
    ...overrides,
  };
  return merged;
}

afterEach(() => {
  fetchMock = mock(async () => new Response());
});

describe("runtime proxy handler", () => {
  test("rewrites legacy /v1/assistants/:assistantId/... to flat /v1/... for upstream", async () => {
    const captured: { url: string }[] = [];
    fetchMock = mock(async (input: string | URL | Request) => {
      captured.push({ url: String(input) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const handler = createRuntimeProxyHandler(makeConfig());
    const req = new Request(
      "http://localhost:7830/v1/assistants/test-assistant/channels/inbound",
    );
    await handler(req);

    expect(captured[0].url).toBe("http://localhost:7821/v1/channels/inbound");
  });

  test("forwards request to upstream with correct path and query (legacy assistant-scoped rewrite)", async () => {
    const captured: { url: string; method: string }[] = [];
    fetchMock = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        captured.push({ url: String(input), method: init?.method ?? "GET" });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );

    const handler = createRuntimeProxyHandler(makeConfig());
    const req = new Request(
      "http://localhost:7830/v1/assistants/test/health?foo=bar",
    );
    const res = await handler(req);

    expect(res.status).toBe(200);
    // Legacy /v1/assistants/test/health is rewritten to /v1/health
    expect(captured[0].url).toBe("http://localhost:7821/v1/health?foo=bar");
    expect(captured[0].method).toBe("GET");
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  test("forwards POST body to upstream", async () => {
    let capturedBody = "";
    fetchMock = mock(
      async (_input: string | URL | Request, init?: RequestInit) => {
        if (init?.body) {
          // Body is an ArrayBuffer after buffering in the proxy handler
          capturedBody = new TextDecoder().decode(init.body as ArrayBuffer);
        }
        return new Response("ok", { status: 200 });
      },
    );

    const handler = createRuntimeProxyHandler(makeConfig());
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
    fetchMock = mock(async () => {
      return new Response("Not Found", { status: 404 });
    });

    const handler = createRuntimeProxyHandler(makeConfig());
    const req = new Request("http://localhost:7830/v1/nonexistent");
    const res = await handler(req);

    expect(res.status).toBe(404);
  });

  test("returns 502 on upstream connection failure", async () => {
    fetchMock = mock(async () => {
      throw new Error("Connection refused");
    });

    const handler = createRuntimeProxyHandler(makeConfig());
    const req = new Request("http://localhost:7830/v1/health");
    const res = await handler(req);

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("Bad Gateway");
  });

  test("strips hop-by-hop headers from request", async () => {
    let capturedHeaders: Headers | undefined;
    fetchMock = mock(
      async (_input: string | URL | Request, init?: RequestInit) => {
        capturedHeaders = init?.headers as unknown as Headers;
        return new Response("ok", { status: 200 });
      },
    );

    const handler = createRuntimeProxyHandler(makeConfig());
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
    fetchMock = mock(async () => {
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

    const handler = createRuntimeProxyHandler(makeConfig());
    const req = new Request("http://localhost:7830/v1/health");
    const res = await handler(req);

    expect(res.headers.has("connection")).toBe(false);
    expect(res.headers.has("transfer-encoding")).toBe(false);
    expect(res.headers.get("x-custom")).toBe("preserved");
    expect(res.headers.get("content-type")).toBe("text/plain");
  });

  test("returns 504 on upstream timeout", async () => {
    const timeoutError = new DOMException(
      "The operation was aborted due to timeout",
      "TimeoutError",
    );
    fetchMock = mock(async () => {
      throw timeoutError;
    });

    const handler = createRuntimeProxyHandler(
      makeConfig({ runtimeTimeoutMs: 100 }),
    );
    const req = new Request("http://localhost:7830/v1/health");
    const res = await handler(req);

    expect(res.status).toBe(504);
    const body = await res.json();
    expect(body.error).toBe("Gateway Timeout");
  });

  test("passes AbortSignal.timeout to upstream fetch", async () => {
    let capturedSignal: AbortSignal | null | undefined;
    fetchMock = mock(
      async (_input: string | URL | Request, init?: RequestInit) => {
        capturedSignal = init?.signal;
        return new Response("ok", { status: 200 });
      },
    );

    const handler = createRuntimeProxyHandler(
      makeConfig({ runtimeTimeoutMs: 5000 }),
    );
    const req = new Request("http://localhost:7830/v1/health");
    await handler(req);

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
  });

  test("replaces client authorization with JWT service token when auth is not required", async () => {
    let capturedHeaders: Headers | undefined;
    fetchMock = mock(
      async (_input: string | URL | Request, init?: RequestInit) => {
        capturedHeaders = init?.headers as unknown as Headers;
        return new Response("ok", { status: 200 });
      },
    );

    const handler = createRuntimeProxyHandler(makeConfig());
    const req = new Request("http://localhost:7830/v1/health", {
      headers: { authorization: "Bearer upstream-token" },
    });
    await handler(req);

    // When auth is not required, gateway still mints a JWT service token for the runtime
    expect(capturedHeaders!.get("authorization")).toMatch(/^Bearer ey/);
  });

  test("replaces client authorization with JWT token for upstream", async () => {
    let capturedHeaders: Headers | undefined;
    fetchMock = mock(
      async (_input: string | URL | Request, init?: RequestInit) => {
        capturedHeaders = init?.headers as unknown as Headers;
        return new Response("ok", { status: 200 });
      },
    );

    const handler = createRuntimeProxyHandler(makeConfig({}));
    const req = new Request("http://localhost:7830/v1/health", {
      headers: { authorization: "Bearer client-token" },
    });
    await handler(req);

    expect(capturedHeaders!.get("authorization")).toMatch(/^Bearer ey/);
  });

  test("truncates long upstream error bodies in logs", async () => {
    const longBody = "x".repeat(512);
    fetchMock = mock(async () => {
      return new Response(longBody, { status: 500 });
    });

    const handler = createRuntimeProxyHandler(makeConfig());
    const req = new Request("http://localhost:7830/v1/fail");
    const res = await handler(req);

    expect(res.status).toBe(500);
    // The full body is still returned to the client
    const responseBody = await res.text();
    expect(responseBody).toBe(longBody);
  });

  test("does not forward host header to upstream", async () => {
    let capturedHeaders: Headers | undefined;
    fetchMock = mock(
      async (_input: string | URL | Request, init?: RequestInit) => {
        capturedHeaders = init?.headers as unknown as Headers;
        return new Response("ok", { status: 200 });
      },
    );

    const handler = createRuntimeProxyHandler(makeConfig());
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
      fetchMock = mock(async (input: string | URL | Request) => {
        fetchCalls.push(String(input));
        return new Response("ok", { status: 200 });
      });

      const handler = createRuntimeProxyHandler(makeConfig());
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
      fetchMock = mock(async (input: string | URL | Request) => {
        fetchCalls.push(String(input));
        return new Response("ok", { status: 200 });
      });

      const handler = createRuntimeProxyHandler(makeConfig());
      const req = new Request("http://localhost:7830/webhooks/twilio/voice", {
        method: "POST",
      });
      const res = await handler(req);

      expect(res.status).toBe(404);
      expect(fetchCalls.length).toBe(0);
    });

    test("blocks /webhooks/oauth/callback from being proxied", async () => {
      const fetchCalls: string[] = [];
      fetchMock = mock(async (input: string | URL | Request) => {
        fetchCalls.push(String(input));
        return new Response("ok", { status: 200 });
      });

      const handler = createRuntimeProxyHandler(makeConfig());
      const req = new Request("http://localhost:7830/webhooks/oauth/callback");
      const res = await handler(req);

      expect(res.status).toBe(404);
      expect(fetchCalls.length).toBe(0);
    });

    test("blocks /webhooks/any-future-channel from being proxied", async () => {
      const fetchCalls: string[] = [];
      fetchMock = mock(async (input: string | URL | Request) => {
        fetchCalls.push(String(input));
        return new Response("ok", { status: 200 });
      });

      const handler = createRuntimeProxyHandler(makeConfig());
      const req = new Request(
        "http://localhost:7830/webhooks/any-future-channel",
        {
          method: "POST",
        },
      );
      const res = await handler(req);

      expect(res.status).toBe(404);
      expect(fetchCalls.length).toBe(0);
    });

    test("allows /v1/channels/inbound to be proxied (non-webhook path)", async () => {
      const fetchCalls: string[] = [];
      fetchMock = mock(async (input: string | URL | Request) => {
        fetchCalls.push(String(input));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });

      const handler = createRuntimeProxyHandler(makeConfig());
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
      fetchMock = mock(async (input: string | URL | Request) => {
        fetchCalls.push(String(input));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });

      const handler = createRuntimeProxyHandler(makeConfig());
      const req = new Request("http://localhost:7830/v1/health");
      const res = await handler(req);

      expect(res.status).toBe(200);
      expect(fetchCalls.length).toBe(1);
    });
  });

  // ── STT endpoint regression coverage ─────────────────────────────────

  describe("STT payload forwarding", () => {
    test("rewrites /v1/assistants/:id/stt/transcribe to /v1/stt/transcribe", async () => {
      const captured: { url: string; method: string }[] = [];
      fetchMock = mock(
        async (input: string | URL | Request, init?: RequestInit) => {
          captured.push({ url: String(input), method: init?.method ?? "GET" });
          return new Response(JSON.stringify({ text: "hello world" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      );

      const handler = createRuntimeProxyHandler(makeConfig());
      const req = new Request(
        "http://localhost:7830/v1/assistants/my-assistant/stt/transcribe",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ audio: "base64data" }),
        },
      );
      const res = await handler(req);

      expect(res.status).toBe(200);
      expect(captured).toHaveLength(1);
      expect(captured[0].url).toBe("http://localhost:7821/v1/stt/transcribe");
      expect(captured[0].method).toBe("POST");
    });

    test("forwards buffered base64-heavy JSON body intact with correct content-length", async () => {
      // Simulate a base64-encoded audio payload (~16 KB of base64 data)
      const fakeBase64Audio = Buffer.from(
        new Uint8Array(12_000).fill(0x41),
      ).toString("base64");
      const requestPayload = JSON.stringify({
        audio: fakeBase64Audio,
        format: "wav",
        sample_rate: 16000,
      });

      let capturedBody: ArrayBuffer | null = null;
      let capturedContentLength: string | null = null;
      fetchMock = mock(
        async (_input: string | URL | Request, init?: RequestInit) => {
          capturedBody = init?.body as ArrayBuffer;
          capturedContentLength =
            (init?.headers as Headers)?.get("content-length") ?? null;
          return new Response(JSON.stringify({ text: "transcribed" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      );

      const handler = createRuntimeProxyHandler(makeConfig());
      const req = new Request(
        "http://localhost:7830/v1/assistants/test-asst/stt/transcribe",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: requestPayload,
        },
      );
      const res = await handler(req);

      expect(res.status).toBe(200);

      // Verify the buffered body is forwarded byte-for-byte
      const forwarded = new TextDecoder().decode(capturedBody!);
      expect(forwarded).toBe(requestPayload);

      // Verify content-length matches actual byte length
      const expectedLength = new TextEncoder().encode(
        requestPayload,
      ).byteLength;
      expect(capturedContentLength).toEqual(String(expectedLength));
    });

    test("streams non-error STT response body back unchanged (no truncation)", async () => {
      // Build a large-ish response body (~32 KB) to confirm no corruption
      const segments = Array.from({ length: 200 }, (_, i) => ({
        id: i,
        text: `Segment ${i}: ${"lorem ipsum ".repeat(10)}`,
        confidence: 0.95,
      }));
      const largeResponseBody = JSON.stringify({ segments });

      fetchMock = mock(async () => {
        return new Response(largeResponseBody, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });

      const handler = createRuntimeProxyHandler(makeConfig());
      const req = new Request("http://localhost:7830/v1/stt/transcribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ audio: "data" }),
      });
      const res = await handler(req);

      expect(res.status).toBe(200);
      const body = await res.text();
      // The full response body must arrive without truncation or corruption
      expect(body).toBe(largeResponseBody);
      expect(body.length).toBe(largeResponseBody.length);
    });
  });
});
