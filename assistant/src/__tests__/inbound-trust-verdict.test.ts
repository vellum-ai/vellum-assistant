/**
 * The inbound text path builds `trustCtx` from the gateway-stamped
 * `sourceMetadata.trustVerdict` via `trustContextFromVerdict`. Admission follows
 * the trust class + floor, and the Slack requester timezone attaches to the
 * resulting context.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../config/env.js", () => ({ isHttpAuthDisabled: () => true }));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Enable the channel-trust-floors flag so the admission-policy stage runs.
mock.module("../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: (key: string) =>
    key === "channel-trust-floors",
}));

mock.module("../runtime/gateway-client.js", () => ({
  deliverChannelReply: async () => {},
}));

import type { TrustVerdict } from "@vellumai/gateway-client";

import type { TrustContext } from "../daemon/trust-context-types.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { messages } from "../persistence/schema/index.js";
import {
  handleChannelInbound,
  setAdapterProcessMessage,
} from "./helpers/channel-test-adapter.js";

await initializeDb();

function resetTables(): void {
  const db = getDb();
  db.run("DELETE FROM channel_inbound_events");
  db.run("DELETE FROM canonical_guardian_requests");
  db.run("DELETE FROM conversation_keys");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
  db.run("DELETE FROM external_conversation_bindings");
  db.run("DELETE FROM contact_channels");
  db.run("DELETE FROM contacts");
}

/** Capture the `trustContext` the handler dispatches to the agent loop. */
function captureTrustContextProcessor(captured: { ctx?: TrustContext }) {
  return async (
    conversationId: string,
    _content: string,
    options?: Record<string, unknown>,
  ) => {
    captured.ctx = options?.trustContext as TrustContext | undefined;
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
  };
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
      content: "hello",
      actorExternalId: "user-1",
      replyCallbackUrl: "https://gateway.test/deliver/telegram",
      sourceMetadata,
      ...overrides,
    }),
  });
}

/** A full member verdict (ACL passes) for the given trust class. */
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
    memberDisplayName: "Member One",
    ...overrides,
  } satisfies TrustVerdict;
}

describe("inbound trust verdict → TrustContext", () => {
  beforeEach(() => {
    resetTables();
    setAdapterProcessMessage(undefined);
  });

  test("guardian verdict admits with guardian-class trustCtx and guardian fields", async () => {
    const verdict = memberVerdict("guardian", {
      guardianExternalUserId: "user-1",
      guardianDeliveryChatId: "guardian-chat-1",
      guardianPrincipalId: "vellum-principal-1",
    });

    const captured: { ctx?: TrustContext } = {};
    setAdapterProcessMessage(captureTrustContextProcessor(captured));
    const res = await handleChannelInbound(
      makeInboundRequest({
        trustVerdict: verdict,
        admissionPolicy: "trusted_contacts",
      }),
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.accepted).toBe(true);
    expect(body.denied).toBeUndefined();

    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(captured.ctx?.trustClass).toBe("guardian");
    expect(captured.ctx?.guardianExternalUserId).toBe("user-1");
    expect(captured.ctx?.guardianChatId).toBe("guardian-chat-1");
    expect(captured.ctx?.guardianPrincipalId).toBe("vellum-principal-1");
  });

  test("trusted_contact admitted under a trusted_contacts floor", async () => {
    const captured: { ctx?: TrustContext } = {};
    setAdapterProcessMessage(captureTrustContextProcessor(captured));
    const res = await handleChannelInbound(
      makeInboundRequest({
        trustVerdict: memberVerdict("trusted_contact"),
        admissionPolicy: "trusted_contacts",
      }),
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.accepted).toBe(true);
    expect(body.denied).toBeUndefined();

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(captured.ctx?.trustClass).toBe("trusted_contact");
  });

  test("trusted_contact denied under a guardian_only floor", async () => {
    const res = await handleChannelInbound(
      makeInboundRequest({
        trustVerdict: memberVerdict("trusted_contact"),
        admissionPolicy: "guardian_only",
      }),
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.accepted).toBe(true);
    expect(body.denied).toBe(true);
    expect(body.reason).toBe("admission_policy_guardian_only");
  });

  test("present unknown (stranger) verdict admitted under a strangers floor", async () => {
    const captured: { ctx?: TrustContext } = {};
    setAdapterProcessMessage(captureTrustContextProcessor(captured));
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
    expect(body.accepted).toBe(true);
    expect(body.denied).toBeUndefined();

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(captured.ctx?.trustClass).toBe("unknown");
  });

  test("present unknown (stranger) verdict denied under a trusted_contacts floor", async () => {
    const res = await handleChannelInbound(
      makeInboundRequest({
        trustVerdict: {
          trustClass: "unknown",
          canonicalSenderId: "user-1",
        } satisfies TrustVerdict,
        admissionPolicy: "trusted_contacts",
      }),
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.accepted).toBe(true);
    expect(body.denied).toBe(true);
    expect(body.reason).toBe("not_a_member");
  });

  test("slack requester timezone is attached to the verdict-sourced trustCtx", async () => {
    const captured: { ctx?: TrustContext } = {};
    setAdapterProcessMessage(captureTrustContextProcessor(captured));
    const res = await handleChannelInbound(
      makeInboundRequest(
        {
          trustVerdict: memberVerdict("trusted_contact", {
            type: "slack",
            externalChatId: "slack-chan-1",
          }),
          admissionPolicy: "trusted_contacts",
          timezone: "America/New_York",
          timezoneLabel: "ET",
          timezoneOffsetSeconds: -18000,
        },
        {
          sourceChannel: "slack",
          interface: "slack",
          conversationExternalId: "slack-chan-1",
          replyCallbackUrl: "https://gateway.test/deliver/slack",
        },
      ),
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.accepted).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(captured.ctx?.trustClass).toBe("trusted_contact");
    expect(captured.ctx?.requesterTimezone).toBe("America/New_York");
    expect(captured.ctx?.requesterTimezoneLabel).toBe("ET");
    expect(captured.ctx?.requesterTimezoneOffsetSeconds).toBe(-18000);
  });
});
