import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { formatChannelAddress } from "../channel-address.js";
import {
  ADMISSION_POLICY_VALUES,
  AdmissionStampSchema,
  CHANNEL_ENVELOPE_VERSION,
  CHANNEL_EVENT_KINDS,
  ChannelContentRefsSchema,
  ChannelEnvelopeV1ConsistentSchema,
  ChannelEnvelopeV1Schema,
  GatewayAuthoritySchema,
  TRUST_CLASS_VALUES,
  TrustVerdictSchema,
  channelEnvelopeV1,
} from "../channel-envelope.js";

const AUTHORITY = {
  stampedBy: "gateway",
  ingressId: "ing_01HZY",
  receivedAt: "2026-07-30T12:00:00.000Z",
  trustVerdict: {
    trustClass: "trusted_contact",
    canonicalSenderId: "U0123ABCD",
  },
  admission: { policy: "trusted_contacts", admitted: true },
} as const;

const ADDRESS = {
  channel: "slack",
  scope: { teamId: "T0123ABCD" },
  coordinates: { conversationId: "C0123ABCD" },
} as const;

const ACTOR = {
  channel: "slack",
  scope: { teamId: "T0123ABCD" },
  coordinates: { userId: "U0123ABCD" },
} as const;

const CONTENT = { externalMessageId: "1700000000.000200" } as const;

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    v: CHANNEL_ENVELOPE_VERSION,
    address: ADDRESS,
    kind: "message",
    actor: ACTOR,
    content: CONTENT,
    gatewayAuthority: AUTHORITY,
    ...overrides,
  };
}

describe("channel envelope v1", () => {
  test("accepts a complete envelope", () => {
    const result = ChannelEnvelopeV1Schema.safeParse(envelope());
    expect(result.success).toBe(true);
  });

  test("every field is load-bearing", () => {
    for (const field of [
      "v",
      "address",
      "kind",
      "actor",
      "content",
      "gatewayAuthority",
    ]) {
      const partial: Record<string, unknown> = { ...envelope() };
      delete partial[field];
      expect(ChannelEnvelopeV1Schema.safeParse(partial).success).toBe(false);
    }
  });

  test("the version is a number literal, not a free value", () => {
    expect(CHANNEL_ENVELOPE_VERSION).toBe(1);
    for (const v of [2, "1", "v1", 0, null]) {
      expect(ChannelEnvelopeV1Schema.safeParse(envelope({ v })).success).toBe(
        false,
      );
    }
  });

  test("validates the address through the address union", () => {
    expect(
      ChannelEnvelopeV1Schema.safeParse(
        // No workspace scope.
        envelope({
          address: {
            channel: "slack",
            coordinates: { conversationId: "C0123ABCD" },
          },
        }),
      ).success,
    ).toBe(false);
    expect(
      ChannelEnvelopeV1Schema.safeParse(
        envelope({
          address: {
            channel: "mastodon",
            coordinates: { conversationId: "1" },
          },
        }),
      ).success,
    ).toBe(false);
  });

  test("validates the actor through the actor union", () => {
    expect(
      ChannelEnvelopeV1Schema.safeParse(
        envelope({
          actor: {
            channel: "slack",
            scope: { teamId: "T0123ABCD" },
            coordinates: { userId: "C0123ABCD" },
          },
        }),
      ).success,
    ).toBe(false);
  });

  test("an address is not accepted in the actor slot", () => {
    expect(
      ChannelEnvelopeV1Schema.safeParse(envelope({ actor: ADDRESS })).success,
    ).toBe(false);
  });

  test("rejects unknown fields", () => {
    expect(
      ChannelEnvelopeV1Schema.safeParse(
        envelope({
          replyCallbackUrl: "https://gateway.example.com/deliver/slack",
        }),
      ).success,
    ).toBe(false);
  });

  test("address and actor must agree on the channel", () => {
    const crossed = envelope({
      actor: { channel: "telegram", coordinates: { userId: "987654321" } },
    });
    // Each half is independently valid, so only the cross-field check catches it.
    expect(ChannelEnvelopeV1Schema.safeParse(crossed).success).toBe(true);
    expect(ChannelEnvelopeV1ConsistentSchema.safeParse(crossed).success).toBe(
      false,
    );
    expect(
      ChannelEnvelopeV1ConsistentSchema.safeParse(envelope()).success,
    ).toBe(true);
  });
});

