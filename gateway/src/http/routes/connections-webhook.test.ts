import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import "../../__tests__/test-preload.js";

import type { GatewayConfig } from "../../config.js";
import { CredentialCache } from "../../credential-cache.js";
import { credentialKey } from "../../credential-key.js";
import type {
  HandleInboundOptions,
  InboundResult,
} from "../../handlers/handle-inbound.js";
import type { GatewayInboundEvent } from "../../types.js";

let flagEnabled = true;
const actualFlagResolver = await import("../../feature-flag-resolver.js");
mock.module("../../feature-flag-resolver.js", () => ({
  ...actualFlagResolver,
  isFeatureFlagEnabled: (flag: string) =>
    flag === "connections-channel" ? flagEnabled : false,
}));

const seededContacts: Array<{
  sourceChannel: string;
  externalUserId: string;
  externalChatId?: string;
}> = [];
const actualContactHelpers =
  await import("../../verification/contact-helpers.js");
mock.module("../../verification/contact-helpers.js", () => ({
  ...actualContactHelpers,
  upsertContactChannel: async (params: {
    sourceChannel: string;
    externalUserId: string;
    externalChatId?: string;
  }) => {
    seededContacts.push(params);
  },
}));

const forwarded: Array<{
  event: GatewayInboundEvent;
  options?: HandleInboundOptions;
}> = [];
let nextResult: InboundResult = { forwarded: true, rejected: false };
const actualHandleInbound = await import("../../handlers/handle-inbound.js");
mock.module("../../handlers/handle-inbound.js", () => ({
  ...actualHandleInbound,
  handleInbound: async (
    _config: GatewayConfig,
    event: GatewayInboundEvent,
    options?: HandleInboundOptions,
  ) => {
    forwarded.push({ event, options });
    return nextResult;
  },
}));

const { createConnectionsWebhookHandler } =
  await import("./connections-webhook.js");

const WEBHOOK_SECRET = "test-webhook-secret-1234";

class StubCredentialCache extends CredentialCache {
  readonly secret: string | undefined;

  constructor(secret: string | undefined) {
    super();
    this.secret = secret;
  }

  override async get(key: string): Promise<string | undefined> {
    return key === credentialKey("vellum", "webhook_secret")
      ? this.secret
      : undefined;
  }
}

const config: GatewayConfig = {
  assistantRuntimeBaseUrl: "http://localhost:7821",
  gatewayInternalBaseUrl: "http://127.0.0.1:7830",
  logFile: { dir: undefined, retentionDays: 30 },
  maxAttachmentBytes: { default: 50 * 1024 * 1024 },
  maxAttachmentConcurrency: 3,
  maxWebhookPayloadBytes: 1024 * 1024,
  port: 7830,
  routingEntries: [],
  runtimeInitialBackoffMs: 500,
  runtimeMaxRetries: 2,
  runtimeProxyRequireAuth: true,
  runtimeTimeoutMs: 30000,
  shutdownDrainMs: 5000,
  trustProxy: false,
};

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function deliveryBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    eventId: "evt-123",
    issuedAt: nowSeconds(),
    threadId: "thread-abc",
    sender: { userId: "user-123", displayName: "Alice", username: "alice" },
    text: "Hi, can you help me with something?",
    ...overrides,
  });
}

function signedRequest(body: string, secret = WEBHOOK_SECRET): Request {
  const signature =
    "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex");
  return new Request("http://127.0.0.1:7830/webhooks/connections", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "vellum-signature": signature,
    },
    body,
  });
}

/** `null` stores no webhook secret. */
function makeHandler(secret: string | null = WEBHOOK_SECRET) {
  return createConnectionsWebhookHandler(config, {
    credentials: new StubCredentialCache(secret ?? undefined),
  }).handler;
}

beforeEach(() => {
  flagEnabled = true;
  seededContacts.length = 0;
  forwarded.length = 0;
  nextResult = { forwarded: true, rejected: false };
});

