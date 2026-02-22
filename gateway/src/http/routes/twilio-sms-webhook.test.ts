import { describe, it, expect, mock, beforeEach } from "bun:test";
import { createHmac } from "node:crypto";
import type { GatewayConfig } from "../../config.js";

// --- Mocks ----------------------------------------------------------------

const handleInboundMock = mock(() =>
  Promise.resolve({ forwarded: true, rejected: false }),
);

mock.module("../../handlers/handle-inbound.js", () => ({
  handleInbound: handleInboundMock,
}));

// Import after mocks are registered
const { createTwilioSmsWebhookHandler } = await import("./twilio-sms-webhook.js");

// --- Helpers ---------------------------------------------------------------

const AUTH_TOKEN = "test-twilio-auth-token";

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
  telegramBotToken: undefined,
  telegramDeliverAuthBypass: false,
  telegramInitialBackoffMs: 1000,
  telegramMaxRetries: 3,
  telegramTimeoutMs: 15000,
  telegramWebhookSecret: undefined,
  twilioAuthToken: AUTH_TOKEN,
  twilioAccountSid: "AC-test",
  twilioPhoneNumber: "+15551234567",
  smsDeliverAuthBypass: false,
  ingressPublicBaseUrl: undefined,
  unmappedPolicy: "default",
};

function computeSignature(
  url: string,
  params: Record<string, string>,
  authToken: string,
): string {
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) {
    data += key + params[key];
  }
  return createHmac("sha1", authToken).update(data).digest("base64");
}

function buildSignedSmsRequest(
  url: string,
  params: Record<string, string>,
  authToken: string,
): Request {
  const body = new URLSearchParams(params).toString();
  const signature = computeSignature(url, params, authToken);
  return new Request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Twilio-Signature": signature,
    },
    body,
  });
}

// --- Tests -----------------------------------------------------------------

