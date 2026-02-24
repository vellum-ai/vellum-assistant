import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import type { GatewayConfig } from "../config.js";

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
let fetchMock: ReturnType<typeof mock<FetchFn>> = mock(async () => new Response());

mock.module("../fetch.js", () => ({
  fetchImpl: (...args: Parameters<FetchFn>) => fetchMock(...args),
}));

const { createTelegramReconcileHandler } = await import("../http/routes/telegram-reconcile.js");

function makeTelegramResponse(result: unknown) {
  return new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  const merged: GatewayConfig = {
    assistantRuntimeBaseUrl: "http://localhost:7821",
    defaultAssistantId: undefined,
    gatewayInternalBaseUrl: "http://127.0.0.1:7830",
    logFile: { dir: undefined, retentionDays: 30 },
    maxAttachmentBytes: 20 * 1024 * 1024,
    maxAttachmentConcurrency: 3,
    maxWebhookPayloadBytes: 1024 * 1024,
    port: 7830,
    routingEntries: [],
    runtimeBearerToken: undefined,
    runtimeGatewayOriginSecret: undefined,
    runtimeInitialBackoffMs: 500,
    runtimeMaxRetries: 2,
    runtimeProxyBearerToken: "test-token",
    runtimeProxyEnabled: false,
    runtimeProxyRequireAuth: true,
    runtimeTimeoutMs: 30000,
    shutdownDrainMs: 5000,
    telegramApiBaseUrl: "https://api.telegram.org",
    telegramBotToken: "bot-token",
    telegramDeliverAuthBypass: false,
    telegramInitialBackoffMs: 1000,
    telegramMaxRetries: 0,
    telegramTimeoutMs: 15000,
    telegramWebhookSecret: "webhook-secret",
    twilioAuthToken: undefined,
    twilioAccountSid: undefined,
    twilioPhoneNumber: undefined,
    smsDeliverAuthBypass: false,
    ingressPublicBaseUrl: "https://example.com",
    unmappedPolicy: "reject",
    ...overrides,
  };
  if (merged.runtimeGatewayOriginSecret === undefined) {
    merged.runtimeGatewayOriginSecret = merged.runtimeBearerToken;
  }
  return merged;
}

