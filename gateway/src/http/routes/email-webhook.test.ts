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

mock.module("../../email/verify.js", () => ({
  verifyEmailWebhookSignature: () => true,
}));

// Import after mocks are registered
const { createEmailWebhookHandler } = await import("./email-webhook.js");

// --- Helpers ---------------------------------------------------------------

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

function makeMessageReceivedPayload(overrides?: {
  eventId?: string;
  messageId?: string;
  from?: string;
  to?: string[];
  subject?: string;
  text?: string;
  threadId?: string;
}) {
  return JSON.stringify({
    type: "event",
    eventType: "message.received",
    eventId: overrides?.eventId ?? "evt-123",
    message: {
      inboxId: "inbox-1",
      threadId: overrides?.threadId ?? "thread-abc",
      messageId: overrides?.messageId ?? "msg-456",
      from: overrides?.from ?? "sender@example.com",
      to: overrides?.to ?? ["assistant@mail.vellum.ai"],
      subject: overrides?.subject ?? "Hello",
      text: overrides?.text ?? "Hi, how are you?",
      timestamp: "2026-04-03T01:00:00.000Z",
      createdAt: "2026-04-03T01:00:00.000Z",
    },
    thread: {
      inboxId: "inbox-1",
      threadId: overrides?.threadId ?? "thread-abc",
      subject: overrides?.subject ?? "Hello",
      senders: [overrides?.from ?? "sender@example.com"],
      recipients: overrides?.to ?? ["assistant@mail.vellum.ai"],
      messageCount: 1,
    },
  });
}

function postRequest(body: string): Request {
  return new Request("http://localhost:7830/webhooks/email/inbound", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": "msg_test123",
      "svix-timestamp": String(Math.floor(Date.now() / 1000)),
      "svix-signature": "v1,dGVzdA==",
    },
    body,
  });
}

function makeCaches() {
  const credentials = {
    get: async (key: string) => {
      if (key === credentialKey("email", "webhook_secret"))
        return "whsec_dGVzdHNlY3JldA==";
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

  it("forwards a valid message.received event to runtime", async () => {
    const { handler } = createEmailWebhookHandler(baseConfig, makeCaches());
    const body = makeMessageReceivedPayload();
    const res = await handler(postRequest(body));
    expect(res.status).toBe(200);

    const json = (await res.json()) as { ok: boolean };
    expect(json.ok).toBe(true);
    expect(handleInboundMock).toHaveBeenCalledTimes(1);

    // Verify the normalized event structure
    const callArgs = handleInboundMock.mock.calls[0];
    const event = callArgs[1] as {
      sourceChannel: string;
      message: { content: string; conversationExternalId: string };
      actor: { actorExternalId: string };
    };
    expect(event.sourceChannel).toBe("email");
    expect(event.message.content).toBe("Hi, how are you?");
    expect(event.message.conversationExternalId).toBe("thread-abc");
    expect(event.actor.actorExternalId).toBe("sender@example.com");
  });

  it("acknowledges non-message events silently", async () => {
    const { handler } = createEmailWebhookHandler(baseConfig, makeCaches());
    const body = JSON.stringify({
      type: "event",
      eventType: "message.delivered",
      eventId: "evt-delivery-1",
    });
    const res = await handler(postRequest(body));
    expect(res.status).toBe(200);
    expect(handleInboundMock).not.toHaveBeenCalled();
  });

  it("deduplicates events by event ID", async () => {
    const { handler } = createEmailWebhookHandler(baseConfig, makeCaches());
    const body = makeMessageReceivedPayload({ eventId: "evt-dedup-test" });

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
    const body = makeMessageReceivedPayload();
    const res = await handler(postRequest(body));
    expect(res.status).toBe(413);
  });

  it("rejects invalid JSON with 400", async () => {
    const { handler } = createEmailWebhookHandler(baseConfig, makeCaches());
    const req = new Request("http://localhost:7830/webhooks/email/inbound", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "svix-id": "msg_test123",
        "svix-timestamp": String(Math.floor(Date.now() / 1000)),
        "svix-signature": "v1,dGVzdA==",
      },
      body: "not json",
    });
    const res = await handler(req);
    expect(res.status).toBe(400);
  });

  it("parses display name from 'Name <email>' format", async () => {
    const { handler } = createEmailWebhookHandler(baseConfig, makeCaches());
    const body = makeMessageReceivedPayload({
      from: "Alice Smith <alice@example.com>",
      eventId: "evt-display-name",
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

  it("uses extractedText when available over full text", async () => {
    const { handler } = createEmailWebhookHandler(baseConfig, makeCaches());
    const body = JSON.stringify({
      type: "event",
      eventType: "message.received",
      eventId: "evt-extracted",
      message: {
        inboxId: "inbox-1",
        threadId: "thread-ext",
        messageId: "msg-ext",
        from: "test@example.com",
        to: ["bot@vellum.ai"],
        text: "On Monday, someone wrote:\n> old content\n\nNew reply here",
        extractedText: "New reply here",
        timestamp: "2026-04-03T01:00:00.000Z",
        createdAt: "2026-04-03T01:00:00.000Z",
      },
    });
    const res = await handler(postRequest(body));
    expect(res.status).toBe(200);

    const callArgs = handleInboundMock.mock.calls[0];
    const event = callArgs[1] as { message: { content: string } };
    expect(event.message.content).toBe("New reply here");
  });

  it("returns 500 when webhook secret is not configured", async () => {
    const emptyCaches = {
      credentials: {
        get: async () => undefined,
        invalidate: () => {},
      } as unknown as CredentialCache,
    };
    const { handler } = createEmailWebhookHandler(baseConfig, emptyCaches);
    const body = makeMessageReceivedPayload({ eventId: "evt-no-secret" });
    const res = await handler(postRequest(body));
    expect(res.status).toBe(500);
  });
});
