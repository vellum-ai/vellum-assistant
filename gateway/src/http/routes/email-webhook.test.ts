import { createHmac } from "node:crypto";
import {
  describe,
  it,
  expect,
  mock,
  beforeEach,
  afterEach,
} from "bun:test";
import type { GatewayConfig } from "../../config.js";

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

// Svix secrets are `whsec_<base64>`. The base64-decoded part is the
// raw HMAC key. The example below decodes to `test-signing-key-1234567890`.
const TEST_SIGNING_KEY = "whsec_dGVzdC1zaWduaW5nLWtleS0xMjM0NTY3ODkw";

function computeSvixSignature(
  msgId: string,
  timestamp: number,
  body: string,
  key: string,
): string {
  const secretPart = key.startsWith("whsec_") ? key.slice(6) : key;
  const secretBytes = Buffer.from(secretPart, "base64");
  const signedContent = `${msgId}.${timestamp}.${body}`;
  const sig = createHmac("sha256", secretBytes)
    .update(signedContent, "utf8")
    .digest("base64");
  return `v1,${sig}`;
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

interface RequestOptions {
  msgId?: string;
  timestamp?: number; // Unix seconds; defaults to now
  key?: string;
  omitHeaders?: Array<"svix-id" | "svix-timestamp" | "svix-signature">;
  signatureOverride?: string;
}

function postRequest(body: string, opts: RequestOptions = {}): Request {
  const msgId = opts.msgId ?? `msg_${Math.random().toString(36).slice(2)}`;
  const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000);
  const key = opts.key ?? TEST_SIGNING_KEY;
  const signature =
    opts.signatureOverride ?? computeSvixSignature(msgId, timestamp, body, key);

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  const omit = opts.omitHeaders ?? [];
  if (!omit.includes("svix-id")) headers["svix-id"] = msgId;
  if (!omit.includes("svix-timestamp"))
    headers["svix-timestamp"] = String(timestamp);
  if (!omit.includes("svix-signature")) headers["svix-signature"] = signature;

  return new Request("http://localhost:7830/webhooks/email", {
    method: "POST",
    headers,
    body,
  });
}

// --- Tests ----------------------------------------------------------------

