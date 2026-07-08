import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ChannelId } from "../../channels/types.js";

// Gateway guardian-delivery list: null = couldn't determine (gateway
// unreachable), [] = authoritatively no guardian, one active entry = bound.
let mockGuardianList: Array<Record<string, unknown>> | null = [];

// Both the async path (resolveLocalPrincipalTrustContext) and the sync
// resolveActorTrust read the same gateway delivery list — async via
// getGuardianDelivery, sync via the peek snapshot.
mock.module("../../contacts/guardian-delivery-reader.js", () => ({
  getGuardianDelivery: (_input?: { channelTypes?: string[] }) =>
    Promise.resolve(mockGuardianList),
  peekCachedGuardianDelivery: (input?: { channelTypes?: string[] }) => {
    if (mockGuardianList == null) return undefined;
    if (!input?.channelTypes) return mockGuardianList;
    return mockGuardianList.filter((g) =>
      input.channelTypes!.includes(g.channelType as string),
    );
  },
  guardianForChannel: (
    list: Array<Record<string, unknown>>,
    channelType: string,
  ) => list.find((g) => g.channelType === channelType && g.status === "active"),
}));

const { resolveLocalPrincipalTrustContext } = await import(
  "../local-principal-trust.js"
);
const { resolveActorTrust, toTrustContext } = await import(
  "../actor-trust-resolver.js"
);

const SOURCE_CHANNEL: ChannelId = "vellum";
const CONVERSATION_ID = "conv-1";
const GUARDIAN_PRINCIPAL_ID = "principal-guardian";
const GUARDIAN_ADDRESS = "guardian-address";
const GUARDIAN_CHAT_ID = "guardian-chat";

describe("resolveLocalPrincipalTrustContext", () => {
  beforeEach(() => {
    mockGuardianList = [];
  });

  test("principal matching the gateway guardian → guardian ctx", async () => {
    mockGuardianList = [
      {
        channelType: "vellum",
        contactId: "contact-1",
        principalId: GUARDIAN_PRINCIPAL_ID,
        address: GUARDIAN_ADDRESS,
        externalChatId: GUARDIAN_CHAT_ID,
        status: "active",
      },
    ];

    const ctx = await resolveLocalPrincipalTrustContext({
      actorPrincipalId: GUARDIAN_PRINCIPAL_ID,
      sourceChannel: SOURCE_CHANNEL,
      conversationExternalId: CONVERSATION_ID,
    });

    expect(ctx.trustClass).toBe("guardian");
    expect(ctx.guardianPrincipalId).toBe(GUARDIAN_PRINCIPAL_ID);
    expect(ctx.guardianExternalUserId).toBe(GUARDIAN_ADDRESS);
    expect(ctx.guardianChatId).toBe(GUARDIAN_CHAT_ID);
    expect(ctx.requesterExternalUserId).toBe(GUARDIAN_PRINCIPAL_ID);
    expect(ctx.requesterChatId).toBe(CONVERSATION_ID);
    expect(ctx.sourceChannel).toBe(SOURCE_CHANNEL);
  });

  test("guardian ctx is equivalent to the prior toTrustContext output", async () => {
    // The actor IS the guardian: its principal id is the guardian binding's
    // address (vellum canonicalization is pass-through) so the local resolver
    // classifies it guardian and we can compare the two outputs directly.
    mockGuardianList = [
      {
        channelType: "vellum",
        contactId: "contact-1",
        principalId: GUARDIAN_ADDRESS,
        address: GUARDIAN_ADDRESS,
        externalChatId: GUARDIAN_CHAT_ID,
        status: "active",
      },
    ];

    const expected = toTrustContext(
      resolveActorTrust({
        assistantId: "assistant-1",
        sourceChannel: SOURCE_CHANNEL,
        conversationExternalId: CONVERSATION_ID,
        actorExternalId: GUARDIAN_ADDRESS,
      }),
      CONVERSATION_ID,
    );

    const actual = await resolveLocalPrincipalTrustContext({
      actorPrincipalId: GUARDIAN_ADDRESS,
      sourceChannel: SOURCE_CHANNEL,
      conversationExternalId: CONVERSATION_ID,
    });

    expect(actual).toEqual(expected);
  });

  test("non-matching principal → unknown ctx", async () => {
    mockGuardianList = [
      {
        channelType: "vellum",
        contactId: "contact-1",
        principalId: GUARDIAN_PRINCIPAL_ID,
        address: GUARDIAN_ADDRESS,
        externalChatId: GUARDIAN_CHAT_ID,
        status: "active",
      },
    ];

    const ctx = await resolveLocalPrincipalTrustContext({
      actorPrincipalId: "principal-other",
      sourceChannel: SOURCE_CHANNEL,
      conversationExternalId: CONVERSATION_ID,
    });

    expect(ctx.trustClass).toBe("unknown");
    expect(ctx.requesterExternalUserId).toBe("principal-other");
    expect(ctx.requesterChatId).toBe(CONVERSATION_ID);
    expect(ctx.sourceChannel).toBe(SOURCE_CHANNEL);
    expect(ctx.guardianPrincipalId).toBeUndefined();
  });

  test("empty guardian list → unknown ctx", async () => {
    mockGuardianList = [];

    const ctx = await resolveLocalPrincipalTrustContext({
      actorPrincipalId: GUARDIAN_PRINCIPAL_ID,
      sourceChannel: SOURCE_CHANNEL,
      conversationExternalId: CONVERSATION_ID,
    });

    expect(ctx.trustClass).toBe("unknown");
  });

  test("null guardian list (gateway unreachable) → unknown (fail closed)", async () => {
    mockGuardianList = null;

    const ctx = await resolveLocalPrincipalTrustContext({
      actorPrincipalId: GUARDIAN_PRINCIPAL_ID,
      sourceChannel: SOURCE_CHANNEL,
      conversationExternalId: CONVERSATION_ID,
    });

    expect(ctx.trustClass).toBe("unknown");
    expect(ctx.requesterExternalUserId).toBe(GUARDIAN_PRINCIPAL_ID);
  });
});
