import { createHmac } from "node:crypto";
import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { GatewayConfig } from "../../config.js";
import type { CredentialCache } from "../../credential-cache.js";
import { credentialKey } from "../../credential-key.js";

// --- Mocks ----------------------------------------------------------------

const handleInboundMock = mock(
  (_config: GatewayConfig, _normalized: unknown, _options?: unknown) =>
    Promise.resolve({ forwarded: true, rejected: false }),
);

const resetConversationMock = mock(() => Promise.resolve());

mock.module("../../handlers/handle-inbound.js", () => ({
  handleInbound: handleInboundMock,
}));

mock.module("../../runtime/client.js", () => ({
  resetConversation: resetConversationMock,
  uploadAttachment: mock(() => Promise.resolve({ id: "att-1" })),
  AttachmentValidationError: class extends Error {},
  CircuitBreakerOpenError: class extends Error {},
}));

// Import after mocks are registered
const { createEmailWebhookHandler } = await import("./email-webhook.js");

// --- Helpers ---------------------------------------------------------------

const TEST_WEBHOOK_SECRET = "test-webhook-secret-1234";

function computeSignature(body: string, secret: string): string {
  return (
    "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex")
  );
}

const baseConfig: GatewayConfig = {
  assistantRuntimeBaseUrl: "http://localhost:7821",
  defaultAssistantId: "ast-default",
  gatewayInternalBaseUrl: "http://127.0.0.1:7830",
  logFile: { dir: undefined, retentionDays: 30 },
  maxAttachmentBytes: {
    telegram: 50 * 1024 * 1024,
    slack: 100 * 1024 * 1024,
    whatsapp: 16 * 1024 * 1024,
    default: 50 * 1024 * 1024,
  },
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
  unmappedPolicy: "default",
  trustProxy: false,
};

function makeEmailPayload(overrides?: {
  from?: string;
  fromName?: string;
  to?: string;
  subject?: string;
  strippedText?: string;
  bodyText?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  conversationId?: string;
  timestamp?: string;
}) {
  return JSON.stringify({
    from: overrides?.from ?? "sender@example.com",
    fromName: overrides?.fromName,
    to: overrides?.to ?? "assistant@vellum.me",
    subject: overrides?.subject ?? "Hello",
    strippedText: overrides?.strippedText ?? "Hi, how are you?",
    bodyText:
      overrides?.bodyText ??
      "On Mon, someone wrote:\n> old\n\nHi, how are you?",
    messageId: overrides?.messageId ?? "<msg-456@example.com>",
    inReplyTo: overrides?.inReplyTo,
    references: overrides?.references,
    conversationId: overrides?.conversationId ?? "conv-abc",
    timestamp: overrides?.timestamp ?? "2026-04-03T01:00:00.000Z",
  });
}

function postRequest(body: string, secret?: string): Request {
  const sigSecret = secret ?? TEST_WEBHOOK_SECRET;
  return new Request("http://localhost:7830/webhooks/email/inbound", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "vellum-signature": computeSignature(body, sigSecret),
    },
    body,
  });
}

function makeCaches(secret?: string) {
  const credentials = {
    get: async (key: string) => {
      if (key === credentialKey("vellum", "webhook_secret"))
        return secret ?? TEST_WEBHOOK_SECRET;
      return undefined;
    },
    invalidate: () => {},
  } as unknown as CredentialCache;
  return { credentials };
}

// --- Tests ----------------------------------------------------------------

