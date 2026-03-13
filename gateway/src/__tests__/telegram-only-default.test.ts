import { describe, test, expect, afterAll } from "bun:test";

/**
 * Proves that runtime proxy passthrough routes stay disabled by default while
 * dedicated gateway routes still work. Uses the same routing logic as
 * src/index.ts so that changes to production defaults are caught here.
 */

// Minimal env for loadConfig
const env: Record<string, string> = {
  TELEGRAM_BOT_TOKEN: "test-tok",
  TELEGRAM_WEBHOOK_SECRET: "wh-sec",
  GATEWAY_PORT: "7830",
};

// Save and set env
const saved: Record<string, string | undefined> = {};
for (const [k, v] of Object.entries(env)) {
  saved[k] = process.env[k];
  process.env[k] = v;
}

// Dynamically import to pick up env
const { loadConfig } = await import("../config.js");
const { createTelegramWebhookHandler } =
  await import("../http/routes/telegram-webhook.js");
const { createRuntimeProxyHandler } =
  await import("../http/routes/runtime-proxy.js");
const { createRuntimeHealthProxyHandler } =
  await import("../http/routes/runtime-health-proxy.js");

const config = await loadConfig();

const { handler: handleTelegramWebhook } = createTelegramWebhookHandler(config);
const runtimeHealthProxy = createRuntimeHealthProxyHandler(config);

// Mirror production routing from src/index.ts: only create proxy when enabled
const handleRuntimeProxy = config.runtimeProxyEnabled
  ? createRuntimeProxyHandler(config)
  : null;

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/healthz") {
    return Response.json({ status: "ok" });
  }

  if (url.pathname === "/readyz") {
    return Response.json({ status: "ok" });
  }

  if (url.pathname === "/webhooks/telegram") {
    return handleTelegramWebhook(req);
  }

  if (url.pathname === "/v1/health" && req.method === "GET") {
    const authHeader = req.headers.get("authorization");
    if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    return runtimeHealthProxy.handleRuntimeHealth(req);
  }

  if (handleRuntimeProxy) {
    return handleRuntimeProxy(req);
  }

  return Response.json({ error: "Not found" }, { status: 404 });
}

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("Telegram-only default: runtime proxy is disabled by default", () => {
  test("GET / returns 404", async () => {
    const res = await handleRequest(new Request("http://gateway.test/"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Not found");
  });

  test("GET /v1/health returns 401 without bearer auth", async () => {
    const res = await handleRequest(
      new Request("http://gateway.test/v1/health"),
    );
    expect(res.status).toBe(401);
  });

  test("POST /v1/assistants/foo/chat returns 404", async () => {
    const res = await handleRequest(
      new Request("http://gateway.test/v1/assistants/foo/chat", {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(404);
  });

  test("GET /random-path returns 404", async () => {
    const res = await handleRequest(
      new Request("http://gateway.test/random-path"),
    );
    expect(res.status).toBe(404);
  });

  test("config.runtimeProxyEnabled is false by default", () => {
    expect(config.runtimeProxyEnabled).toBe(false);
  });

  test("runtime proxy handler is not created when proxy is disabled", () => {
    expect(handleRuntimeProxy).toBeNull();
  });

  test("GET /healthz returns 200 (infrastructure routes still work)", async () => {
    const res = await handleRequest(new Request("http://gateway.test/healthz"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  test("GET /readyz returns 200 (infrastructure routes still work)", async () => {
    const res = await handleRequest(new Request("http://gateway.test/readyz"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });
});
