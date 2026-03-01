import { describe, expect, mock, test } from "bun:test";

import { loadConfig } from "../config.js";
import {
  dispatchManagedInboundEvent,
} from "../managed-inbound-dispatch-client.js";
import type { ManagedGatewayUpstreamFetch } from "../route-resolve.js";

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
    MANAGED_GATEWAY_INTERNAL_REVOKED_TOKEN_IDS: "",
    MANAGED_GATEWAY_INTERNAL_MTLS_PRINCIPALS: "managed-gateway-staging",
    MANAGED_GATEWAY_MTLS_PRINCIPAL_HEADER: "x-managed-gateway-principal",
    MANAGED_GATEWAY_MTLS_AUDIENCE_HEADER: "x-managed-gateway-audience",
    MANAGED_GATEWAY_MTLS_SCOPES_HEADER: "x-managed-gateway-scopes",
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

describe("managed inbound dispatch client", () => {
  test("dispatches normalized event via Django internal endpoint using bearer auth", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchMock: MockedFetch = mock(async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
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
    });
    const config = makeConfig();

    const result = await dispatchManagedInboundEvent(config, {
      route: {
        routeId: "87c8dd8f-1f92-45c4-a524-126cf59fd760",
        assistantId: "8aa67431-9f28-40c0-98a5-e49d83bd15ab",
        provider: "twilio",
        routeType: "sms",
        identityKey: "+15559999999",
      },
      normalizedEvent: {
        version: "v1",
        sourceChannel: "sms",
        receivedAt: "2026-03-01T00:00:00Z",
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
        },
        raw: {
          Body: "hello from managed lane",
          From: "+15550000000",
          To: "+15559999999",
          MessageSid: "SM123",
        },
      },
      fetchImpl: (...args) => fetchMock(...args),
    });

    expect(result).toEqual({
      ok: true,
      dispatch: {
        status: "accepted",
        routeId: "87c8dd8f-1f92-45c4-a524-126cf59fd760",
        assistantId: "8aa67431-9f28-40c0-98a5-e49d83bd15ab",
        eventId: "evt_123",
        duplicate: false,
      },
    });
    expect(capturedUrl).toBe("http://127.0.0.1:8000/v1/internal/managed-gateway/inbound/dispatch/");
    expect(capturedInit?.method).toBe("POST");

    const requestBody = JSON.parse(capturedInit?.body as string) as Record<string, unknown>;
    expect(requestBody.route_id).toBe("87c8dd8f-1f92-45c4-a524-126cf59fd760");
    expect(requestBody.assistant_id).toBe("8aa67431-9f28-40c0-98a5-e49d83bd15ab");
    expect(requestBody.normalized_event).toBeDefined();

    const headers = capturedInit?.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer token-active");
    expect(headers.get("content-type")).toBe("application/json");
  });

  test("uses mTLS headers when configured in mTLS mode", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchMock: MockedFetch = mock(async (_input, init) => {
      capturedInit = init;
      return new Response(
        JSON.stringify({
          status: "accepted",
          route_id: "17b5e8c3-f07f-42e4-8099-a10af4c3d056",
          assistant_id: "4a6b3a7f-1f1f-4f5d-b18f-9c0f64baea77",
          duplicate: true,
        }),
        {
          status: 202,
          headers: { "content-type": "application/json" },
        },
      );
    });
    const config = makeConfig({
      MANAGED_GATEWAY_INTERNAL_AUTH_MODE: "mtls",
      MANAGED_GATEWAY_INTERNAL_MTLS_PRINCIPALS: "managed-gateway-staging",
    });

    const result = await dispatchManagedInboundEvent(config, {
      route: {
        routeId: "17b5e8c3-f07f-42e4-8099-a10af4c3d056",
        assistantId: "4a6b3a7f-1f1f-4f5d-b18f-9c0f64baea77",
        provider: "twilio",
        routeType: "voice",
        identityKey: "+15559999999",
      },
      normalizedEvent: {
        version: "v1",
        sourceChannel: "voice",
        receivedAt: "2026-03-01T00:00:00Z",
        message: {
          content: "",
          conversationExternalId: "+15550000000",
          externalMessageId: "CA123",
        },
        actor: {
          actorExternalId: "+15550000000",
          displayName: "+15550000000",
        },
        source: {
          updateId: "CA123",
          messageId: "CA123",
        },
        raw: {
          CallSid: "CA123",
          From: "+15550000000",
          To: "+15559999999",
          CallStatus: "ringing",
        },
      },
      fetchImpl: (...args) => fetchMock(...args),
    });

    expect(result.ok).toBe(true);
    const headers = capturedInit?.headers as Headers;
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-managed-gateway-principal")).toBe("managed-gateway-staging");
    expect(headers.get("x-managed-gateway-audience")).toBe("managed-gateway-internal");
    expect(headers.get("x-managed-gateway-scopes")).toBe("events:dispatch");
  });

  test("returns 404 when upstream route is missing", async () => {
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
    const config = makeConfig();

    const result = await dispatchManagedInboundEvent(config, {
      route: {
        routeId: "87c8dd8f-1f92-45c4-a524-126cf59fd760",
        assistantId: "8aa67431-9f28-40c0-98a5-e49d83bd15ab",
        provider: "twilio",
        routeType: "sms",
        identityKey: "+15559999999",
      },
      normalizedEvent: {
        version: "v1",
        sourceChannel: "sms",
        receivedAt: "2026-03-01T00:00:00Z",
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
        },
        raw: {
          Body: "hello from managed lane",
          From: "+15550000000",
          To: "+15559999999",
          MessageSid: "SM123",
        },
      },
      fetchImpl: (...args) => fetchMock(...args),
    });

    expect(result).toEqual({
      ok: false,
      status: 404,
      error: {
        code: "managed_route_not_found",
        detail: "Managed route not found.",
      },
    });
  });

  test("returns internal auth unavailable when no active bearer credentials exist", async () => {
    const config = makeConfig({
      MANAGED_GATEWAY_STRICT_STARTUP_VALIDATION: "false",
      MANAGED_GATEWAY_INTERNAL_BEARER_TOKENS: "{}",
    });

    const result = await dispatchManagedInboundEvent(config, {
      route: {
        routeId: "87c8dd8f-1f92-45c4-a524-126cf59fd760",
        assistantId: "8aa67431-9f28-40c0-98a5-e49d83bd15ab",
        provider: "twilio",
        routeType: "sms",
        identityKey: "+15559999999",
      },
      normalizedEvent: {
        version: "v1",
        sourceChannel: "sms",
        receivedAt: "2026-03-01T00:00:00Z",
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
        },
        raw: {
          Body: "hello from managed lane",
          From: "+15550000000",
          To: "+15559999999",
          MessageSid: "SM123",
        },
      },
    });

    expect(result).toEqual({
      ok: false,
      status: 500,
      error: {
        code: "internal_auth_unavailable",
        detail: "No active managed gateway internal auth credentials are available.",
      },
    });
  });
});
