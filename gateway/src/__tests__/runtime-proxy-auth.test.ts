import { describe, test, expect, mock, afterEach } from "bun:test";
import type { GatewayConfig } from "../config.js";

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
let fetchMock: ReturnType<typeof mock<FetchFn>> = mock(async () => new Response());

mock.module("../fetch.js", () => ({
  fetchImpl: (...args: Parameters<FetchFn>) => fetchMock(...args),
}));

const { createRuntimeProxyHandler } = await import("../http/routes/runtime-proxy.js");

const TOKEN = "test-secret-token";

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
    runtimeProxyRequireAuth: true,
    runtimeProxyBearerToken: TOKEN,
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
    whatsappPhoneNumberId: undefined,
    whatsappAccessToken: undefined,
    whatsappAppSecret: undefined,
    whatsappWebhookVerifyToken: undefined,
    whatsappDeliverAuthBypass: false,
    whatsappTimeoutMs: 15000,
    whatsappMaxRetries: 3,
    whatsappInitialBackoffMs: 1000,
    slackChannelBotToken: undefined,
    slackChannelAppToken: undefined,
    slackDeliverAuthBypass: false,
    trustProxy: false,
    ...overrides,
  };
  if (merged.runtimeGatewayOriginSecret === undefined) {
    merged.runtimeGatewayOriginSecret = merged.runtimeBearerToken;
  }
  return merged;
}

afterEach(() => {
  fetchMock = mock(async () => new Response());
});

function mockUpstream() {
  fetchMock = mock(async () => {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

describe("runtime proxy auth enforcement", () => {
  test("auth required: rejects missing token with 401", async () => {
    mockUpstream();
    const handler = createRuntimeProxyHandler(makeConfig());
    const req = new Request("http://localhost:7830/v1/health");
    const res = await handler(req);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  test("auth required: rejects invalid token with 401", async () => {
    mockUpstream();
    const handler = createRuntimeProxyHandler(makeConfig());
    const req = new Request("http://localhost:7830/v1/health", {
      headers: { authorization: "Bearer wrong-token" },
    });
    const res = await handler(req);

    expect(res.status).toBe(401);
  });

  test("auth required: accepts valid token and proxies", async () => {
    mockUpstream();
    const handler = createRuntimeProxyHandler(makeConfig());
    const req = new Request("http://localhost:7830/v1/health", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const res = await handler(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test("auth required: accepts actor authorization for actor-bound route", async () => {
    mockUpstream();
    const handler = createRuntimeProxyHandler(makeConfig());
    const req = new Request("http://localhost:7830/v1/messages", {
      method: "POST",
      headers: {
        authorization: "Actor actor-token-123",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        conversationKey: "conversation-key",
        sourceChannel: "vellum",
        interface: "macos",
        content: "hello",
      }),
    });
    const res = await handler(req);

    expect(res.status).toBe(200);
  });

  test("auth required: rejects actor authorization for non-vellum /v1/messages", async () => {
    mockUpstream();
    const handler = createRuntimeProxyHandler(makeConfig());
    const req = new Request("http://localhost:7830/v1/messages", {
      method: "POST",
      headers: {
        authorization: "Actor actor-token-123",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        conversationKey: "conversation-key",
        sourceChannel: "telegram",
        interface: "macos",
        content: "hello",
      }),
    });
    const res = await handler(req);

    expect(res.status).toBe(401);
  });

  test("auth required: rejects actor authorization for non-actor route", async () => {
    mockUpstream();
    const handler = createRuntimeProxyHandler(makeConfig());
    const req = new Request("http://localhost:7830/v1/health", {
      headers: { authorization: "Actor actor-token-123" },
    });
    const res = await handler(req);

    expect(res.status).toBe(401);
  });

  test("auth required: replaces client authorization with configured bearer token for upstream", async () => {
    let capturedHeaders: Headers | undefined;
    fetchMock = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = init?.headers as unknown as Headers;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const handler = createRuntimeProxyHandler(makeConfig());
    const req = new Request("http://localhost:7830/v1/health", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    await handler(req);

    expect(capturedHeaders!.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  test("auth required: maps actor authorization to upstream x-actor-token", async () => {
    let capturedHeaders: Headers | undefined;
    fetchMock = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = init?.headers as unknown as Headers;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const handler = createRuntimeProxyHandler(makeConfig());
    const req = new Request("http://localhost:7830/v1/events?conversationKey=test-key", {
      headers: { authorization: "Actor actor-token-123" },
    });
    await handler(req);

    expect(capturedHeaders!.get("x-actor-token")).toBe("actor-token-123");
    // Gateway still authenticates upstream with its configured runtime token.
    expect(capturedHeaders!.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  test("auth not required: proxies without token", async () => {
    mockUpstream();
    const handler = createRuntimeProxyHandler(
      makeConfig({ runtimeProxyRequireAuth: false, runtimeProxyBearerToken: undefined }),
    );
    const req = new Request("http://localhost:7830/v1/health");
    const res = await handler(req);

    expect(res.status).toBe(200);
  });

  test("OPTIONS request bypasses auth", async () => {
    mockUpstream();
    const handler = createRuntimeProxyHandler(makeConfig());
    const req = new Request("http://localhost:7830/v1/health", {
      method: "OPTIONS",
    });
    const res = await handler(req);

    expect(res.status).toBe(200);
  });
});
