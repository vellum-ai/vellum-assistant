import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { GatewayConfig } from "../config.js";
import type { CredentialCache } from "../credential-cache.js";

// ── Mocks ──

let forwardToRuntimeMock = mock(async () => ({
  accepted: true,
  duplicate: false,
  eventId: "evt-1",
}));

mock.module("../runtime/client.js", () => ({
  forwardToRuntime: (...args: unknown[]) =>
    forwardToRuntimeMock(...(args as [unknown, unknown, unknown])),
  CircuitBreakerOpenError: class extends Error {
    retryAfterSecs: number;
    constructor(s: number) {
      super("circuit open");
      this.retryAfterSecs = s;
    }
  },
}));

let featureFlagEnabled = true;

mock.module("../feature-flag-defaults.js", () => ({
  loadFeatureFlagDefaults: () =>
    featureFlagEnabled
      ? {
          "feature_flags.assistant-a2a.enabled": {
            defaultEnabled: true,
            description: "A2A",
            label: "A2A",
          },
        }
      : {},
}));

mock.module("../feature-flag-store.js", () => ({
  readPersistedFeatureFlags: () => ({}),
}));

mock.module("../auth/token-exchange.js", () => ({
  mintIngressToken: () => "mock-ingress-token",
  mintServiceToken: () => "mock-service-token",
}));

const { createA2AWebhookHandler } =
  await import("../http/routes/a2a-webhook.js");

// ── Helpers ──

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
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
}

function makeCredentialCache(
  entries: Record<string, string> = {},
): CredentialCache {
  return {
    get: mock(async (key: string) => entries[key]),
    refreshNow: mock(async () => {}),
    invalidate: mock(() => {}),
    onInvalidate: mock(() => () => {}),
  } as unknown as CredentialCache;
}