describe("event kind", () => {
  test("covers the gateway's normalizer families", () => {
    expect([...CHANNEL_EVENT_KINDS]).toEqual([
      "message",
      "message_edit",
      "message_delete",
      "reaction",
      "action",
    ]);
  });

  test("each kind is accepted and an unknown one is not", () => {
    for (const kind of CHANNEL_EVENT_KINDS) {
      expect(
        ChannelEnvelopeV1Schema.safeParse(envelope({ kind })).success,
      ).toBe(true);
    }
    for (const kind of ["typing", "", "MESSAGE", null]) {
      expect(
        ChannelEnvelopeV1Schema.safeParse(envelope({ kind })).success,
      ).toBe(false);
    }
  });
});

describe("content refs", () => {
  test("carries pointers, not bodies", () => {
    expect(Object.keys(ChannelContentRefsSchema.shape).sort()).toEqual([
      "attachmentIds",
      "externalMessageId",
    ]);
  });

  test("a message id is required and attachments are optional", () => {
    expect(ChannelContentRefsSchema.safeParse({}).success).toBe(false);
    expect(
      ChannelContentRefsSchema.safeParse({ externalMessageId: "" }).success,
    ).toBe(false);
    expect(
      ChannelContentRefsSchema.safeParse({
        externalMessageId: "1700000000.000200",
        attachmentIds: ["att_1", "att_2"],
      }).success,
    ).toBe(true);
  });

  test("attachment ids are bounded and non-empty", () => {
    expect(
      ChannelContentRefsSchema.safeParse({
        externalMessageId: "m1",
        attachmentIds: [""],
      }).success,
    ).toBe(false);
    expect(
      ChannelContentRefsSchema.safeParse({
        externalMessageId: "m1",
        attachmentIds: Array.from({ length: 65 }, (_unused, i) => `att_${i}`),
      }).success,
    ).toBe(false);
  });
});

describe("gateway-owned authority", () => {
  test("only the gateway can claim to have stamped an envelope", () => {
    for (const stampedBy of ["assistant", "client", "", "Gateway"]) {
      expect(
        GatewayAuthoritySchema.safeParse({ ...AUTHORITY, stampedBy }).success,
      ).toBe(false);
    }
  });

  test("a trust verdict is required, not optional", () => {
    const { trustVerdict: _dropped, ...withoutVerdict } = AUTHORITY;
    expect(GatewayAuthoritySchema.safeParse(withoutVerdict).success).toBe(
      false,
    );
  });

  test("an admission stamp is required, not optional", () => {
    const { admission: _dropped, ...withoutAdmission } = AUTHORITY;
    expect(GatewayAuthoritySchema.safeParse(withoutAdmission).success).toBe(
      false,
    );
  });

  test("the trust class vocabulary is the canonical four", () => {
    expect([...TRUST_CLASS_VALUES]).toEqual([
      "guardian",
      "trusted_contact",
      "unverified_contact",
      "unknown",
    ]);
    for (const trustClass of TRUST_CLASS_VALUES) {
      expect(
        TrustVerdictSchema.safeParse({ trustClass, canonicalSenderId: null })
          .success,
      ).toBe(true);
    }
    for (const trustClass of ["non_guardian", "admin", ""]) {
      expect(
        TrustVerdictSchema.safeParse({ trustClass, canonicalSenderId: null })
          .success,
      ).toBe(false);
    }
  });

  test("a resolver failure is distinguishable from a real stranger", () => {
    const failed = TrustVerdictSchema.parse({
      trustClass: "unknown",
      canonicalSenderId: null,
      resolutionFailed: true,
    });
    const stranger = TrustVerdictSchema.parse({
      trustClass: "unknown",
      canonicalSenderId: "U0123ABCD",
    });
    expect(failed.resolutionFailed).toBe(true);
    expect(stranger.resolutionFailed).toBeUndefined();
  });

  test("the admission stamp carries both the floor and the outcome", () => {
    expect(Object.keys(AdmissionStampSchema.shape).sort()).toEqual([
      "admitted",
      "exempt",
      "policy",
    ]);
    for (const policy of ADMISSION_POLICY_VALUES) {
      expect(
        AdmissionStampSchema.safeParse({ policy, admitted: true }).success,
      ).toBe(true);
    }
    expect(
      AdmissionStampSchema.safeParse({ policy: "everyone", admitted: true })
        .success,
    ).toBe(false);
    expect(AdmissionStampSchema.safeParse({ policy: "no_one" }).success).toBe(
      false,
    );
  });

  test("receivedAt must be an ISO 8601 UTC instant", () => {
    for (const receivedAt of [
      "2026-07-30",
      "2026-07-30T12:00:00+02:00",
      "30 July 2026",
      "not-a-time",
    ]) {
      expect(
        GatewayAuthoritySchema.safeParse({ ...AUTHORITY, receivedAt }).success,
      ).toBe(false);
    }
    expect(GatewayAuthoritySchema.safeParse(AUTHORITY).success).toBe(true);
  });

  test("ingressId is required and bounded", () => {
    expect(
      GatewayAuthoritySchema.safeParse({ ...AUTHORITY, ingressId: "" }).success,
    ).toBe(false);
    expect(
      GatewayAuthoritySchema.safeParse({
        ...AUTHORITY,
        ingressId: "i".repeat(257),
      }).success,
    ).toBe(false);
  });

  test("the authority block admits no extra claims", () => {
    expect(
      GatewayAuthoritySchema.safeParse({ ...AUTHORITY, capabilities: ["all"] })
        .success,
    ).toBe(false);
  });
});

