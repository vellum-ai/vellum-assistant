import { describe, expect, mock, test } from "bun:test";
import type { GatewayConfig } from "../config.js";
import type { CredentialCache } from "../credential-cache.js";
import type { ConfigFileCache } from "../config-file-cache.js";
import { initSigningKey, mintToken } from "../auth/token-service.js";
import { CURRENT_POLICY_EPOCH } from "../auth/policy.js";

const TEST_SIGNING_KEY = Buffer.from("test-signing-key-at-least-32-bytes-long");
initSigningKey(TEST_SIGNING_KEY);

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

const { createTwilioReconcileHandler } =
  await import("../http/routes/twilio-reconcile.js");

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
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
    headers.authorization = `Bearer ${token}`;
  }
  return new Request("http://localhost:7830/internal/twilio/reconcile", {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

function makeMockCaches() {
  const invalidateMock = mock(() => {});
  const refreshNowMock = mock(() => {});
  const credentials = {
    get: async () => undefined,
    invalidate: invalidateMock,
  } as unknown as CredentialCache;
  const configFile = {
    getString: () => undefined,
    getRecord: () => undefined,
    refreshNow: refreshNowMock,
  } as unknown as ConfigFileCache;
  return { credentials, configFile, invalidateMock, refreshNowMock };
}

describe("POST /internal/twilio/reconcile", () => {
  test("rejects non-POST methods", async () => {
    const config = makeConfig();
    const handler = createTwilioReconcileHandler(config);
    const res = await handler(
      new Request("http://localhost:7830/internal/twilio/reconcile", {
        method: "GET",
      }),
    );
    expect(res.status).toBe(405);
  });

  test("returns 401 for unauthorized requests", async () => {
    const config = makeConfig();
    const handler = createTwilioReconcileHandler(config);

    const missingAuthResponse = await handler(makeRequest("POST"));
    const invalidTokenResponse = await handler(makeRequest("POST", "wrong"));

    expect(missingAuthResponse.status).toBe(401);
    expect(invalidTokenResponse.status).toBe(401);
  });

  test("returns 200 and invalidates caches on valid request", async () => {
    const config = makeConfig();
    const { credentials, configFile, invalidateMock, refreshNowMock } =
      makeMockCaches();
    const handler = createTwilioReconcileHandler(config, {
      credentials,
      configFile,
    });

    const res = await handler(makeRequest("POST", TOKEN));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // Verify caches were invalidated
    expect(invalidateMock).toHaveBeenCalled();
    expect(refreshNowMock).toHaveBeenCalled();
  });

  test("accepts body with ingressPublicBaseUrl for backward compatibility", async () => {
    const config = makeConfig();
    const handler = createTwilioReconcileHandler(config);

    const res = await handler(
      makeRequest("POST", TOKEN, {
        ingressPublicBaseUrl: "https://new.example.com/",
      }),
    );

    expect(res.status).toBe(200);
  });

  test("returns 400 for invalid JSON body", async () => {
    const config = makeConfig();
    const handler = createTwilioReconcileHandler(config);
    const req = new Request("http://localhost:7830/internal/twilio/reconcile", {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: "not-json{",
    });
    const res = await handler(req);
    expect(res.status).toBe(400);
  });

  test("works without caches (no-op cache invalidation)", async () => {
    const config = makeConfig();
    const handler = createTwilioReconcileHandler(config);
    const res = await handler(makeRequest("POST", TOKEN));
    expect(res.status).toBe(200);
  });
});
