import { describe, expect, test } from "bun:test";

import type { TrustVerdict } from "@vellumai/gateway-client";

import { channelStatusToMemberStatus } from "../../contacts/member-status.js";
import type {
  ChannelPolicy,
  ChannelStatus,
  ContactChannel,
  ContactWithChannels,
} from "../../contacts/types.js";
import type { ActorTrustContext } from "../actor-trust-resolver.js";
import { toTrustContext } from "../actor-trust-resolver.js";
import {
  actorTrustContextFromVerdict,
  trustContextFromVerdict,
  verdictMemberFromVerdict,
  verdictUsability,
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

  test("member verdict stamps ACL member fields + contact id onto the context", () => {
    const verdict = {
      trustClass: "trusted_contact",
      canonicalSenderId: "u-1",
      contactId: "contact-1",
      channelId: "channel-1",
      type: "slack",
      address: "u-1",
      status: "unverified",
      policy: "deny",
    } satisfies TrustVerdict;

    const result = trustContextFromVerdict(verdict, {
      sourceChannel: "slack",
      conversationExternalId: CONV,
    });

    expect(result.requesterContactId).toBe("contact-1");
    // "unverified" maps to the API-facing "pending" member status.
    expect(result.memberStatus).toBe("pending");
    expect(result.memberPolicy).toBe("deny");
  });

  test("carries the verdict's gateway-owned interaction count onto the context", () => {
    const verdict = {
      trustClass: "trusted_contact",
      canonicalSenderId: "u-1",
      contactId: "contact-1",
      channelId: "channel-1",
      status: "active",
      policy: "allow",
      interactionCount: 9,
    } satisfies TrustVerdict;

    const result = trustContextFromVerdict(verdict, {
      sourceChannel: "slack",
      conversationExternalId: CONV,
    });

    expect(result.requesterInteractionCount).toBe(9);
  });

  test("leaves interaction count undefined when the verdict carries none", () => {
    const verdict = {
      trustClass: "trusted_contact",
      canonicalSenderId: "u-1",
      contactId: "contact-1",
      channelId: "channel-1",
      status: "active",
      policy: "allow",
    } satisfies TrustVerdict;

    const result = trustContextFromVerdict(verdict, {
      sourceChannel: "slack",
      conversationExternalId: CONV,
    });

    expect(result.requesterInteractionCount).toBeUndefined();
  });

  test("memberless verdict leaves ACL member fields undefined", () => {
    const verdict = {
      trustClass: "unknown",
      canonicalSenderId: "u-2",
    } satisfies TrustVerdict;

    const result = trustContextFromVerdict(verdict, {
      sourceChannel: "slack",
      conversationExternalId: CONV,
    });

    expect(result.requesterContactId).toBeUndefined();
    expect(result.memberStatus).toBeUndefined();
    expect(result.memberPolicy).toBeUndefined();
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

describe("actorTrustContextFromVerdict", () => {
  test("maps guardian verdict fields", () => {
    const verdict = {
      trustClass: "guardian",
      canonicalSenderId: "+15550100",
      guardianExternalUserId: "+15550100",
      guardianDeliveryChatId: "chat-9",
      guardianPrincipalId: "vellum-principal-abc",
      memberDisplayName: "Alice",
    } satisfies TrustVerdict;

    const ctx = actorTrustContextFromVerdict(verdict, {
      sourceChannel: "phone",
      conversationExternalId: CONV,
      actorUsername: "alice",
      actorDisplayName: "Alice Sender",
    });

    expect(ctx).toEqual({
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
    });
  });

  test("guardianBindingMatch is null without guardianExternalUserId", () => {
    const verdict = {
      trustClass: "trusted_contact",
      canonicalSenderId: "+15550101",
      memberDisplayName: "Bob",
    } satisfies TrustVerdict;

    const ctx = actorTrustContextFromVerdict(verdict, {
      sourceChannel: "phone",
      conversationExternalId: CONV,
    });

    expect(ctx.guardianBindingMatch).toBeNull();
    expect(ctx.trustClass).toBe("trusted_contact");
    // identifier falls back to canonicalSenderId when no username.
    expect(ctx.actorMetadata.identifier).toBe("+15550101");
    // displayName uses memberDisplayName when present.
    expect(ctx.actorMetadata.displayName).toBe("Bob");
    expect(ctx.actorMetadata.channel).toBe("phone");
    expect(ctx.memberRecord).toBeNull();
  });

  test("displayName falls back to actorDisplayName; identifier uses @username", () => {
    const verdict = {
      trustClass: "unverified_contact",
      canonicalSenderId: "u-1",
    } satisfies TrustVerdict;

    const ctx = actorTrustContextFromVerdict(verdict, {
      sourceChannel: "slack",
      conversationExternalId: CONV,
      actorUsername: "carol",
      actorDisplayName: "Carol Display",
    });

    expect(ctx.trustClass).toBe("unverified_contact");
    expect(ctx.actorMetadata.identifier).toBe("@carol");
    expect(ctx.actorMetadata.displayName).toBe("Carol Display");
    expect(ctx.actorMetadata.memberDisplayName).toBeUndefined();
    expect(ctx.actorMetadata.trustStatus).toBe("unverified_contact");
  });

  test("maps unknown verdict with no identity overrides", () => {
    const verdict = {
      trustClass: "unknown",
      canonicalSenderId: "u-2",
    } satisfies TrustVerdict;

    const ctx = actorTrustContextFromVerdict(verdict, {
      sourceChannel: "slack",
      conversationExternalId: CONV,
    });

    expect(ctx.trustClass).toBe("unknown");
    expect(ctx.guardianBindingMatch).toBeNull();
    expect(ctx.guardianPrincipalId).toBeUndefined();
    expect(ctx.memberRecord).toBeNull();
    expect(ctx.actorMetadata.identifier).toBe("u-2");
    expect(ctx.actorMetadata.displayName).toBeUndefined();
  });

  test("member verdict populates memberRecord from the verdict (voice ACL)", () => {
    const verdict = {
      trustClass: "trusted_contact",
      canonicalSenderId: "u-1",
      contactId: "contact-1",
      channelId: "channel-1",
      type: "slack",
      address: "u-1",
      status: "blocked",
      policy: "deny",
    } satisfies TrustVerdict;

    const ctx = actorTrustContextFromVerdict(verdict, {
      sourceChannel: "slack",
      conversationExternalId: CONV,
    });

    expect(ctx.memberRecord).not.toBeNull();
    expect(ctx.memberRecord!.contact.id).toBe("contact-1");
    expect(ctx.memberRecord!.channel.id).toBe("channel-1");
    expect(ctx.memberRecord!.status).toBe("blocked");
    expect(ctx.memberRecord!.policy).toBe("deny");
  });

  test("memberRecord surfaces channel ACL/identity, info fields null", () => {
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
      memberDisplayName: "Dora",
    } satisfies TrustVerdict;

    const { memberRecord } = actorTrustContextFromVerdict(verdict, {
      sourceChannel: "slack",
      conversationExternalId: CONV,
    });
    expect(memberRecord!.status).toBe("active");
    expect(memberRecord!.policy).toBe("allow");
    expect(memberRecord!.channel.externalChatId).toBe("chat-1");

    expect(memberRecord!.contact.displayName).toBe("Dora");
    expect(memberRecord!.role).toBe("contact");
    // INFO fields must be null/default placeholders.
    expect(memberRecord!.contact.notes).toBeNull();
    expect(memberRecord!.contact.userFile).toBeNull();
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

    const ctx = actorTrustContextFromVerdict(verdict, {
      sourceChannel: "slack",
      conversationExternalId: CONV,
    });
    expect(ctx.memberRecord!.role).toBe("guardian");
    expect(ctx.guardianPrincipalId).toBe("vellum-principal-g");
  });

  test("memberRecord null when status missing (fail-closed)", () => {
    const verdict = {
      trustClass: "trusted_contact",
      canonicalSenderId: "u-4",
      contactId: "contact-4",
      channelId: "channel-4",
      policy: "allow",
    } satisfies TrustVerdict;

    expect(
      actorTrustContextFromVerdict(verdict, {
        sourceChannel: "slack",
        conversationExternalId: CONV,
      }).memberRecord,
    ).toBeNull();
  });

  test("stranger verdict (no contactId/channelId) leaves memberRecord null", () => {
    const verdict = {
      trustClass: "unknown",
      canonicalSenderId: "u-9",
    } satisfies TrustVerdict;

    const ctx = actorTrustContextFromVerdict(verdict, {
      sourceChannel: "slack",
      conversationExternalId: CONV,
    });

    expect(ctx.memberRecord).toBeNull();
  });

  test("malformed member verdict (unknown status) leaves memberRecord null (fail-closed)", () => {
    const verdict = {
      trustClass: "trusted_contact",
      canonicalSenderId: "u-10",
      contactId: "contact-10",
      channelId: "channel-10",
      status: "quarantined",
      policy: "allow",
    } satisfies TrustVerdict;

    const ctx = actorTrustContextFromVerdict(verdict, {
      sourceChannel: "slack",
      conversationExternalId: CONV,
    });

    expect(ctx.memberRecord).toBeNull();
  });

  test("trustContextFromVerdict equals member stamp applied to toTrustContext(actorTrustContextFromVerdict)", () => {
    const verdict = {
      trustClass: "trusted_contact",
      canonicalSenderId: "u-1",
      contactId: "contact-1",
      channelId: "channel-1",
      type: "slack",
      address: "u-1",
      status: "unverified",
      policy: "deny",
      memberDisplayName: "Dora",
    } satisfies TrustVerdict;
    const input = {
      sourceChannel: "slack",
      conversationExternalId: CONV,
      actorUsername: "dora",
      actorDisplayName: "Dora Display",
    } as const;

    const expected = toTrustContext(
      actorTrustContextFromVerdict(verdict, input),
      input.conversationExternalId,
    );
    const member = verdictMemberFromVerdict(verdict);
    expect(member).not.toBeNull();
    expected.requesterContactId = member!.contactId;
    expected.memberStatus = channelStatusToMemberStatus(member!.status);
    expected.memberPolicy = member!.policy;

    expect(trustContextFromVerdict(verdict, input)).toEqual(expected);
  });
});

describe("toTrustContext member grounding", () => {
  function memberChannel(): ContactChannel {
    return {
      id: "channel-1",
      contactId: "contact-1",
      type: "phone",
      address: "+15550100",
      isPrimary: true,
      externalChatId: null,
      updatedAt: null,
      createdAt: 0,
    };
  }

  function memberContact(): ContactWithChannels {
    return {
      id: "contact-1",
      displayName: "Frank",
      notes: null,
      createdAt: 0,
      updatedAt: 0,
      contactType: "human",
      userFile: null,
      channels: [memberChannel()],
    };
  }

  function ctxWithMember(
    acl: { status: ChannelStatus; policy: ChannelPolicy } = {
      status: "unverified",
      policy: "deny",
    },
  ): ActorTrustContext {
    return {
      canonicalSenderId: "+15550100",
      guardianBindingMatch: null,
      guardianPrincipalId: undefined,
      memberRecord: {
        contact: memberContact(),
        channel: memberChannel(),
        status: acl.status,
        policy: acl.policy,
        role: "contact",
      },
      trustClass: "trusted_contact",
      actorMetadata: {
        identifier: "+15550100",
        displayName: "Frank",
        senderDisplayName: "Frank",
        memberDisplayName: "Frank",
        username: undefined,
        channel: "phone",
        trustStatus: "trusted_contact",
      },
    };
  }

  test("populates member fields from memberRecord (voice path)", () => {
    const context = toTrustContext(ctxWithMember(), CONV);
    expect(context.requesterContactId).toBe("contact-1");
    // "unverified" maps to the API-facing "pending" member status.
    expect(context.memberStatus).toBe("pending");
    expect(context.memberPolicy).toBe("deny");
  });

  test("passes through active status + allow policy", () => {
    const context = toTrustContext(
      ctxWithMember({ status: "active", policy: "allow" }),
      CONV,
    );
    expect(context.memberStatus).toBe("active");
    expect(context.memberPolicy).toBe("allow");
  });

  test("leaves member fields undefined when memberRecord is null", () => {
    const context = toTrustContext(
      {
        canonicalSenderId: "u-2",
        guardianBindingMatch: null,
        guardianPrincipalId: undefined,
        memberRecord: null,
        trustClass: "unknown",
        actorMetadata: {
          identifier: "u-2",
          displayName: undefined,
          senderDisplayName: undefined,
          memberDisplayName: undefined,
          username: undefined,
          channel: "slack",
          trustStatus: "unknown",
        },
      },
      CONV,
    );
    expect(context.requesterContactId).toBeUndefined();
    expect(context.memberStatus).toBeUndefined();
    expect(context.memberPolicy).toBeUndefined();
  });
});

describe("verdictMemberFromVerdict", () => {
  test("active member verdict yields the narrow ACL view", () => {
    const verdict = {
      trustClass: "trusted_contact",
      canonicalSenderId: "u-1",
      contactId: "contact-1",
      channelId: "channel-1",
      type: "slack",
      address: "u-1",
      status: "active",
      policy: "allow",
      verifiedAt: 1700000000,
      memberDisplayName: "Dora",
    } satisfies TrustVerdict;

    expect(verdictMemberFromVerdict(verdict)).toEqual({
      contactId: "contact-1",
      channelId: "channel-1",
      status: "active",
      policy: "allow",
      verifiedAt: 1700000000,
      displayName: "Dora",
    });
  });

  test("blocked member verdict surfaces status/policy verbatim, null defaults", () => {
    const verdict = {
      trustClass: "unknown",
      canonicalSenderId: "u-3",
      contactId: "contact-3",
      channelId: "channel-3",
      status: "blocked",
      policy: "deny",
    } satisfies TrustVerdict;

    expect(verdictMemberFromVerdict(verdict)).toEqual({
      contactId: "contact-3",
      channelId: "channel-3",
      status: "blocked",
      policy: "deny",
      verifiedAt: null,
      displayName: null,
    });
  });

  test("memberless verdict (no contactId/channelId) returns null", () => {
    expect(
      verdictMemberFromVerdict({
        trustClass: "unknown",
        canonicalSenderId: "u-2",
      } satisfies TrustVerdict),
    ).toBeNull();
  });

  test("invalid enum (unknown status/policy) returns null (fail-closed)", () => {
    expect(
      verdictMemberFromVerdict({
        trustClass: "trusted_contact",
        canonicalSenderId: "u-7",
        contactId: "contact-7",
        channelId: "channel-7",
        status: "quarantined",
        policy: "allow",
      } satisfies TrustVerdict),
    ).toBeNull();
    expect(
      verdictMemberFromVerdict({
        trustClass: "trusted_contact",
        canonicalSenderId: "u-6",
        contactId: "contact-6",
        channelId: "channel-6",
        status: "active",
        policy: "bogus",
      } satisfies TrustVerdict),
    ).toBeNull();
  });

  test('stale "escalate" policy returns null (fail-closed backstop for un-migrated gateways)', () => {
    const verdict = {
      trustClass: "trusted_contact",
      canonicalSenderId: "u-8",
      contactId: "contact-8",
      channelId: "channel-8",
      status: "active",
      policy: "escalate",
    } satisfies TrustVerdict;

    expect(verdictMemberFromVerdict(verdict)).toBeNull();
    expect(verdictUsability(verdict)).toEqual({
      usable: false,
      reason: "member unresolvable",
    });
  });

  test("missing status or policy returns null (fail-closed)", () => {
    expect(
      verdictMemberFromVerdict({
        trustClass: "trusted_contact",
        canonicalSenderId: "u-4",
        contactId: "contact-4",
        channelId: "channel-4",
        policy: "allow",
      } satisfies TrustVerdict),
    ).toBeNull();
    expect(
      verdictMemberFromVerdict({
        trustClass: "trusted_contact",
        canonicalSenderId: "u-5",
        contactId: "contact-5",
        channelId: "channel-5",
        status: "active",
      } satisfies TrustVerdict),
    ).toBeNull();
  });
});

// Member-identity handling is module-private; exercised via verdictUsability's
// "member unresolvable" reason.
describe("verdict member-identity handling (via verdictUsability)", () => {
  test("partial member identity (contactId or channelId alone) is member unresolvable", () => {
    expect(
      verdictUsability({
        trustClass: "unknown",
        canonicalSenderId: "u-1",
        contactId: "contact-1",
      } satisfies TrustVerdict),
    ).toEqual({ usable: false, reason: "member unresolvable" });
    expect(
      verdictUsability({
        trustClass: "unknown",
        canonicalSenderId: "u-1",
        channelId: "channel-1",
      } satisfies TrustVerdict),
    ).toEqual({ usable: false, reason: "member unresolvable" });
  });

  test("member identity with unsynthesizable ACL is member unresolvable", () => {
    expect(
      verdictUsability({
        trustClass: "trusted_contact",
        canonicalSenderId: "u-1",
        contactId: "contact-1",
        channelId: "channel-1",
        policy: "allow",
      } satisfies TrustVerdict),
    ).toEqual({ usable: false, reason: "member unresolvable" });
  });

  test("resolvable member verdict is usable, not member unresolvable", () => {
    const verdict = {
      trustClass: "trusted_contact",
      canonicalSenderId: "u-1",
      contactId: "contact-1",
      channelId: "channel-1",
      status: "active",
      policy: "allow",
    } satisfies TrustVerdict;
    expect(verdictUsability(verdict)).toEqual({ usable: true, verdict });
  });

  test("memberless verdict is usable, not member unresolvable", () => {
    const verdict = {
      trustClass: "unknown",
      canonicalSenderId: "u-1",
    } satisfies TrustVerdict;
    expect(verdictUsability(verdict)).toEqual({ usable: true, verdict });
  });
});

describe("verdictUsability", () => {
  test("missing / resolutionFailed / member-unresolvable are unusable with their reasons", () => {
    expect(verdictUsability(null)).toEqual({
      usable: false,
      reason: "missing",
    });
    expect(verdictUsability(undefined)).toEqual({
      usable: false,
      reason: "missing",
    });
    expect(
      verdictUsability({
        trustClass: "unknown",
        canonicalSenderId: null,
        resolutionFailed: true,
      } satisfies TrustVerdict),
    ).toEqual({ usable: false, reason: "resolution failed" });
    expect(
      verdictUsability({
        trustClass: "trusted_contact",
        canonicalSenderId: "u-1",
        contactId: "contact-1",
        channelId: "channel-1",
        policy: "allow",
      } satisfies TrustVerdict),
    ).toEqual({ usable: false, reason: "member unresolvable" });
  });

  test("unrecognized trust class (version skew) is unusable", () => {
    expect(
      verdictUsability({
        trustClass: "superadmin" as TrustVerdict["trustClass"],
        canonicalSenderId: "u-1",
      }),
    ).toEqual({ usable: false, reason: "unrecognized trust class" });
  });

  test("memberless guardian claim is contradictory and unusable", () => {
    expect(
      verdictUsability({
        trustClass: "guardian",
        canonicalSenderId: "u-g",
        guardianExternalUserId: "u-g",
        guardianPrincipalId: "p-1",
      } satisfies TrustVerdict),
    ).toEqual({ usable: false, reason: "guardian without member" });
  });

  test("memberful guardian and memberless stranger verdicts are usable", () => {
    const guardian = {
      trustClass: "guardian",
      canonicalSenderId: "u-g",
      contactId: "contact-g",
      channelId: "channel-g",
      status: "active",
      policy: "allow",
    } satisfies TrustVerdict;
    expect(verdictUsability(guardian)).toEqual({
      usable: true,
      verdict: guardian,
    });

    const stranger = {
      trustClass: "unknown",
      canonicalSenderId: "u-2",
    } satisfies TrustVerdict;
    expect(verdictUsability(stranger)).toEqual({
      usable: true,
      verdict: stranger,
    });
  });
});
