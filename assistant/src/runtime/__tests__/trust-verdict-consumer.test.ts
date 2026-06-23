import { describe, expect, test } from "bun:test";

import type { TrustVerdict } from "@vellumai/gateway-client";

import type { ActorTrustContext } from "../actor-trust-resolver.js";
import { toTrustContext } from "../actor-trust-resolver.js";
import {
  resolvedMemberFromVerdict,
  trustContextFromVerdict,
} from "../trust-verdict-consumer.js";

const CONV = "conv-123";

describe("trustContextFromVerdict", () => {
  test("guardian verdict maps trust + guardian fields and is byte-identical to toTrustContext", () => {
    const verdict = {
      trustClass: "guardian",
      canonicalSenderId: "+15550100",
      guardianExternalUserId: "+15550100",
      guardianDeliveryChatId: "chat-9",
      guardianPrincipalId: "vellum-principal-abc",
      memberDisplayName: "Alice",
    } satisfies TrustVerdict;

    const result = trustContextFromVerdict(verdict, {
      sourceChannel: "phone",
      conversationExternalId: CONV,
      actorUsername: "alice",
      actorDisplayName: "Alice Sender",
    });

    expect(result.trustClass).toBe("guardian");
    expect(result.requesterExternalUserId).toBe("+15550100");
    expect(result.guardianExternalUserId).toBe("+15550100");
    expect(result.guardianChatId).toBe("chat-9");
    expect(result.guardianPrincipalId).toBe("vellum-principal-abc");
    // memberDisplayName wins over sender display name.
    expect(result.requesterDisplayName).toBe("Alice");
    expect(result.requesterIdentifier).toBe("@alice");

    const equivalent: ActorTrustContext = {
      canonicalSenderId: "+15550100",
      guardianBindingMatch: {
        guardianExternalUserId: "+15550100",
        guardianDeliveryChatId: "chat-9",
      },
      guardianPrincipalId: "vellum-principal-abc",
      memberRecord: null,
      trustClass: "guardian",
      actorMetadata: {
        identifier: "@alice",
        displayName: "Alice",
        senderDisplayName: "Alice Sender",
        memberDisplayName: "Alice",
        username: "alice",
        channel: "phone",
        trustStatus: "guardian",
      },
    };
    expect(result).toEqual(toTrustContext(equivalent, CONV));
  });

  test("identifier falls back to canonicalSenderId when no username", () => {
    const verdict = {
      trustClass: "trusted_contact",
      canonicalSenderId: "+15550101",
      memberDisplayName: "Bob",
    } satisfies TrustVerdict;

    const result = trustContextFromVerdict(verdict, {
      sourceChannel: "phone",
      conversationExternalId: CONV,
    });

    expect(result.requesterIdentifier).toBe("+15550101");
    // No memberDisplayName/sender override -> memberDisplayName used.
    expect(result.requesterDisplayName).toBe("Bob");
  });

  test("displayName falls back to actorDisplayName when no memberDisplayName", () => {
    const verdict = {
      trustClass: "unverified_contact",
      canonicalSenderId: "u-1",
    } satisfies TrustVerdict;

    const result = trustContextFromVerdict(verdict, {
      sourceChannel: "slack",
      conversationExternalId: CONV,
      actorUsername: "carol",
      actorDisplayName: "Carol Display",
    });

    expect(result.trustClass).toBe("unverified_contact");
    expect(result.requesterDisplayName).toBe("Carol Display");
    expect(result.requesterIdentifier).toBe("@carol");
  });

  test("maps trustClass through and leaves guardian fields undefined when absent", () => {
    for (const trustClass of [
      "trusted_contact",
      "unverified_contact",
      "unknown",
    ] as const) {
      const verdict = {
        trustClass,
        canonicalSenderId: "u-x",
      } satisfies TrustVerdict;

      const result = trustContextFromVerdict(verdict, {
        sourceChannel: "slack",
        conversationExternalId: CONV,
      });

      expect(result.trustClass).toBe(trustClass);
      expect(result.guardianExternalUserId).toBeUndefined();
      expect(result.guardianPrincipalId).toBeUndefined();
      // Non-guardian without binding -> no guardian chat id.
      expect(result.guardianChatId).toBeUndefined();
    }
  });
});

