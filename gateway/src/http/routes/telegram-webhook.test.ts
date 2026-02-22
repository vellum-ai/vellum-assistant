import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { GatewayConfig } from "../../config.js";
import { createTelegramWebhookHandler } from "./telegram-webhook.js";

// ---- Mocks ----

// Track calls to sendTelegramReply
let sendTelegramReplyCalls: Array<{ chatId: string; text: string }> = [];

mock.module("../../telegram/send.js", () => ({
  sendTelegramReply: async (_config: unknown, chatId: string, text: string) => {
    sendTelegramReplyCalls.push({ chatId, text });
  },
  sendTelegramAttachments: async () => {},
  sendTypingIndicator: async () => true,
}));

mock.module("../../telegram/verify.js", () => ({
  verifyWebhookSecret: () => true,
}));

mock.module("../../runtime/client.js", () => ({
  resetConversation: async () => {},
  forwardToRuntime: async () => ({ eventId: "evt-1", duplicate: false }),
  uploadAttachment: async () => ({ id: "att-1" }),
  AttachmentValidationError: class extends Error {},
}));

mock.module("../../telegram/download.js", () => ({
  downloadTelegramFile: async () => ({
    data: Buffer.from("fake"),
    fileName: "test.txt",
    mimeType: "text/plain",
  }),
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
    telegramDeliverAuthBypass: false,
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

function makeTelegramPayload(text: string, updateId = 1, chatId = 12345) {
  return {
    update_id: updateId,
    message: {
      message_id: 100,
      text,
      chat: { id: chatId, type: "private" },
      from: { id: 99, is_bot: false, username: "testuser", first_name: "Test" },
    },
  };
}

function makeRequest(body: object): Request {
  const json = JSON.stringify(body);
  return new Request("http://localhost:7830/webhook/telegram", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": "test-secret",
    },
    body: json,
  });
}

// ---- Tests ----

describe("telegram-webhook /new rejection", () => {
  beforeEach(() => {
    sendTelegramReplyCalls = [];
  });

  it("sends a rejection notice when /new is routed to an unmapped chat", async () => {
    // No routing entries + unmappedPolicy "reject" means every chat is rejected
    const config = makeConfig({ unmappedPolicy: "reject", routingEntries: [] });
    const handler = createTelegramWebhookHandler(config);

    const payload = makeTelegramPayload("/new", 1000, 55555);
    const req = makeRequest(payload);
    const res = await handler(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });

    // The handler should have sent a rejection notice to the chat
    const rejectionReply = sendTelegramReplyCalls.find((c) =>
      c.text.includes("could not be routed"),
    );
    expect(rejectionReply).toBeDefined();
    expect(rejectionReply!.chatId).toBe("55555");
  });

  it("does not send a rejection notice when /new routing succeeds", async () => {
    const config = makeConfig({
      unmappedPolicy: "reject",
      routingEntries: [{ type: "chat_id", key: "55555", assistantId: "asst-1" }],
    });
    const handler = createTelegramWebhookHandler(config);

    const payload = makeTelegramPayload("/new", 1001, 55555);
    const req = makeRequest(payload);
    const res = await handler(req);

    expect(res.status).toBe(200);

    // Should get the success confirmation, not a rejection notice
    const rejectionReply = sendTelegramReplyCalls.find((c) =>
      c.text.includes("could not be routed"),
    );
    expect(rejectionReply).toBeUndefined();

    const confirmReply = sendTelegramReplyCalls.find((c) =>
      c.text.includes("Starting a new conversation"),
    );
    expect(confirmReply).toBeDefined();
  });

  it("rate-limits rejection notices for the same chat on /new", async () => {
    const config = makeConfig({ unmappedPolicy: "reject", routingEntries: [] });
    const handler = createTelegramWebhookHandler(config);

    // First /new — should produce a notice
    const req1 = makeRequest(makeTelegramPayload("/new", 2000, 77777));
    await handler(req1);

    // Second /new from the same chat — should be rate-limited (no notice)
    const req2 = makeRequest(makeTelegramPayload("/new", 2001, 77777));
    await handler(req2);

    const rejectionReplies = sendTelegramReplyCalls.filter(
      (c) => c.chatId === "77777" && c.text.includes("could not be routed"),
    );
    expect(rejectionReplies.length).toBe(1);
  });
});
