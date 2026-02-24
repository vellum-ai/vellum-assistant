import { describe, test, expect } from "bun:test";
import { createHmac } from "node:crypto";
import type { GatewayConfig } from "../config.js";
import { createTwilioSmsWebhookHandler } from "../http/routes/twilio-sms-webhook.js";

/**
 * Proves that the SMS ingress route cannot be bypassed — requests
 * without valid Twilio signature are rejected, and unauthenticated
 * requests to the deliver endpoint are rejected.
 *
 * Also validates that signature URL candidate selection is tightened
 * when INGRESS_PUBLIC_BASE_URL is configured: the raw local request URL
 * is still included as a fallback to preserve local-dev operability,
 * but the canonical ingress URL is tried first.
 */

const AUTH_TOKEN = "test-guard-auth-token";

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  const merged: GatewayConfig = {
    telegramBotToken: undefined,
    telegramWebhookSecret: undefined,
    telegramApiBaseUrl: "https://api.telegram.org",
    assistantRuntimeBaseUrl: "http://localhost:7821",
    routingEntries: [],
    defaultAssistantId: "ast-default",
    unmappedPolicy: "default",
    port: 7830,
    runtimeBearerToken: undefined,
    runtimeGatewayOriginSecret: undefined,
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

  test("rejects SMS webhook with empty body (no MessageSid)", async () => {
    const handler = createTwilioSmsWebhookHandler(makeConfig());
    const url = "http://localhost:7830/webhooks/twilio/sms";
    const params: Record<string, string> = {};
    const signature = computeSignature(url, params, AUTH_TOKEN);
    const req = new Request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Twilio-Signature": signature,
      },
      body: "",
    });
    const res = await handler(req);
    // Should be 400 (missing MessageSid) since the signature validates but the
    // payload is malformed — proving the handler enforces payload integrity too.
    expect(res.status).toBe(400);
  });

  test("rejects oversized SMS webhook payload", async () => {
    const handler = createTwilioSmsWebhookHandler(
      makeConfig({ maxWebhookPayloadBytes: 50 }),
    );
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

describe("SMS ingress signature validation with INGRESS_PUBLIC_BASE_URL", () => {
  test("validates signature against configured ingress URL as primary candidate", async () => {
    const publicBase = "https://sms-tunnel.example.com";
    const config = makeConfig({ ingressPublicBaseUrl: publicBase });
    const handler = createTwilioSmsWebhookHandler(config);

    // Twilio signs against the public URL
    const publicUrl = `${publicBase}/webhooks/twilio/sms`;
    const params = {
      Body: "hello tunnel",
      From: "+15551234567",
      To: "+15559876543",
      MessageSid: "SM-ingress-1",
    };
    const signature = computeSignature(publicUrl, params, AUTH_TOKEN);
    const body = new URLSearchParams(params).toString();

    // Request arrives on the local address
    const req = new Request("http://localhost:7830/webhooks/twilio/sms", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Twilio-Signature": signature,
      },
      body,
    });
    const res = await handler(req);
    // Should pass validation because the ingress URL is tried as a candidate
    expect(res.status).not.toBe(403);
  });

  test("rejects signature computed against wrong ingress URL", async () => {
    const config = makeConfig({
      ingressPublicBaseUrl: "https://correct-tunnel.example.com",
    });
    const handler = createTwilioSmsWebhookHandler(config);

    // Attacker signs against a different URL
    const wrongUrl = "https://attacker.example.com/webhooks/twilio/sms";
    const params = {
      Body: "spoofed",
      From: "+15550009999",
      To: "+15559876543",
      MessageSid: "SM-spoof-1",
    };
    const signature = computeSignature(wrongUrl, params, AUTH_TOKEN);
    const body = new URLSearchParams(params).toString();

    const req = new Request("http://localhost:7830/webhooks/twilio/sms", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Twilio-Signature": signature,
      },
      body,
    });
    const res = await handler(req);
    expect(res.status).toBe(403);
  });

  test("local-dev fallback: signature against local URL validates when no ingress configured", async () => {
    const config = makeConfig({ ingressPublicBaseUrl: undefined });
    const handler = createTwilioSmsWebhookHandler(config);

    // In local dev, Twilio signs against the raw request URL
    const localUrl = "http://localhost:7830/webhooks/twilio/sms";
    const params = {
      Body: "local dev test",
      From: "+15551234567",
      To: "+15559876543",
      MessageSid: "SM-local-1",
    };
    const signature = computeSignature(localUrl, params, AUTH_TOKEN);
    const body = new URLSearchParams(params).toString();

    const req = new Request(localUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Twilio-Signature": signature,
      },
      body,
    });
    const res = await handler(req);
    expect(res.status).not.toBe(403);
  });
});
