/**
 * Guardian-path classification in resolveActorTrust.
 *
 * Guardian anchoring comes solely from the gateway delivery cache snapshot
 * (peekCachedGuardianDelivery), never the local DB. A warm cache with an
 * active guardian for the channel classifies a matching sender as `guardian`;
 * a cold/expired cache fails closed (no guardian classification, no DB read).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ChannelId } from "../../channels/types.js";

// Mutable gateway delivery snapshot: undefined = cold/expired cache.
let mockGuardianList: Array<Record<string, unknown>> | undefined;

mock.module("../../contacts/guardian-delivery-reader.js", () => ({
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

// No member resolves: this suite only exercises the gateway-guardian path.
mock.module("../../contacts/contact-store.js", () => ({
  findContactByAddress: (_channelType: string, _address: string) => null,
}));

const { resolveActorTrust } = await import("../actor-trust-resolver.js");

const SOURCE_CHANNEL: ChannelId = "vellum";
const CONVERSATION_ID = "conv-1";
const GUARDIAN_ADDRESS = "guardian-address";
const GUARDIAN_PRINCIPAL_ID = "principal-guardian";
const GUARDIAN_CHAT_ID = "guardian-chat";

function activeGuardian(): Record<string, unknown> {
  return {
    channelType: SOURCE_CHANNEL,
    contactId: "contact-1",
    principalId: GUARDIAN_PRINCIPAL_ID,
    address: GUARDIAN_ADDRESS,
    externalChatId: GUARDIAN_CHAT_ID,
    status: "active",
  };
}

describe("resolveActorTrust — guardian path", () => {
  beforeEach(() => {
    mockGuardianList = undefined;
  });

  test("warm cache + matching sender → guardian", () => {
    mockGuardianList = [activeGuardian()];

    const ctx = resolveActorTrust({
      assistantId: "asst-1",
      sourceChannel: SOURCE_CHANNEL,
      conversationExternalId: CONVERSATION_ID,
      actorExternalId: GUARDIAN_ADDRESS,
    });

    expect(ctx.trustClass).toBe("guardian");
    expect(ctx.guardianPrincipalId).toBe(GUARDIAN_PRINCIPAL_ID);
    expect(ctx.guardianBindingMatch?.guardianExternalUserId).toBe(
      GUARDIAN_ADDRESS,
    );
    expect(ctx.guardianBindingMatch?.guardianDeliveryChatId).toBe(
      GUARDIAN_CHAT_ID,
    );
  });

  test("warm cache + non-matching sender → not guardian", () => {
    mockGuardianList = [activeGuardian()];

    const ctx = resolveActorTrust({
      assistantId: "asst-1",
      sourceChannel: SOURCE_CHANNEL,
      conversationExternalId: CONVERSATION_ID,
      actorExternalId: "someone-else",
    });

    expect(ctx.trustClass).toBe("unknown");
  });

  test("cold cache → fail-closed (not guardian, no binding)", () => {
    mockGuardianList = undefined;

    const ctx = resolveActorTrust({
      assistantId: "asst-1",
      sourceChannel: SOURCE_CHANNEL,
      conversationExternalId: CONVERSATION_ID,
      actorExternalId: GUARDIAN_ADDRESS,
    });

    expect(ctx.trustClass).toBe("unknown");
    expect(ctx.guardianBindingMatch).toBeNull();
    expect(ctx.guardianPrincipalId).toBeUndefined();
  });

  test("no active guardian for channel → fail-closed", () => {
    mockGuardianList = [{ ...activeGuardian(), status: "revoked" }];

    const ctx = resolveActorTrust({
      assistantId: "asst-1",
      sourceChannel: SOURCE_CHANNEL,
      conversationExternalId: CONVERSATION_ID,
      actorExternalId: GUARDIAN_ADDRESS,
    });

    expect(ctx.trustClass).toBe("unknown");
    expect(ctx.guardianBindingMatch).toBeNull();
  });
});
