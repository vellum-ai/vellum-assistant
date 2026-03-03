import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { GatewayConfig } from "../config.js";

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
let fetchMock: ReturnType<typeof mock<FetchFn>> = mock(async () => new Response());

mock.module("../fetch.js", () => ({
  fetchImpl: (...args: Parameters<FetchFn>) => fetchMock(...args),
}));

const { createSlackDeliverHandler } = await import("../http/routes/slack-deliver.js");

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  const merged: GatewayConfig = {
    assistantRuntimeBaseUrl: "http://localhost:7821",
    defaultAssistantId: undefined,
    gatewayInternalBaseUrl: "http://127.0.0.1:7830",
    logFile: { dir: undefined, retentionDays: 30 },
    maxAttachmentBytes: 20971520,
    maxAttachmentConcurrency: 3,
    maxWebhookPayloadBytes: 1048576,
    port: 7830,
    routingEntries: [],
    runtimeInitialBackoffMs: 500,
    runtimeMaxRetries: 2,
    runtimeProxyEnabled: false,
    runtimeProxyRequireAuth: false,
    runtimeTimeoutMs: 30000,
    shutdownDrainMs: 5000,
    telegramApiBaseUrl: "https://api.telegram.org",
    telegramBotToken: undefined,
    telegramDeliverAuthBypass: false,
    telegramInitialBackoffMs: 1000,
    telegramMaxRetries: 3,
    telegramTimeoutMs: 15000,
    telegramWebhookSecret: undefined,
    twilioAuthToken: undefined,
    twilioAccountSid: undefined,
    twilioPhoneNumber: undefined,
    smsDeliverAuthBypass: false,
    ingressPublicBaseUrl: undefined,
    unmappedPolicy: "reject",
    whatsappPhoneNumberId: undefined,
    whatsappAccessToken: undefined,
    whatsappAppSecret: undefined,
    whatsappWebhookVerifyToken: undefined,
    whatsappDeliverAuthBypass: false,
    whatsappTimeoutMs: 15000,
    whatsappMaxRetries: 3,
    whatsappInitialBackoffMs: 1000,
    slackChannelBotToken: "xoxb-test-bot-token",
    slackChannelAppToken: undefined,
    slackDeliverAuthBypass: true,
    trustProxy: false,
    ...overrides,
  } as GatewayConfig;
  return merged;
}

