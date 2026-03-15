import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { GatewayConfig } from "../config.js";
import type { CredentialCache } from "../credential-cache.js";
import { credentialKey } from "../credential-key.js";
import { initSigningKey, mintToken } from "../auth/token-service.js";
import { CURRENT_POLICY_EPOCH } from "../auth/policy.js";

const TEST_SIGNING_KEY = Buffer.from("test-signing-key-at-least-32-bytes-long");
initSigningKey(TEST_SIGNING_KEY);

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
    maxAttachmentBytes: {
      telegram: 50 * 1024 * 1024,
      slack: 100 * 1024 * 1024,
      whatsapp: 16 * 1024 * 1024,
      default: 50 * 1024 * 1024,
    },
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
    unmappedPolicy: "reject",
    trustProxy: false,
    ...overrides,
  } as GatewayConfig;
  return merged;
}

const TOKEN = mintToken({
  aud: "vellum-daemon",
  sub: "svc:gateway:self",
  scope_profile: "gateway_service_v1",
  policy_epoch: CURRENT_POLICY_EPOCH,
  ttlSeconds: 300,
});

function makeRequest(body: unknown): Request {
  return new Request("http://localhost:7830/deliver/slack", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify(body),
  });
}

/** Create a mock CredentialCache that returns a bot token. */
function makeCaches() {
  const credentials = {
    get: async (key: string) => {
      if (key === credentialKey("slack_channel", "bot_token"))
        return "xoxb-test-bot-token";
      return undefined;
    },
    invalidate: () => {},
  } as unknown as CredentialCache;
  return { credentials };
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

    const handler = createSlackDeliverHandler(
      makeConfig(),
      undefined,
      makeCaches(),
    );
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

    const handler = createSlackDeliverHandler(
      makeConfig(),
      undefined,
      makeCaches(),
    );
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

    const handler = createSlackDeliverHandler(
      makeConfig(),
      undefined,
      makeCaches(),
    );
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

    const handler = createSlackDeliverHandler(
      makeConfig(),
      undefined,
      makeCaches(),
    );
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

    const handler = createSlackDeliverHandler(
      makeConfig(),
      undefined,
      makeCaches(),
    );
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

    const handler = createSlackDeliverHandler(
      makeConfig(),
      undefined,
      makeCaches(),
    );
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

    const handler = createSlackDeliverHandler(
      makeConfig(),
      undefined,
      makeCaches(),
    );
    const res = await handler(makeRequest({ chatId: "C123", text: "hello" }));
    expect(res.status).toBe(403);
  });
});