describe("email-webhook", () => {
  beforeEach(() => {
    handleInboundMock.mockClear();
    handleInboundMock.mockResolvedValue({ forwarded: true, rejected: false });
  });

  it("rejects non-POST requests with 405", async () => {
    const { handler } = createEmailWebhookHandler(baseConfig, makeCaches());
    const req = new Request("http://localhost:7830/webhooks/email/inbound", {
      method: "GET",
    });
    const res = await handler(req);
    expect(res.status).toBe(405);
  });

  it("forwards a valid email event to runtime", async () => {
    const { handler } = createEmailWebhookHandler(baseConfig, makeCaches());
    const body = makeEmailPayload();
    const res = await handler(postRequest(body));
    expect(res.status).toBe(200);

    const json = (await res.json()) as { ok: boolean };
    expect(json.ok).toBe(true);
    expect(handleInboundMock).toHaveBeenCalledTimes(1);

    // Verify the normalized event structure
    const callArgs = handleInboundMock.mock.calls[0];
    const event = callArgs[1] as {
      sourceChannel: string;
      message: {
        content: string;
        conversationExternalId: string;
        externalMessageId: string;
      };
      actor: { actorExternalId: string; displayName: string };
    };
    expect(event.sourceChannel).toBe("email");
    expect(event.message.content).toBe("Hi, how are you?");
    expect(event.message.conversationExternalId).toBe("conv-abc");
    expect(event.message.externalMessageId).toBe("<msg-456@example.com>");
    expect(event.actor.actorExternalId).toBe("sender@example.com");
  });

  it("acknowledges payloads missing required fields", async () => {
    const { handler } = createEmailWebhookHandler(baseConfig, makeCaches());
    const body = JSON.stringify({ someOtherEvent: true });
    const res = await handler(postRequest(body));
    expect(res.status).toBe(200);
    expect(handleInboundMock).not.toHaveBeenCalled();
  });

  it("deduplicates events by message ID", async () => {
    const { handler } = createEmailWebhookHandler(baseConfig, makeCaches());
    const body = makeEmailPayload({ messageId: "<dedup-test@example.com>" });

    const res1 = await handler(postRequest(body));
    expect(res1.status).toBe(200);
    expect(handleInboundMock).toHaveBeenCalledTimes(1);

    const res2 = await handler(postRequest(body));
    expect(res2.status).toBe(200);
    // Second call should be deduped
    expect(handleInboundMock).toHaveBeenCalledTimes(1);
  });

  it("rejects payloads exceeding size limit", async () => {
    const config = { ...baseConfig, maxWebhookPayloadBytes: 10 };
    const { handler } = createEmailWebhookHandler(config, makeCaches());
    const body = makeEmailPayload();
    const res = await handler(postRequest(body));
    expect(res.status).toBe(413);
  });

  it("rejects invalid JSON with 400", async () => {
    const { handler } = createEmailWebhookHandler(baseConfig, makeCaches());
    const body = "not json";
    const req = new Request("http://localhost:7830/webhooks/email/inbound", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "vellum-signature": computeSignature(body, TEST_WEBHOOK_SECRET),
      },
      body,
    });
    const res = await handler(req);
    expect(res.status).toBe(400);
  });

  it("uses fromName as displayName when provided", async () => {
    const { handler } = createEmailWebhookHandler(baseConfig, makeCaches());
    const body = makeEmailPayload({
      from: "alice@example.com",
      fromName: "Alice Smith",
      messageId: "<display-name@example.com>",
    });
    const res = await handler(postRequest(body));
    expect(res.status).toBe(200);

    const callArgs = handleInboundMock.mock.calls[0];
    const event = callArgs[1] as {
      actor: { actorExternalId: string; displayName: string };
    };
    expect(event.actor.actorExternalId).toBe("alice@example.com");
    expect(event.actor.displayName).toBe("Alice Smith");
  });

  it("falls back to email as displayName when fromName is absent", async () => {
    const { handler } = createEmailWebhookHandler(baseConfig, makeCaches());
    const body = makeEmailPayload({
      from: "bob@example.com",
      messageId: "<no-name@example.com>",
    });
    const res = await handler(postRequest(body));
    expect(res.status).toBe(200);

    const callArgs = handleInboundMock.mock.calls[0];
    const event = callArgs[1] as {
      actor: { displayName: string };
    };
    expect(event.actor.displayName).toBe("bob@example.com");
  });

  it("prefers strippedText over bodyText", async () => {
    const { handler } = createEmailWebhookHandler(baseConfig, makeCaches());
    const body = makeEmailPayload({
      strippedText: "New reply here",
      bodyText: "On Monday, someone wrote:\n> old content\n\nNew reply here",
      messageId: "<stripped@example.com>",
    });
    const res = await handler(postRequest(body));
    expect(res.status).toBe(200);

    const callArgs = handleInboundMock.mock.calls[0];
    const event = callArgs[1] as { message: { content: string } };
    expect(event.message.content).toBe("New reply here");
  });

  it("falls back to bodyText when strippedText is absent", async () => {
    const { handler } = createEmailWebhookHandler(baseConfig, makeCaches());
    const body = JSON.stringify({
      from: "test@example.com",
      to: "bot@vellum.me",
      messageId: "<fallback@example.com>",
      conversationId: "conv-fallback",
      bodyText: "Full body content here",
    });
    const res = await handler(postRequest(body));
    expect(res.status).toBe(200);

    const callArgs = handleInboundMock.mock.calls[0];
    const event = callArgs[1] as { message: { content: string } };
    expect(event.message.content).toBe("Full body content here");
  });

  it("returns 409 when webhook secret is not configured", async () => {
    const emptyCaches = {
      credentials: {
        get: async () => undefined,
        invalidate: () => {},
      } as unknown as CredentialCache,
    };
    const { handler } = createEmailWebhookHandler(baseConfig, emptyCaches);
    const body = makeEmailPayload({ messageId: "<no-secret@example.com>" });
    const res = await handler(postRequest(body));
    expect(res.status).toBe(409);
  });

  it("rejects requests with wrong webhook secret (HMAC mismatch)", async () => {
    const { handler } = createEmailWebhookHandler(baseConfig, makeCaches());
    const body = makeEmailPayload({ messageId: "<wrong-secret@example.com>" });
    // Sign with a different secret than what the cache returns
    const req = new Request("http://localhost:7830/webhooks/email/inbound", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "vellum-signature": computeSignature(body, "wrong-secret"),
      },
      body,
    });
    const res = await handler(req);
    expect(res.status).toBe(403);
  });

  it("rejects requests with missing signature header", async () => {
    const { handler } = createEmailWebhookHandler(baseConfig, makeCaches());
    const body = makeEmailPayload({
      messageId: "<missing-header@example.com>",
    });
    const req = new Request("http://localhost:7830/webhooks/email/inbound", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const res = await handler(req);
    expect(res.status).toBe(403);
  });

  it("passes email subject and threading headers in sourceMetadata", async () => {
    const { handler } = createEmailWebhookHandler(baseConfig, makeCaches());
    const body = makeEmailPayload({
      subject: "Re: Project Update",
      inReplyTo: "<parent@example.com>",
      references: "<root@example.com> <parent@example.com>",
      messageId: "<metadata@example.com>",
    });
    const res = await handler(postRequest(body));
    expect(res.status).toBe(200);

    const callArgs = handleInboundMock.mock.calls[0];
    const options = callArgs[2] as {
      sourceMetadata: {
        emailSubject: string;
        emailRecipient: string;
        emailInReplyTo: string;
        emailReferences: string;
      };
    };
    expect(options.sourceMetadata.emailSubject).toBe("Re: Project Update");
    expect(options.sourceMetadata.emailRecipient).toBe("assistant@vellum.me");
    expect(options.sourceMetadata.emailInReplyTo).toBe("<parent@example.com>");
    expect(options.sourceMetadata.emailReferences).toBe(
      "<root@example.com> <parent@example.com>",
    );
  });

  it("uses messageId as dedup key for event ID", async () => {
    const { handler, dedupCache } = createEmailWebhookHandler(
      baseConfig,
      makeCaches(),
    );
    const body = makeEmailPayload({
      messageId: "<unique-dedup-id@example.com>",
    });
    await handler(postRequest(body));

    // The dedup cache should have reserved this message ID
    const status = dedupCache.reserve("<unique-dedup-id@example.com>");
    // Should return false because it's already reserved/marked
    expect(status).toBe(false);
  });

  it("returns 403 (not 409) when cache miss resolves on force-refresh but signature is invalid", async () => {
    // Simulate: initial cache miss, force-refresh returns real secret,
    // but signature doesn't match. Should be 403 (not 409 "not configured").
    const caches = {
      credentials: {
        get: async (_key: string, opts?: { force?: boolean }) => {
          // First call: cache miss
          if (!opts?.force) return undefined;
          // Force-refresh: return real secret
          return TEST_WEBHOOK_SECRET;
        },
        invalidate: () => {},
      } as unknown as CredentialCache,
    };
    const { handler } = createEmailWebhookHandler(baseConfig, caches);
    const body = makeEmailPayload({
      messageId: "<stale-var-fix@example.com>",
    });
    // Sign with wrong secret
    const req = new Request("http://localhost:7830/webhooks/email/inbound", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "vellum-signature": computeSignature(body, "wrong-secret"),
      },
      body,
    });
    const res = await handler(req);
    // This was the stale variable bug — it used to return 409 here
    expect(res.status).toBe(403);
  });
});
