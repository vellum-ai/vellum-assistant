import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { GatewayConfig } from "../../config.js";
import { initSigningKey, mintToken } from "../../auth/token-service.js";
import { CURRENT_POLICY_EPOCH } from "../../auth/policy.js";
import { createTelegramDeliverHandler } from "./telegram-deliver.js";

const TEST_SIGNING_KEY = Buffer.from("test-signing-key-at-least-32-bytes-long");
initSigningKey(TEST_SIGNING_KEY);

// ---- Mocks ----

// Track calls to sendTelegramReply so we can assert on approval passthrough.
let sendTelegramReplyCalls: Array<unknown[]> = [];
let sendTypingIndicatorCalls: Array<unknown[]> = [];

mock.module("../../telegram/send.js", () => ({
  sendTelegramReply: async (...args: unknown[]) => {
    sendTelegramReplyCalls.push(args);
  },
  sendTelegramAttachments: async () => {},
  sendTypingIndicator: async (...args: unknown[]) => {
    sendTypingIndicatorCalls.push(args);
    return true;
  },
}));

// ---- Helpers ----

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  const merged: GatewayConfig = {
    assistantRuntimeBaseUrl: "http://localhost:7821",
    defaultAssistantId: undefined,
    gatewayInternalBaseUrl: "http://127.0.0.1:7830",
    logFile: { dir: undefined, retentionDays: 30 },
    maxAttachmentBytes: {
      telegram: 50 * 1024 * 1024,
      slack: 100 * 1024 * 1024,
      whatsapp: 16 * 1024 * 1024,
      default: 50 * 1024 * 1024,
    },
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
    unmappedPolicy: "reject",
    trustProxy: false,
    ...overrides,
  };
  return merged;
}

/** Mint a valid daemon JWT for deliver auth. */
function mintDeliverToken(): string {
  return mintToken({
    aud: "vellum-daemon",
    sub: "svc:gateway:self",
    scope_profile: "gateway_service_v1",
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds: 300,
  });
}

const TOKEN = mintDeliverToken();

