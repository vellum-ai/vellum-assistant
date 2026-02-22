import { describe, test, expect, mock, afterEach, beforeEach } from "bun:test";
import type { GatewayConfig } from "../config.js";
import { createTelegramWebhookHandler } from "../http/routes/telegram-webhook.js";

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    telegramBotToken: "test-bot-token",
    telegramWebhookSecret: "test-webhook-secret",
    telegramApiBaseUrl: "https://api.telegram.org",
    assistantRuntimeBaseUrl: "http://localhost:7821",
    routingEntries: [],
    defaultAssistantId: undefined,
    unmappedPolicy: "reject",
    port: 7830,
    runtimeBearerToken: undefined,
    runtimeProxyEnabled: false,
    runtimeProxyRequireAuth: false,
    runtimeProxyBearerToken: undefined,
    shutdownDrainMs: 5000,
    runtimeTimeoutMs: 30000,
    runtimeMaxRetries: 2,
    runtimeInitialBackoffMs: 500,
    telegramDeliverAuthBypass: false,
    telegramInitialBackoffMs: 1000,
    telegramMaxRetries: 0,
    telegramTimeoutMs: 15000,
    maxWebhookPayloadBytes: 1048576,
    logFile: { dir: undefined, retentionDays: 30 },
    maxAttachmentBytes: 20971520,
    maxAttachmentConcurrency: 3,
    twilioAuthToken: undefined,
    ingressPublicBaseUrl: undefined,
    gatewayInternalBaseUrl: "http://127.0.0.1:7830",
    ...overrides,
  };
}

function makeTelegramPayload(text: string, updateId = 1001) {
  return {
    update_id: updateId,
    message: {
      message_id: 42,
      text,
      chat: { id: 12345, type: "private" },
      from: { id: 67890, is_bot: false, username: "testuser", first_name: "Test" },
    },
  };
}

function makeWebhookRequest(payload: unknown, secret = "test-webhook-secret"): Request {
  return new Request("http://localhost:7830/webhooks/telegram", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": secret,
    },
    body: JSON.stringify(payload),
  });
}

const originalFetch = globalThis.fetch;
let fetchCalls: { url: string; method: string; body?: unknown }[];

beforeEach(() => {
  fetchCalls = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/**
 * Install a mock fetch that records calls and returns a 200 JSON response.
 * Runtime forward calls get an eventId response; Telegram API calls get { ok: true }.
 */
function installFetchMock() {
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET");
    let body: unknown;
    try {
      if (init?.body) {
        body = JSON.parse(String(init.body));
      } else if (typeof input === "object" && "json" in input) {
        body = await (input as Request).clone().json();
      }
    } catch { /* not JSON */ }
    fetchCalls.push({ url, method, body });

    // Runtime inbound endpoint
    if (url.includes("/v1/assistants/") && url.includes("/inbound")) {
      return new Response(JSON.stringify({ eventId: "evt-1", duplicate: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    // Runtime reset conversation endpoint
    if (url.includes("/channels/conversation") && method === "DELETE") {
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }

    // Telegram API calls (sendMessage, etc.)
    if (url.includes("api.telegram.org")) {
      return new Response(JSON.stringify({ ok: true, result: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404 });
  }) as any;
}

describe("telegram webhook handler: gatewayInternalBaseUrl", () => {
  test("uses configured gatewayInternalBaseUrl in replyCallbackUrl", async () => {
    const config = makeConfig({
      gatewayInternalBaseUrl: "http://gateway.internal:9000",
      routingEntries: [{ type: "chat_id", key: "12345", assistantId: "assistant-a" }],
    });
    installFetchMock();
    const handler = createTelegramWebhookHandler(config);

    const payload = makeTelegramPayload("hello");
    const req = makeWebhookRequest(payload);
    const res = await handler(req);

    expect(res.status).toBe(200);

    // Find the runtime forward call and verify the replyCallbackUrl
    const runtimeCall = fetchCalls.find((c) => c.url.includes("/inbound"));
    expect(runtimeCall).toBeDefined();
    expect((runtimeCall!.body as any).replyCallbackUrl).toBe(
      "http://gateway.internal:9000/deliver/telegram",
    );
  });

  test("falls back to localhost URL when gatewayInternalBaseUrl uses default", async () => {
    const config = makeConfig({
      gatewayInternalBaseUrl: "http://127.0.0.1:7830",
      routingEntries: [{ type: "chat_id", key: "12345", assistantId: "assistant-a" }],
    });
    installFetchMock();
    const handler = createTelegramWebhookHandler(config);

    const payload = makeTelegramPayload("hello", 2001);
    const req = makeWebhookRequest(payload);
    const res = await handler(req);

    expect(res.status).toBe(200);

    const runtimeCall = fetchCalls.find((c) => c.url.includes("/inbound"));
    expect(runtimeCall).toBeDefined();
    expect((runtimeCall!.body as any).replyCallbackUrl).toBe(
      "http://127.0.0.1:7830/deliver/telegram",
    );
  });
});

describe("telegram webhook handler: /new rejection", () => {
  test("sends rejection notice when /new command routing is rejected", async () => {
    // No routing entries and unmappedPolicy is "reject" — routing will fail
    const config = makeConfig({ unmappedPolicy: "reject" });
    installFetchMock();
    const handler = createTelegramWebhookHandler(config);

    const payload = makeTelegramPayload("/new", 3001);
    const req = makeWebhookRequest(payload);
    const res = await handler(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // Verify a Telegram sendMessage call was made with the rejection notice
    const telegramCalls = fetchCalls.filter((c) => c.url.includes("api.telegram.org"));
    expect(telegramCalls.length).toBeGreaterThanOrEqual(1);

    const sendCall = telegramCalls.find((c) => c.url.includes("/sendMessage"));
    expect(sendCall).toBeDefined();
    expect((sendCall!.body as any).text).toContain("could not be routed");
  });

  test("/new succeeds and sends confirmation when routing matches", async () => {
    const config = makeConfig({
      routingEntries: [{ type: "chat_id", key: "12345", assistantId: "assistant-a" }],
    });
    installFetchMock();
    const handler = createTelegramWebhookHandler(config);

    const payload = makeTelegramPayload("/new", 4001);
    const req = makeWebhookRequest(payload);
    const res = await handler(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // Verify the reset conversation call was made
    const resetCall = fetchCalls.find((c) => c.url.includes("/channels/conversation"));
    expect(resetCall).toBeDefined();
    expect(resetCall!.method).toBe("DELETE");

    // Verify the confirmation message was sent
    const telegramCalls = fetchCalls.filter((c) => c.url.includes("api.telegram.org"));
    expect(telegramCalls.length).toBeGreaterThanOrEqual(1);
    const confirmCall = telegramCalls.find((c) => {
      return c.url.includes("/sendMessage") && (c.body as any)?.text?.includes("new conversation");
    });
    expect(confirmCall).toBeDefined();
  });

  test("/new rejection does not call resetConversation", async () => {
    const config = makeConfig({ unmappedPolicy: "reject" });
    installFetchMock();
    const handler = createTelegramWebhookHandler(config);

    const payload = makeTelegramPayload("/new", 5001);
    const req = makeWebhookRequest(payload);
    await handler(req);

    // Verify no reset conversation call was made
    const resetCall = fetchCalls.find((c) => c.url.includes("/channels/conversation"));
    expect(resetCall).toBeUndefined();
  });
});
