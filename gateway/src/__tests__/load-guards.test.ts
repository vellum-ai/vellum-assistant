import { describe, test, expect } from "bun:test";
import { createTelegramWebhookHandler } from "../http/routes/telegram-webhook.js";
import type { GatewayConfig } from "../config.js";

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
    runtimeProxyRequireAuth: true,
    runtimeProxyBearerToken: undefined,
    shutdownDrainMs: 5000,
    runtimeTimeoutMs: 30000,
    runtimeMaxRetries: 2,
    runtimeInitialBackoffMs: 500,
    telegramDeliverAuthBypass: false,
    telegramInitialBackoffMs: 1000,
    telegramMaxRetries: 3,
    telegramTimeoutMs: 15000,
    maxWebhookPayloadBytes: 256, // very small for testing
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
}

describe("payload size guard", () => {
  test("returns 413 when content-length exceeds limit", async () => {
    const handler = createTelegramWebhookHandler(makeConfig());
    const body = JSON.stringify({ data: "x".repeat(300) });
    const req = new Request("http://localhost:7830/webhooks/telegram", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "content-length": String(body.length),
        "x-telegram-bot-api-secret-token": "wh-sec",
      },
    });
    const res = await handler(req);
    expect(res.status).toBe(413);
    const json = await res.json();
    expect(json.error).toBe("Payload too large");
  });

  test("returns 413 when body exceeds limit even without content-length", async () => {
    const handler = createTelegramWebhookHandler(makeConfig());
    const body = JSON.stringify({ data: "x".repeat(300) });
    const req = new Request("http://localhost:7830/webhooks/telegram", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "wh-sec",
      },
    });
    const res = await handler(req);
    expect(res.status).toBe(413);
  });

  test("accepts payload within limit", async () => {
    const handler = createTelegramWebhookHandler(
      makeConfig({ maxWebhookPayloadBytes: 10000 }),
    );
    const body = JSON.stringify({ update_id: 1, message: { text: "hi", chat: { id: 1, type: "private" }, from: { id: 1 }, message_id: 1 } });
    const req = new Request("http://localhost:7830/webhooks/telegram", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "content-length": String(body.length),
        "x-telegram-bot-api-secret-token": "wh-sec",
      },
    });
    const res = await handler(req);
    // Will fail downstream (routing reject) but should NOT be 413
    expect(res.status).not.toBe(413);
  });
});
