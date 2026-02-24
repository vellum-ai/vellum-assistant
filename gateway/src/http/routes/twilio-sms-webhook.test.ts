import { describe, it, expect, mock, beforeEach } from "bun:test";
import { createHmac } from "node:crypto";
import type { GatewayConfig } from "../../config.js";

// --- Mocks ----------------------------------------------------------------

const handleInboundMock = mock(() =>
  Promise.resolve({ forwarded: true, rejected: false }),
);

const resetConversationMock = mock(() => Promise.resolve());

const sendSmsReplyMock = mock(() => Promise.resolve());

mock.module("../../handlers/handle-inbound.js", () => ({
  handleInbound: handleInboundMock,
}));

mock.module("../../runtime/client.js", () => ({
  resetConversation: resetConversationMock,
}));

mock.module("../../twilio/send-sms.js", () => ({
  sendSmsReply: sendSmsReplyMock,
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
  runtimeGatewayOriginSecret: undefined,
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
  assistantEmail: undefined,
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
    resetConversationMock.mockClear();
    resetConversationMock.mockImplementation(() => Promise.resolve());
    sendSmsReplyMock.mockClear();
    sendSmsReplyMock.mockImplementation(() => Promise.resolve());
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

  it("/new triggers resetConversation and does not forward as normal message", async () => {
    const handler = createTwilioSmsWebhookHandler(baseConfig);
    const url = "http://localhost:7830/webhooks/twilio/sms";
    const params = {
      Body: "/new",
      From: "+15551234567",
      To: "+15559876543",
      MessageSid: "SM-new-cmd",
    };
    const req = buildSignedSmsRequest(url, params, AUTH_TOKEN);
    const res = await handler(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // resetConversation should have been called
    expect(resetConversationMock).toHaveBeenCalledTimes(1);
    const [, assistantId, sourceChannel, externalChatId] =
      resetConversationMock.mock.calls[0] as unknown[];
    expect(assistantId).toBe("ast-default");
    expect(sourceChannel).toBe("sms");
    expect(externalChatId).toBe("+15551234567");

    // Confirmation SMS should have been sent
    expect(sendSmsReplyMock).toHaveBeenCalledTimes(1);
    const [, to, text, replyAssistantId] = sendSmsReplyMock.mock.calls[0] as unknown[];
    expect(to).toBe("+15551234567");
    expect(text).toBe("Starting a new conversation!");
    expect(replyAssistantId).toBe("ast-default");

    // handleInbound should NOT have been called
    expect(handleInboundMock).toHaveBeenCalledTimes(0);
  });

  it("/new is case-insensitive and trims whitespace", async () => {
    const handler = createTwilioSmsWebhookHandler(baseConfig);
    const url = "http://localhost:7830/webhooks/twilio/sms";
    const params = {
      Body: "  /NEW  ",
      From: "+15551234567",
      To: "+15559876543",
      MessageSid: "SM-new-case",
    };
    const req = buildSignedSmsRequest(url, params, AUTH_TOKEN);
    const res = await handler(req);

    expect(res.status).toBe(200);
    expect(resetConversationMock).toHaveBeenCalledTimes(1);
    expect(handleInboundMock).toHaveBeenCalledTimes(0);
  });

  it("/new with routing rejection sends rejection notice SMS", async () => {
    const rejectConfig: GatewayConfig = {
      ...baseConfig,
      unmappedPolicy: "reject",
      defaultAssistantId: undefined,
    };
    const handler = createTwilioSmsWebhookHandler(rejectConfig);
    const url = "http://localhost:7830/webhooks/twilio/sms";
    const params = {
      Body: "/new",
      From: "+15551234567",
      To: "+15559876543",
      MessageSid: "SM-new-reject",
    };
    const req = buildSignedSmsRequest(url, params, AUTH_TOKEN);
    const res = await handler(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // resetConversation should NOT have been called
    expect(resetConversationMock).toHaveBeenCalledTimes(0);

    // Rejection notice SMS should have been sent
    expect(sendSmsReplyMock).toHaveBeenCalledTimes(1);
    const [, to, text, assistantId] = sendSmsReplyMock.mock.calls[0] as unknown[];
    expect(to).toBe("+15551234567");
    expect(typeof text).toBe("string");
    expect((text as string).toLowerCase()).toContain("could not be routed");
    expect(assistantId).toBeUndefined();

    // handleInbound should NOT have been called
    expect(handleInboundMock).toHaveBeenCalledTimes(0);
  });

  it("MMS payload (NumMedia > 0) returns unsupported notice and does not forward", async () => {
    const handler = createTwilioSmsWebhookHandler(baseConfig);
    const url = "http://localhost:7830/webhooks/twilio/sms";
    const params = {
      Body: "Check out this photo",
      From: "+15551234567",
      To: "+15559876543",
      MessageSid: "SM-mms-test",
      NumMedia: "1",
      MediaUrl0: "https://api.twilio.com/media/123",
      MediaContentType0: "image/jpeg",
    };
    const req = buildSignedSmsRequest(url, params, AUTH_TOKEN);
    const res = await handler(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // Unsupported notice should have been sent
    expect(sendSmsReplyMock).toHaveBeenCalledTimes(1);
    const [, to, text, assistantId] = sendSmsReplyMock.mock.calls[0] as unknown[];
    expect(to).toBe("+15551234567");
    expect(typeof text).toBe("string");
    expect((text as string).toLowerCase()).toContain("not supported");
    expect(assistantId).toBe("ast-default");

    // handleInbound should NOT have been called
    expect(handleInboundMock).toHaveBeenCalledTimes(0);
  });

  it("MMS detected via MediaUrl0 when NumMedia is absent", async () => {
    const handler = createTwilioSmsWebhookHandler(baseConfig);
    const url = "http://localhost:7830/webhooks/twilio/sms";
    const params = {
      Body: "Check out this photo",
      From: "+15551234567",
      To: "+15559876543",
      MessageSid: "SM-mms-mediaurl",
      MediaUrl0: "https://api.twilio.com/media/456",
    };
    const req = buildSignedSmsRequest(url, params, AUTH_TOKEN);
    const res = await handler(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // Unsupported notice should have been sent
    expect(sendSmsReplyMock).toHaveBeenCalledTimes(1);
    const [, to, text, assistantId] = sendSmsReplyMock.mock.calls[0] as unknown[];
    expect(to).toBe("+15551234567");
    expect(typeof text).toBe("string");
    expect((text as string).toLowerCase()).toContain("not supported");
    expect(assistantId).toBe("ast-default");

    // handleInbound should NOT have been called
    expect(handleInboundMock).toHaveBeenCalledTimes(0);
  });

  it("routes by To phone number when assistantPhoneNumbers is configured", async () => {
    const phoneConfig: GatewayConfig = {
      ...baseConfig,
      unmappedPolicy: "reject",
      defaultAssistantId: undefined,
      assistantPhoneNumbers: { "ast-alpha": "+15559876543" },
    };
    const handler = createTwilioSmsWebhookHandler(phoneConfig);
    const url = "http://localhost:7830/webhooks/twilio/sms";
    const params = {
      Body: "Hello via phone routing",
      From: "+15551234567",
      To: "+15559876543",
      MessageSid: "SM-phone-route",
    };
    const req = buildSignedSmsRequest(url, params, AUTH_TOKEN);
    const res = await handler(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // Should have been forwarded via handleInbound (not rejected)
    expect(handleInboundMock).toHaveBeenCalledTimes(1);
  });

  it("phone number routing takes priority over reject policy", async () => {
    const phoneConfig: GatewayConfig = {
      ...baseConfig,
      unmappedPolicy: "reject",
      defaultAssistantId: undefined,
      assistantPhoneNumbers: { "ast-beta": "+15559876543" },
    };
    const handler = createTwilioSmsWebhookHandler(phoneConfig);
    const url = "http://localhost:7830/webhooks/twilio/sms";
    const params = {
      Body: "/new",
      From: "+15551234567",
      To: "+15559876543",
      MessageSid: "SM-phone-new",
    };
    const req = buildSignedSmsRequest(url, params, AUTH_TOKEN);
    const res = await handler(req);

    expect(res.status).toBe(200);
    // resetConversation should have been called with the phone-routed assistant
    expect(resetConversationMock).toHaveBeenCalledTimes(1);
    const [, assistantId] = resetConversationMock.mock.calls[0] as unknown[];
    expect(assistantId).toBe("ast-beta");
    expect(sendSmsReplyMock).toHaveBeenCalledTimes(1);
    const [, , , replyAssistantId] = sendSmsReplyMock.mock.calls[0] as unknown[];
    expect(replyAssistantId).toBe("ast-beta");
  });

  it("MMS notices use phone-number routed assistant for sender resolution", async () => {
    const phoneConfig: GatewayConfig = {
      ...baseConfig,
      unmappedPolicy: "reject",
      defaultAssistantId: undefined,
      assistantPhoneNumbers: { "ast-beta": "+15559876543" },
    };
    const handler = createTwilioSmsWebhookHandler(phoneConfig);
    const url = "http://localhost:7830/webhooks/twilio/sms";
    const params = {
      Body: "MMS inbound",
      From: "+15551234567",
      To: "+15559876543",
      MessageSid: "SM-mms-phone-route",
      NumMedia: "1",
      MediaUrl0: "https://api.twilio.com/media/999",
      MediaContentType0: "image/jpeg",
    };
    const req = buildSignedSmsRequest(url, params, AUTH_TOKEN);
    const res = await handler(req);

    expect(res.status).toBe(200);
    expect(sendSmsReplyMock).toHaveBeenCalledTimes(1);
    const [, , , assistantId] = sendSmsReplyMock.mock.calls[0] as unknown[];
    expect(assistantId).toBe("ast-beta");
    expect(handleInboundMock).toHaveBeenCalledTimes(0);
  });

  it("falls through to standard routing when To number is not in assistantPhoneNumbers", async () => {
    const phoneConfig: GatewayConfig = {
      ...baseConfig,
      assistantPhoneNumbers: { "ast-alpha": "+15550001111" },
    };
    const handler = createTwilioSmsWebhookHandler(phoneConfig);
    const url = "http://localhost:7830/webhooks/twilio/sms";
    const params = {
      Body: "Hello fallthrough",
      From: "+15551234567",
      To: "+15559876543",
      MessageSid: "SM-phone-fallthrough",
    };
    const req = buildSignedSmsRequest(url, params, AUTH_TOKEN);
    const res = await handler(req);

    expect(res.status).toBe(200);
    // Should still be forwarded via the default routing
    expect(handleInboundMock).toHaveBeenCalledTimes(1);
  });

  it("passes phone-number routing override to handleInbound", async () => {
    const phoneConfig: GatewayConfig = {
      ...baseConfig,
      unmappedPolicy: "reject",
      defaultAssistantId: undefined,
      assistantPhoneNumbers: { "ast-alpha": "+15559876543" },
    };
    const handler = createTwilioSmsWebhookHandler(phoneConfig);
    const url = "http://localhost:7830/webhooks/twilio/sms";
    const params = {
      Body: "Hello via phone routing",
      From: "+15551234567",
      To: "+15559876543",
      MessageSid: "SM-routing-override",
    };
    const req = buildSignedSmsRequest(url, params, AUTH_TOKEN);
    const res = await handler(req);

    expect(res.status).toBe(200);
    expect(handleInboundMock).toHaveBeenCalledTimes(1);

    // Verify the routingOverride was passed to handleInbound
    const [, , options] = handleInboundMock.mock.calls[0] as unknown[];
    const typedOptions = options as { routingOverride?: { assistantId: string; routeSource: string } };
    expect(typedOptions.routingOverride).toBeDefined();
    expect(typedOptions.routingOverride!.assistantId).toBe("ast-alpha");
    expect(typedOptions.routingOverride!.routeSource).toBe("phone_number");
  });

  it("passes default routing override to handleInbound when no phone match", async () => {
    const handler = createTwilioSmsWebhookHandler(baseConfig);
    const url = "http://localhost:7830/webhooks/twilio/sms";
    const params = {
      Body: "Hello default routing",
      From: "+15551234567",
      To: "+15559876543",
      MessageSid: "SM-default-routing",
    };
    const req = buildSignedSmsRequest(url, params, AUTH_TOKEN);
    const res = await handler(req);

    expect(res.status).toBe(200);
    expect(handleInboundMock).toHaveBeenCalledTimes(1);

    // Verify the routingOverride uses default routing
    const [, , options] = handleInboundMock.mock.calls[0] as unknown[];
    const typedOptions = options as { routingOverride?: { assistantId: string; routeSource: string } };
    expect(typedOptions.routingOverride).toBeDefined();
    expect(typedOptions.routingOverride!.assistantId).toBe("ast-default");
    expect(typedOptions.routingOverride!.routeSource).toBe("default");
  });

  it("regular inbound SMS with routing rejection sends rejection notice", async () => {
    const rejectConfig: GatewayConfig = {
      ...baseConfig,
      unmappedPolicy: "reject",
      defaultAssistantId: undefined,
    };
    const handler = createTwilioSmsWebhookHandler(rejectConfig);
    const url = "http://localhost:7830/webhooks/twilio/sms";
    // Use a unique From number to avoid the module-level rejection notice
    // rate limiter (shouldSendRejectionNotice) cooldown from other tests.
    const params = {
      Body: "Hello",
      From: "+15553001001",
      To: "+15559876543",
      MessageSid: "SM-regular-reject",
    };
    const req = buildSignedSmsRequest(url, params, AUTH_TOKEN);
    const res = await handler(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // Rejection notice SMS should have been sent
    expect(sendSmsReplyMock).toHaveBeenCalledTimes(1);
    const [, to, text] = sendSmsReplyMock.mock.calls[0] as unknown[];
    expect(to).toBe("+15553001001");
    expect(typeof text).toBe("string");
    expect((text as string).toLowerCase()).toContain("could not be routed");

    // handleInbound should NOT have been called
    expect(handleInboundMock).toHaveBeenCalledTimes(0);
  });

  it("runtime rejection (handleInbound rejected) sends rejection notice", async () => {
    handleInboundMock.mockImplementation(() =>
      Promise.resolve({ forwarded: false, rejected: true, rejectionReason: "test" }),
    );

    const handler = createTwilioSmsWebhookHandler(baseConfig);
    const url = "http://localhost:7830/webhooks/twilio/sms";
    // Use a unique From number to avoid the module-level rejection notice
    // rate limiter (shouldSendRejectionNotice) cooldown from other tests.
    const params = {
      Body: "Hello runtime reject",
      From: "+15553002002",
      To: "+15559876543",
      MessageSid: "SM-runtime-reject",
    };
    const req = buildSignedSmsRequest(url, params, AUTH_TOKEN);
    const res = await handler(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // handleInbound should have been called
    expect(handleInboundMock).toHaveBeenCalledTimes(1);

    // Rejection notice SMS should have been sent
    expect(sendSmsReplyMock).toHaveBeenCalledTimes(1);
    const [, to, text] = sendSmsReplyMock.mock.calls[0] as unknown[];
    expect(to).toBe("+15553002002");
    expect(typeof text).toBe("string");
    expect((text as string).toLowerCase()).toContain("could not be routed");
  });

  it("MMS detected via MediaContentType0 when NumMedia is absent", async () => {
    const handler = createTwilioSmsWebhookHandler(baseConfig);
    const url = "http://localhost:7830/webhooks/twilio/sms";
    const params = {
      Body: "Here is a file",
      From: "+15551234567",
      To: "+15559876543",
      MessageSid: "SM-mms-contenttype",
      MediaContentType0: "image/png",
    };
    const req = buildSignedSmsRequest(url, params, AUTH_TOKEN);
    const res = await handler(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // Unsupported notice should have been sent
    expect(sendSmsReplyMock).toHaveBeenCalledTimes(1);
    const [, to, text, assistantId] = sendSmsReplyMock.mock.calls[0] as unknown[];
    expect(to).toBe("+15551234567");
    expect(typeof text).toBe("string");
    expect((text as string).toLowerCase()).toContain("not supported");
    expect(assistantId).toBe("ast-default");

    // handleInbound should NOT have been called
    expect(handleInboundMock).toHaveBeenCalledTimes(0);
  });
});
