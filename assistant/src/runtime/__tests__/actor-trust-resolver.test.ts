/**
 * Pins the residual sync resolver: guardian-or-unknown from the cached
 * guardian delivery snapshot, no member classification. Member ACL trust
 * (trusted_contact / unverified_contact) is verdict-only — pinned by
 * `trust-verdict-consumer.test.ts`.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

let mockGuardianList: Array<Record<string, unknown>> | undefined = [];

mock.module("../../contacts/guardian-delivery-reader.js", () => ({
  peekCachedGuardianDelivery: () => mockGuardianList,
  guardianForChannel: (
    list: Array<Record<string, unknown>>,
    channelType: string,
  ) => list.find((g) => g.channelType === channelType && g.status === "active"),
}));

const { resolveActorTrust } = await import("../actor-trust-resolver.js");
const { __resetMemberVerdictCacheForTest, setMemberVerdict } = await import(
  "../member-verdict-cache.js"
);

const GUARDIAN_ADDRESS = "vellum-principal-guardian";

function guardianDelivery(): Record<string, unknown> {
  return {
    channelType: "vellum",
    contactId: "guardian-contact",
    principalId: GUARDIAN_ADDRESS,
    address: GUARDIAN_ADDRESS,
    externalChatId: "guardian-chat",
    status: "active",
  };
}

describe("resolveActorTrust", () => {
  beforeEach(() => {
    mockGuardianList = [];
    __resetMemberVerdictCacheForTest();
  });

  test("sender matching the cached guardian delivery → guardian", () => {
    mockGuardianList = [guardianDelivery()];

    const result = resolveActorTrust({
      assistantId: "self",
      sourceChannel: "vellum",
      conversationExternalId: "local",
      actorExternalId: GUARDIAN_ADDRESS,
    });

    expect(result.trustClass).toBe("guardian");
    expect(result.guardianBindingMatch?.guardianExternalUserId).toBe(
      GUARDIAN_ADDRESS,
    );
    expect(result.guardianPrincipalId).toBe(GUARDIAN_ADDRESS);
    expect(result.actorMetadata.trustStatus).toBe("guardian");
  });

  test("non-guardian sender → unknown even with a warmed member-verdict entry", () => {
    // Member classification is verdict-only: the resolver must not read the
    // member-verdict cache or elevate past unknown.
    mockGuardianList = [guardianDelivery()];
    setMemberVerdict("vellum", "some-other-principal", {
      trustClass: "unknown",
      canonicalSenderId: "some-other-principal",
      contactId: "contact-1",
      channelId: "channel-1",
      status: "active",
      policy: "allow",
    });

    const result = resolveActorTrust({
      assistantId: "self",
      sourceChannel: "vellum",
      conversationExternalId: "local",
      actorExternalId: "some-other-principal",
    });

    expect(result.trustClass).toBe("unknown");
    expect(result.memberRecord).toBeNull();
    // The guardian binding is still surfaced for routing even on a non-match.
    expect(result.guardianBindingMatch?.guardianExternalUserId).toBe(
      GUARDIAN_ADDRESS,
    );
  });

  test("cold guardian cache → unknown (no binding match)", () => {
    mockGuardianList = undefined;

    const result = resolveActorTrust({
      assistantId: "self",
      sourceChannel: "vellum",
      conversationExternalId: "local",
      actorExternalId: GUARDIAN_ADDRESS,
    });

    expect(result.trustClass).toBe("unknown");
    expect(result.guardianBindingMatch).toBeNull();
  });

  test("no sender identity → unknown with null canonicalSenderId", () => {
    mockGuardianList = [guardianDelivery()];

    const result = resolveActorTrust({
      assistantId: "self",
      sourceChannel: "vellum",
      conversationExternalId: "local",
      actorExternalId: "   ",
    });

    expect(result.trustClass).toBe("unknown");
    expect(result.canonicalSenderId).toBeNull();
    expect(result.memberRecord).toBeNull();
  });

  test("sender metadata passes through; identifier prefers @username", () => {
    const result = resolveActorTrust({
      assistantId: "self",
      sourceChannel: "vellum",
      conversationExternalId: "local",
      actorExternalId: "principal-x",
      actorUsername: "alice",
      actorDisplayName: "Alice",
    });

    expect(result.actorMetadata.identifier).toBe("@alice");
    expect(result.actorMetadata.displayName).toBe("Alice");
    expect(result.actorMetadata.senderDisplayName).toBe("Alice");
    expect(result.actorMetadata.memberDisplayName).toBeUndefined();
  });
});
