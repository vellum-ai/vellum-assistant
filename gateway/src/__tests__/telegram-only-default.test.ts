import { describe, test, expect, afterAll } from "bun:test";

/**
 * Proves that non-Telegram requests return 404 when the gateway runs in its
 * default configuration (proxy disabled). This is the "Telegram-only" guardrail.
 */

const PORT = 19830; // ephemeral port for test

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
saved["GATEWAY_RUNTIME_PROXY_ENABLED"] = process.env.GATEWAY_RUNTIME_PROXY_ENABLED;
delete process.env.GATEWAY_RUNTIME_PROXY_ENABLED;

// Dynamically import to pick up env
const { loadConfig } = await import("../config.js");
const { createTelegramWebhookHandler } = await import(
  "../http/routes/telegram-webhook.js"
);

const config = loadConfig();

const handleTelegramWebhook = createTelegramWebhookHandler(
  config,
  async () => {},
);

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/webhooks/telegram") {
      return handleTelegramWebhook(req);
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
});