function makeRequest(body: unknown, headers?: Record<string, string>): Request {
  return new Request("http://localhost:7830/deliver/telegram", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

/** Make a request without Authorization header (for testing auth rejection). */
function makeUnauthRequest(
  body: unknown,
  headers?: Record<string, string>,
): Request {
  return new Request("http://localhost:7830/deliver/telegram", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

// ---- Tests ----

describe("telegram-deliver endpoint basics", () => {
  beforeEach(() => {
    sendTelegramReplyCalls = [];
    sendTypingIndicatorCalls = [];
  });

  it("rejects GET requests with 405", async () => {
    const handler = createTelegramDeliverHandler(makeConfig());
    const req = new Request("http://localhost:7830/deliver/telegram", {
      method: "GET",
    });
    const res = await handler(req);
    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body.error).toBe("Method not allowed");
  });

  it("rejects request without Authorization header with 401", async () => {
    const handler = createTelegramDeliverHandler(makeConfig());
    const req = makeUnauthRequest({ chatId: "123", text: "hello" });
    const res = await handler(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("rejects request with wrong bearer token with 401", async () => {
    const handler = createTelegramDeliverHandler(makeConfig());
    const req = makeUnauthRequest(
      { chatId: "123", text: "hello" },
      {
        authorization: "Bearer wrong-token",
      },
    );
    const res = await handler(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("accepts request with correct bearer token", async () => {
    const handler = createTelegramDeliverHandler(makeConfig());
    const req = makeRequest({ chatId: "123", text: "hello" });
    const res = await handler(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("returns 400 when chatId is missing", async () => {
    const handler = createTelegramDeliverHandler(makeConfig());
    const req = makeRequest({ text: "hello" });
    const res = await handler(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("chatId is required");
  });

  it("returns 400 when text and attachments are both missing", async () => {
    const handler = createTelegramDeliverHandler(makeConfig());
    const req = makeRequest({ chatId: "123" });
    const res = await handler(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("text, attachments, or chatAction required");
  });

  it("returns 400 when chatAction is invalid", async () => {
    const handler = createTelegramDeliverHandler(makeConfig());
    const req = makeRequest({ chatId: "123", chatAction: "upload_photo" });
    const res = await handler(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('chatAction must be "typing"');
  });

  it("accepts typing action-only payloads", async () => {
    const handler = createTelegramDeliverHandler(makeConfig());
    const req = makeRequest({ chatId: "42", chatAction: "typing" });
    const res = await handler(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(sendTypingIndicatorCalls).toHaveLength(1);
    const [, chatId] = sendTypingIndicatorCalls[0] as [unknown, string];
    expect(chatId).toBe("42");
    expect(sendTelegramReplyCalls).toHaveLength(0);
  });

  it("returns 400 when JSON is invalid", async () => {
    const handler = createTelegramDeliverHandler(makeConfig());
    const req = new Request("http://localhost:7830/deliver/telegram", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
      body: "not-json",
    });
    const res = await handler(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid JSON");
  });

  it("returns 400 when attachments is not an array", async () => {
    const handler = createTelegramDeliverHandler(makeConfig());
    const req = makeRequest({ chatId: "123", attachments: "not-array" });
    const res = await handler(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("attachments must be an array");
  });

  it("returns 502 when sendTelegramReply throws", async () => {
    mock.module("../../telegram/send.js", () => ({
      sendTelegramReply: async () => {
        throw new Error("Telegram API failure");
      },
      sendTelegramAttachments: async () => {},
      sendTypingIndicator: async () => true,
    }));

    const { createTelegramDeliverHandler: createHandler } =
      await import("./telegram-deliver.js");
    const handler = createHandler(makeConfig());
    const req = makeRequest({ chatId: "123", text: "hello" });
    const res = await handler(req);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("Delivery failed");

    // Restore non-throwing mock
    mock.module("../../telegram/send.js", () => ({
      sendTelegramReply: async (...args: unknown[]) => {
        sendTelegramReplyCalls.push(args);
      },
      sendTelegramAttachments: async () => {},
      sendTypingIndicator: async (...args: unknown[]) => {
        sendTypingIndicatorCalls.push(args);
        return true;
      },
    }));
  });

  it("sends text to the correct chat and passes config", async () => {
    const handler = createTelegramDeliverHandler(makeConfig());
    const req = makeRequest({ chatId: "42", text: "Test message" });
    const res = await handler(req);
    expect(res.status).toBe(200);

    expect(sendTelegramReplyCalls).toHaveLength(1);
    const [, chatId, text] = sendTelegramReplyCalls[0] as [
      unknown,
      string,
      string,
    ];
    expect(chatId).toBe("42");
    expect(text).toBe("Test message");
  });
});

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

  it("returns 400 when approval.requestId is missing", async () => {
    const res = await handler(
      makeRequest({
        chatId: "123",
        text: "hi",
        approval: {
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
    // "apr:" (4 bytes) + requestId + ":" (1 byte) + actionId must stay <= 64
    // A 60-char requestId + short action id will exceed the limit.
    const longRequestId = "r".repeat(60);
    const res = await handler(
      makeRequest({
        chatId: "123",
        text: "Approve?",
        approval: {
          requestId: longRequestId,
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
    // "apr:" = 4 bytes, ":" separator = 1 byte, so requestId + actionId = 59 bytes
    const requestId = "r".repeat(50);
    const actionId = "a".repeat(9);
    const res = await handler(
      makeRequest({
        chatId: "123",
        text: "Approve?",
        approval: {
          requestId,
          actions: [{ id: actionId, label: "OK" }],
          plainTextFallback: "ok",
        },
      }),
    );
    // Verify the callback_data is exactly 64 bytes
    expect(Buffer.byteLength(`apr:${requestId}:${actionId}`)).toBe(64);
    expect(res.status).toBe(200);
  });
});
