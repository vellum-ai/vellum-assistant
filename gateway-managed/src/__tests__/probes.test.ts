import { describe, expect, test } from "bun:test";

import { loadConfig } from "../config.js";
import { createManagedGatewayAppFetch } from "../http.js";

const BASE_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  MANAGED_GATEWAY_DJANGO_INTERNAL_BASE_URL: "http://127.0.0.1:8000",
  MANAGED_GATEWAY_INTERNAL_AUTH_MODE: "bearer",
  MANAGED_GATEWAY_INTERNAL_AUTH_AUDIENCE: "managed-gateway-internal",
  MANAGED_GATEWAY_INTERNAL_BEARER_TOKENS: JSON.stringify({
    "token-active": {
      token_id: "mgw-active",
      principal: "managed-gateway-staging",
      audience: "managed-gateway-internal",
      scopes: ["managed-gateway:internal", "routes:resolve"],
    },
  }),
  MANAGED_GATEWAY_TWILIO_AUTH_TOKENS: JSON.stringify({
    "twilio-current": {
      token_id: "twilio-2026-01",
      auth_token: "twilio-current-secret",
      expires_at: "2099-01-01T00:00:00.000Z",
    },
  }),
};

async function handleRequest(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Response> {
  const config = loadConfig({ ...BASE_ENV, ...env });
  const fetchHandler = createManagedGatewayAppFetch(config);
  return fetchHandler(new Request(url));
}

describe("managed-gateway probes", () => {
  test("health endpoints return ok payload", async () => {
    const res = await handleRequest(
      "http://managed-gateway.test/v1/internal/managed-gateway/healthz/",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "ok",
      service: "managed-gateway",
      mode: "skeleton",
      enabled: true,
    });
  });

  test("readiness endpoint returns ready by default", async () => {
    const res = await handleRequest(
      "http://managed-gateway.test/v1/internal/managed-gateway/readyz/",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "ready",
      service: "managed-gateway",
      mode: "skeleton",
      upstreamBaseUrl: "http://127.0.0.1:8000",
    });
  });

  test("readiness endpoint returns 503 when disabled", async () => {
    const res = await handleRequest(
      "http://managed-gateway.test/v1/internal/managed-gateway/readyz/",
      {
        ...process.env,
        MANAGED_GATEWAY_ENABLED: "false",
      },
    );

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      status: "not_ready",
      service: "managed-gateway",
      mode: "skeleton",
      reason: "managed_gateway_disabled",
    });
  });
});
