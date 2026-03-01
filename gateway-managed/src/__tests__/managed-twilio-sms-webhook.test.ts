import { describe, expect, mock, test } from "bun:test";

import { loadConfig } from "../config.js";
import { createManagedGatewayAppFetch } from "../http.js";
import { MANAGED_TWILIO_SMS_WEBHOOK_PATH } from "../managed-twilio-sms-webhook.js";
import type { ManagedGatewayUpstreamFetch } from "../route-resolve.js";
import { computeTwilioSignature } from "../twilio-signature.js";

const FAR_FUTURE = "2099-01-01T00:00:00.000Z";

type EnvOverrides = Record<string, string | undefined>;
type MockedFetch = ReturnType<typeof mock<ManagedGatewayUpstreamFetch>>;

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
        scopes: ["managed-gateway:internal", "routes:resolve", "events:dispatch"],
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
    let callCount = 0;
    const fetchMock: MockedFetch = mock(async () => {
      callCount += 1;
      if (callCount === 1) {
        return new Response(
          JSON.stringify({
            route_id: "87c8dd8f-1f92-45c4-a524-126cf59fd760",
            assistant_id: "8aa67431-9f28-40c0-98a5-e49d83bd15ab",
            provider: "twilio",
            route_type: "sms",
            identity_key: "+15559999999",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      if (callCount === 2) {
        return new Response(
          JSON.stringify({
            status: "accepted",
            route_id: "87c8dd8f-1f92-45c4-a524-126cf59fd760",
            assistant_id: "8aa67431-9f28-40c0-98a5-e49d83bd15ab",
            event_id: "evt_123",
            duplicate: false,
          }),
          {
            status: 202,
            headers: { "content-type": "application/json" },
          },
        );
      }

      throw new Error(`unexpected upstream call #${callCount}`);
    });
    const handler = createManagedGatewayAppFetch(config, {
      fetchImpl: (...args) => fetchMock(...args),
    });
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
      code: "managed_sms_webhook_dispatched",
      provider: "twilio",
      route_type: "sms",
      message_sid: "SM123",
      from: "+15550000000",
      to: "+15559999999",
      body: "hello from managed lane",
      assistant_id: "8aa67431-9f28-40c0-98a5-e49d83bd15ab",
      route_id: "87c8dd8f-1f92-45c4-a524-126cf59fd760",
      normalized_event: {
        version: "v1",
        sourceChannel: "sms",
        receivedAt: expect.any(String),
        message: {
          content: "hello from managed lane",
          conversationExternalId: "+15550000000",
          externalMessageId: "SM123",
        },
        actor: {
          actorExternalId: "+15550000000",
          displayName: "+15550000000",
        },
        source: {
          updateId: "SM123",
          messageId: "SM123",
          to: "+15559999999",
        },
        raw: {
          From: "+15550000000",
          To: "+15559999999",
          Body: "hello from managed lane",
          MessageSid: "SM123",
          _to: "+15559999999",
        },
      },
      dispatch: {
        status: "accepted",
        event_id: "evt_123",
        duplicate: false,
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("returns 400 for invalid webhook payload", async () => {
    const config = makeConfig();
    const fetchMock: MockedFetch = mock(async () => {
      throw new Error("route resolution should not be called for invalid payload");
    });
    const handler = createManagedGatewayAppFetch(config, {
      fetchImpl: (...args) => fetchMock(...args),
    });
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
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  test("returns 403 for missing Twilio signature", async () => {
    const config = makeConfig();
    const fetchMock: MockedFetch = mock(async () => {
      throw new Error("route resolution should not be called for missing signature");
    });
    const handler = createManagedGatewayAppFetch(config, {
      fetchImpl: (...args) => fetchMock(...args),
    });
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
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  test("returns 403 for invalid Twilio signature", async () => {
    const config = makeConfig();
    const fetchMock: MockedFetch = mock(async () => {
      throw new Error("route resolution should not be called for invalid signature");
    });
    const handler = createManagedGatewayAppFetch(config, {
      fetchImpl: (...args) => fetchMock(...args),
    });
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
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  test("returns 405 for unsupported method", async () => {
    const config = makeConfig();
    const fetchMock: MockedFetch = mock(async () => {
      throw new Error("route resolution should not be called for GET");
    });
    const handler = createManagedGatewayAppFetch(config, {
      fetchImpl: (...args) => fetchMock(...args),
    });
    const response = await handler(
      makeRequest(new URLSearchParams(), {}, "GET"),
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  test("returns 404 when managed route is not found", async () => {
    const config = makeConfig();
    const fetchMock: MockedFetch = mock(async () => {
      return new Response(
        JSON.stringify({
          error: {
            code: "managed_route_not_found",
            detail: "Managed route not found.",
          },
        }),
        {
          status: 404,
          headers: { "content-type": "application/json" },
        },
      );
    });
    const handler = createManagedGatewayAppFetch(config, {
      fetchImpl: (...args) => fetchMock(...args),
    });
    const payload = new URLSearchParams({
      From: "+15550000000",
      To: "+15559999999",
      Body: "hello",
      MessageSid: "SM126",
    });
    const signature = computeTwilioSignature(
      `http://managed-gateway.test${MANAGED_TWILIO_SMS_WEBHOOK_PATH}`,
      Object.fromEntries(payload),
      "twilio-current-secret",
    );

    const response = await handler(makeRequest(payload, {
      "x-twilio-signature": signature,
    }));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: {
        code: "managed_route_not_found",
        detail: "Managed route not found.",
      },
    });
  });

  test("returns 502 when dispatch upstream fails", async () => {
    const config = makeConfig();
    let callCount = 0;
    const fetchMock: MockedFetch = mock(async () => {
      callCount += 1;
      if (callCount === 1) {
        return new Response(
          JSON.stringify({
            route_id: "87c8dd8f-1f92-45c4-a524-126cf59fd760",
            assistant_id: "8aa67431-9f28-40c0-98a5-e49d83bd15ab",
            provider: "twilio",
            route_type: "sms",
            identity_key: "+15559999999",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      return new Response(
        JSON.stringify({
          error: {
            code: "upstream_error",
            detail: "runtime unavailable",
          },
        }),
        {
          status: 503,
          headers: { "content-type": "application/json" },
        },
      );
    });
    const handler = createManagedGatewayAppFetch(config, {
      fetchImpl: (...args) => fetchMock(...args),
    });
    const payload = new URLSearchParams({
      From: "+15550000000",
      To: "+15559999999",
      Body: "hello",
      MessageSid: "SM127",
    });
    const signature = computeTwilioSignature(
      `http://managed-gateway.test${MANAGED_TWILIO_SMS_WEBHOOK_PATH}`,
      Object.fromEntries(payload),
      "twilio-current-secret",
    );

    const response = await handler(makeRequest(payload, {
      "x-twilio-signature": signature,
    }));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: {
        code: "upstream_error",
        detail: "runtime unavailable",
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
