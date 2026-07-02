/**
 * Invite redemption intercept tests for `handle-inbound.ts`:
 *
 *  - A valid 6-digit code (or /start iv_<token> deep link) from a non-member
 *    is redeemed at the gateway: no forward, reply delivered via the
 *    callback URL, gateway channel activated, daemon `invite_redeemed`
 *    info-mirror fired.
 *  - A bare 6-digit matching no invite falls through to normal forwarding.
 *  - Member senders and disabled channels are never intercepted.
 *  - A cross-channel code hit intercepts with the mismatch reply and
 *    consumes nothing.
 *  - The verification intercept wins when both could match.
 *
 * The gateway DB is real; the runtime client, verification intercept,
 * assistant IPC, and assistant DB proxy are mocked.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { hashInviteCode, hashInviteToken } from "@vellumai/gateway-client";

import type { GatewayConfig } from "../config.js";
import type {
  RuntimeInboundPayload,
  RuntimeInboundResponse,
} from "../runtime/client.js";
import type { GatewayInboundEvent } from "../types.js";

type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
let fetchCalls: { url: string; body: Record<string, unknown> }[] = [];
const fetchMock: ReturnType<typeof mock<FetchFn>> = mock(async (input, init) => {
  fetchCalls.push({
    url: String(input),
    body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
  });
  return new Response();
});

let runtimePayloads: RuntimeInboundPayload[] = [];
const forwardToRuntimeMock = mock(
  async (
    _config: GatewayConfig,
    payload: RuntimeInboundPayload,
  ): Promise<RuntimeInboundResponse> => {
    runtimePayloads.push(payload);
    return { accepted: true, duplicate: false, eventId: "runtime-event-1" };
  },
);

let interceptResult: { intercepted: boolean; [k: string]: unknown } = {
  intercepted: false,
};
const tryTextVerificationInterceptMock = mock(async () => interceptResult);

let ipcCalls: { method: string; params?: Record<string, unknown> }[] = [];
const ipcCallAssistantMock = mock(
  async (method: string, params?: Record<string, unknown>) => {
    ipcCalls.push({ method, params });
    return { ok: true };
  },
);

mock.module("../fetch.js", () => ({
  fetchImpl: (...args: Parameters<FetchFn>) => fetchMock(...args),
}));

mock.module("../runtime/client.js", () => ({
  CircuitBreakerOpenError: class CircuitBreakerOpenError extends Error {
    readonly retryAfterSecs: number;
    constructor(retryAfterSecs: number) {
      super("Circuit breaker is open");
      this.retryAfterSecs = retryAfterSecs;
    }
  },
  forwardToRuntime: (...args: Parameters<typeof forwardToRuntimeMock>) =>
    forwardToRuntimeMock(...args),
  // Not exercised here, but mock.module bleeds across files in a combined
  // `bun test` run — keep the surface a superset of what other files import.
  resetConversation: async () => {},
}));

mock.module("../verification/text-verification.js", () => ({
  tryTextVerificationIntercept: (...args: unknown[]) =>
    tryTextVerificationInterceptMock(...(args as [])),
}));

// Spread the actual module so untouched exports (IpcHandlerError,
// IpcTransportError, ipcSuggestTrustRule) stay importable by later-loaded
// files when suites share a bun process.
const actualAssistantClient = await import("../ipc/assistant-client.js");
mock.module("../ipc/assistant-client.js", () => ({
  ...actualAssistantClient,
  ipcCallAssistant: (...args: Parameters<typeof ipcCallAssistantMock>) =>
    ipcCallAssistantMock(...args),
}));

// The redemption engine's ACL side effect dual-writes an assistant-DB info
// mirror; stub it so tests never touch a socket. Mutable impls let tests
// simulate a down assistant DB proxy.
let assistantDbQueryImpl: () => Promise<unknown[]> = async () => [];
let assistantDbRunImpl: () => Promise<void> = async () => {};
mock.module("../db/assistant-db-proxy.js", () => ({
  assistantDbQuery: () => assistantDbQueryImpl(),
  assistantDbRun: () => assistantDbRunImpl(),
}));

await import("./test-preload.js");
const { initGatewayDb, resetGatewayDb, getGatewayDb } = await import(
  "../db/connection.js"
);
const {
  initAdmissionPolicyCache,
  resetAdmissionPolicyCache,
} = await import("../risk/admission-policy-cache.js");
const { contacts, contactChannels, ingressInvites } = await import(
  "../db/schema.js"
);
const { ContactStore } = await import("../db/contact-store.js");
const { handleInbound } = await import("../handlers/handle-inbound.js");

const CHANNEL = "telegram";
const CODE = "123456";
const TOKEN = "tok_raw_abc123";
const REPLY_URL = "http://127.0.0.1:7830/deliver/telegram";

function seedContact(id: string): void {
  const now = Date.now();
  getGatewayDb()
    .insert(contacts)
    .values({
      id,
      displayName: `name-${id}`,
      role: "contact",
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function seedChannel(args: {
  contactId: string;
  address: string;
  status?: string;
}): void {
  const now = Date.now();
  getGatewayDb()
    .insert(contactChannels)
    .values({
      id: crypto.randomUUID(),
      contactId: args.contactId,
      type: CHANNEL,
      address: args.address,
      externalChatId: "chat-1",
      status: args.status ?? "active",
      policy: "allow",
      interactionCount: 0,
      createdAt: now,
    })
    .run();
}

function seedInvite(overrides: { sourceChannel?: string } = {}): string {
  const id = crypto.randomUUID();
  new ContactStore().createInvite({
    id,
    sourceChannel: overrides.sourceChannel ?? CHANNEL,
    inviteCodeHash: hashInviteCode(CODE),
    tokenHash: hashInviteToken(TOKEN),
    contactId: "c1",
    maxUses: 1,
    expiresAt: Date.now() + 60_000,
  });
  return id;
}

function inviteRow(id: string) {
  return new ContactStore().getInviteById(id)!;
}

function makeConfig(): GatewayConfig {
  return {
    assistantRuntimeBaseUrl: "http://localhost:7821",
    defaultAssistantId: "default-assistant",
    gatewayInternalBaseUrl: "http://127.0.0.1:7830",
    logFile: { dir: undefined, retentionDays: 30 },
    maxAttachmentBytes: { default: 50 * 1024 * 1024 },
    maxAttachmentConcurrency: 3,
    maxWebhookPayloadBytes: 1048576,
    port: 7830,
    routingEntries: [],
    runtimeInitialBackoffMs: 500,
    runtimeMaxRetries: 2,
    runtimeProxyRequireAuth: false,
    runtimeTimeoutMs: 30000,
    shutdownDrainMs: 5000,
    unmappedPolicy: "default",
    trustProxy: false,
  } as unknown as GatewayConfig;
}

function makeEvent(
  overrides: Record<string, unknown> = {},
): GatewayInboundEvent {
  return {
    sourceChannel: CHANNEL,
    source: { updateId: "u1", messageId: "m1", chatType: "private" },
    actor: {
      actorExternalId: "U_SENDER",
      displayName: "Sender Name",
      username: "sender",
    },
    message: {
      conversationExternalId: "chat-sender",
      externalMessageId: "extmsg-1",
      content: CODE,
    },
    ...overrides,
  } as GatewayInboundEvent;
}

const ROUTING = {
  routingOverride: { assistantId: "asst-1", routeSource: "default" as const },
};

beforeEach(async () => {
  resetGatewayDb();
  resetAdmissionPolicyCache();
  await initGatewayDb();
  getGatewayDb().delete(ingressInvites).run();
  getGatewayDb().delete(contactChannels).run();
  getGatewayDb().delete(contacts).run();
  initAdmissionPolicyCache();
  runtimePayloads = [];
  fetchCalls = [];
  ipcCalls = [];
  forwardToRuntimeMock.mockClear();
  interceptResult = { intercepted: false };
  assistantDbQueryImpl = async () => [];
  assistantDbRunImpl = async () => {};
});

afterEach(() => {
  resetAdmissionPolicyCache();
  resetGatewayDb();
});

describe("handle-inbound invite redemption intercept", () => {
  test("valid 6-digit code from a non-member: redeems, replies, does not forward, fires invite_redeemed", async () => {
    seedContact("c1");
    const inviteId = seedInvite();

    const result = await handleInbound(makeConfig(), makeEvent(), {
      ...ROUTING,
      replyCallbackUrl: REPLY_URL,
    });

    expect(result.inviteIntercepted).toBe(true);
    expect(result.forwarded).toBe(false);
    expect(result.rejected).toBe(false);
    expect(forwardToRuntimeMock).toHaveBeenCalledTimes(0);

    // Reply delivered via the callback URL (no pending reply text).
    expect(result.inviteReplyText).toBeUndefined();
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe(REPLY_URL);
    expect(fetchCalls[0]!.body.text).toBe(
      "Welcome! You've been granted access.",
    );

    // Redemption landed: use consumed, gateway channel active.
    expect(inviteRow(inviteId).useCount).toBe(1);
    const channel = getGatewayDb().select().from(contactChannels).all()[0];
    expect(channel?.status).toBe("active");
    expect(channel?.verifiedVia).toBe("invite");

    // Daemon info-mirror fired best-effort with the outcome.
    const mirror = ipcCalls.find((c) => c.method === "invite_redeemed");
    expect(mirror).toBeDefined();
    expect(mirror!.params!.body).toMatchObject({
      inviteId,
      contactId: "c1",
      sourceChannel: CHANNEL,
      memberExternalUserId: "U_SENDER",
      result: "redeemed",
    });
  });

  test("reply delivery failure after a successful claim: intercept stands, no forward", async () => {
    seedContact("c1");
    const inviteId = seedInvite();
    fetchMock.mockImplementationOnce(async () => {
      throw new Error("provider send failed");
    });

    const result = await handleInbound(makeConfig(), makeEvent(), {
      ...ROUTING,
      replyCallbackUrl: REPLY_URL,
    });

    // The claim + ACL side effect are committed; a failed reply send must not
    // surface as an error or fall through to normal forwarding.
    expect(result.inviteIntercepted).toBe(true);
    expect(result.forwarded).toBe(false);
    expect(forwardToRuntimeMock).toHaveBeenCalledTimes(0);
    expect(inviteRow(inviteId).useCount).toBe(1);
    const channel = getGatewayDb().select().from(contactChannels).all()[0];
    expect(channel?.status).toBe("active");
  });

  test("without a replyCallbackUrl the reply text is surfaced on the result", async () => {
    seedContact("c1");
    seedInvite();

    const result = await handleInbound(makeConfig(), makeEvent(), ROUTING);

    expect(result.inviteIntercepted).toBe(true);
    expect(result.inviteReplyText).toBe("Welcome! You've been granted access.");
    expect(fetchCalls).toHaveLength(0);
  });

  test("/start iv_<token> deep link (commandIntent) redeems at the gateway", async () => {
    seedContact("c1");
    const inviteId = seedInvite();

    const result = await handleInbound(
      makeConfig(),
      makeEvent({
        message: {
          conversationExternalId: "chat-sender",
          externalMessageId: "extmsg-1",
          content: `/start iv_${TOKEN}`,
        },
      }),
      {
        ...ROUTING,
        replyCallbackUrl: REPLY_URL,
        sourceMetadata: {
          commandIntent: { type: "start", payload: `iv_${TOKEN}` },
        },
      },
    );

    expect(result.inviteIntercepted).toBe(true);
    expect(forwardToRuntimeMock).toHaveBeenCalledTimes(0);
    expect(inviteRow(inviteId).useCount).toBe(1);
  });

  test("bare 6-digit matching no invite falls through to normal forwarding", async () => {
    seedContact("c1");

    const result = await handleInbound(makeConfig(), makeEvent(), ROUTING);

    expect(result.inviteIntercepted).toBeUndefined();
    expect(result.forwarded).toBe(true);
    expect(forwardToRuntimeMock).toHaveBeenCalledTimes(1);
  });

  test("member sender is NOT intercepted — the bare 6-digit forwards normally", async () => {
    seedContact("c1");
    seedChannel({ contactId: "c1", address: "U_SENDER", status: "active" });
    const inviteId = seedInvite();

    const result = await handleInbound(makeConfig(), makeEvent(), ROUTING);

    expect(result.inviteIntercepted).toBeUndefined();
    expect(result.forwarded).toBe(true);
    expect(inviteRow(inviteId).useCount).toBe(0);
  });

  test("disabled channel is NOT intercepted", async () => {
    seedContact("c1");
    const inviteId = seedInvite({ sourceChannel: "phone" });

    const result = await handleInbound(
      makeConfig(),
      makeEvent({ sourceChannel: "phone" }),
      ROUTING,
    );

    expect(result.inviteIntercepted).toBeUndefined();
    expect(result.forwarded).toBe(true);
    expect(inviteRow(inviteId).useCount).toBe(0);
  });

  test("cross-channel code hit: intercepts with the mismatch reply, consumes nothing", async () => {
    seedContact("c1");
    const inviteId = seedInvite({ sourceChannel: "whatsapp" });

    const result = await handleInbound(makeConfig(), makeEvent(), {
      ...ROUTING,
      replyCallbackUrl: REPLY_URL,
    });

    expect(result.inviteIntercepted).toBe(true);
    expect(forwardToRuntimeMock).toHaveBeenCalledTimes(0);
    expect(fetchCalls[0]!.body.text).toBe(
      "This invite is not valid for this channel.",
    );
    expect(inviteRow(inviteId).useCount).toBe(0);
    expect(ipcCalls.find((c) => c.method === "invite_redeemed")).toBeUndefined();
  });

  test("blocked sender with a valid code: intercepted failure, channel stays blocked", async () => {
    seedContact("c1");
    seedChannel({ contactId: "c1", address: "U_SENDER", status: "blocked" });
    const inviteId = seedInvite();

    const result = await handleInbound(makeConfig(), makeEvent(), {
      ...ROUTING,
      replyCallbackUrl: REPLY_URL,
    });

    expect(result.inviteIntercepted).toBe(true);
    expect(fetchCalls[0]!.body.text).toBe("This invite is no longer valid.");
    expect(inviteRow(inviteId).useCount).toBe(0);
    const channel = getGatewayDb().select().from(contactChannels).all()[0];
    expect(channel?.status).toBe("blocked");
    expect(ipcCalls.find((c) => c.method === "invite_redeemed")).toBeUndefined();
  });

  test("assistant DB proxy down: valid code still redeems with the success reply, never forwards", async () => {
    seedContact("c1");
    const inviteId = seedInvite();
    assistantDbQueryImpl = async () => {
      throw new Error("assistant IPC unavailable");
    };
    assistantDbRunImpl = async () => {
      throw new Error("assistant IPC unavailable");
    };

    const result = await handleInbound(makeConfig(), makeEvent(), {
      ...ROUTING,
      replyCallbackUrl: REPLY_URL,
    });

    // The mirror is best-effort: the raw code must never reach the runtime
    // once the gateway claimed the use.
    expect(result.inviteIntercepted).toBe(true);
    expect(result.forwarded).toBe(false);
    expect(forwardToRuntimeMock).toHaveBeenCalledTimes(0);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.body.text).toBe(
      "Welcome! You've been granted access.",
    );

    expect(inviteRow(inviteId).useCount).toBe(1);
    const channel = getGatewayDb().select().from(contactChannels).all()[0];
    expect(channel?.status).toBe("active");
    expect(channel?.verifiedVia).toBe("invite");
  });

  test("verification intercept wins when both could match", async () => {
    seedContact("c1");
    const inviteId = seedInvite();
    interceptResult = {
      intercepted: true,
      outcome: "verified",
      trustClass: "trusted_contact",
      pendingReplyText: "Verified!",
    };

    const result = await handleInbound(makeConfig(), makeEvent(), ROUTING);

    expect(result.verificationIntercepted).toBe(true);
    expect(result.inviteIntercepted).toBeUndefined();
    expect(inviteRow(inviteId).useCount).toBe(0);
    expect(forwardToRuntimeMock).toHaveBeenCalledTimes(0);
  });
});
