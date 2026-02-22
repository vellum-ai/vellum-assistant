import { describe, test, expect, mock, beforeEach } from "bun:test";
import { createTelegramReconcileHandler } from "../http/routes/telegram-reconcile.js";
import type { GatewayConfig } from "../config.js";

// Mock reconcileTelegramWebhook so tests don't call the real Telegram API
const mockReconcile = mock(() => Promise.resolve());
mock.module("../telegram/webhook-manager.js", () => ({
  reconcileTelegramWebhook: mockReconcile,
}));

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    assistantRuntimeBaseUrl: "http://localhost:7821",
    defaultAssistantId: undefined,
    gatewayInternalBaseUrl: "http://127.0.0.1:7830",
    logFile: { dir: undefined, retentionDays: 30 },
    maxAttachmentBytes: 20 * 1024 * 1024,
    maxAttachmentConcurrency: 3,
    maxWebhookPayloadBytes: 1024 * 1024,
    port: 7830,
    routingEntries: [],
    runtimeBearerToken: undefined,
    runtimeInitialBackoffMs: 500,
    runtimeMaxRetries: 2,
    runtimeProxyBearerToken: "test-token",
    runtimeProxyEnabled: false,
    runtimeProxyRequireAuth: true,
    runtimeTimeoutMs: 30000,
    shutdownDrainMs: 5000,
    telegramApiBaseUrl: "https://api.telegram.org",
    telegramBotToken: "bot-token",
    telegramDeliverAuthBypass: false,
    telegramInitialBackoffMs: 1000,
    telegramMaxRetries: 3,
    telegramTimeoutMs: 15000,
    telegramWebhookSecret: "webhook-secret",
    twilioAuthToken: undefined,
    ingressPublicBaseUrl: "https://example.com",
    unmappedPolicy: "reject",
    ...overrides,
  };
}

function makeRequest(
  method: string,
  token?: string,
  body?: Record<string, unknown>,
): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (token) {
    headers["authorization"] = `Bearer ${token}`;
  }
  return new Request("http://localhost:7830/internal/telegram/reconcile", {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe("POST /internal/telegram/reconcile", () => {
  beforeEach(() => {
    mockReconcile.mockClear();
  });

  test("rejects non-POST methods", async () => {
    const config = makeConfig();
    const handler = createTelegramReconcileHandler(config);
    const res = await handler(
      new Request("http://localhost:7830/internal/telegram/reconcile", {
        method: "GET",
      }),
    );
    expect(res.status).toBe(405);
  });

  test("returns 503 when no bearer token is configured", async () => {
    const config = makeConfig({ runtimeProxyBearerToken: undefined });
    const handler = createTelegramReconcileHandler(config);
    const res = await handler(makeRequest("POST", "any-token"));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toContain("bearer token required");
  });

  test("returns 401 for missing auth header", async () => {
    const config = makeConfig();
    const handler = createTelegramReconcileHandler(config);
    const res = await handler(makeRequest("POST"));
    expect(res.status).toBe(401);
  });

  test("returns 401 for wrong token", async () => {
    const config = makeConfig();
    const handler = createTelegramReconcileHandler(config);
    const res = await handler(makeRequest("POST", "wrong-token"));
    expect(res.status).toBe(401);
  });

  test("triggers reconcile with correct auth", async () => {
    const config = makeConfig();
    const handler = createTelegramReconcileHandler(config);
    const res = await handler(makeRequest("POST", "test-token"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(mockReconcile).toHaveBeenCalledTimes(1);
    expect(mockReconcile).toHaveBeenCalledWith(config);
  });

  test("updates ingressPublicBaseUrl when provided", async () => {
    const config = makeConfig({ ingressPublicBaseUrl: "https://old.example.com" });
    const handler = createTelegramReconcileHandler(config);
    const res = await handler(
      makeRequest("POST", "test-token", {
        ingressPublicBaseUrl: "https://new.example.com/",
      }),
    );
    expect(res.status).toBe(200);
    // Trailing slash should be normalized
    expect(config.ingressPublicBaseUrl).toBe("https://new.example.com");
    expect(mockReconcile).toHaveBeenCalledTimes(1);
  });

  test("clears ingressPublicBaseUrl when empty string is provided", async () => {
    const config = makeConfig({ ingressPublicBaseUrl: "https://old.example.com" });
    const handler = createTelegramReconcileHandler(config);
    const res = await handler(
      makeRequest("POST", "test-token", {
        ingressPublicBaseUrl: "",
      }),
    );
    expect(res.status).toBe(200);
    expect(config.ingressPublicBaseUrl).toBeUndefined();
    expect(mockReconcile).toHaveBeenCalledTimes(1);
  });

  test("works with empty body (no URL update)", async () => {
    const config = makeConfig();
    const handler = createTelegramReconcileHandler(config);
    const req = new Request("http://localhost:7830/internal/telegram/reconcile", {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
      },
    });
    const res = await handler(req);
    expect(res.status).toBe(200);
    expect(config.ingressPublicBaseUrl).toBe("https://example.com");
    expect(mockReconcile).toHaveBeenCalledTimes(1);
  });

  test("returns 502 when reconcile throws", async () => {
    mockReconcile.mockImplementationOnce(() =>
      Promise.reject(new Error("Telegram API error")),
    );
    const config = makeConfig();
    const handler = createTelegramReconcileHandler(config);
    const res = await handler(makeRequest("POST", "test-token"));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("Reconciliation failed");
  });

  test("returns 400 for invalid JSON body", async () => {
    const config = makeConfig();
    const handler = createTelegramReconcileHandler(config);
    const req = new Request("http://localhost:7830/internal/telegram/reconcile", {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: "not-json{",
    });
    const res = await handler(req);
    expect(res.status).toBe(400);
  });
});
