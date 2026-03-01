import { describe, expect, mock, test } from "bun:test";

import { loadConfig } from "../config.js";
import { createManagedGatewayAppFetch } from "../http.js";
import {
  MANAGED_GATEWAY_ROUTE_RESOLVE_PATH,
  type ManagedGatewayUpstreamFetch,
} from "../route-resolve.js";

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
        scopes: ["managed-gateway:internal", "routes:resolve"],
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

function makeResolveRequest(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Request {
  return new Request(`http://managed-gateway.test${MANAGED_GATEWAY_ROUTE_RESOLVE_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("managed-gateway route resolve endpoint", () => {
  test("returns 200 and forwards normalized payload on success", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchMock: MockedFetch = mock(async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response(
        JSON.stringify({
          route_id: "87c8dd8f-1f92-45c4-a524-126cf59fd760",
          assistant_id: "8aa67431-9f28-40c0-98a5-e49d83bd15ab",
          provider: "twilio",
          route_type: "sms",
          identity_key: "+15550101010",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });

    const config = makeConfig();
    const handler = createManagedGatewayAppFetch(config, {
      fetchImpl: (...args) => fetchMock(...args),
    });

    const response = await handler(
      makeResolveRequest(
        {
          provider: " Twilio ",
          route_type: " SMS ",
          identity_key: " tel:+1 555 010 1010 ",
        },
        { authorization: "Bearer token-active" },
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      route_id: "87c8dd8f-1f92-45c4-a524-126cf59fd760",
      assistant_id: "8aa67431-9f28-40c0-98a5-e49d83bd15ab",
      provider: "twilio",
      route_type: "sms",
      identity_key: "+15550101010",
    });

    expect(capturedUrl).toBe("http://127.0.0.1:8000/v1/internal/managed-gateway/routes/resolve/");
    expect(capturedInit?.method).toBe("POST");
    expect(JSON.parse(capturedInit?.body as string)).toEqual({
      provider: "twilio",
      route_type: "sms",
      identity_key: "+15550101010",
    });

    const upstreamHeaders = capturedInit?.headers as Headers;
    expect(upstreamHeaders.get("authorization")).toBe("Bearer token-active");
    expect(upstreamHeaders.get("content-type")).toBe("application/json");
  });

  test("returns 400 validation envelope for invalid payload", async () => {
    const fetchMock: MockedFetch = mock(async () => {
      return new Response("unreachable", { status: 500 });
    });
    const handler = createManagedGatewayAppFetch(makeConfig(), {
      fetchImpl: (...args) => fetchMock(...args),
    });

    const response = await handler(
      makeResolveRequest(
        {
          provider: " ",
          route_type: "sms",
          identity_key: "+15550101011",
        },
        { authorization: "Bearer token-active" },
      ),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "validation_error",
        detail: "Invalid route resolve payload.",
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  test("returns 401 auth envelope when token is missing", async () => {
    const fetchMock: MockedFetch = mock(async () => {
      return new Response("unreachable", { status: 500 });
    });
    const handler = createManagedGatewayAppFetch(makeConfig(), {
      fetchImpl: (...args) => fetchMock(...args),
    });

    const response = await handler(
      makeResolveRequest({
        provider: "twilio",
        route_type: "sms",
        identity_key: "+15550101012",
      }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: {
        code: "missing_bearer",
        detail: "Missing managed gateway bearer token.",
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  test("returns 404 envelope when Django reports no route mapping", async () => {
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
    const handler = createManagedGatewayAppFetch(makeConfig(), {
      fetchImpl: (...args) => fetchMock(...args),
    });

    const response = await handler(
      makeResolveRequest(
        {
          provider: "twilio",
          route_type: "sms",
          identity_key: "+15550101013",
        },
        { authorization: "Bearer token-active" },
      ),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: {
        code: "managed_route_not_found",
        detail: "Managed route not found.",
      },
    });
  });

  test("returns 502 envelope when Django upstream is unavailable", async () => {
    const fetchMock: MockedFetch = mock(async () => {
      throw new Error("connection refused");
    });
    const handler = createManagedGatewayAppFetch(makeConfig(), {
      fetchImpl: (...args) => fetchMock(...args),
    });

    const response = await handler(
      makeResolveRequest(
        {
          provider: "twilio",
          route_type: "sms",
          identity_key: "+15550101014",
        },
        { authorization: "Bearer token-active" },
      ),
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: {
        code: "upstream_unavailable",
        detail: "Managed route resolver upstream is unavailable.",
      },
    });
  });

  test("keeps existing health endpoint behavior unchanged", async () => {
    const fetchMock: MockedFetch = mock(async () => {
      throw new Error("health endpoint should not call upstream");
    });
    const handler = createManagedGatewayAppFetch(makeConfig(), {
      fetchImpl: (...args) => fetchMock(...args),
    });

    const response = await handler(
      new Request("http://managed-gateway.test/v1/internal/managed-gateway/healthz/"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      service: "managed-gateway",
      mode: "skeleton",
      enabled: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });
});