describe("golden thread and topic envelopes", () => {
  test("a Slack thread reply keeps the thread in the address", () => {
    const threaded = envelope({
      address: {
        channel: "slack",
        scope: { teamId: "T0123ABCD" },
        coordinates: {
          conversationId: "C0123ABCD",
          threadTs: "1700000000.000100",
        },
      },
    });
    const parsed = ChannelEnvelopeV1ConsistentSchema.parse(threaded);
    expect(formatChannelAddress(parsed.address)).toBe(
      "slack:scope.teamId=T0123ABCD;conversationId=C0123ABCD;threadTs=1700000000.000100",
    );
  });

  test("a Telegram forum topic keeps the topic in the address", () => {
    const topic = envelope({
      address: {
        channel: "telegram",
        scope: { botId: "8012345" },
        coordinates: { chatId: "-1001234567890", topicId: "42" },
      },
      actor: { channel: "telegram", coordinates: { userId: "987654321" } },
    });
    const parsed = ChannelEnvelopeV1ConsistentSchema.parse(topic);
    expect(formatChannelAddress(parsed.address)).toBe(
      "telegram:scope.botId=8012345;chatId=-1001234567890;topicId=42",
    );
  });

  test("a Discord thread keeps the thread in the address", () => {
    const thread = envelope({
      address: {
        channel: "discord",
        scope: {
          applicationId: "111111111111111111",
          guildId: "222222222222222222",
        },
        coordinates: {
          channelId: "333333333333333333",
          threadId: "444444444444444444",
        },
      },
      actor: {
        channel: "discord",
        coordinates: { userId: "555555555555555555" },
      },
    });
    const parsed = ChannelEnvelopeV1ConsistentSchema.parse(thread);
    expect(formatChannelAddress(parsed.address)).toBe(
      "discord:scope.applicationId=111111111111111111;scope.guildId=222222222222222222;channelId=333333333333333333;threadId=444444444444444444",
    );
  });

  test("two threads in one conversation are two addresses", () => {
    const base = { channel: "slack", scope: { teamId: "T0123ABCD" } } as const;
    const first = formatChannelAddress({
      ...base,
      coordinates: {
        conversationId: "C0123ABCD",
        threadTs: "1700000000.000100",
      },
    });
    const second = formatChannelAddress({
      ...base,
      coordinates: {
        conversationId: "C0123ABCD",
        threadTs: "1700000999.000100",
      },
    });
    expect(first).not.toBe(second);
  });
});

describe("envelope payloads", () => {
  const WithPayload = channelEnvelopeV1(
    z.object({ content: z.string().min(1) }),
  );

  test("validates the payload in the same pass as the rest", () => {
    expect(
      WithPayload.safeParse({ ...envelope(), payload: { content: "hello" } })
        .success,
    ).toBe(true);
    expect(
      WithPayload.safeParse({ ...envelope(), payload: { content: "" } })
        .success,
    ).toBe(false);
    expect(WithPayload.safeParse(envelope()).success).toBe(false);
  });

  test("a payload does not loosen the envelope", () => {
    expect(
      WithPayload.safeParse({
        ...envelope({ v: 2 }),
        payload: { content: "hello" },
      }).success,
    ).toBe(false);
  });
});