function makeRequest(
  body: unknown,
  headers?: Record<string, string>,
  queryString = "",
): Request {
  return new Request(`http://localhost:7830/deliver/slack${queryString}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

let fetchCalls: { url: string; body?: unknown; headers?: Record<string, string> }[];

beforeEach(() => {
  fetchCalls = [];
  fetchMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    let body: unknown;
    try {
      if (init?.body) body = JSON.parse(String(init.body));
    } catch { /* not JSON */ }
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers;
      if (h && typeof h === "object" && !Array.isArray(h)) {
        for (const [k, v] of Object.entries(h)) {
          headers[k.toLowerCase()] = v;
        }
      }
    }
    fetchCalls.push({ url, body, headers });

    // Slack API response
    if (url.includes("slack.com/api/chat.postMessage")) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("Not found", { status: 404 });
  });
});

describe("slack-deliver endpoint", () => {
  test("returns 401 when auth is required and missing", async () => {
    const handler = createSlackDeliverHandler(
      makeConfig({ slackDeliverAuthBypass: false }),
    );
    const req = makeRequest({ chatId: "C123", text: "hello" });
    const res = await handler(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  test("returns 200 with valid payload containing chatId and text", async () => {
    const handler = createSlackDeliverHandler(makeConfig());
    const req = makeRequest({ chatId: "C123", text: "hello" });
    const res = await handler(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // Verify the Slack API was called with the correct payload
    const slackCall = fetchCalls.find((c) => c.url.includes("chat.postMessage"));
    expect(slackCall).toBeDefined();
    expect((slackCall!.body as any).channel).toBe("C123");
    expect((slackCall!.body as any).text).toBe("hello");
  });

  test("threadTs query param gets passed as thread_ts to Slack API", async () => {
    const handler = createSlackDeliverHandler(makeConfig());
    const req = makeRequest(
      { chatId: "C123", text: "reply in thread" },
      undefined,
      "?threadTs=1700000000.000050",
    );
    const res = await handler(req);
    expect(res.status).toBe(200);

    const slackCall = fetchCalls.find((c) => c.url.includes("chat.postMessage"));
    expect(slackCall).toBeDefined();
    expect((slackCall!.body as any).thread_ts).toBe("1700000000.000050");
  });

  test("returns 400 when chatId/to is missing", async () => {
    const handler = createSlackDeliverHandler(makeConfig());
    const req = makeRequest({ text: "hello" });
    const res = await handler(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("chatId is required");
  });

  test("returns 400 with 'not supported' message when attachments are provided", async () => {
    const handler = createSlackDeliverHandler(makeConfig());
    const req = makeRequest({ chatId: "C123", text: "hello", attachments: [{ id: "att-1" }] });
    const res = await handler(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("not supported");
  });

  test("returns 503 when bot token is not configured", async () => {
    const handler = createSlackDeliverHandler(
      makeConfig({ slackChannelBotToken: undefined }),
    );
    const req = makeRequest({ chatId: "C123", text: "hello" });
    const res = await handler(req);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toContain("not configured");
  });

  test("accepts 'to' as alias for chatId", async () => {
    const handler = createSlackDeliverHandler(makeConfig());
    const req = makeRequest({ to: "C_TO_CHAN", text: "hello" });
    const res = await handler(req);
    expect(res.status).toBe(200);

    const slackCall = fetchCalls.find((c) => c.url.includes("chat.postMessage"));
    expect(slackCall).toBeDefined();
    expect((slackCall!.body as any).channel).toBe("C_TO_CHAN");
  });

  test("returns 400 when text is missing", async () => {
    const handler = createSlackDeliverHandler(makeConfig());
    const req = makeRequest({ chatId: "C123" });
    const res = await handler(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("text is required");
  });

  test("returns 400 for invalid JSON", async () => {
    const handler = createSlackDeliverHandler(makeConfig());
    const req = new Request("http://localhost:7830/deliver/slack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    const res = await handler(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid JSON");
  });

  test("returns 405 for GET requests", async () => {
    const handler = createSlackDeliverHandler(makeConfig());
    const req = new Request("http://localhost:7830/deliver/slack", {
      method: "GET",
    });
    const res = await handler(req);
    expect(res.status).toBe(405);
  });

  test("sends Authorization header with bot token to Slack API", async () => {
    const handler = createSlackDeliverHandler(
      makeConfig({ slackChannelBotToken: "xoxb-my-secret-token" }),
    );
    const req = makeRequest({ chatId: "C123", text: "hello" });
    await handler(req);

    const slackCall = fetchCalls.find((c) => c.url.includes("chat.postMessage"));
    expect(slackCall).toBeDefined();
    expect(slackCall!.headers!["authorization"]).toBe("Bearer xoxb-my-secret-token");
  });

  test("returns 502 when Slack API returns ok: false", async () => {
    fetchMock = mock(async () => {
      return new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const handler = createSlackDeliverHandler(makeConfig());
    const req = makeRequest({ chatId: "C123", text: "hello" });
    const res = await handler(req);
    expect(res.status).toBe(502);
  });

  test("does not include thread_ts when threadTs query param is absent", async () => {
    const handler = createSlackDeliverHandler(makeConfig());
    const req = makeRequest({ chatId: "C123", text: "hello" });
    await handler(req);

    const slackCall = fetchCalls.find((c) => c.url.includes("chat.postMessage"));
    expect(slackCall).toBeDefined();
    expect((slackCall!.body as any).thread_ts).toBeUndefined();
  });
});
