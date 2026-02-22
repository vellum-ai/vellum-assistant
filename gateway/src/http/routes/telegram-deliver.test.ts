import { describe, it, expect, mock } from "bun:test";
import type { GatewayConfig } from "../../config.js";
import { createTelegramDeliverHandler } from "./telegram-deliver.js";

// ---- Mocks ----

mock.module("../../telegram/send.js", () => ({
  sendTelegramReply: async () => {},
  sendTelegramAttachments: async () => {},
}));

// ---- Helpers ----

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
    runtimeProxyBearerToken: undefined,
    runtimeProxyEnabled: false,
    runtimeProxyRequireAuth: true,
    runtimeTimeoutMs: 30000,
    shutdownDrainMs: 5000,
    telegramApiBaseUrl: "https://api.telegram.org",
    telegramBotToken: "test-bot-token",
    telegramDeliverAuthBypass: true,
    telegramInitialBackoffMs: 1000,
    telegramMaxRetries: 3,
    telegramTimeoutMs: 15000,
    telegramWebhookSecret: "test-secret",
    twilioAuthToken: undefined,
    ingressPublicBaseUrl: undefined,
    unmappedPolicy: "reject",
    ...overrides,
  };
}

function makeRequest(body: unknown): Request {
  return new Request("http://localhost:7830/deliver/telegram", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---- Tests ----

describe("telegram-deliver attachment validation", () => {
  const config = makeConfig();
  const handler = createTelegramDeliverHandler(config);

  it("returns 400 when attachments contains a null element", async () => {
    const req = makeRequest({
      chatId: "123",
      attachments: [null],
    });
    const res = await handler(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("each attachment must be an object");
  });

  it("returns 400 when attachments contains a number", async () => {
    const req = makeRequest({
      chatId: "123",
      attachments: [42],
    });
    const res = await handler(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("each attachment must be an object");
  });

  it("returns 400 when attachments contains a string", async () => {
    const req = makeRequest({
      chatId: "123",
      attachments: ["not-an-object"],
    });
    const res = await handler(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("each attachment must be an object");
  });

  it("returns 400 when attachments contains a nested array", async () => {
    const req = makeRequest({
      chatId: "123",
      attachments: [["nested"]],
    });
    const res = await handler(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("each attachment must be an object");
  });

  it("returns 400 when attachments contains a boolean", async () => {
    const req = makeRequest({
      chatId: "123",
      attachments: [true],
    });
    const res = await handler(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("each attachment must be an object");
  });

  it("returns 400 when an attachment object is missing an id", async () => {
    const req = makeRequest({
      chatId: "123",
      attachments: [{ filename: "test.txt" }],
    });
    const res = await handler(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("each attachment must have an id");
  });

  it("returns 400 when attachment id is not a string", async () => {
    const req = makeRequest({
      chatId: "123",
      attachments: [{ id: 123 }],
    });
    const res = await handler(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("each attachment must have an id");
  });

  it("returns 400 for a mix of valid and invalid elements", async () => {
    const req = makeRequest({
      chatId: "123",
      attachments: [{ id: "att-1" }, null, { id: "att-2" }],
    });
    const res = await handler(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("each attachment must be an object");
  });

  it("accepts valid attachments with string ids", async () => {
    const req = makeRequest({
      chatId: "123",
      attachments: [{ id: "att-1" }, { id: "att-2", filename: "test.txt" }],
    });
    const res = await handler(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });
});