function makeRequest(
  method: string,
  token?: string,
  body?: Record<string, unknown>,
): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (token) {
    headers["authorization"] = `Bearer ${token}`;
  }
  return new Request("http://localhost:7830/internal/telegram/reconcile", {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

/** Default fetch mock that handles Telegram API calls with success responses. */
function installDefaultFetchMock() {
  fetchMock = mock(async (input: string | URL | Request) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (url.includes("/getWebhookInfo")) {
      return makeTelegramResponse({
        url: "",
        has_custom_certificate: false,
        pending_update_count: 0,
      });
    }
    if (url.includes("/setWebhook")) {
      return makeTelegramResponse(true);
    }
    return new Response("Not found", { status: 404 });
  });
}

describe("POST /internal/telegram/reconcile", () => {
  beforeEach(() => {
    installDefaultFetchMock();
  });

  afterEach(() => {
    fetchMock = mock(async () => new Response());
  });

  test("rejects non-POST methods", async () => {
    const config = makeConfig();
    const handler = createTelegramReconcileHandler(config);
    const res = await handler(
      new Request("http://localhost:7830/internal/telegram/reconcile", {
        method: "GET",
      }),
    );
    expect(res.status).toBe(405);
  });

  test("returns 503 when no bearer token is configured", async () => {
    const config = makeConfig({ runtimeProxyBearerToken: undefined });
    const handler = createTelegramReconcileHandler(config);
    const res = await handler(makeRequest("POST", "any-token"));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toContain("bearer token required");
  });

  test("returns 401 for missing auth header", async () => {
    const config = makeConfig();
    const handler = createTelegramReconcileHandler(config);
    const res = await handler(makeRequest("POST"));
    expect(res.status).toBe(401);
  });

  test("returns 401 for wrong token", async () => {
    const config = makeConfig();
    const handler = createTelegramReconcileHandler(config);
    const res = await handler(makeRequest("POST", "wrong-token"));
    expect(res.status).toBe(401);
  });

  test("triggers reconcile with correct auth", async () => {
    const config = makeConfig();
    const handler = createTelegramReconcileHandler(config);
    const res = await handler(makeRequest("POST", "test-token"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    // Fetch was called (getWebhookInfo + setWebhook) proving reconcile ran.
    expect(fetchMock).toHaveBeenCalled();
  });

  test("updates ingressPublicBaseUrl when provided", async () => {
    const config = makeConfig({ ingressPublicBaseUrl: "https://old.example.com" });
    const handler = createTelegramReconcileHandler(config);
    const res = await handler(
      makeRequest("POST", "test-token", {
        ingressPublicBaseUrl: "https://new.example.com/",
      }),
    );
    expect(res.status).toBe(200);
    // Trailing slash should be normalized
    expect(config.ingressPublicBaseUrl).toBe("https://new.example.com");
  });

  test("clears ingressPublicBaseUrl when empty string is provided", async () => {
    const config = makeConfig({ ingressPublicBaseUrl: "https://old.example.com" });
    const handler = createTelegramReconcileHandler(config);
    const res = await handler(
      makeRequest("POST", "test-token", {
        ingressPublicBaseUrl: "",
      }),
    );
    expect(res.status).toBe(200);
    expect(config.ingressPublicBaseUrl).toBeUndefined();
  });

  test("works with empty body (no URL update)", async () => {
    const config = makeConfig();
    const handler = createTelegramReconcileHandler(config);
    const req = new Request("http://localhost:7830/internal/telegram/reconcile", {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
      },
    });
    const res = await handler(req);
    expect(res.status).toBe(200);
    expect(config.ingressPublicBaseUrl).toBe("https://example.com");
  });

  test("returns 502 when reconcile throws", async () => {
    fetchMock = mock(async () => {
      throw new Error("Telegram API error");
    });
    const config = makeConfig();
    const handler = createTelegramReconcileHandler(config);
    const res = await handler(makeRequest("POST", "test-token"));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("Reconciliation failed");
  });

  test("returns 400 for invalid JSON body", async () => {
    const config = makeConfig();
    const handler = createTelegramReconcileHandler(config);
    const req = new Request("http://localhost:7830/internal/telegram/reconcile", {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: "not-json{",
    });
    const res = await handler(req);
    expect(res.status).toBe(400);
  });

  test("serializes concurrent requests so the last URL wins", async () => {
    const setWebhookUrls: string[] = [];

    // Make reconcile slow enough that the first call is still in-flight
    // when the second one arrives.
    fetchMock = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        if (url.includes("/getWebhookInfo")) {
          return makeTelegramResponse({
            url: "",
            has_custom_certificate: false,
            pending_update_count: 0,
          });
        }
        if (url.includes("/setWebhook")) {
          const body = init?.body ? JSON.parse(init.body as string) : {};
          setWebhookUrls.push(body.url);
          await new Promise((r) => setTimeout(r, 50));
          return makeTelegramResponse(true);
        }
        return new Response("Not found", { status: 404 });
      },
    );

    const config = makeConfig({ ingressPublicBaseUrl: "https://original.com" });
    const handler = createTelegramReconcileHandler(config);

    // Fire two requests concurrently — without serialization the second
    // would mutate config.ingressPublicBaseUrl while the first reconcile
    // is still running, leaving Telegram pointed at the first URL.
    const [res1, res2] = await Promise.all([
      handler(
        makeRequest("POST", "test-token", {
          ingressPublicBaseUrl: "https://first.com",
        }),
      ),
      handler(
        makeRequest("POST", "test-token", {
          ingressPublicBaseUrl: "https://second.com",
        }),
      ),
    ]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    // The first reconcile should register with "first" and the second with
    // "second" — proving that config mutation + reconcile are atomic.
    expect(setWebhookUrls).toEqual([
      "https://first.com/webhooks/telegram",
      "https://second.com/webhooks/telegram",
    ]);
    // After both complete, the config should reflect the last write.
    expect(config.ingressPublicBaseUrl).toBe("https://second.com");
  });
});
