/**
 * Introduction nudge on first admit: a floor-admitted sender the guardian has
 * never classified gets an introduction card (informationally — the turn
 * proceeds), at most once per (assistant, channel, actor, conversation).
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => true,
  getGatewayInternalBaseUrl: () => "http://127.0.0.1:7830",
}));

// Enable the channel-trust-floors flag so the admission-policy stage runs.
mock.module("../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: (key: string) =>
    key === "channel-trust-floors",
}));

mock.module("../runtime/gateway-client.js", () => ({
  deliverChannelReply: async () => {},
}));

// Track emitNotificationSignal calls so trigger/urgency can be asserted.
const emitSignalCalls: Array<Record<string, unknown>> = [];
mock.module("../notifications/emit-signal.js", () => ({
  emitNotificationSignal: async (params: Record<string, unknown>) => {
    emitSignalCalls.push(params);
    return {
      signalId: "mock-signal-id",
      deduplicated: false,
      dispatched: true,
      reason: "mock",
      deliveryResults: [],
    };
  },
}));

// Guardian resolution: serve a vellum anchor so guardian access requests can
// bind a principal (creation requires one for decisionable kinds).
interface GatewayGuardian {
  contactId: string;
  principalId?: string | null;
  displayName?: string | null;
  channelType: string;
  address: string;
  externalChatId?: string | null;
  status: string;
  verifiedAt?: number | null;
}
let gatewayGuardians: GatewayGuardian[] = [];
mock.module("../contacts/guardian-delivery-reader.js", () => ({
  getGuardianDelivery: async () => gatewayGuardians,
  guardianForChannel: (list: GatewayGuardian[], channelType: string) =>
    list.find((g) => g.channelType === channelType && g.status === "active"),
}));

import type { TrustVerdict } from "@vellumai/gateway-client";

import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { messages } from "../persistence/schema/index.js";
import {
  handleChannelInbound,
  setAdapterProcessMessage,
} from "./helpers/channel-test-adapter.js";
import { createGuardianBinding } from "./helpers/create-guardian-binding.js";
import { bridgeState } from "./helpers/gateway-guardian-requests-store-bridge.js";

await initializeDb();

function resetState(): void {
  bridgeState.reset();
  const db = getDb();
  db.run("DELETE FROM channel_inbound_events");
  db.run("DELETE FROM notification_events");
  db.run("DELETE FROM conversation_keys");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
  db.run("DELETE FROM external_conversation_bindings");
  db.run("DELETE FROM contact_channels");
  db.run("DELETE FROM contacts");
  emitSignalCalls.length = 0;
  gatewayGuardians = [];

  const principalId = `vellum-principal-${crypto.randomUUID()}`;
  gatewayGuardians.push({
    contactId: "c-vellum",
    channelType: "vellum",
    address: principalId,
    principalId,
    displayName: principalId,
    status: "active",
  });
  createGuardianBinding({
    channel: "vellum",
    guardianExternalUserId: principalId,
    guardianDeliveryChatId: "local",
    guardianPrincipalId: principalId,
    verifiedVia: "bootstrap",
  });
}

/** Minimal processor so admitted turns dispatch cleanly. */
function installNoopProcessor(): void {
  setAdapterProcessMessage(async (conversationId: string) => {
    const messageId = `msg-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    getDb()
      .insert(messages)
      .values({
        id: messageId,
        conversationId,
        role: "user",
        content: JSON.stringify([{ type: "text", text: "hello" }]),
        createdAt: Date.now(),
      })
      .run();
    return { messageId };
  });
}

function makeInboundRequest(
  sourceMetadata: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Request {
  return new Request("http://localhost/channels/inbound", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Gateway-Origin": "test-token",
    },
    body: JSON.stringify({
      sourceChannel: "telegram",
      interface: "telegram",
      conversationExternalId: "chat-123",
      externalMessageId: `msg-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`,
      content: "hello there",
      actorExternalId: "user-1",
      actorDisplayName: "User One",
      replyCallbackUrl: "https://gateway.test/deliver/telegram",
      sourceMetadata,
      ...overrides,
    }),
  });
}

function memberVerdict(
  trustClass: TrustVerdict["trustClass"],
  overrides: Partial<TrustVerdict> = {},
): TrustVerdict {
  return {
    trustClass,
    canonicalSenderId: "user-1",
    contactId: "contact-1",
    channelId: "channel-1",
    type: "telegram",
    address: "user-1",
    externalChatId: "chat-123",
    status: "active",
    policy: "allow",
    memberDisplayName: "User One",
    ...overrides,
  } satisfies TrustVerdict;
}

function unverifiedVerdict(): TrustVerdict {
  return memberVerdict("unverified_contact", { status: "unverified" });
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 300));
}

function accessRequests() {
  return [...bridgeState.requests.values()].filter(
    (row) => row.kind === "access_request",
  );
}

describe("introduction nudge on first admit", () => {
  beforeEach(() => {
    resetState();
    installNoopProcessor();
  });

  test("unverified_contact admitted under any_contact fires one admitted-mode card", async () => {
    const res = await handleChannelInbound(
      makeInboundRequest({
        trustVerdict: unverifiedVerdict(),
        admissionPolicy: "any_contact",
      }),
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.accepted).toBe(true);
    expect(body.denied).toBeUndefined();

    await settle();
    const requests = accessRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0].questionText).toContain("was admitted");
    expect(requests[0].status).toBe("pending");

    const signal = emitSignalCalls.find(
      (call) => call.sourceEventName === "ingress.access_request",
    );
    expect(signal).toBeDefined();
    expect((signal!.contextPayload as Record<string, unknown>).trigger).toBe(
      "admitted",
    );
    expect((signal!.attentionHints as Record<string, unknown>).urgency).toBe(
      "medium",
    );
  });

  test("repeat message in the same conversation does not re-nudge", async () => {
    await handleChannelInbound(
      makeInboundRequest({
        trustVerdict: unverifiedVerdict(),
        admissionPolicy: "any_contact",
      }),
    );
    await settle();
    expect(accessRequests()).toHaveLength(1);

    await handleChannelInbound(
      makeInboundRequest({
        trustVerdict: unverifiedVerdict(),
        admissionPolicy: "any_contact",
      }),
    );
    await settle();
    expect(accessRequests()).toHaveLength(1);
  });

  test("trusted_contact admitted under any_contact does not nudge", async () => {
    const res = await handleChannelInbound(
      makeInboundRequest({
        trustVerdict: memberVerdict("trusted_contact"),
        admissionPolicy: "any_contact",
      }),
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.denied).toBeUndefined();

    await settle();
    expect(accessRequests()).toHaveLength(0);
  });

  test("unknown sender admitted under strangers fires the nudge", async () => {
    const res = await handleChannelInbound(
      makeInboundRequest({
        trustVerdict: {
          trustClass: "unknown",
          canonicalSenderId: "user-1",
        } satisfies TrustVerdict,
        admissionPolicy: "strangers",
      }),
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.denied).toBeUndefined();

    await settle();
    const requests = accessRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0].questionText).toContain("was admitted");
  });

  test("floor-denied senders get the deny-path card, not the admitted variant", async () => {
    const res = await handleChannelInbound(
      makeInboundRequest({
        trustVerdict: unverifiedVerdict(),
        admissionPolicy: "trusted_contacts",
      }),
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.denied).toBe(true);

    await settle();
    const requests = accessRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0].questionText).toContain("requesting access");

    const signal = emitSignalCalls.find(
      (call) => call.sourceEventName === "ingress.access_request",
    );
    expect(signal).toBeDefined();
    expect(
      "trigger" in (signal!.contextPayload as Record<string, unknown>),
    ).toBe(false);
    expect((signal!.attentionHints as Record<string, unknown>).urgency).toBe(
      "high",
    );
  });
});
