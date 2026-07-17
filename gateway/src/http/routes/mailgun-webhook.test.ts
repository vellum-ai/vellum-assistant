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
const {
  createMailgunWebhookHandler,
  extractMailgunAuthResults,
  normalizeMailgunToVellumPayload,
} = await import("./mailgun-webhook.js");

// --- Sender authentication -------------------------------------------------
// Mailgun inbound trust hinges on `senderAuthenticated`, derived from the
// `Authentication-Results` header the receiving MTA stamps. These tests lock
// the extraction (first, receiver-stamped verdict wins) and the normalizer
// wiring (authenticated pass-through vs. forged/unauthenticated downgrade).

const GUARDIAN = "guardian@example.com";

function messageHeaders(pairs: Array<[string, string]>): string {
  return JSON.stringify(pairs);
}

function fields(
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    from: GUARDIAN,
    recipient: "bot@example.com",
    "Message-Id": "<msg-1@example.com>",
    subject: "Test",
    "body-plain": "hello",
    ...overrides,
  };
}

describe("extractMailgunAuthResults", () => {
  it("returns the Authentication-Results value from message-headers", () => {
    const headers = messageHeaders([
      ["Received", "from mx by mailgun"],
      [
        "Authentication-Results",
        "mx.mailgun.org; dmarc=pass header.from=example.com",
      ],
      ["From", GUARDIAN],
    ]);
    expect(
      extractMailgunAuthResults(fields({ "message-headers": headers })),
    ).toBe("mx.mailgun.org; dmarc=pass header.from=example.com");
  });

  it("returns the FIRST Authentication-Results (the receiver-prepended one)", () => {
    // A spoofer can inject their own Authentication-Results in the message body;
    // it sits BELOW the receiver's prepended verdict, so the first wins.
    const headers = messageHeaders([
      [
        "Authentication-Results",
        "mx.mailgun.org; dmarc=fail header.from=example.com",
      ],
      ["Authentication-Results", "spoofed; dmarc=pass header.from=example.com"],
    ]);
    expect(
      extractMailgunAuthResults(fields({ "message-headers": headers })),
    ).toBe("mx.mailgun.org; dmarc=fail header.from=example.com");
  });

  it("returns undefined when message-headers is absent", () => {
    expect(extractMailgunAuthResults(fields())).toBeUndefined();
  });

  it("returns undefined when message-headers is not valid JSON", () => {
    expect(
      extractMailgunAuthResults(fields({ "message-headers": "not-json" })),
    ).toBeUndefined();
  });

  it("returns undefined when no Authentication-Results header is present", () => {
    const headers = messageHeaders([
      ["Received", "x"],
      ["From", GUARDIAN],
    ]);
    expect(
      extractMailgunAuthResults(fields({ "message-headers": headers })),
    ).toBeUndefined();
  });
});

describe("normalizeMailgunToVellumPayload sender authentication", () => {
  it("sets senderAuthenticated=true for a DMARC-authenticated sender", () => {
    const headers = messageHeaders([
      [
        "Authentication-Results",
        "mx.mailgun.org; dmarc=pass header.from=example.com",
      ],
    ]);
    const payload = normalizeMailgunToVellumPayload(
      fields({ "message-headers": headers }),
    );
    expect(payload?.senderAuthenticated).toBe(true);
  });

  it("sets senderAuthenticated=false for a forged (DMARC-failed) sender", () => {
    // The spoof case: From: claims the guardian but DMARC failed. handleInbound
    // collapses this out of the guardian/trusted_contact tiers.
    const headers = messageHeaders([
      [
        "Authentication-Results",
        "mx.mailgun.org; spf=fail smtp.mailfrom=attacker.net; dmarc=fail header.from=example.com",
      ],
    ]);
    const payload = normalizeMailgunToVellumPayload(
      fields({ "message-headers": headers }),
    );
    expect(payload?.senderAuthenticated).toBe(false);
  });

  it("omits senderAuthenticated when Mailgun sent no auth header", () => {
    const payload = normalizeMailgunToVellumPayload(fields());
    expect(payload).not.toBeNull();
    expect(payload?.senderAuthenticated).toBeUndefined();
  });
});

// --- API-key resolution ----------------------------------------------------

const SIGNING_KEY = "test-mailgun-signing-key";

const config = {
  maxWebhookPayloadBytes: 1024 * 1024,
  maxAttachmentBytes: { email: 25 * 1024 * 1024, default: 100 * 1024 * 1024 },
  maxAttachmentConcurrency: 3,
} as unknown as GatewayConfig;

function makeCaches(opts?: { apiKey?: string; apiKeyThrows?: boolean }) {
  const credentials = {
    get: async (key: string) => {
      if (key === credentialKey("mailgun", "webhook_signing_key")) {
        return SIGNING_KEY;
      }
      if (key === credentialKey("mailgun", "api_key")) {
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

function postRequest(token: string): Request {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac("sha256", SIGNING_KEY)
    .update(timestamp + token, "utf8")
    .digest("hex");
  const body = JSON.stringify({
    from: "alice@example.com",
    recipient: "assistant@example.org",
    "Message-Id": `<${token}@example.com>`,
    subject: "Hello",
    "body-plain": "Hi there",
    timestamp,
    token,
    signature,
  });
  return new Request("http://localhost:7830/webhooks/mailgun", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

beforeEach(() => {
  handleInboundMock.mockClear();
  handleInboundMock.mockImplementation(() =>
    Promise.resolve({ forwarded: true, rejected: false }),
  );
});

describe("mailgun-webhook API-key resolution", () => {
  it("releases the reserved dedup token and returns 500 when the API-key read throws", async () => {
    const { handler, dedupCache } = createMailgunWebhookHandler(
      config,
      makeCaches({ apiKeyThrows: true }),
    );
    const token = "throw-token-1";
    const res = await handler(postRequest(token));

    expect(res.status).toBe(500);
    // The throw happens at API-key resolution, before the pipeline runs.
    expect(handleInboundMock).not.toHaveBeenCalled();
    // Released: Mailgun's retry delivery reserves the token again instead of
    // being silently deduped and dropped (StringDedupCache reservations have
    // no TTL, so a stranded reservation would be permanent).
    expect(dedupCache.reserve(token)).toBe(true);
  });

  it("forwards through the pipeline and keeps the token deduped when the API key resolves", async () => {
    const { handler, dedupCache } = createMailgunWebhookHandler(
      config,
      makeCaches({ apiKey: "mg-api-key" }),
    );
    const token = "ok-token-1";
    const res = await handler(postRequest(token));

    expect(res.status).toBe(200);
    expect(handleInboundMock).toHaveBeenCalledTimes(1);
    // A processed delivery stays deduped: the retry reservation is refused.
    expect(dedupCache.reserve(token)).toBe(false);
  });
});
