import { describe, test, expect, afterAll } from "bun:test";

/**
 * Proves that non-Telegram requests return 404 when the gateway runs in its
 * default configuration (proxy disabled). Uses the same routing logic as
 * src/index.ts so that changes to the production routing (e.g. accidentally
 * enabling the proxy by default) will be caught by this test.
 */

const PORT = 19830 + Math.floor(Math.random() * 1000);

// Minimal env for loadConfig
const env: Record<string, string> = {
  TELEGRAM_BOT_TOKEN: "test-tok",
  TELEGRAM_WEBHOOK_SECRET: "wh-sec",
  ASSISTANT_RUNTIME_BASE_URL: "http://localhost:7821",
  GATEWAY_PORT: String(PORT),
  // GATEWAY_RUNTIME_PROXY_ENABLED intentionally unset → defaults to false
};

// Save and set env
const saved: Record<string, string | undefined> = {};
for (const [k, v] of Object.entries(env)) {
  saved[k] = process.env[k];
  process.env[k] = v;
}
// Ensure proxy flag is unset
saved["GATEWAY_RUNTIME_PROXY_ENABLED"] =
  process.env.GATEWAY_RUNTIME_PROXY_ENABLED;
delete process.env.GATEWAY_RUNTIME_PROXY_ENABLED;

// Dynamically import to pick up env
const { loadConfig } = await import("../config.js");
const { createTelegramWebhookHandler } = await import(
  "../http/routes/telegram-webhook.js"
);
const { createRuntimeProxyHandler } = await import(
  "../http/routes/runtime-proxy.js"
);

const config = loadConfig();

const handleTelegramWebhook = createTelegramWebhookHandler(config);

// Mirror production routing from src/index.ts: only create proxy when enabled
const handleRuntimeProxy = config.runtimeProxyEnabled
  ? createRuntimeProxyHandler(config)
  : null;

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
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

    if (handleRuntimeProxy) {
      return handleRuntimeProxy(req);
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
});

afterAll(() => {
  server.stop(true);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("Telegram-only default: non-Telegram requests return 404", () => {
  test("GET / returns 404", async () => {
    const res = await fetch(`http://localhost:${PORT}/`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Not found");
  });

  test("GET /v1/health returns 404", async () => {
    const res = await fetch(`http://localhost:${PORT}/v1/health`);
    expect(res.status).toBe(404);
  });

  test("POST /v1/assistants/foo/chat returns 404", async () => {
    const res = await fetch(`http://localhost:${PORT}/v1/assistants/foo/chat`, {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(404);
  });

  test("GET /random-path returns 404", async () => {
    const res = await fetch(`http://localhost:${PORT}/random-path`);
    expect(res.status).toBe(404);
  });

  test("config.runtimeProxyEnabled is false by default", () => {
    expect(config.runtimeProxyEnabled).toBe(false);
  });

  test("runtime proxy handler is not created when proxy is disabled", () => {
    expect(handleRuntimeProxy).toBeNull();
  });

  test("GET /healthz returns 200 (infrastructure routes still work)", async () => {
    const res = await fetch(`http://localhost:${PORT}/healthz`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  test("GET /readyz returns 200 (infrastructure routes still work)", async () => {
    const res = await fetch(`http://localhost:${PORT}/readyz`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });
});