describe("twilio-sms-webhook", () => {
  beforeEach(() => {
    handleInboundMock.mockClear();
    handleInboundMock.mockImplementation(() =>
      Promise.resolve({ forwarded: true, rejected: false }),
    );
  });

  it("rejects GET requests with 405", async () => {
    const handler = createTwilioSmsWebhookHandler(baseConfig);
    const req = new Request("http://localhost:7830/webhooks/twilio/sms", {
      method: "GET",
    });
    const res = await handler(req);
    expect(res.status).toBe(405);
  });

  it("rejects missing signature with 403", async () => {
    const handler = createTwilioSmsWebhookHandler(baseConfig);
    const req = new Request("http://localhost:7830/webhooks/twilio/sms", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "Body=hello&From=%2B15551234567&To=%2B15559876543&MessageSid=SM123",
    });
    const res = await handler(req);
    expect(res.status).toBe(403);
  });

  it("rejects invalid signature with 403", async () => {
    const handler = createTwilioSmsWebhookHandler(baseConfig);
    const req = new Request("http://localhost:7830/webhooks/twilio/sms", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Twilio-Signature": "invalid-signature",
      },
      body: "Body=hello&From=%2B15551234567&To=%2B15559876543&MessageSid=SM123",
    });
    const res = await handler(req);
    expect(res.status).toBe(403);
  });

  it("rejects when twilioAuthToken is not configured (fail-closed)", async () => {
    const handler = createTwilioSmsWebhookHandler({
      ...baseConfig,
      twilioAuthToken: undefined,
    });
    const req = new Request("http://localhost:7830/webhooks/twilio/sms", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "Body=hello&MessageSid=SM123",
    });
    const res = await handler(req);
    expect(res.status).toBe(403);
  });

  it("returns 400 when MessageSid is missing", async () => {
    const handler = createTwilioSmsWebhookHandler(baseConfig);
    const url = "http://localhost:7830/webhooks/twilio/sms";
    const params = { Body: "hello", From: "+15551234567", To: "+15559876543" };
    const req = buildSignedSmsRequest(url, params, AUTH_TOKEN);
    const res = await handler(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Missing MessageSid");
  });

  it("forwards valid SMS to runtime and returns 200", async () => {
    const handler = createTwilioSmsWebhookHandler(baseConfig);
    const url = "http://localhost:7830/webhooks/twilio/sms";
    const params = {
      Body: "Hello from SMS",
      From: "+15551234567",
      To: "+15559876543",
      MessageSid: "SM-test-123",
    };
    const req = buildSignedSmsRequest(url, params, AUTH_TOKEN);
    const res = await handler(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // Verify handleInbound was called with correct parameters
    expect(handleInboundMock).toHaveBeenCalledTimes(1);
    const [, event, options] = handleInboundMock.mock.calls[0] as unknown[];
    const typedEvent = event as { sourceChannel: string; message: { externalChatId: string; content: string; externalMessageId: string } };
    expect(typedEvent.sourceChannel).toBe("sms");
    expect(typedEvent.message.content).toBe("Hello from SMS");
    expect(typedEvent.message.externalChatId).toBe("+15551234567");
    expect(typedEvent.message.externalMessageId).toBe("SM-test-123");
    const typedOptions = options as { replyCallbackUrl: string };
    expect(typedOptions.replyCallbackUrl).toBe("http://127.0.0.1:7830/deliver/sms");
  });

  it("deduplicates by MessageSid", async () => {
    const handler = createTwilioSmsWebhookHandler(baseConfig);
    const url = "http://localhost:7830/webhooks/twilio/sms";
    const params = {
      Body: "dedup test",
      From: "+15551234567",
      To: "+15559876543",
      MessageSid: "SM-dedup-test",
    };

    // First request should be processed
    const req1 = buildSignedSmsRequest(url, params, AUTH_TOKEN);
    const res1 = await handler(req1);
    expect(res1.status).toBe(200);
    expect(handleInboundMock).toHaveBeenCalledTimes(1);

    // Second request with same MessageSid should be deduped
    const req2 = buildSignedSmsRequest(url, params, AUTH_TOKEN);
    const res2 = await handler(req2);
    expect(res2.status).toBe(200);
    // handleInbound should NOT have been called again
    expect(handleInboundMock).toHaveBeenCalledTimes(1);
  });

  it("returns 500 when handleInbound fails", async () => {
    handleInboundMock.mockImplementation(() =>
      Promise.resolve({ forwarded: false, rejected: false }),
    );

    const handler = createTwilioSmsWebhookHandler(baseConfig);
    const url = "http://localhost:7830/webhooks/twilio/sms";
    const params = {
      Body: "fail test",
      From: "+15551234567",
      To: "+15559876543",
      MessageSid: "SM-fail-test",
    };
    const req = buildSignedSmsRequest(url, params, AUTH_TOKEN);
    const res = await handler(req);
    expect(res.status).toBe(500);
  });

  it("allows retry after failed forwarding (does not dedup failures)", async () => {
    const handler = createTwilioSmsWebhookHandler(baseConfig);
    const url = "http://localhost:7830/webhooks/twilio/sms";
    const params = {
      Body: "retry test",
      From: "+15551234567",
      To: "+15559876543",
      MessageSid: "SM-retry-test",
    };

    // First attempt fails
    handleInboundMock.mockImplementation(() =>
      Promise.resolve({ forwarded: false, rejected: false }),
    );
    const req1 = buildSignedSmsRequest(url, params, AUTH_TOKEN);
    const res1 = await handler(req1);
    expect(res1.status).toBe(500);
    expect(handleInboundMock).toHaveBeenCalledTimes(1);

    // Retry with same MessageSid should NOT be deduped since first attempt failed
    handleInboundMock.mockImplementation(() =>
      Promise.resolve({ forwarded: true, rejected: false }),
    );
    const req2 = buildSignedSmsRequest(url, params, AUTH_TOKEN);
    const res2 = await handler(req2);
    expect(res2.status).toBe(200);
    expect(handleInboundMock).toHaveBeenCalledTimes(2);

    // Now a third attempt should be deduped since the second succeeded
    const req3 = buildSignedSmsRequest(url, params, AUTH_TOKEN);
    const res3 = await handler(req3);
    expect(res3.status).toBe(200);
    expect(handleInboundMock).toHaveBeenCalledTimes(2);
  });

  it("allows retry after handleInbound throws (does not dedup exceptions)", async () => {
    const handler = createTwilioSmsWebhookHandler(baseConfig);
    const url = "http://localhost:7830/webhooks/twilio/sms";
    const params = {
      Body: "throw test",
      From: "+15551234567",
      To: "+15559876543",
      MessageSid: "SM-throw-test",
    };

    // First attempt throws
    handleInboundMock.mockImplementation(() =>
      Promise.reject(new Error("connection refused")),
    );
    const req1 = buildSignedSmsRequest(url, params, AUTH_TOKEN);
    const res1 = await handler(req1);
    expect(res1.status).toBe(500);
    expect(handleInboundMock).toHaveBeenCalledTimes(1);

    // Retry should succeed and not be treated as duplicate
    handleInboundMock.mockImplementation(() =>
      Promise.resolve({ forwarded: true, rejected: false }),
    );
    const req2 = buildSignedSmsRequest(url, params, AUTH_TOKEN);
    const res2 = await handler(req2);
    expect(res2.status).toBe(200);
    expect(handleInboundMock).toHaveBeenCalledTimes(2);
  });

  it("returns 200 when routing rejects the SMS", async () => {
    handleInboundMock.mockImplementation(() =>
      Promise.resolve({ forwarded: false, rejected: true, rejectionReason: "No route" }),
    );

    const handler = createTwilioSmsWebhookHandler(baseConfig);
    const url = "http://localhost:7830/webhooks/twilio/sms";
    const params = {
      Body: "rejected test",
      From: "+15551234567",
      To: "+15559876543",
      MessageSid: "SM-reject-test",
    };
    const req = buildSignedSmsRequest(url, params, AUTH_TOKEN);
    const res = await handler(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("rejects oversized payload via Content-Length header", async () => {
    const handler = createTwilioSmsWebhookHandler({
      ...baseConfig,
      maxWebhookPayloadBytes: 50,
    });
    const req = new Request("http://localhost:7830/webhooks/twilio/sms", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": "999999",
        "X-Twilio-Signature": "irrelevant",
      },
      body: "x".repeat(200),
    });
    const res = await handler(req);
    expect(res.status).toBe(413);
  });
});
