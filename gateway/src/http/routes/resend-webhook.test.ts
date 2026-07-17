import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { GatewayConfig } from "../../config.js";
import type { CredentialCache } from "../../credential-cache.js";
import { credentialKey } from "../../credential-key.js";

// --- Mocks ----------------------------------------------------------------

const handleInboundMock = mock(() =>
  Promise.resolve({ forwarded: true, rejected: false } as Record<
    string,
    unknown
  >),
);

mock.module("../../handlers/handle-inbound.js", () => ({
  handleInbound: handleInboundMock,
}));
mock.module("../../routing/resolve-assistant.js", () => ({
  resolveAssistant: () => ({ assistantId: "assistant-1" }),
  isRejection: (routing: Record<string, unknown>) => "reason" in routing,
}));
mock.module("../../db/denial-reply-rate-limiter.js", () => ({
  recordDenialReplyIfAllowed: () => true,
}));
mock.module("../../runtime/client.js", () => ({
  resetConversation: mock(() => Promise.resolve()),
  uploadAttachment: mock(() => Promise.resolve({ id: "att-1" })),
  AttachmentValidationError: class extends Error {},
  CircuitBreakerOpenError: class extends Error {},
}));

// Import after mocks are registered
const { createResendWebhookHandler } = await import("./resend-webhook.js");

// --- Helpers ---------------------------------------------------------------

// Svix secrets are `whsec_<base64>`; the verifier base64-decodes the part
// after the prefix and HMACs `${svix-id}.${svix-timestamp}.${rawBody}`.
const SECRET_BYTES = Buffer.from("resend-webhook-secret-key-bytes");
const WEBHOOK_SECRET = `whsec_${SECRET_BYTES.toString("base64")}`;

const config = {
  maxWebhookPayloadBytes: 1024 * 1024,
  maxAttachmentBytes: { email: 25 * 1024 * 1024, default: 100 * 1024 * 1024 },
  maxAttachmentConcurrency: 3,
} as unknown as GatewayConfig;

function makeCaches(opts?: { apiKey?: string; apiKeyThrows?: boolean }) {
  const credentials = {
    get: async (key: string) => {
      if (key === credentialKey("resend", "webhook_secret")) {
        return WEBHOOK_SECRET;
      }
      if (key === credentialKey("resend", "api_key")) {
        if (opts?.apiKeyThrows) {
          throw new Error("credential backend unavailable");
        }
        return opts?.apiKey;
      }
      return undefined;
    },
    invalidate: () => {},
  } as unknown as CredentialCache;
  return { credentials };
}

function postRequest(messageId: string): Request {
  const svixId = `msg_${messageId}`;
  const svixTimestamp = Math.floor(Date.now() / 1000).toString();
  const body = JSON.stringify({
    type: "email.received",
    created_at: "2026-04-03T01:00:00.000Z",
    data: {
      email_id: `email_${messageId}`,
      created_at: "2026-04-03T01:00:00.000Z",
      from: "alice@example.com",
      to: ["assistant@example.org"],
      subject: "Hello",
      message_id: messageId,
    },
  });
  const signature = createHmac("sha256", SECRET_BYTES)
    .update(`${svixId}.${svixTimestamp}.${body}`, "utf8")
    .digest("base64");
  return new Request("http://localhost:7830/webhooks/resend", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": `v1,${signature}`,
    },
    body,
  });
}

beforeEach(() => {
  handleInboundMock.mockClear();
  handleInboundMock.mockImplementation(() =>
    Promise.resolve({ forwarded: true, rejected: false }),
  );
});

// --- Tests ----------------------------------------------------------------

describe("resend-webhook API-key resolution", () => {
  it("releases the reserved dedup key and returns 500 when the API-key read throws", async () => {
    const { handler, dedupCache } = createResendWebhookHandler(
      config,
      makeCaches({ apiKeyThrows: true }),
    );
    const messageId = "<throw-msg-1@example.com>";
    const res = await handler(postRequest(messageId));

    expect(res.status).toBe(500);
    // The throw happens at API-key resolution, before the pipeline runs.
    expect(handleInboundMock).not.toHaveBeenCalled();
    // Released: Resend's retry delivery reserves the key again instead of
    // being silently deduped and dropped.
    expect(dedupCache.reserve(messageId)).toBe(true);
  });

  it("forwards through the pipeline and keeps the key deduped when the API key resolves", async () => {
    // API key omitted (undefined): the body fetch is skipped but the event
    // still forwards — a non-throwing resolution must not 500.
    const { handler, dedupCache } = createResendWebhookHandler(
      config,
      makeCaches(),
    );
    const messageId = "<ok-msg-1@example.com>";
    const res = await handler(postRequest(messageId));

    expect(res.status).toBe(200);
    expect(handleInboundMock).toHaveBeenCalledTimes(1);
    // A processed delivery stays deduped: the retry reservation is refused.
    expect(dedupCache.reserve(messageId)).toBe(false);
  });
});