describe("resolvedMemberFromVerdict", () => {
  test("member verdict surfaces channel ACL/identity, info fields null", () => {
    const verdict = {
      trustClass: "trusted_contact",
      canonicalSenderId: "u-1",
      contactId: "contact-1",
      channelId: "channel-1",
      type: "slack",
      address: "u-1",
      status: "active",
      policy: "allow",
      externalChatId: "chat-1",
      verifiedAt: 1700000000,
      verifiedVia: "code",
      memberDisplayName: "Dora",
    } satisfies TrustVerdict;

    const member = resolvedMemberFromVerdict(verdict);
    expect(member).not.toBeNull();
    expect(member!.channel.id).toBe("channel-1");
    expect(member!.channel.status).toBe("active");
    expect(member!.channel.policy).toBe("allow");
    expect(member!.channel.verifiedAt).toBe(1700000000);
    expect(member!.channel.verifiedVia).toBe("code");
    expect(member!.channel.externalChatId).toBe("chat-1");

    expect(member!.contact.id).toBe("contact-1");
    expect(member!.contact.displayName).toBe("Dora");
    expect(member!.contact.role).toBe("contact");
    // INFO fields must be null/default placeholders.
    expect(member!.contact.notes).toBeNull();
    expect(member!.contact.userFile).toBeNull();
    expect(member!.contact.interactionCount).toBe(0);
    expect(member!.contact.lastInteraction).toBeNull();
  });

  test("guardian member verdict maps role guardian + principalId", () => {
    const verdict = {
      trustClass: "guardian",
      canonicalSenderId: "u-g",
      contactId: "contact-g",
      channelId: "channel-g",
      guardianPrincipalId: "vellum-principal-g",
      status: "active",
      policy: "allow",
    } satisfies TrustVerdict;

    const member = resolvedMemberFromVerdict(verdict);
    expect(member!.contact.role).toBe("guardian");
    expect(member!.contact.principalId).toBe("vellum-principal-g");
  });

  test("memberless verdict (no contactId) returns null", () => {
    const verdict = {
      trustClass: "unknown",
      canonicalSenderId: "u-2",
    } satisfies TrustVerdict;

    expect(resolvedMemberFromVerdict(verdict)).toBeNull();
  });

  test("member verdict missing status returns null (fail-closed)", () => {
    const verdict = {
      trustClass: "trusted_contact",
      canonicalSenderId: "u-4",
      contactId: "contact-4",
      channelId: "channel-4",
      policy: "allow",
    } satisfies TrustVerdict;

    expect(resolvedMemberFromVerdict(verdict)).toBeNull();
  });

  test("member verdict missing policy returns null (fail-closed)", () => {
    const verdict = {
      trustClass: "trusted_contact",
      canonicalSenderId: "u-5",
      contactId: "contact-5",
      channelId: "channel-5",
      status: "active",
    } satisfies TrustVerdict;

    expect(resolvedMemberFromVerdict(verdict)).toBeNull();
  });

  test("member verdict with unknown policy returns null (fail-closed)", () => {
    const verdict = {
      trustClass: "trusted_contact",
      canonicalSenderId: "u-6",
      contactId: "contact-6",
      channelId: "channel-6",
      status: "active",
      policy: "bogus",
    } satisfies TrustVerdict;

    expect(resolvedMemberFromVerdict(verdict)).toBeNull();
  });

  test("member verdict with unknown status returns null (fail-closed)", () => {
    const verdict = {
      trustClass: "trusted_contact",
      canonicalSenderId: "u-7",
      contactId: "contact-7",
      channelId: "channel-7",
      status: "quarantined",
      policy: "allow",
    } satisfies TrustVerdict;

    expect(resolvedMemberFromVerdict(verdict)).toBeNull();
  });

  test("member verdict with valid known status+policy returns a member", () => {
    const verdict = {
      trustClass: "trusted_contact",
      canonicalSenderId: "u-8",
      contactId: "contact-8",
      channelId: "channel-8",
      status: "active",
      policy: "allow",
    } satisfies TrustVerdict;

    const member = resolvedMemberFromVerdict(verdict);
    expect(member).not.toBeNull();
    expect(member!.channel.status).toBe("active");
    expect(member!.channel.policy).toBe("allow");
  });

  test("blocked/revoked verdict surfaces channel.status verbatim", () => {
    for (const status of ["blocked", "revoked"] as const) {
      const verdict = {
        trustClass: "unknown",
        canonicalSenderId: "u-3",
        contactId: "contact-3",
        channelId: "channel-3",
        status,
        policy: "deny",
      } satisfies TrustVerdict;

      const member = resolvedMemberFromVerdict(verdict);
      expect(member!.channel.status).toBe(status);
      expect(member!.channel.policy).toBe("deny");
    }
  });
});
