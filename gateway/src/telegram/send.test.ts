import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import type { ApprovalPayload } from "../http/routes/telegram-deliver.js";
import type { GatewayConfig } from "../config.js";

// Mock fetch at the transport level (same pattern as all other test files)
// instead of mocking ./api.js — mock.module for api.js leaks across test
// files in the same Bun process, poisoning callTelegramApi for other tests.
type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
let fetchMock: ReturnType<typeof mock<FetchFn>> = mock(async () => new Response());

mock.module("../fetch.js", () => ({
  fetchImpl: (...args: Parameters<FetchFn>) => fetchMock(...args),
}));

const { buildInlineKeyboard, sendTelegramReply } = await import("./send.js");

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
  runtimeGatewayOriginSecret: undefined,
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
  telegramMaxRetries: 0,
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

function makeTelegramResponse(result: unknown) {
  return new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

let fetchCalls: { url: string; body: unknown }[];

beforeEach(() => {
  fetchCalls = [];
  fetchMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    let body: unknown;
    try {
      if (init?.body) body = JSON.parse(String(init.body));
    } catch { /* FormData or non-JSON body */ }
    fetchCalls.push({ url, body });
    return makeTelegramResponse({});
  });
});

afterEach(() => {
  fetchMock = mock(async () => new Response());
});

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
  it("sends a plain message without reply_markup when no approval", async () => {
    await sendTelegramReply(baseConfig, "chat-1", "Hello");

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toContain("/sendMessage");
    const body = fetchCalls[0].body as Record<string, unknown>;
    expect(body.chat_id).toBe("chat-1");
    expect(body.text).toBe("Hello");
    expect(body.reply_markup).toBeUndefined();
  });

  it("attaches inline keyboard when approval is provided", async () => {
    await sendTelegramReply(baseConfig, "chat-1", "Approve?", sampleApproval);

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toContain("/sendMessage");
    const body = fetchCalls[0].body as Record<string, unknown>;
    expect(body.reply_markup).toBeDefined();

    const markup = body.reply_markup as {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
    };
    expect(markup.inline_keyboard).toHaveLength(3);
    expect(markup.inline_keyboard[0][0].callback_data).toBe("apr:run-123:approve_once");
  });

  it("attaches inline keyboard only to the last chunk for long messages", async () => {
    // Create a message that exceeds TELEGRAM_MAX_MESSAGE_LEN (4000 chars)
    const longText = "A".repeat(4001);
    await sendTelegramReply(baseConfig, "chat-1", longText, sampleApproval);

    expect(fetchCalls).toHaveLength(2);

    const firstBody = fetchCalls[0].body as Record<string, unknown>;
    expect(firstBody.reply_markup).toBeUndefined();

    const lastBody = fetchCalls[1].body as Record<string, unknown>;
    expect(lastBody.reply_markup).toBeDefined();
  });
});
