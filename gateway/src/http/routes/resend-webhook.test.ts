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
const { createResendWebhookHandler, normalizeResendToVellumPayload } =
  await import("./resend-webhook.js");

// --- Sender authentication -------------------------------------------------
// Resend inbound trust hinges on `senderAuthenticated`, derived from the
// `Authentication-Results` header returned by the receiving API.
// `fetchResendEmailContent` lowercases header keys, so the normalizer reads the
// `authentication-results` key. These tests lock authenticated pass-through vs.
// forged/unauthenticated downgrade, and the omit-on-missing-data behavior.

const GUARDIAN = "guardian@example.com";

// Structural stand-in for the module-private ResendReceivedEvent shape.
function makeEvent(from: string = GUARDIAN) {
  return {
    type: "email.received" as const,
    created_at: "2026-04-03T01:00:00.000Z",
    data: {
      email_id: "email-1",
      created_at: "2026-04-03T01:00:00.000Z",
      from,
      to: ["bot@example.com"],
      subject: "Test",
      message_id: "<msg-1@example.com>",
    },
  };
}

function makeContent(authResults: string | null): {
  html: string | null;
  text: string | null;
  headers: Record<string, string>;
} {
  return {
    html: null,
    text: "hello",
    headers:
      authResults === null ? {} : { "authentication-results": authResults },
  };
}

describe("normalizeResendToVellumPayload sender authentication", () => {
  it("sets senderAuthenticated=true for a DMARC-authenticated sender", () => {
    const payload = normalizeResendToVellumPayload(
      makeEvent(),
      makeContent("mx.resend.com; dmarc=pass header.from=example.com"),
    );
    expect(payload?.senderAuthenticated).toBe(true);
  });

  it("sets senderAuthenticated=false for a forged (DMARC-failed) sender", () => {
    const payload = normalizeResendToVellumPayload(
      makeEvent(),
      makeContent(
        "mx.resend.com; spf=fail smtp.mailfrom=attacker.net; dmarc=fail header.from=example.com",
      ),
    );
    expect(payload?.senderAuthenticated).toBe(false);
  });

  it("omits senderAuthenticated when the content fetch failed (no content)", () => {
    // No API key / fetch failure → content is null → signal omitted so
    // handleInbound preserves existing behavior on missing data.
    const payload = normalizeResendToVellumPayload(makeEvent(), null);
    expect(payload).not.toBeNull();
    expect(payload?.senderAuthenticated).toBeUndefined();
  });

  it("omits senderAuthenticated when headers carry no Authentication-Results", () => {
    const payload = normalizeResendToVellumPayload(
      makeEvent(),
      makeContent(null),
    );
    expect(payload?.senderAuthenticated).toBeUndefined();
  });
});

// --- API-key resolution ----------------------------------------------------

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

// --- Payload validation ----------------------------------------------------

/** Sign an arbitrary JSON body as a valid Svix-signed Resend webhook. */
function signedRequest(bodyObj: unknown): Request {
  const body = JSON.stringify(bodyObj);
  const svixId = "msg_validation";
  const svixTimestamp = Math.floor(Date.now() / 1000).toString();
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

describe("resend-webhook payload validation", () => {
  it("acknowledges a non-received event (delivery status, bounce) without forwarding", async () => {
    const { handler } = createResendWebhookHandler(config, makeCaches());
    const res = await handler(
      signedRequest({ type: "email.delivered", data: { email_id: "e1" } }),
    );
    expect(res.status).toBe(200);
    expect(handleInboundMock).not.toHaveBeenCalled();
  });

  it("drops an email.received event whose `to` is not an array, rather than forwarding a garbage recipient", async () => {
    // A string `to` must be treated as malformed, not as a list: indexing it
    // would forward `to[0]` — a single character — as the recipient address.
    const { handler } = createResendWebhookHandler(config, makeCaches());
    const res = await handler(
      signedRequest({
        type: "email.received",
        created_at: "2026-04-03T01:00:00.000Z",
        data: {
          email_id: "email_x",
          from: "alice@example.com",
          to: "not-an-array",
          subject: "Hello",
          message_id: "<garbage-to@example.com>",
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(handleInboundMock).not.toHaveBeenCalled();
  });
});
