import { describe, test, expect } from "bun:test";
import { createTelegramWebhookHandler } from "../http/routes/telegram-webhook.js";
import type { GatewayConfig } from "../config.js";
import type { CredentialCache } from "../credential-cache.js";
import { credentialKey } from "../credential-key.js";

function makeCaches() {
  const credentials = {
    get: async (key: string) => {
      if (key === credentialKey("telegram", "webhook_secret")) return "wh-sec";
      return undefined;
    },
    invalidate: () => {},
  } as unknown as CredentialCache;
  return { credentials };
}

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  const merged: GatewayConfig = {
    assistantRuntimeBaseUrl: "http://localhost:7821",
    routingEntries: [],
    defaultAssistantId: undefined,
    unmappedPolicy: "reject",
    port: 7830,
    runtimeProxyEnabled: false,
    runtimeProxyRequireAuth: true,
    shutdownDrainMs: 5000,
    runtimeTimeoutMs: 30000,
    runtimeMaxRetries: 2,
    runtimeInitialBackoffMs: 500,
    maxWebhookPayloadBytes: 256, // very small for testing
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

describe("payload size guard", () => {
  test("returns 413 when content-length exceeds limit", async () => {
    const { handler } = createTelegramWebhookHandler(
      makeConfig(),
      makeCaches(),
    );
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
    const { handler } = createTelegramWebhookHandler(
      makeConfig(),
      makeCaches(),
    );
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
    const { handler } = createTelegramWebhookHandler(
      makeConfig({ maxWebhookPayloadBytes: 10000 }),
      makeCaches(),
    );
    const body = JSON.stringify({
      update_id: 1,
      message: {
        text: "hi",
        chat: { id: 1, type: "private" },
        from: { id: 1 },
        message_id: 1,
      },
    });
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
