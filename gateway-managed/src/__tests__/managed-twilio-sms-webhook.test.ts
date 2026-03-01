import { describe, expect, test } from "bun:test";

import { loadConfig } from "../config.js";
import { createManagedGatewayAppFetch } from "../http.js";
import { MANAGED_TWILIO_SMS_WEBHOOK_PATH } from "../managed-twilio-sms-webhook.js";
import { computeTwilioSignature } from "../twilio-signature.js";

const FAR_FUTURE = "2099-01-01T00:00:00.000Z";

type EnvOverrides = Record<string, string | undefined>;

function makeConfig(overrides: EnvOverrides = {}): ReturnType<typeof loadConfig> {
  return loadConfig({
    ...process.env,
    MANAGED_GATEWAY_ENABLED: "true",
    MANAGED_GATEWAY_STRICT_STARTUP_VALIDATION: "true",
    MANAGED_GATEWAY_DJANGO_INTERNAL_BASE_URL: "http://127.0.0.1:8000",
    MANAGED_GATEWAY_INTERNAL_AUTH_MODE: "bearer",
    MANAGED_GATEWAY_INTERNAL_AUTH_AUDIENCE: "managed-gateway-internal",
    MANAGED_GATEWAY_INTERNAL_BEARER_TOKENS: JSON.stringify({
      "token-active": {
        token_id: "mgw-2026-01",
        principal: "managed-gateway-staging",
        audience: "managed-gateway-internal",
        scopes: ["managed-gateway:internal", "routes:resolve"],
        expires_at: FAR_FUTURE,
      },
    }),
    MANAGED_GATEWAY_TWILIO_AUTH_TOKENS: JSON.stringify({
      "twilio-current": {
        token_id: "twilio-2026-01",
        auth_token: "twilio-current-secret",
        expires_at: FAR_FUTURE,
      },
    }),
    ...overrides,
  });
}

function makeRequest(
  body: URLSearchParams,
  headers: Record<string, string> = {},
  method: string = "POST",
): Request {
  return new Request(`http://managed-gateway.test${MANAGED_TWILIO_SMS_WEBHOOK_PATH}`, {
    method,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body: method === "POST" ? body.toString() : undefined,
  });
}

describe("managed Twilio SMS webhook skeleton", () => {
  test("returns 202 for valid signed Twilio SMS payload", async () => {
    const config = makeConfig();
    const handler = createManagedGatewayAppFetch(config);
    const payload = new URLSearchParams({
      From: "+15550000000",
      To: "+15559999999",
      Body: "hello from managed lane",
      MessageSid: "SM123",
    });
    const signature = computeTwilioSignature(
      `http://managed-gateway.test${MANAGED_TWILIO_SMS_WEBHOOK_PATH}`,
      Object.fromEntries(payload),
      "twilio-current-secret",
    );

    const response = await handler(makeRequest(payload, {
      "x-twilio-signature": signature,
    }));

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      status: "accepted",
      code: "managed_sms_webhook_stub",
      provider: "twilio",
      route_type: "sms",
      message_sid: "SM123",
      from: "+15550000000",
      to: "+15559999999",
      body: "hello from managed lane",
    });
  });

  test("returns 400 for invalid webhook payload", async () => {
    const config = makeConfig();
    const handler = createManagedGatewayAppFetch(config);
    const payload = new URLSearchParams({
      From: "+15550000000",
      To: "+15559999999",
      Body: "missing sid",
    });
    const signature = computeTwilioSignature(
      `http://managed-gateway.test${MANAGED_TWILIO_SMS_WEBHOOK_PATH}`,
      Object.fromEntries(payload),
      "twilio-current-secret",
    );

    const response = await handler(makeRequest(payload, {
      "x-twilio-signature": signature,
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "validation_error",
        detail: "Invalid managed Twilio SMS webhook payload.",
      },
    });
  });

  test("returns 403 for missing Twilio signature", async () => {
    const config = makeConfig();
    const handler = createManagedGatewayAppFetch(config);
    const payload = new URLSearchParams({
      From: "+15550000000",
      To: "+15559999999",
      Body: "hello",
      MessageSid: "SM124",
    });

    const response = await handler(makeRequest(payload));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: {
        code: "missing_signature",
        detail: "Missing X-Twilio-Signature header.",
      },
    });
  });

  test("returns 403 for invalid Twilio signature", async () => {
    const config = makeConfig();
    const handler = createManagedGatewayAppFetch(config);
    const payload = new URLSearchParams({
      From: "+15550000000",
      To: "+15559999999",
      Body: "hello",
      MessageSid: "SM125",
    });

    const response = await handler(makeRequest(payload, {
      "x-twilio-signature": "invalid",
    }));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_signature",
        detail: "Invalid Twilio request signature.",
      },
    });
  });

  test("returns 405 for unsupported method", async () => {
    const config = makeConfig();
    const handler = createManagedGatewayAppFetch(config);
    const response = await handler(
      makeRequest(new URLSearchParams(), {}, "GET"),
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });
});
