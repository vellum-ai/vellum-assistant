import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { GatewayConfig } from "../../config.js";

// --- Mocks ----------------------------------------------------------------

const callTelegramApiMock = mock(
  (_config: GatewayConfig, _method: string, _body: Record<string, unknown>) =>
    Promise.resolve({}),
);
const sendTelegramReplyMock = mock(() => Promise.resolve());
const handleInboundMock = mock(() =>
  Promise.resolve({ forwarded: true, rejected: false }),
);
const resetConversationMock = mock(() => Promise.resolve());

mock.module("../../telegram/api.js", () => ({
  callTelegramApi: callTelegramApiMock,
  callTelegramApiMultipart: mock(() => Promise.resolve({})),
}));

mock.module("../../telegram/send.js", () => ({
  sendTelegramReply: sendTelegramReplyMock,
}));

mock.module("../../handlers/handle-inbound.js", () => ({
  handleInbound: handleInboundMock,
}));

mock.module("../../runtime/client.js", () => ({
  resetConversation: resetConversationMock,
  uploadAttachment: mock(() => Promise.resolve({ id: "att-1" })),
  AttachmentValidationError: class extends Error {},
}));

mock.module("../../telegram/verify.js", () => ({
  verifyWebhookSecret: () => true,
}));

mock.module("../../telegram/download.js", () => ({
  downloadTelegramFile: mock(() =>
    Promise.resolve({ buffer: Buffer.alloc(0), fileName: "f.txt", mimeType: "text/plain" }),
  ),
}));

// Import after mocks are registered
const { createTelegramWebhookHandler } = await import("./telegram-webhook.js");

// --- Helpers ---------------------------------------------------------------

const baseConfig: GatewayConfig = {
  assistantRuntimeBaseUrl: "http://localhost:7821",
  defaultAssistantId: "ast-default",
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
  telegramBotToken: "test-token",
  telegramDeliverAuthBypass: true,
  telegramInitialBackoffMs: 1000,
  telegramMaxRetries: 3,
  telegramTimeoutMs: 15000,
  telegramWebhookSecret: "test-secret",
  twilioAuthToken: undefined,
  twilioAccountSid: undefined,
  twilioPhoneNumber: undefined,
  smsDeliverAuthBypass: false,
  ingressPublicBaseUrl: undefined,
  unmappedPolicy: "default",
};

function makeCallbackQueryBody(data: string, updateId = 200) {
  return JSON.stringify({
    update_id: updateId,
    callback_query: {
      id: "cbq-42",
      from: { id: 42, first_name: "Alice" },
      message: {
        message_id: 10,
        chat: { id: 42, type: "private" },
      },
      data,
    },
  });
}

function postRequest(body: string): Request {
  return new Request("http://localhost:7830/webhook/telegram", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": "test-secret",
    },
    body,
  });
}

// --- Tests -----------------------------------------------------------------

describe("telegram-webhook callback query acknowledgment", () => {
  beforeEach(() => {
    callTelegramApiMock.mockClear();
    sendTelegramReplyMock.mockClear();
    handleInboundMock.mockClear();
    resetConversationMock.mockClear();
    // Default: forwarding succeeds
    handleInboundMock.mockImplementation(() =>
      Promise.resolve({ forwarded: true, rejected: false }),
    );
  });

  it("acknowledges callback query after successful forwarding", async () => {
    const handler = createTelegramWebhookHandler(baseConfig);
    const body = makeCallbackQueryBody("apr:run1:approve", 300);
    const res = await handler(postRequest(body));

    expect(res.status).toBe(200);
    const answerCalls = callTelegramApiMock.mock.calls.filter(
      (c) => c[1] === "answerCallbackQuery",
    );
    expect(answerCalls.length).toBe(1);
    expect(answerCalls[0][2]).toEqual({
      callback_query_id: "cbq-42",
    });
  });

  it("acknowledges callback query when routing rejects the message", async () => {
    handleInboundMock.mockImplementation(() =>
      Promise.resolve({ forwarded: false, rejected: true, rejectionReason: "No route" }),
    );

    const handler = createTelegramWebhookHandler(baseConfig);
    const body = makeCallbackQueryBody("apr:run1:approve", 301);
    const res = await handler(postRequest(body));

    expect(res.status).toBe(200);
    const answerCalls = callTelegramApiMock.mock.calls.filter(
      (c) => c[1] === "answerCallbackQuery",
    );
    expect(answerCalls.length).toBe(1);
    expect(answerCalls[0][2]).toEqual({
      callback_query_id: "cbq-42",
    });
  });

  it("acknowledges callback query when /new command is triggered via callback", async () => {
    const handler = createTelegramWebhookHandler(baseConfig);
    const body = makeCallbackQueryBody("/new", 302);
    const res = await handler(postRequest(body));

    expect(res.status).toBe(200);
    const answerCalls = callTelegramApiMock.mock.calls.filter(
      (c) => c[1] === "answerCallbackQuery",
    );
    expect(answerCalls.length).toBe(1);
    expect(answerCalls[0][2]).toEqual({
      callback_query_id: "cbq-42",
    });
  });

  it("does not call answerCallbackQuery for regular text messages", async () => {
    const handler = createTelegramWebhookHandler(baseConfig);
    const body = JSON.stringify({
      update_id: 303,
      message: {
        message_id: 11,
        text: "hello",
        chat: { id: 42, type: "private" },
        from: { id: 42, first_name: "Alice" },
      },
    });
    const res = await handler(postRequest(body));

    expect(res.status).toBe(200);
    const answerCalls = callTelegramApiMock.mock.calls.filter(
      (c) => c[1] === "answerCallbackQuery",
    );
    expect(answerCalls.length).toBe(0);
  });
});
