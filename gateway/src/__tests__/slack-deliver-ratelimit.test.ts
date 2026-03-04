import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { GatewayConfig } from "../config.js";

type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
let fetchMock: ReturnType<typeof mock<FetchFn>> = mock(
  async () => new Response(),
);

mock.module("../fetch.js", () => ({
  fetchImpl: (...args: Parameters<FetchFn>) => fetchMock(...args),
}));

const { createSlackDeliverHandler } =
  await import("../http/routes/slack-deliver.js");

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

function makeRequest(body: unknown): Request {
  return new Request("http://localhost:7830/deliver/slack", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

let fetchCallCount: number;

beforeEach(() => {
  fetchCallCount = 0;
});

describe("slack-deliver rate limit handling", () => {
  test("retries on HTTP 429 and succeeds", async () => {
    fetchMock = mock(async () => {
      fetchCallCount++;
      if (fetchCallCount === 1) {
        return new Response("", {
          status: 429,
          headers: { "Retry-After": "0" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const handler = createSlackDeliverHandler(makeConfig());
    const res = await handler(makeRequest({ chatId: "C123", text: "hello" }));
    expect(res.status).toBe(200);
    expect(fetchCallCount).toBe(2);
  });

  test("returns 429 after exhausting rate limit retries", async () => {
    fetchMock = mock(async () => {
      fetchCallCount++;
      return new Response("", {
        status: 429,
        headers: { "Retry-After": "0" },
      });
    });

    const handler = createSlackDeliverHandler(makeConfig());
    const res = await handler(makeRequest({ chatId: "C123", text: "hello" }));
    expect(res.status).toBe(429);
    // 1 initial + 3 retries = 4 total
    expect(fetchCallCount).toBe(4);
  });

  test("retries on rate_limited error in response body", async () => {
    fetchMock = mock(async () => {
      fetchCallCount++;
      if (fetchCallCount === 1) {
        return new Response(
          JSON.stringify({ ok: false, error: "rate_limited" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const handler = createSlackDeliverHandler(makeConfig());
    const res = await handler(makeRequest({ chatId: "C123", text: "hello" }));
    expect(res.status).toBe(200);
    expect(fetchCallCount).toBe(2);
  });

  test("returns 429 after exhausting body-level rate limit retries", async () => {
    fetchMock = mock(async () => {
      fetchCallCount++;
      return new Response(
        JSON.stringify({ ok: false, error: "rate_limited" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const handler = createSlackDeliverHandler(makeConfig());
    const res = await handler(makeRequest({ chatId: "C123", text: "hello" }));
    expect(res.status).toBe(429);
    // 1 initial + 3 retries = 4 total
    expect(fetchCallCount).toBe(4);
  });

  test("returns 502 for auth errors (retryable for transient token issues)", async () => {
    fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({ ok: false, error: "invalid_auth" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const handler = createSlackDeliverHandler(makeConfig());
    const res = await handler(makeRequest({ chatId: "C123", text: "hello" }));
    expect(res.status).toBe(502);
  });

  test("returns 404 for channel_not_found errors", async () => {
    fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({ ok: false, error: "channel_not_found" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const handler = createSlackDeliverHandler(makeConfig());
    const res = await handler(makeRequest({ chatId: "C123", text: "hello" }));
    expect(res.status).toBe(404);
  });

  test("returns 403 for permission errors", async () => {
    fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({ ok: false, error: "not_in_channel" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const handler = createSlackDeliverHandler(makeConfig());
    const res = await handler(makeRequest({ chatId: "C123", text: "hello" }));
    expect(res.status).toBe(403);
  });
});
