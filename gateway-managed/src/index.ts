process.title = "vellum-managed-gateway";

import { loadConfig } from "./config.js";

const config = loadConfig();

function healthPayload() {
  return {
    status: "ok",
    service: config.serviceName,
    mode: config.mode,
    enabled: config.enabled,
  };
}

function readinessResponse(): Response {
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

function routeRequest(pathname: string): Response {
  if (
    pathname === "/healthz"
    || pathname === "/v1/internal/managed-gateway/healthz/"
  ) {
    return Response.json(healthPayload());
  }

  if (
    pathname === "/readyz"
    || pathname === "/v1/internal/managed-gateway/readyz/"
  ) {
    return readinessResponse();
  }

  return Response.json({ error: "Not found" }, { status: 404 });
}

const server = Bun.serve({
  port: config.port,
  async fetch(req) {
    const url = new URL(req.url);
    return routeRequest(url.pathname);
  },
});

console.log(`Managed gateway listening on port ${config.port}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.stop(true);
    process.exit(0);
  });
}