function makeRequest(
  body: unknown,
  options: { method?: string; headers?: Record<string, string> } = {},
): Request {
  return new Request("http://gateway.test/webhook/a2a", {
    method: options.method ?? "POST",
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /webhook/a2a", () => {
  beforeEach(() => {
    featureFlagEnabled = true;
    forwardToRuntimeMock = mock(async () => ({
      accepted: true,
      duplicate: false,
      eventId: "evt-1",
    }));
  });

  test("returns 404 when feature flag is disabled", async () => {
    featureFlagEnabled = false;
    const handler = createA2AWebhookHandler(makeConfig());
    const res = await handler(
      makeRequest({
        version: "v1",
        type: "pairing_request",
        senderAssistantId: "alice",
        senderGatewayUrl: "http://alice.test",
        inviteCode: "inv-1",
      }),
    );
    expect(res.status).toBe(404);
  });

  test("accepts pairing_request without auth", async () => {
    const config = makeConfig();
    const handler = createA2AWebhookHandler(config);

    const res = await handler(
      makeRequest({
        version: "v1",
        type: "pairing_request",
        senderAssistantId: "alice",
        senderGatewayUrl: "http://alice.test",
        inviteCode: "inv-1",
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(forwardToRuntimeMock).toHaveBeenCalledTimes(1);

    // Verify the forwarded payload
    const [, payload] = forwardToRuntimeMock.mock.calls[0] as [
      unknown,
      Record<string, unknown>,
    ];
    expect(payload.sourceChannel).toBe("vellum");
    expect(payload.interface).toBe("vellum");
    expect(payload.conversationExternalId).toBe("alice");
    expect(payload.actorExternalId).toBe("alice");
    expect((payload.sourceMetadata as Record<string, unknown>).a2a).toBe(true);
    expect(
      (payload.sourceMetadata as Record<string, unknown>).envelopeType,
    ).toBe("pairing_request");
    expect(
      (payload.sourceMetadata as Record<string, unknown>).authenticated,
    ).toBe(false);
  });

  test("accepts pairing_accepted without auth", async () => {
    const handler = createA2AWebhookHandler(makeConfig());
    const res = await handler(
      makeRequest({
        version: "v1",
        type: "pairing_accepted",
        senderAssistantId: "bob",
        inviteCode: "inv-1",
        inboundToken: "token-for-alice",
      }),
    );
    expect(res.status).toBe(200);
    expect(forwardToRuntimeMock).toHaveBeenCalledTimes(1);

    const [, payload] = forwardToRuntimeMock.mock.calls[0] as [
      unknown,
      Record<string, unknown>,
    ];
    expect(
      (payload.sourceMetadata as Record<string, unknown>).authenticated,
    ).toBe(false);
  });

  test("rejects message without auth (401)", async () => {
    const creds = makeCredentialCache({
      "a2a:inbound:alice": "secret-token",
    });
    const handler = createA2AWebhookHandler(makeConfig(), {
      credentials: creds,
    });

    const res = await handler(
      makeRequest({
        version: "v1",
        type: "message",
        senderAssistantId: "alice",
        messageId: "msg-1",
        content: "hello",
      }),
    );

    expect(res.status).toBe(401);
    expect(forwardToRuntimeMock).not.toHaveBeenCalled();
  });

  test("accepts message with valid Bearer token", async () => {
    const creds = makeCredentialCache({
      "a2a:inbound:alice": "secret-token",
      "a2a:gateway:alice": "http://alice.test",
    });
    const handler = createA2AWebhookHandler(makeConfig(), {
      credentials: creds,
    });

    const res = await handler(
      makeRequest(
        {
          version: "v1",
          type: "message",
          senderAssistantId: "alice",
          messageId: "msg-1",
          content: "hello from alice",
        },
        {
          headers: { Authorization: "Bearer secret-token" },
        },
      ),
    );

    expect(res.status).toBe(200);
    expect(forwardToRuntimeMock).toHaveBeenCalledTimes(1);

    const [, payload] = forwardToRuntimeMock.mock.calls[0] as [
      unknown,
      Record<string, unknown>,
    ];
    expect(payload.content).toBe("hello from alice");
    expect(
      (payload.sourceMetadata as Record<string, unknown>).authenticated,
    ).toBe(true);
    expect(
      (payload.sourceMetadata as Record<string, unknown>).envelopeType,
    ).toBe("message");
    // replyCallbackUrl should be set with gateway info
    expect(payload.replyCallbackUrl).toContain("/deliver/a2a");
    expect(payload.replyCallbackUrl).toContain(
      encodeURIComponent("http://alice.test"),
    );
  });

  test("rejects message with invalid Bearer token (401)", async () => {
    const creds = makeCredentialCache({
      "a2a:inbound:alice": "correct-token",
    });
    const handler = createA2AWebhookHandler(makeConfig(), {
      credentials: creds,
    });

    const res = await handler(
      makeRequest(
        {
          version: "v1",
          type: "message",
          senderAssistantId: "alice",
          messageId: "msg-1",
          content: "hello",
        },
        {
          headers: { Authorization: "Bearer wrong-token" },
        },
      ),
    );

    expect(res.status).toBe(401);
    expect(forwardToRuntimeMock).not.toHaveBeenCalled();
  });

  test("pairing_finalize requires auth (same as message)", async () => {
    const creds = makeCredentialCache({
      "a2a:inbound:alice": "secret-token",
    });
    const handler = createA2AWebhookHandler(makeConfig(), {
      credentials: creds,
    });

    // Without auth
    const res1 = await handler(
      makeRequest({
        version: "v1",
        type: "pairing_finalize",
        senderAssistantId: "alice",
        inviteCode: "inv-1",
        inboundToken: "token-for-bob",
      }),
    );
    expect(res1.status).toBe(401);

    // With valid auth
    const res2 = await handler(
      makeRequest(
        {
          version: "v1",
          type: "pairing_finalize",
          senderAssistantId: "alice",
          inviteCode: "inv-1",
          inboundToken: "token-for-bob",
        },
        {
          headers: { Authorization: "Bearer secret-token" },
        },
      ),
    );
    expect(res2.status).toBe(200);
  });

  test("rejects malformed envelope (400)", async () => {
    const handler = createA2AWebhookHandler(makeConfig());

    // Missing required fields
    const res = await handler(makeRequest({ version: "v1", type: "message" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid envelope");
  });

  test("rejects invalid JSON (400)", async () => {
    const handler = createA2AWebhookHandler(makeConfig());
    const req = new Request("http://gateway.test/webhook/a2a", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    const res = await handler(req);
    expect(res.status).toBe(400);
  });

  test("conversationExternalId is always server-derived from senderAssistantId", async () => {
    const handler = createA2AWebhookHandler(makeConfig());

    const res = await handler(
      makeRequest({
        version: "v1",
        type: "pairing_request",
        senderAssistantId: "alice-id",
        senderGatewayUrl: "http://alice.test",
        inviteCode: "inv-1",
      }),
    );

    expect(res.status).toBe(200);
    const [, payload] = forwardToRuntimeMock.mock.calls[0] as [
      unknown,
      Record<string, unknown>,
    ];
    expect(payload.conversationExternalId).toBe("alice-id");
  });

  test("replyCallbackUrl encodes target gateway info", async () => {
    const creds = makeCredentialCache({
      "a2a:inbound:alice": "token",
      "a2a:gateway:alice": "http://alice-gw.example.com:7830",
    });
    const config = makeConfig({
      gatewayInternalBaseUrl: "http://127.0.0.1:7830",
    });
    const handler = createA2AWebhookHandler(config, {
      credentials: creds,
    });

    const res = await handler(
      makeRequest(
        {
          version: "v1",
          type: "message",
          senderAssistantId: "alice",
          messageId: "msg-1",
          content: "test",
        },
        {
          headers: { Authorization: "Bearer token" },
        },
      ),
    );

    expect(res.status).toBe(200);
    const [, payload] = forwardToRuntimeMock.mock.calls[0] as [
      unknown,
      Record<string, unknown>,
    ];
    const url = new URL(
      payload.replyCallbackUrl as string,
      "http://placeholder",
    );
    expect(url.pathname).toBe("/deliver/a2a");
    expect(url.searchParams.get("gatewayUrl")).toBe(
      "http://alice-gw.example.com:7830",
    );
    expect(url.searchParams.get("assistantId")).toBe("alice");
  });

  test("replyCallbackUrl uses senderGatewayUrl from pairing_request envelope", async () => {
    const handler = createA2AWebhookHandler(makeConfig());

    const res = await handler(
      makeRequest({
        version: "v1",
        type: "pairing_request",
        senderAssistantId: "alice",
        senderGatewayUrl: "http://alice-pairing.test",
        inviteCode: "inv-1",
      }),
    );

    expect(res.status).toBe(200);
    const [, payload] = forwardToRuntimeMock.mock.calls[0] as [
      unknown,
      Record<string, unknown>,
    ];
    expect(payload.replyCallbackUrl).toContain(
      encodeURIComponent("http://alice-pairing.test"),
    );
  });
});