describe("connections webhook", () => {
  test("is not found while the flag is off", async () => {
    flagEnabled = false;
    const res = await makeHandler()(signedRequest(deliveryBody()));

    expect(res.status).toBe(404);
    expect(forwarded).toHaveLength(0);
  });

  test("fails closed when no webhook secret is configured", async () => {
    const res = await makeHandler(null)(signedRequest(deliveryBody()));

    expect(res.status).toBe(409);
    expect(forwarded).toHaveLength(0);
    expect(seededContacts).toHaveLength(0);
  });

  test("rejects a delivery signed with another secret", async () => {
    const res = await makeHandler()(
      signedRequest(deliveryBody(), "some-other-secret"),
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
    expect(forwarded).toHaveLength(0);
    expect(seededContacts).toHaveLength(0);
  });

  test("rejects a correctly signed delivery issued outside the window", async () => {
    const res = await makeHandler()(
      signedRequest(deliveryBody({ issuedAt: nowSeconds() - 60 * 60 })),
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Stale delivery" });
    expect(forwarded).toHaveLength(0);
    expect(seededContacts).toHaveLength(0);
  });

  test("rejects a signed delivery missing a keyed field", async () => {
    const res = await makeHandler()(
      signedRequest(deliveryBody({ sender: { displayName: "Alice" } })),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid delivery" });
    expect(forwarded).toHaveLength(0);
    expect(seededContacts).toHaveLength(0);
  });

  test("seeds the sender and forwards through the channel gate with no reply callback", async () => {
    const res = await makeHandler()(signedRequest(deliveryBody()));

    expect(res.status).toBe(200);
    expect(forwarded).toHaveLength(1);
    const { event, options } = forwarded[0]!;
    expect(event.sourceChannel).toBe("connections");
    expect(event.actor.actorExternalId).toBe("user-123");
    expect(event.message.conversationExternalId).toBe("thread-abc");
    expect(options?.replyCallbackUrl).toBeUndefined();
    expect(options?.senderAuthenticated).toBe(true);

    expect(seededContacts).toEqual([
      expect.objectContaining({
        sourceChannel: "connections",
        externalUserId: "user-123",
      }),
    ]);
    expect(seededContacts[0]?.externalChatId).toBeUndefined();
  });

  test("returns the runtime's deny text for the platform to show the sender", async () => {
    nextResult = {
      forwarded: true,
      rejected: false,
      runtimeResponse: {
        accepted: true,
        duplicate: false,
        eventId: "runtime-evt-1",
        denied: true,
        reason: "member_pending",
        replyText: "I've let my guardian know you're trying to reach me.",
      },
    };

    const res = await makeHandler()(signedRequest(deliveryBody()));
    const body = (await res.json()) as { denied?: boolean; replyText?: string };

    expect(res.status).toBe(200);
    expect(body.denied).toBe(true);
    expect(body.replyText).toBe(
      "I've let my guardian know you're trying to reach me.",
    );
  });

  test("returns a gateway intercept reply in the response", async () => {
    nextResult = {
      forwarded: false,
      rejected: false,
      verificationIntercepted: true,
      verificationReplyText: "You're verified.",
    };

    const res = await makeHandler()(signedRequest(deliveryBody()));
    const body = (await res.json()) as {
      verificationIntercepted?: boolean;
      replyText?: string;
    };

    expect(res.status).toBe(200);
    expect(body.verificationIntercepted).toBe(true);
    expect(body.replyText).toBe("You're verified.");
  });

  test("forwards a repeated delivery once", async () => {
    const handler = makeHandler();
    const body = deliveryBody();

    await handler(signedRequest(body));
    const second = await handler(signedRequest(body));
    const secondBody = (await second.json()) as { duplicate?: boolean };

    expect(forwarded).toHaveLength(1);
    expect(secondBody.duplicate).toBe(true);
  });
});
