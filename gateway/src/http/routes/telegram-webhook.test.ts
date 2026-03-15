import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { GatewayConfig } from "../../config.js";
import type { CredentialCache } from "../../credential-cache.js";
import { credentialKey } from "../../credential-key.js";

// --- Mocks ----------------------------------------------------------------

const callTelegramApiMock = mock(
  (_method: string, _body: Record<string, unknown>, _opts?: unknown) =>
    Promise.resolve({}),
);
const sendTelegramReplyMock = mock(() => Promise.resolve());
const handleInboundMock = mock(
  (_config: GatewayConfig, _normalized: unknown, _options?: unknown) =>
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
  CircuitBreakerOpenError: class extends Error {},
}));

mock.module("../../telegram/verify.js", () => ({
  verifyWebhookSecret: () => true,
}));

mock.module("../../telegram/download.js", () => ({
  downloadTelegramFile: mock(() =>
    Promise.resolve({
      buffer: Buffer.alloc(0),
      fileName: "f.txt",
      mimeType: "text/plain",
    }),
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
  runtimeInitialBackoffMs: 500,
  runtimeMaxRetries: 2,
  runtimeProxyEnabled: false,
  runtimeProxyRequireAuth: true,
  runtimeTimeoutMs: 30000,
  shutdownDrainMs: 5000,
  unmappedPolicy: "default",
  trustProxy: false,
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

/** Create mock caches for the telegram webhook handler. */
function makeCaches() {
  const credentials = {
    get: async (key: string) => {
      if (key === credentialKey("telegram", "webhook_secret"))
        return "test-secret";
      return undefined;
    },
    invalidate: () => {},
  } as unknown as CredentialCache;
  return { credentials };
}

// --- Tests -----------------------------------------------------------------

describe("telegram-webhook callback query acknowledgment", () => {
  beforeEach(() => {
    callTelegramApiMock.mockClear();
    callTelegramApiMock.mockImplementation(
      (_method: string, _body: Record<string, unknown>, _opts?: unknown) =>
        Promise.resolve({}),
    );
    sendTelegramReplyMock.mockClear();
    handleInboundMock.mockClear();
    resetConversationMock.mockClear();
    // Default: forwarding succeeds
    handleInboundMock.mockImplementation(() =>
      Promise.resolve({ forwarded: true, rejected: false }),
    );
  });

  it("acknowledges callback query after successful forwarding", async () => {
    const { handler } = createTelegramWebhookHandler(baseConfig, makeCaches());
    const body = makeCallbackQueryBody("apr:run1:approve", 300);
    const res = await handler(postRequest(body));

    expect(res.status).toBe(200);
    const answerCalls = callTelegramApiMock.mock.calls.filter(
      (c) => c[0] === "answerCallbackQuery",
    );
    expect(answerCalls.length).toBe(1);
    expect(answerCalls[0][1]).toEqual({
      callback_query_id: "cbq-42",
    });
  });

  it("acknowledges callback query when routing rejects the message", async () => {
    handleInboundMock.mockImplementation(() =>
      Promise.resolve({
        forwarded: false,
        rejected: true,
        rejectionReason: "No route",
      }),
    );

    const { handler } = createTelegramWebhookHandler(baseConfig, makeCaches());
    const body = makeCallbackQueryBody("apr:run1:approve", 301);
    const res = await handler(postRequest(body));

    expect(res.status).toBe(200);
    const answerCalls = callTelegramApiMock.mock.calls.filter(
      (c) => c[0] === "answerCallbackQuery",
    );
    expect(answerCalls.length).toBe(1);
    expect(answerCalls[0][1]).toEqual({
      callback_query_id: "cbq-42",
    });
  });

  it("acknowledges callback query when forwarding fails with forwarded=false", async () => {
    handleInboundMock.mockImplementation(() =>
      Promise.resolve({ forwarded: false, rejected: false }),
    );

    const { handler } = createTelegramWebhookHandler(baseConfig, makeCaches());
    const body = makeCallbackQueryBody("apr:run1:approve", 304);
    const res = await handler(postRequest(body));

    expect(res.status).toBe(500);
    const answerCalls = callTelegramApiMock.mock.calls.filter(
      (c) => c[0] === "answerCallbackQuery",
    );
    expect(answerCalls.length).toBe(1);
    expect(answerCalls[0][1]).toEqual({
      callback_query_id: "cbq-42",
    });
  });

  it("acknowledges callback query when forwarding throws", async () => {
    handleInboundMock.mockImplementation(() =>
      Promise.reject(new Error("boom")),
    );

    const { handler } = createTelegramWebhookHandler(baseConfig, makeCaches());
    const body = makeCallbackQueryBody("apr:run1:approve", 305);
    const res = await handler(postRequest(body));

    expect(res.status).toBe(500);
    const answerCalls = callTelegramApiMock.mock.calls.filter(
      (c) => c[0] === "answerCallbackQuery",
    );
    expect(answerCalls.length).toBe(1);
    expect(answerCalls[0][1]).toEqual({
      callback_query_id: "cbq-42",
    });
  });

  it("acknowledges callback query when /new command is triggered via callback", async () => {
    const { handler } = createTelegramWebhookHandler(baseConfig, makeCaches());
    const body = makeCallbackQueryBody("/new", 302);
    const res = await handler(postRequest(body));

    expect(res.status).toBe(200);
    const answerCalls = callTelegramApiMock.mock.calls.filter(
      (c) => c[0] === "answerCallbackQuery",
    );
    expect(answerCalls.length).toBe(1);
    expect(answerCalls[0][1]).toEqual({
      callback_query_id: "cbq-42",
    });
  });

  it("acknowledges callback query when /start command is triggered via callback", async () => {
    const { handler } = createTelegramWebhookHandler(baseConfig, makeCaches());
    const body = makeCallbackQueryBody("/start", 313);
    const res = await handler(postRequest(body));

    expect(res.status).toBe(200);
    const answerCalls = callTelegramApiMock.mock.calls.filter(
      (c) => c[0] === "answerCallbackQuery",
    );
    expect(answerCalls.length).toBe(1);
    expect(answerCalls[0][1]).toEqual({
      callback_query_id: "cbq-42",
    });
    expect(sendTelegramReplyMock).not.toHaveBeenCalled();
  });

  it("forwards /start with payload as channel command-intent metadata without sending ACK", async () => {
    const { handler } = createTelegramWebhookHandler(baseConfig, makeCaches());
    const body = JSON.stringify({
      update_id: 314,
      message: {
        message_id: 12,
        text: "/start ref-123",
        chat: { id: 42, type: "private" },
        from: { id: 42, first_name: "Alice", language_code: "en" },
      },
    });
    const res = await handler(postRequest(body));

    expect(res.status).toBe(200);
    expect(handleInboundMock).toHaveBeenCalledTimes(1);
    const options = handleInboundMock.mock.calls[0][2] as {
      sourceMetadata?: {
        commandIntent?: { type: string; payload?: string };
      };
    };
    expect(options.sourceMetadata?.commandIntent).toEqual({
      type: "start",
      payload: "ref-123",
    });
    // ACK is suppressed when /start has a payload
    expect(sendTelegramReplyMock).not.toHaveBeenCalled();
  });

  it("does not call answerCallbackQuery for regular text messages", async () => {
    const { handler } = createTelegramWebhookHandler(baseConfig, makeCaches());
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
      (c) => c[0] === "answerCallbackQuery",
    );
    expect(answerCalls.length).toBe(0);
  });

  it("clears inline approval buttons after a standard approval decision", async () => {
    handleInboundMock.mockImplementation(() =>
      Promise.resolve({
        forwarded: true,
        rejected: false,
        runtimeResponse: {
          accepted: true,
          duplicate: false,
          eventId: "evt-1",
          approval: "decision_applied",
        },
      }),
    );

    const { handler } = createTelegramWebhookHandler(baseConfig, makeCaches());
    const body = makeCallbackQueryBody("apr:run1:approve", 306);
    const res = await handler(postRequest(body));

    expect(res.status).toBe(200);
    const clearCalls = callTelegramApiMock.mock.calls.filter(
      (c) => c[0] === "editMessageReplyMarkup",
    );
    expect(clearCalls.length).toBe(1);
    expect(clearCalls[0][1]).toEqual({
      chat_id: "42",
      message_id: 10,
      reply_markup: null,
    });
  });

  it("clears inline approval buttons for stale callback queries", async () => {
    handleInboundMock.mockImplementation(() =>
      Promise.resolve({
        forwarded: true,
        rejected: false,
        runtimeResponse: {
          accepted: true,
          duplicate: false,
          eventId: "evt-2",
          approval: "stale_ignored",
        },
      }),
    );

    const { handler } = createTelegramWebhookHandler(baseConfig, makeCaches());
    const body = makeCallbackQueryBody("apr:stale:approve", 307);
    const res = await handler(postRequest(body));

    expect(res.status).toBe(200);
    const clearCalls = callTelegramApiMock.mock.calls.filter(
      (c) => c[0] === "editMessageReplyMarkup",
    );
    expect(clearCalls.length).toBe(1);
  });

  it("does not clear inline approval buttons for non-decision callback handling", async () => {
    handleInboundMock.mockImplementation(() =>
      Promise.resolve({
        forwarded: true,
        rejected: false,
        runtimeResponse: {
          accepted: true,
          duplicate: false,
          eventId: "evt-3",
          approval: "assistant_turn",
        },
      }),
    );

    const { handler } = createTelegramWebhookHandler(baseConfig, makeCaches());
    const body = makeCallbackQueryBody("apr:run1:approve", 308);
    const res = await handler(postRequest(body));

    expect(res.status).toBe(200);
    const clearCalls = callTelegramApiMock.mock.calls.filter(
      (c) => c[0] === "editMessageReplyMarkup",
    );
    expect(clearCalls.length).toBe(0);
  });

  it("clears inline approval buttons when approval field is omitted for approval callback data", async () => {
    handleInboundMock.mockImplementation(() =>
      Promise.resolve({
        forwarded: true,
        rejected: false,
        runtimeResponse: {
          accepted: true,
          duplicate: false,
          eventId: "evt-omitted",
        },
      }),
    );

    const { handler } = createTelegramWebhookHandler(baseConfig, makeCaches());
    const body = makeCallbackQueryBody("apr:run1:approve_once", 310);
    const res = await handler(postRequest(body));

    expect(res.status).toBe(200);
    const clearCalls = callTelegramApiMock.mock.calls.filter(
      (c) => c[0] === "editMessageReplyMarkup",
    );
    expect(clearCalls.length).toBe(1);
    expect(clearCalls[0][1]).toEqual({
      chat_id: "42",
      message_id: 10,
      reply_markup: null,
    });
  });

  it("falls back to empty inline keyboard payload when null reply_markup fails", async () => {
    handleInboundMock.mockImplementation(() =>
      Promise.resolve({
        forwarded: true,
        rejected: false,
        runtimeResponse: {
          accepted: true,
          duplicate: false,
          eventId: "evt-fallback",
          approval: "decision_applied",
        },
      }),
    );

    let editAttempts = 0;
    callTelegramApiMock.mockImplementation((method: string) => {
      if (method === "editMessageReplyMarkup") {
        editAttempts++;
        if (editAttempts === 1) {
          return Promise.reject(
            new Error(
              "Telegram editMessageReplyMarkup failed: can't parse reply markup JSON object",
            ),
          );
        }
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });

    const { handler } = createTelegramWebhookHandler(baseConfig, makeCaches());
    const body = makeCallbackQueryBody("apr:run1:approve_once", 311);
    const res = await handler(postRequest(body));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(res.status).toBe(200);
    const clearCalls = callTelegramApiMock.mock.calls.filter(
      (c) => c[0] === "editMessageReplyMarkup",
    );
    expect(clearCalls.length).toBe(2);
    expect(clearCalls[0][1]).toEqual({
      chat_id: "42",
      message_id: 10,
      reply_markup: null,
    });
    expect(clearCalls[1][1]).toEqual({
      chat_id: "42",
      message_id: 10,
      reply_markup: { inline_keyboard: [] },
    });
    const deleteCalls = callTelegramApiMock.mock.calls.filter(
      (c) => c[0] === "deleteMessage",
    );
    expect(deleteCalls.length).toBe(0);
  });

  it("does not fail webhook when clearing inline approval buttons fails", async () => {
    handleInboundMock.mockImplementation(() =>
      Promise.resolve({
        forwarded: true,
        rejected: false,
        runtimeResponse: {
          accepted: true,
          duplicate: false,
          eventId: "evt-4",
          approval: "guardian_decision_applied",
        },
      }),
    );
    callTelegramApiMock.mockImplementation((method: string) => {
      if (method === "editMessageReplyMarkup") {
        return Promise.reject(new Error("edit failed"));
      }
      return Promise.resolve({});
    });

    const { handler } = createTelegramWebhookHandler(baseConfig, makeCaches());
    const body = makeCallbackQueryBody("gapr:run1:approve", 309);
    const res = await handler(postRequest(body));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(res.status).toBe(200);
    const clearCalls = callTelegramApiMock.mock.calls.filter(
      (c) => c[0] === "editMessageReplyMarkup",
    );
    expect(clearCalls.length).toBe(2);
    const deleteCalls = callTelegramApiMock.mock.calls.filter(
      (c) => c[0] === "deleteMessage",
    );
    expect(deleteCalls.length).toBe(1);
    expect(deleteCalls[0][1]).toEqual({
      chat_id: "42",
      message_id: 10,
    });
  });

  it("does not fail webhook if delete fallback also fails", async () => {
    handleInboundMock.mockImplementation(() =>
      Promise.resolve({
        forwarded: true,
        rejected: false,
        runtimeResponse: {
          accepted: true,
          duplicate: false,
          eventId: "evt-5",
          approval: "decision_applied",
        },
      }),
    );
    callTelegramApiMock.mockImplementation((method: string) => {
      if (method === "editMessageReplyMarkup" || method === "deleteMessage") {
        return Promise.reject(new Error("hard failure"));
      }
      return Promise.resolve({});
    });

    const { handler } = createTelegramWebhookHandler(baseConfig, makeCaches());
    const body = makeCallbackQueryBody("apr:run1:approve_once", 312);
    const res = await handler(postRequest(body));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(res.status).toBe(200);
    const clearCalls = callTelegramApiMock.mock.calls.filter(
      (c) => c[0] === "editMessageReplyMarkup",
    );
    expect(clearCalls.length).toBe(2);
    const deleteCalls = callTelegramApiMock.mock.calls.filter(
      (c) => c[0] === "deleteMessage",
    );
    expect(deleteCalls.length).toBe(1);
  });
});
