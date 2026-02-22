import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { ApprovalPayload } from "../http/routes/telegram-deliver.js";
import { buildInlineKeyboard, sendTelegramReply } from "./send.js";
import type { GatewayConfig } from "../config.js";

// Capture calls to callTelegramApi so we can inspect payloads without
// hitting the network.
const callTelegramApiMock = mock(
  (_config: GatewayConfig, _method: string, _body: Record<string, unknown>) =>
    Promise.resolve({}),
);

// Mock the api module before importing send.ts functions. The import
// above resolved the real module, but Bun's mock.module patches the
// resolved module so subsequent internal imports from send.ts pick up the
// mock.
mock.module("./api.js", () => ({
  callTelegramApi: callTelegramApiMock,
  callTelegramApiMultipart: mock(() => Promise.resolve({})),
}));

const baseConfig: GatewayConfig = {
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
  telegramBotToken: "test-token",
  telegramDeliverAuthBypass: true,
  telegramInitialBackoffMs: 1000,
  telegramMaxRetries: 3,
  telegramTimeoutMs: 15000,
  telegramWebhookSecret: undefined,
  twilioAuthToken: undefined,
  twilioAccountSid: undefined,
  twilioPhoneNumber: undefined,
  smsDeliverAuthBypass: false,
  ingressPublicBaseUrl: undefined,
  unmappedPolicy: "reject",
};

const sampleApproval: ApprovalPayload = {
  runId: "run-123",
  requestId: "req-456",
  actions: [
    { id: "approve_once", label: "Approve once" },
    { id: "approve_always", label: "Approve always" },
    { id: "reject", label: "Reject" },
  ],
  plainTextFallback: "Reply: approve, always, or reject",
};

describe("buildInlineKeyboard", () => {
  it("maps each action to its own row with compact callback data", () => {
    const result = buildInlineKeyboard(sampleApproval);

    expect(result.inline_keyboard).toHaveLength(3);
    expect(result.inline_keyboard[0]).toEqual([
      { text: "Approve once", callback_data: "apr:run-123:approve_once" },
    ]);
    expect(result.inline_keyboard[1]).toEqual([
      { text: "Approve always", callback_data: "apr:run-123:approve_always" },
    ]);
    expect(result.inline_keyboard[2]).toEqual([
      { text: "Reject", callback_data: "apr:run-123:reject" },
    ]);
  });

  it("handles a single action", () => {
    const approval: ApprovalPayload = {
      runId: "r1",
      requestId: "rq1",
      actions: [{ id: "ok", label: "OK" }],
      plainTextFallback: "ok",
    };
    const result = buildInlineKeyboard(approval);
    expect(result.inline_keyboard).toHaveLength(1);
    expect(result.inline_keyboard[0][0].callback_data).toBe("apr:r1:ok");
  });

  it("uses compact callback data format apr:<runId>:<actionId>", () => {
    const approval: ApprovalPayload = {
      runId: "abc-def",
      requestId: "req",
      actions: [{ id: "my_action", label: "Do it" }],
      plainTextFallback: "do it",
    };
    const result = buildInlineKeyboard(approval);
    expect(result.inline_keyboard[0][0].callback_data).toBe("apr:abc-def:my_action");
  });

  it("throws when callback_data exceeds 64 bytes", () => {
    const approval: ApprovalPayload = {
      runId: "r".repeat(60),
      requestId: "req",
      actions: [{ id: "action", label: "Go" }],
      plainTextFallback: "go",
    };
    expect(() => buildInlineKeyboard(approval)).toThrow("64-byte limit");
  });

  it("accepts callback_data exactly at 64 bytes", () => {
    // "apr:" = 4 bytes, ":" = 1 byte, so runId + actionId = 59 bytes
    const runId = "r".repeat(50);
    const actionId = "a".repeat(9);
    const approval: ApprovalPayload = {
      runId,
      requestId: "req",
      actions: [{ id: actionId, label: "Go" }],
      plainTextFallback: "go",
    };
    expect(Buffer.byteLength(`apr:${runId}:${actionId}`)).toBe(64);
    const result = buildInlineKeyboard(approval);
    expect(result.inline_keyboard[0][0].callback_data).toBe(`apr:${runId}:${actionId}`);
  });
});

describe("sendTelegramReply", () => {
  beforeEach(() => {
    callTelegramApiMock.mockClear();
  });

  it("sends a plain message without reply_markup when no approval", async () => {
    await sendTelegramReply(baseConfig, "chat-1", "Hello");

    expect(callTelegramApiMock).toHaveBeenCalledTimes(1);
    const payload = callTelegramApiMock.mock.calls[0][2];
    expect(payload.chat_id).toBe("chat-1");
    expect(payload.text).toBe("Hello");
    expect(payload.reply_markup).toBeUndefined();
  });

  it("attaches inline keyboard when approval is provided", async () => {
    await sendTelegramReply(baseConfig, "chat-1", "Approve?", sampleApproval);

    expect(callTelegramApiMock).toHaveBeenCalledTimes(1);
    const payload = callTelegramApiMock.mock.calls[0][2];
    expect(payload.reply_markup).toBeDefined();

    const markup = payload.reply_markup as {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
    };
    expect(markup.inline_keyboard).toHaveLength(3);
    expect(markup.inline_keyboard[0][0].callback_data).toBe("apr:run-123:approve_once");
  });

  it("attaches inline keyboard only to the last chunk for long messages", async () => {
    // Create a message that exceeds TELEGRAM_MAX_MESSAGE_LEN (4000 chars)
    const longText = "A".repeat(4001);
    await sendTelegramReply(baseConfig, "chat-1", longText, sampleApproval);

    expect(callTelegramApiMock).toHaveBeenCalledTimes(2);

    const firstPayload = callTelegramApiMock.mock.calls[0][2];
    expect(firstPayload.reply_markup).toBeUndefined();

    const lastPayload = callTelegramApiMock.mock.calls[1][2];
    expect(lastPayload.reply_markup).toBeDefined();
  });
});
