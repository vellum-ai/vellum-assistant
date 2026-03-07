import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import type { GatewayConfig } from "../config.js";
import type { CredentialCache } from "../credential-cache.js";
import type { ConfigFileCache } from "../config-file-cache.js";
import { initSigningKey, mintToken } from "../auth/token-service.js";
import { CURRENT_POLICY_EPOCH } from "../auth/policy.js";

const TEST_SIGNING_KEY = Buffer.from("test-signing-key-at-least-32-bytes-long");
initSigningKey(TEST_SIGNING_KEY);

/** Mint a valid daemon JWT for reconcile auth. */
function mintDaemonToken(): string {
  return mintToken({
    aud: "vellum-daemon",
    sub: "svc:gateway:self",
    scope_profile: "gateway_service_v1",
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds: 300,
  });
}

const TOKEN = mintDaemonToken();

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

const { createTelegramReconcileHandler } =
  await import("../http/routes/telegram-reconcile.js");

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
    runtimeInitialBackoffMs: 500,
    runtimeMaxRetries: 2,
    runtimeProxyEnabled: false,
    runtimeProxyRequireAuth: true,
    runtimeTimeoutMs: 30000,
    shutdownDrainMs: 5000,
    telegramApiBaseUrl: "https://api.telegram.org",
    telegramDeliverAuthBypass: false,
    telegramInitialBackoffMs: 1000,
    telegramMaxRetries: 0,
    telegramTimeoutMs: 15000,
    unmappedPolicy: "reject",
    whatsappDeliverAuthBypass: false,
    whatsappTimeoutMs: 15000,
    whatsappMaxRetries: 3,
    whatsappInitialBackoffMs: 1000,
    slackDeliverAuthBypass: false,
    trustProxy: false,
    ...overrides,
  };
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

/** Create mock caches for reconcile handler (provides bot token, secret, ingress). */
function makeCaches() {
  const credentialMap: Record<string, string | undefined> = {
    "credential:telegram:bot_token": "test-bot-token",
    "credential:telegram:webhook_secret": "test-webhook-secret",
  };
  const credentials = {
    get: async (key: string) => credentialMap[key],
    invalidate: () => {},
  } as unknown as CredentialCache;
  const configFile = {
    getString: (section: string, key: string) => {
      if (section === "ingress" && key === "publicBaseUrl")
        return "https://example.ngrok.io";
      return undefined;
    },
    getRecord: () => undefined,
    refreshNow: () => {},
  } as unknown as ConfigFileCache;
  return { credentials, configFile };
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
    const handler = createTelegramReconcileHandler(config, makeCaches());
    const res = await handler(
      new Request("http://localhost:7830/internal/telegram/reconcile", {
        method: "GET",
      }),
    );
    expect(res.status).toBe(405);
  });

  test("returns 401 for missing auth header", async () => {
    const config = makeConfig();
    const handler = createTelegramReconcileHandler(config, makeCaches());
    const res = await handler(makeRequest("POST"));
    expect(res.status).toBe(401);
  });

  test("returns 401 for wrong token", async () => {
    const config = makeConfig();
    const handler = createTelegramReconcileHandler(config, makeCaches());
    const res = await handler(makeRequest("POST", "wrong-token"));
    expect(res.status).toBe(401);
  });

  test("triggers reconcile with correct auth", async () => {
    const config = makeConfig();
    const handler = createTelegramReconcileHandler(config, makeCaches());
    const res = await handler(makeRequest("POST", TOKEN));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    // Fetch was called (getWebhookInfo + setWebhook) proving reconcile ran.
    expect(fetchMock).toHaveBeenCalled();
  });

  test("accepts body with ingressPublicBaseUrl for backward compatibility", async () => {
    const config = makeConfig();
    const handler = createTelegramReconcileHandler(config, makeCaches());
    const res = await handler(
      makeRequest("POST", TOKEN, {
        ingressPublicBaseUrl: "https://new.example.com/",
      }),
    );
    expect(res.status).toBe(200);
  });

  test("works with empty body", async () => {
    const config = makeConfig();
    const handler = createTelegramReconcileHandler(config, makeCaches());
    const req = new Request(
      "http://localhost:7830/internal/telegram/reconcile",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
        },
      },
    );
    const res = await handler(req);
    expect(res.status).toBe(200);
  });

  test("returns 502 when reconcile throws", async () => {
    fetchMock = mock(async () => {
      throw new Error("Telegram API error");
    });
    const config = makeConfig();
    const handler = createTelegramReconcileHandler(config, makeCaches());
    const res = await handler(makeRequest("POST", TOKEN));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("Reconciliation failed");
  });

  test("returns 400 for invalid JSON body", async () => {
    const config = makeConfig();
    const handler = createTelegramReconcileHandler(config, makeCaches());
    const req = new Request(
      "http://localhost:7830/internal/telegram/reconcile",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: "not-json{",
      },
    );
    const res = await handler(req);
    expect(res.status).toBe(400);
  });

  test("serializes concurrent reconcile requests", async () => {
    let reconcileCount = 0;

    // Make reconcile slow enough that the first call is still in-flight
    // when the second one arrives.
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
        reconcileCount++;
        await new Promise((r) => setTimeout(r, 50));
        return makeTelegramResponse(true);
      }
      return new Response("Not found", { status: 404 });
    });

    const config = makeConfig();
    const handler = createTelegramReconcileHandler(config, makeCaches());

    const [res1, res2] = await Promise.all([
      handler(makeRequest("POST", TOKEN)),
      handler(makeRequest("POST", TOKEN)),
    ]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    // Both reconciles should have run
    expect(reconcileCount).toBe(2);
  });
});
