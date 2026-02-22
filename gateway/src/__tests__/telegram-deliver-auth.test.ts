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
    telegramDeliverAuthBypass: false,
    telegramInitialBackoffMs: 1000,
    telegramMaxRetries: 3,
    telegramTimeoutMs: 15000,
    maxWebhookPayloadBytes: 1048576,
    logFile: { dir: undefined, retentionDays: 30 },
    maxAttachmentBytes: 20971520,
    maxAttachmentConcurrency: 3,
    twilioAuthToken: undefined,
    ingressPublicBaseUrl: undefined,
    gatewayInternalBaseUrl: "http://127.0.0.1:7830",
    ...overrides,
  };
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockTelegramApi() {
  globalThis.fetch = mock(async () => {
    return new Response(JSON.stringify({ ok: true, result: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as any;
}

describe("/deliver/telegram attachment delivery without assistantId", () => {
  test("delivers attachments without assistantId using assistant-less download path", async () => {
    const calls: string[] = [];
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      calls.push(urlStr);
      // Runtime attachment download (assistant-less path)
      if (urlStr.includes("/v1/attachments/att-1")) {
        return new Response(
          JSON.stringify({
            id: "att-1",
            filename: "photo.png",
            mimeType: "image/png",
            sizeBytes: 100,
            kind: "generated_image",
            data: "iVBORw0KGgo=",
          }),
        );
      }
      // Telegram API calls
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as any;

    const handler = createTelegramDeliverHandler(
      makeConfig({ runtimeProxyBearerToken: undefined, telegramDeliverAuthBypass: true }),
    );
    const req = new Request("http://localhost:7830/deliver/telegram", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chatId: "123",
        attachments: [
          { id: "att-1", filename: "photo.png", mimeType: "image/png", sizeBytes: 100, kind: "generated_image" },
        ],
      }),
    });
    const res = await handler(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // Should have downloaded via /v1/attachments/att-1 (no assistantId in URL)
    const downloadCall = calls.find((u) => u.includes("/attachments/att-1"));
    expect(downloadCall).toBeDefined();
    expect(downloadCall).not.toContain("/assistants/");

    // Should have sent the photo via Telegram
    const telegramCall = calls.find((u) => u.includes("sendPhoto"));
    expect(telegramCall).toBeDefined();
  });

  test("delivers attachments with assistantId using legacy download path", async () => {
    const calls: string[] = [];
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      calls.push(urlStr);
      // Runtime attachment download (legacy path)
      if (urlStr.includes("/attachments/att-2")) {
        return new Response(
          JSON.stringify({
            id: "att-2",
            filename: "doc.pdf",
            mimeType: "application/pdf",
            sizeBytes: 200,
            kind: "filesystem",
            data: "JVBER",
          }),
        );
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as any;

    const handler = createTelegramDeliverHandler(
      makeConfig({ runtimeProxyBearerToken: undefined, telegramDeliverAuthBypass: true }),
    );
    const req = new Request("http://localhost:7830/deliver/telegram", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chatId: "456",
        assistantId: "my-assistant",
        attachments: [
          { id: "att-2", filename: "doc.pdf", mimeType: "application/pdf", sizeBytes: 200, kind: "filesystem" },
        ],
      }),
    });
    const res = await handler(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // Should have downloaded via legacy /v1/assistants/my-assistant/attachments/att-2
    const downloadCall = calls.find((u) => u.includes("/attachments/att-2"));
    expect(downloadCall).toBeDefined();
    expect(downloadCall).toContain("/assistants/my-assistant/");
  });
});

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

  test("returns 503 when no token is configured and bypass is not set", async () => {
    const handler = createTelegramDeliverHandler(
      makeConfig({ runtimeProxyBearerToken: undefined }),
    );
    const req = new Request("http://localhost:7830/deliver/telegram", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chatId: "123", text: "hello" }),
    });
    const res = await handler(req);

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("Service not configured: bearer token required");
  });

  test("allows unauthenticated access when bypass flag is set and no token configured", async () => {
    mockTelegramApi();
    const handler = createTelegramDeliverHandler(
      makeConfig({ runtimeProxyBearerToken: undefined, telegramDeliverAuthBypass: true }),
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

  test("bypass flag is ignored when a bearer token is configured (auth still required)", async () => {
    const handler = createTelegramDeliverHandler(
      makeConfig({ telegramDeliverAuthBypass: true }),
    );
    const req = new Request("http://localhost:7830/deliver/telegram", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chatId: "123", text: "hello" }),
    });
    const res = await handler(req);

    // Token is configured, so missing Authorization header is still rejected
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
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
