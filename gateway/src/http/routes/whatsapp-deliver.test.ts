import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { GatewayConfig } from "../../config.js";
import { initSigningKey, mintToken } from "../../auth/token-service.js";
import { CURRENT_POLICY_EPOCH } from "../../auth/policy.js";

const TEST_SIGNING_KEY = Buffer.from("test-signing-key-at-least-32-bytes-long");
initSigningKey(TEST_SIGNING_KEY);

// ---- Mocks ----

let sendWhatsAppReplyCalls: Array<unknown[]> = [];

mock.module("../../whatsapp/send.js", () => ({
  sendWhatsAppReply: async (...args: unknown[]) => {
    sendWhatsAppReplyCalls.push(args);
  },
  sendWhatsAppAttachments: mock(() =>
    Promise.resolve({ allFailed: false, failureCount: 0, totalCount: 0 }),
  ),
}));

const { createWhatsAppDeliverHandler } = await import("./whatsapp-deliver.js");

// ---- Helpers ----

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

function makeRequest(body: unknown, headers?: Record<string, string>): Request {
  return new Request("http://localhost:7830/deliver/whatsapp", {
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
  return new Request("http://localhost:7830/deliver/whatsapp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

// ---- Tests ----

describe("/deliver/whatsapp", () => {
  beforeEach(() => {
    sendWhatsAppReplyCalls = [];
  });

  it("rejects GET requests with 405", async () => {
    const handler = createWhatsAppDeliverHandler(makeConfig());
    const req = new Request("http://localhost:7830/deliver/whatsapp", {
      method: "GET",
    });
    const res = await handler(req);
    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body.error).toBe("Method not allowed");
  });

  it("rejects request without Authorization header with 401", async () => {
    const handler = createWhatsAppDeliverHandler(makeConfig());
    const req = makeUnauthRequest({ to: "+15559876543", text: "hello" });
    const res = await handler(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("rejects request with wrong bearer token with 401", async () => {
    const handler = createWhatsAppDeliverHandler(makeConfig());
    const req = makeUnauthRequest(
      { to: "+15559876543", text: "hello" },
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
    const handler = createWhatsAppDeliverHandler(makeConfig());
    const req = makeRequest({ to: "+15559876543", text: "hello" });
    const res = await handler(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  // WhatsApp credential availability is now gated by the route precondition
  // (isWhatsAppConfigured) rather than checked inside the handler. The 503
  // tests for missing credentials were removed because the handler no longer
  // performs those checks -- the router prevents the handler from running at
  // all when credentials are absent.

  it("returns 400 when 'to' is missing", async () => {
    const handler = createWhatsAppDeliverHandler(makeConfig());
    const req = makeRequest({ text: "hello" });
    const res = await handler(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("to is required");
  });

  it("returns 400 when 'text' is missing and no attachments", async () => {
    const handler = createWhatsAppDeliverHandler(makeConfig());
    const req = makeRequest({ to: "+15559876543" });
    const res = await handler(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("text or attachments required");
  });

  it("returns 400 when JSON is invalid", async () => {
    const handler = createWhatsAppDeliverHandler(makeConfig());
    const req = new Request("http://localhost:7830/deliver/whatsapp", {
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

  it("accepts chatId as alias for to", async () => {
    const handler = createWhatsAppDeliverHandler(makeConfig());
    const req = makeRequest({
      chatId: "+15559876543",
      text: "hello via chatId",
    });
    const res = await handler(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    expect(sendWhatsAppReplyCalls).toHaveLength(1);
    expect(sendWhatsAppReplyCalls[0][1]).toBe("+15559876543");
    expect(sendWhatsAppReplyCalls[0][2]).toBe("hello via chatId");
  });

  it("prefers 'to' over 'chatId' when both are provided", async () => {
    const handler = createWhatsAppDeliverHandler(makeConfig());
    const req = makeRequest({
      to: "+15551111111",
      chatId: "+15552222222",
      text: "both fields",
    });
    const res = await handler(req);
    expect(res.status).toBe(200);

    expect(sendWhatsAppReplyCalls).toHaveLength(1);
    expect(sendWhatsAppReplyCalls[0][1]).toBe("+15551111111");
  });

  it("delivers attachments when text is missing but attachments are present", async () => {
    const handler = createWhatsAppDeliverHandler(makeConfig());
    const req = makeRequest({
      to: "+15559876543",
      attachments: [{ id: "att-1", url: "https://example.com/image.png" }],
    });
    const res = await handler(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // Text reply should NOT have been called — only attachments
    expect(sendWhatsAppReplyCalls).toHaveLength(0);
  });

  it("delivers both text and attachments when both are present", async () => {
    const handler = createWhatsAppDeliverHandler(makeConfig());
    const req = makeRequest({
      to: "+15559876543",
      text: "Here is a file",
      attachments: [{ id: "att-1", url: "https://example.com/image.png" }],
    });
    const res = await handler(req);
    expect(res.status).toBe(200);

    // Text reply should have been sent
    expect(sendWhatsAppReplyCalls).toHaveLength(1);
    expect(sendWhatsAppReplyCalls[0][2]).toBe("Here is a file");
  });

  it("returns 502 when sendWhatsAppReply throws", async () => {
    // Override the mock to throw
    const _throwingMock = mock.module("../../whatsapp/send.js", () => ({
      sendWhatsAppReply: async () => {
        throw new Error("WhatsApp API failure");
      },
      sendWhatsAppAttachments: mock(() =>
        Promise.resolve({ allFailed: false, failureCount: 0, totalCount: 0 }),
      ),
    }));

    // Re-import to get the handler with the throwing mock
    const { createWhatsAppDeliverHandler: createHandler } =
      await import("./whatsapp-deliver.js");
    const handler = createHandler(makeConfig());
    const req = makeRequest({ to: "+15559876543", text: "hello" });
    const res = await handler(req);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("Delivery failed");

    // Restore non-throwing mock
    mock.module("../../whatsapp/send.js", () => ({
      sendWhatsAppReply: async (...args: unknown[]) => {
        sendWhatsAppReplyCalls.push(args);
      },
      sendWhatsAppAttachments: mock(() =>
        Promise.resolve({ allFailed: false, failureCount: 0, totalCount: 0 }),
      ),
    }));
  });

  it("sends text to the correct recipient", async () => {
    const handler = createWhatsAppDeliverHandler(makeConfig());
    const req = makeRequest({ to: "+15559876543", text: "Test message" });
    const res = await handler(req);
    expect(res.status).toBe(200);

    expect(sendWhatsAppReplyCalls).toHaveLength(1);
    const [_config, to, text] = sendWhatsAppReplyCalls[0] as [
      GatewayConfig,
      string,
      string,
    ];
    expect(to).toBe("+15559876543");
    expect(text).toBe("Test message");
  });
});
