import { describe, expect, test } from "bun:test";

import { loadConfig } from "../config.js";

function handleRequest(url: string, env: NodeJS.ProcessEnv = process.env): Response {
  const config = loadConfig(env);
  const pathname = new URL(url).pathname;

  if (pathname === "/healthz" || pathname === "/v1/internal/managed-gateway/healthz/") {
    return Response.json({
      status: "ok",
      service: config.serviceName,
      mode: config.mode,
      enabled: config.enabled,
    });
  }

  if (pathname === "/readyz" || pathname === "/v1/internal/managed-gateway/readyz/") {
    if (!config.enabled) {
      return Response.json(
        {
          status: "not_ready",
          service: config.serviceName,
          mode: config.mode,
          reason: "managed_gateway_disabled",
        },
        { status: 503 },
      );
    }

    return Response.json({
      status: "ready",
      service: config.serviceName,
      mode: config.mode,
    });
  }

  return Response.json({ error: "Not found" }, { status: 404 });
}

describe("managed-gateway probes", () => {
  test("health endpoints return ok payload", async () => {
    const res = handleRequest("http://managed-gateway.test/v1/internal/managed-gateway/healthz/");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "ok",
      service: "managed-gateway",
      mode: "skeleton",
      enabled: true,
    });
  });

  test("readiness endpoint returns ready by default", async () => {
    const res = handleRequest("http://managed-gateway.test/v1/internal/managed-gateway/readyz/");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "ready",
      service: "managed-gateway",
      mode: "skeleton",
    });
  });

  test("readiness endpoint returns 503 when disabled", async () => {
    const res = handleRequest(
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
