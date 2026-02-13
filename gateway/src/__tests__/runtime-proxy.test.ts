import { describe, test, expect, mock, afterEach } from "bun:test";
import { createRuntimeProxyHandler } from "../http/routes/runtime-proxy.js";
import type { GatewayConfig } from "../config.js";

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    telegramBotToken: "tok",
    telegramWebhookSecret: "wh-ver",
    telegramApiBaseUrl: "https://api.telegram.org",
    assistantRuntimeBaseUrl: "http://localhost:7821",
    routingEntries: [],
    defaultAssistantId: undefined,
    unmappedPolicy: "reject",
    port: 7830,
    runtimeProxyEnabled: true,
    runtimeProxyRequireAuth: false,
    runtimeProxyBearerToken: undefined,
    shutdownDrainMs: 5000,
    runtimeTimeoutMs: 30000,
    runtimeMaxRetries: 2,
    runtimeInitialBackoffMs: 500,
    telegramTimeoutMs: 15000,
    ...overrides,
  };
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("runtime proxy handler", () => {
  test("forwards request to upstream with correct path and query", async () => {
    const captured: { url: string; method: string }[] = [];
    globalThis.fetch = mock(async (input: any, init?: any) => {
      captured.push({ url: String(input), method: init?.method ?? "GET" });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as any;

    const handler = createRuntimeProxyHandler(makeConfig());
    const req = new Request("http://localhost:7830/v1/assistants/test/health?foo=bar");
    const res = await handler(req);

    expect(res.status).toBe(200);
    expect(captured[0].url).toBe("http://localhost:7821/v1/assistants/test/health?foo=bar");
    expect(captured[0].method).toBe("GET");
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  test("forwards POST body to upstream", async () => {
    let capturedBody = "";
    globalThis.fetch = mock(async (_input: any, init?: any) => {
      if (init?.body) {
        const reader = init.body.getReader();
        const chunks: Uint8Array[] = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
        capturedBody = new TextDecoder().decode(
          new Uint8Array(chunks.reduce((acc, c) => acc + c.length, 0)),
        );
        // Simpler: just read as text
        capturedBody = Buffer.concat(chunks).toString();
      }
      return new Response("ok", { status: 200 });
    }) as any;

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
    globalThis.fetch = mock(async () => {
      return new Response("Not Found", { status: 404 });
    }) as any;

    const handler = createRuntimeProxyHandler(makeConfig());
    const req = new Request("http://localhost:7830/v1/nonexistent");
    const res = await handler(req);

    expect(res.status).toBe(404);
  });

  test("returns 502 on upstream connection failure", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("Connection refused");
    }) as any;

    const handler = createRuntimeProxyHandler(makeConfig());
    const req = new Request("http://localhost:7830/v1/health");
    const res = await handler(req);

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("Bad Gateway");
  });

  test("strips hop-by-hop headers from request", async () => {
    let capturedHeaders: Headers | undefined;
    globalThis.fetch = mock(async (_input: any, init?: any) => {
      capturedHeaders = init?.headers;
      return new Response("ok", { status: 200 });
    }) as any;

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
    globalThis.fetch = mock(async () => {
      return new Response("ok", {
        status: 200,
        headers: {
          connection: "keep-alive",
          "transfer-encoding": "chunked",
          "x-custom": "preserved",
          "content-type": "text/plain",
        },
      });
    }) as any;

    const handler = createRuntimeProxyHandler(makeConfig());
    const req = new Request("http://localhost:7830/v1/health");
    const res = await handler(req);

    expect(res.headers.has("connection")).toBe(false);
    expect(res.headers.has("transfer-encoding")).toBe(false);
    expect(res.headers.get("x-custom")).toBe("preserved");
    expect(res.headers.get("content-type")).toBe("text/plain");
  });

  test("does not forward host header to upstream", async () => {
    let capturedHeaders: Headers | undefined;
    globalThis.fetch = mock(async (_input: any, init?: any) => {
      capturedHeaders = init?.headers;
      return new Response("ok", { status: 200 });
    }) as any;

    const handler = createRuntimeProxyHandler(makeConfig());
    const req = new Request("http://localhost:7830/v1/health", {
      headers: { host: "localhost:7830" },
    });
    await handler(req);

    expect(capturedHeaders!.has("host")).toBe(false);
  });
});
