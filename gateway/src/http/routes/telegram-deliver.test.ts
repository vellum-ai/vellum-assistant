import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { GatewayConfig } from "../../config.js";
import { createTelegramDeliverHandler } from "./telegram-deliver.js";

// ---- Mocks ----

// Track calls to sendTelegramReply so we can assert on approval passthrough.
let sendTelegramReplyCalls: Array<unknown[]> = [];

mock.module("../../telegram/send.js", () => ({
  sendTelegramReply: async (...args: unknown[]) => {
    sendTelegramReplyCalls.push(args);
  },
  sendTelegramAttachments: async () => {},
}));

// ---- Helpers ----

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  const merged: GatewayConfig = {
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
    telegramBotToken: "test-bot-token",
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
    unmappedPolicy: "reject",
    whatsappPhoneNumberId: undefined,
    whatsappAccessToken: undefined,
    whatsappAppSecret: undefined,
    whatsappWebhookVerifyToken: undefined,
    whatsappDeliverAuthBypass: false,
    whatsappTimeoutMs: 15000,
    whatsappMaxRetries: 3,
    whatsappInitialBackoffMs: 1000,
    ...overrides,
  };
  if (merged.runtimeGatewayOriginSecret === undefined) {
    merged.runtimeGatewayOriginSecret = merged.runtimeBearerToken;
  }
  return merged;
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

describe("telegram-deliver approval validation", () => {
  const config = makeConfig();
  const handler = createTelegramDeliverHandler(config);

  beforeEach(() => {
    sendTelegramReplyCalls = [];
  });

  it("accepts a valid payload without approval (existing behavior unchanged)", async () => {
    const res = await handler(makeRequest({ chatId: "123", text: "hello" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("accepts a valid payload with approval", async () => {
    const res = await handler(
      makeRequest({
        chatId: "123",
        text: "Please approve",
        approval: {
          runId: "run-1",
          requestId: "req-1",
          actions: [
            { id: "approve_once", label: "Approve once" },
            { id: "reject", label: "Reject" },
          ],
          plainTextFallback: "Reply: approve or reject",
        },
      }),
    );
    expect(res.status).toBe(200);
  });

  it("returns 400 when approval is not an object", async () => {
    const res = await handler(
      makeRequest({ chatId: "123", text: "hi", approval: "bad" }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("approval must be an object");
  });

  it("returns 400 when approval is null", async () => {
    const res = await handler(
      makeRequest({ chatId: "123", text: "hi", approval: null }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("approval must be an object");
  });

  it("returns 400 when approval is an array", async () => {
    const res = await handler(
      makeRequest({ chatId: "123", text: "hi", approval: [] }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("approval must be an object");
  });

  it("returns 400 when approval.runId is missing", async () => {
    const res = await handler(
      makeRequest({
        chatId: "123",
        text: "hi",
        approval: {
          requestId: "req-1",
          actions: [{ id: "ok", label: "OK" }],
          plainTextFallback: "ok",
        },
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("approval.runId is required");
  });

  it("returns 400 when approval.requestId is missing", async () => {
    const res = await handler(
      makeRequest({
        chatId: "123",
        text: "hi",
        approval: {
          runId: "run-1",
          actions: [{ id: "ok", label: "OK" }],
          plainTextFallback: "ok",
        },
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("approval.requestId is required");
  });

  it("returns 400 when approval.actions is empty", async () => {
    const res = await handler(
      makeRequest({
        chatId: "123",
        text: "hi",
        approval: {
          runId: "run-1",
          requestId: "req-1",
          actions: [],
          plainTextFallback: "ok",
        },
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("approval.actions must be a non-empty array");
  });

  it("returns 400 when approval.actions is not an array", async () => {
    const res = await handler(
      makeRequest({
        chatId: "123",
        text: "hi",
        approval: {
          runId: "run-1",
          requestId: "req-1",
          actions: "not-array",
          plainTextFallback: "ok",
        },
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("approval.actions must be a non-empty array");
  });

  it("returns 400 when an action is missing id", async () => {
    const res = await handler(
      makeRequest({
        chatId: "123",
        text: "hi",
        approval: {
          runId: "run-1",
          requestId: "req-1",
          actions: [{ label: "OK" }],
          plainTextFallback: "ok",
        },
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("each approval action must have an id");
  });

  it("returns 400 when an action is missing label", async () => {
    const res = await handler(
      makeRequest({
        chatId: "123",
        text: "hi",
        approval: {
          runId: "run-1",
          requestId: "req-1",
          actions: [{ id: "ok" }],
          plainTextFallback: "ok",
        },
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("each approval action must have a label");
  });

  it("returns 400 when an action is not an object", async () => {
    const res = await handler(
      makeRequest({
        chatId: "123",
        text: "hi",
        approval: {
          runId: "run-1",
          requestId: "req-1",
          actions: [null],
          plainTextFallback: "ok",
        },
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("each approval action must be an object");
  });

  it("passes approval payload through to sendTelegramReply", async () => {
    const approval = {
      runId: "run-x",
      requestId: "req-y",
      actions: [{ id: "go", label: "Go" }],
      plainTextFallback: "go",
    };
    await handler(makeRequest({ chatId: "c1", text: "msg", approval }));

    expect(sendTelegramReplyCalls).toHaveLength(1);
    // sendTelegramReply(config, chatId, text, approval)
    const args = sendTelegramReplyCalls[0];
    expect(args[3]).toEqual(approval);
  });

  it("does not pass approval to sendTelegramReply when not provided", async () => {
    await handler(makeRequest({ chatId: "c1", text: "msg" }));

    expect(sendTelegramReplyCalls).toHaveLength(1);
    const args = sendTelegramReplyCalls[0];
    expect(args[3]).toBeUndefined();
  });

  it("returns 400 when approval is present but text is missing", async () => {
    const res = await handler(
      makeRequest({
        chatId: "123",
        attachments: [{ id: "att-1" }],
        approval: {
          runId: "run-1",
          requestId: "req-1",
          actions: [{ id: "ok", label: "OK" }],
          plainTextFallback: "ok",
        },
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("text is required when approval is present");
  });

  it("returns 400 when callback_data would exceed 64 bytes", async () => {
    // "apr:" (4 bytes) + runId + ":" (1 byte) + actionId must stay <= 64
    // A 60-char runId + short action id will exceed the limit.
    const longRunId = "r".repeat(60);
    const res = await handler(
      makeRequest({
        chatId: "123",
        text: "Approve?",
        approval: {
          runId: longRunId,
          requestId: "req-1",
          actions: [{ id: "ok", label: "OK" }],
          plainTextFallback: "ok",
        },
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("64-byte limit");
  });

  it("accepts callback_data exactly at 64 bytes", async () => {
    // "apr:" = 4 bytes, ":" separator = 1 byte, so runId + actionId = 59 bytes
    const runId = "r".repeat(50);
    const actionId = "a".repeat(9);
    const res = await handler(
      makeRequest({
        chatId: "123",
        text: "Approve?",
        approval: {
          runId,
          requestId: "req-1",
          actions: [{ id: actionId, label: "OK" }],
          plainTextFallback: "ok",
        },
      }),
    );
    // Verify the callback_data is exactly 64 bytes
    expect(Buffer.byteLength(`apr:${runId}:${actionId}`)).toBe(64);
    expect(res.status).toBe(200);
  });
});