describe("email-webhook", () => {
  beforeEach(() => {
    process.env.RESEND_WEBHOOK_SIGNING_KEY = TEST_SIGNING_KEY;
    handleInboundMock.mockClear();
    handleInboundMock.mockResolvedValue({ forwarded: true, rejected: false });
  });

  afterEach(() => {
    delete process.env.RESEND_WEBHOOK_SIGNING_KEY;
  });

  it("rejects non-POST requests with 405", async () => {
    const { handler } = createEmailWebhookHandler(baseConfig);
    const req = new Request("http://localhost:7830/webhooks/email", {
      method: "GET",
    });
    const res = await handler(req);
    expect(res.status).toBe(405);
  });

  it("forwards a valid email event to runtime", async () => {
    const { handler } = createEmailWebhookHandler(baseConfig);
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
    const { handler } = createEmailWebhookHandler(baseConfig);
    const body = JSON.stringify({ someOtherEvent: true });
    const res = await handler(postRequest(body));
    expect(res.status).toBe(200);
    expect(handleInboundMock).not.toHaveBeenCalled();
  });

  it("deduplicates events by message ID", async () => {
    const { handler } = createEmailWebhookHandler(baseConfig);
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
    const { handler } = createEmailWebhookHandler(config);
    const body = makeEmailPayload();
    const res = await handler(postRequest(body));
    expect(res.status).toBe(413);
  });

  it("rejects invalid JSON with 400", async () => {
    const { handler } = createEmailWebhookHandler(baseConfig);
    const body = "not json";
    const res = await handler(postRequest(body));
    expect(res.status).toBe(400);
  });

  it("uses fromName as displayName when provided", async () => {
    const { handler } = createEmailWebhookHandler(baseConfig);
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
    const { handler } = createEmailWebhookHandler(baseConfig);
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
    const { handler } = createEmailWebhookHandler(baseConfig);
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
    const { handler } = createEmailWebhookHandler(baseConfig);
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

  it("returns 409 when RESEND_WEBHOOK_SIGNING_KEY is not configured", async () => {
    delete process.env.RESEND_WEBHOOK_SIGNING_KEY;
    const { handler } = createEmailWebhookHandler(baseConfig);
    const body = makeEmailPayload({ messageId: "<no-key@example.com>" });
    const res = await handler(postRequest(body));
    expect(res.status).toBe(409);
    expect(handleInboundMock).not.toHaveBeenCalled();
  });

  it("rejects requests signed with the wrong key (Svix mismatch)", async () => {
    const { handler } = createEmailWebhookHandler(baseConfig);
    const body = makeEmailPayload({ messageId: "<wrong-key@example.com>" });
    const wrongKey = "whsec_d3Jvbmcta2V5LWZvci10ZXN0aW5n";
    const res = await handler(postRequest(body, { key: wrongKey }));
    expect(res.status).toBe(403);
    expect(handleInboundMock).not.toHaveBeenCalled();
  });

  it("rejects requests missing svix-signature header", async () => {
    const { handler } = createEmailWebhookHandler(baseConfig);
    const body = makeEmailPayload({ messageId: "<missing-sig@example.com>" });
    const res = await handler(
      postRequest(body, { omitHeaders: ["svix-signature"] }),
    );
    expect(res.status).toBe(403);
  });

  it("rejects requests missing svix-id header", async () => {
    const { handler } = createEmailWebhookHandler(baseConfig);
    const body = makeEmailPayload({ messageId: "<missing-id@example.com>" });
    const res = await handler(postRequest(body, { omitHeaders: ["svix-id"] }));
    expect(res.status).toBe(403);
  });

  it("rejects requests missing svix-timestamp header", async () => {
    const { handler } = createEmailWebhookHandler(baseConfig);
    const body = makeEmailPayload({ messageId: "<missing-ts@example.com>" });
    const res = await handler(
      postRequest(body, { omitHeaders: ["svix-timestamp"] }),
    );
    expect(res.status).toBe(403);
  });

  it("rejects requests with stale timestamp (replay protection)", async () => {
    const { handler } = createEmailWebhookHandler(baseConfig);
    const body = makeEmailPayload({ messageId: "<stale-ts@example.com>" });
    // 10 minutes ago — outside the ±5-minute tolerance window
    const staleTimestamp = Math.floor(Date.now() / 1000) - 10 * 60;
    const res = await handler(postRequest(body, { timestamp: staleTimestamp }));
    expect(res.status).toBe(403);
    expect(handleInboundMock).not.toHaveBeenCalled();
  });

  it("rejects requests with future timestamp outside tolerance", async () => {
    const { handler } = createEmailWebhookHandler(baseConfig);
    const body = makeEmailPayload({ messageId: "<future-ts@example.com>" });
    const futureTimestamp = Math.floor(Date.now() / 1000) + 10 * 60;
    const res = await handler(
      postRequest(body, { timestamp: futureTimestamp }),
    );
    expect(res.status).toBe(403);
  });

  it("rejects requests with non-numeric timestamp", async () => {
    const { handler } = createEmailWebhookHandler(baseConfig);
    const body = makeEmailPayload({ messageId: "<bad-ts@example.com>" });
    const msgId = "msg_bad_ts";
    const sig = computeSvixSignature(
      msgId,
      Math.floor(Date.now() / 1000),
      body,
      TEST_SIGNING_KEY,
    );
    const req = new Request("http://localhost:7830/webhooks/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "svix-id": msgId,
        "svix-timestamp": "not-a-number",
        "svix-signature": sig,
      },
      body,
    });
    const res = await handler(req);
    expect(res.status).toBe(403);
  });

  it("accepts signature header with multiple versioned entries (matches any v1)", async () => {
    const { handler } = createEmailWebhookHandler(baseConfig);
    const body = makeEmailPayload({ messageId: "<multi-sig@example.com>" });
    const msgId = "msg_multi";
    const timestamp = Math.floor(Date.now() / 1000);
    const validSig = computeSvixSignature(
      msgId,
      timestamp,
      body,
      TEST_SIGNING_KEY,
    );
    // Mix in a `v2` entry and a bogus `v1` entry; valid `v1` should still match.
    // (Pad bogus values to match base64 lengths so the constant-time comparator
    // doesn't short-circuit on length mismatch alone.)
    const compositeHeader = `v2,unrelatedB64== ${validSig} v1,bogusButSameLen==`;
    const req = new Request("http://localhost:7830/webhooks/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "svix-id": msgId,
        "svix-timestamp": String(timestamp),
        "svix-signature": compositeHeader,
      },
      body,
    });
    const res = await handler(req);
    expect(res.status).toBe(200);
  });

  it("passes email subject and threading headers in sourceMetadata", async () => {
    const { handler } = createEmailWebhookHandler(baseConfig);
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
    const { handler, dedupCache } = createEmailWebhookHandler(baseConfig);
    const body = makeEmailPayload({
      messageId: "<unique-dedup-id@example.com>",
    });
    await handler(postRequest(body));

    // The dedup cache should have reserved this message ID
    const status = dedupCache.reserve("<unique-dedup-id@example.com>");
    // Should return false because it's already reserved/marked
    expect(status).toBe(false);
  });
});
