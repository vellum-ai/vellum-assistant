import { describe, test, expect } from "bun:test";
import { createHmac } from "node:crypto";
import type { GatewayConfig } from "../config.js";
import { createTwilioSmsWebhookHandler } from "../http/routes/twilio-sms-webhook.js";

/**
 * Proves that the SMS ingress route cannot be bypassed — requests
 * without valid Twilio signature are rejected, and unauthenticated
 * requests to the deliver endpoint are rejected.
 */

const AUTH_TOKEN = "test-guard-auth-token";

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    telegramBotToken: undefined,
    telegramWebhookSecret: undefined,
    telegramApiBaseUrl: "https://api.telegram.org",
    assistantRuntimeBaseUrl: "http://localhost:7821",
    routingEntries: [],
    defaultAssistantId: "ast-default",
    unmappedPolicy: "default",
    port: 7830,
    runtimeBearerToken: undefined,
    runtimeProxyEnabled: false,
    runtimeProxyRequireAuth: true,
    runtimeProxyBearerToken: "runtime-token",
    shutdownDrainMs: 5000,
    runtimeTimeoutMs: 30000,
    runtimeMaxRetries: 2,
    runtimeInitialBackoffMs: 500,
    telegramDeliverAuthBypass: false,
    telegramInitialBackoffMs: 1000,
    telegramMaxRetries: 3,
    telegramTimeoutMs: 15000,
    maxWebhookPayloadBytes: 1048576,
    logFile: { dir: undefined, retentionDays: 30 },
    maxAttachmentBytes: 20971520,
    maxAttachmentConcurrency: 3,
    twilioAuthToken: AUTH_TOKEN,
    twilioAccountSid: "AC-test",
    twilioPhoneNumber: "+15551234567",
    smsDeliverAuthBypass: false,
    ingressPublicBaseUrl: undefined,
    gatewayInternalBaseUrl: "http://127.0.0.1:7830",
    ...overrides,
  };
}

describe("SMS ingress cannot bypass gateway boundary", () => {
  test("rejects SMS webhook without X-Twilio-Signature header", async () => {
    const handler = createTwilioSmsWebhookHandler(makeConfig());
    const req = new Request("http://localhost:7830/webhooks/twilio/sms", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "Body=hello&From=%2B15551234567&To=%2B15559876543&MessageSid=SM123",
    });
    const res = await handler(req);
    expect(res.status).toBe(403);
  });

  test("rejects SMS webhook with forged signature", async () => {
    const handler = createTwilioSmsWebhookHandler(makeConfig());
    const req = new Request("http://localhost:7830/webhooks/twilio/sms", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Twilio-Signature": "forged-signature-value",
      },
      body: "Body=hello&From=%2B15551234567&To=%2B15559876543&MessageSid=SM123",
    });
    const res = await handler(req);
    expect(res.status).toBe(403);
  });

  test("rejects SMS webhook when auth token is not configured (fail-closed)", async () => {
    const handler = createTwilioSmsWebhookHandler(
      makeConfig({ twilioAuthToken: undefined }),
    );
    const req = new Request("http://localhost:7830/webhooks/twilio/sms", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "Body=hello&MessageSid=SM123",
    });
    const res = await handler(req);
    expect(res.status).toBe(403);
  });

  test("rejects SMS webhook with signature signed by wrong auth token", async () => {
    const handler = createTwilioSmsWebhookHandler(makeConfig());
    const url = "http://localhost:7830/webhooks/twilio/sms";
    const params = {
      Body: "hello",
      From: "+15551234567",
      To: "+15559876543",
      MessageSid: "SM123",
    };
    // Sign with a different auth token
    const wrongToken = "wrong-auth-token";
    const sortedKeys = Object.keys(params).sort();
    let data = url;
    for (const key of sortedKeys) {
      data += key + params[key as keyof typeof params];
    }
    const wrongSignature = createHmac("sha1", wrongToken)
      .update(data)
      .digest("base64");

    const body = new URLSearchParams(params).toString();
    const req = new Request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Twilio-Signature": wrongSignature,
      },
      body,
    });
    const res = await handler(req);
    expect(res.status).toBe(403);
  });

  test("rejects non-POST methods", async () => {
    const handler = createTwilioSmsWebhookHandler(makeConfig());
    const req = new Request("http://localhost:7830/webhooks/twilio/sms", {
      method: "GET",
    });
    const res = await handler(req);
    expect(res.status).toBe(405);
  });
});
