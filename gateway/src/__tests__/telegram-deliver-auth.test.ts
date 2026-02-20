import { describe, test, expect, mock, afterEach } from "bun:test";
import { createTelegramDeliverHandler } from "../http/routes/telegram-deliver.js";
import type { GatewayConfig } from "../config.js";

const TOKEN = "test-deliver-token";

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    telegramBotToken: "tok",
    telegramWebhookSecret: "wh-sec",
    telegramApiBaseUrl: "https://api.telegram.org",
    assistantRuntimeBaseUrl: "http://localhost:7821",
    routingEntries: [],
    defaultAssistantId: undefined,
    unmappedPolicy: "reject",
    port: 7830,
    runtimeBearerToken: undefined,
    runtimeProxyEnabled: false,
    runtimeProxyRequireAuth: false,
    runtimeProxyBearerToken: TOKEN,
    shutdownDrainMs: 5000,
    runtimeTimeoutMs: 30000,
    runtimeMaxRetries: 2,
    runtimeInitialBackoffMs: 500,
    telegramInitialBackoffMs: 1000,
    telegramMaxRetries: 3,
    telegramTimeoutMs: 15000,
    maxWebhookPayloadBytes: 1048576,
    logFile: { dir: undefined, retentionDays: 30 },
    maxAttachmentBytes: 20971520,
    maxAttachmentConcurrency: 3,
    twilioAuthToken: undefined,
    ingressPublicBaseUrl: undefined,
    publicUrl: undefined,
    ...overrides,
  };
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockTelegramApi() {
  globalThis.fetch = mock(async () => {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as any;
}

describe("/deliver/telegram bearer auth enforcement", () => {
  test("rejects request without Authorization header with 401", async () => {
    const handler = createTelegramDeliverHandler(makeConfig());
    const req = new Request("http://localhost:7830/deliver/telegram", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chatId: "123", text: "hello" }),
    });
    const res = await handler(req);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  test("rejects request with wrong bearer token with 401", async () => {
    const handler = createTelegramDeliverHandler(makeConfig());
    const req = new Request("http://localhost:7830/deliver/telegram", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer wrong-token",
      },
      body: JSON.stringify({ chatId: "123", text: "hello" }),
    });
    const res = await handler(req);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  test("rejects request with empty bearer token with 401", async () => {
    const handler = createTelegramDeliverHandler(makeConfig());
    const req = new Request("http://localhost:7830/deliver/telegram", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer ",
      },
      body: JSON.stringify({ chatId: "123", text: "hello" }),
    });
    const res = await handler(req);

    expect(res.status).toBe(401);
  });

  test("accepts request with correct bearer token", async () => {
    mockTelegramApi();
    const handler = createTelegramDeliverHandler(makeConfig());
    const req = new Request("http://localhost:7830/deliver/telegram", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ chatId: "123", text: "hello" }),
    });
    const res = await handler(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test("allows unauthenticated access when no token is configured", async () => {
    mockTelegramApi();
    const handler = createTelegramDeliverHandler(
      makeConfig({ runtimeProxyBearerToken: undefined }),
    );
    const req = new Request("http://localhost:7830/deliver/telegram", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chatId: "123", text: "hello" }),
    });
    const res = await handler(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test("still rejects non-POST methods before auth check", async () => {
    const handler = createTelegramDeliverHandler(makeConfig());
    const req = new Request("http://localhost:7830/deliver/telegram", {
      method: "GET",
    });
    const res = await handler(req);

    expect(res.status).toBe(405);
  });

  test("still validates request body after successful auth", async () => {
    const handler = createTelegramDeliverHandler(makeConfig());
    const req = new Request("http://localhost:7830/deliver/telegram", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({}),
    });
    const res = await handler(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("chatId is required");
  });
});
