import { formatChannelAddress } from "@vellumai/service-contracts/channel-address";
import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { ADMISSION_POLICY_VALUES } from "../admission-policy-contract.js";
import {
  AdmissionStampSchema,
  CHANNEL_ENVELOPE_VERSION,
  ChannelEnvelopeV1Schema,
  GatewayAuthoritySchema,
  channelEnvelopeV1,
} from "../channel-envelope.js";
import { TrustVerdictSchema } from "../trust-verdict-contract.js";

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

const TELEGRAM_ACTOR = {
  channel: "telegram",
  coordinates: { userId: "987654321" },
} as const;

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    v: CHANNEL_ENVELOPE_VERSION,
    address: ADDRESS,
    kind: "message",
    actor: ACTOR,
    content: { externalMessageId: "1700000000.000200" },
    gatewayAuthority: AUTHORITY,
    ...overrides,
  };
}

describe("channel envelope v1", () => {
  test("accepts a complete envelope", () => {
    expect(ChannelEnvelopeV1Schema.safeParse(envelope()).success).toBe(true);
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

  test("validates the address and the actor through their own unions", () => {
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
        // A conversation id in the user slot.
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
});

describe("address and actor must agree on the channel", () => {
  const crossed = envelope({ actor: TELEGRAM_ACTOR });

  test("the plain schema rejects a channel mismatch", () => {
    const result = ChannelEnvelopeV1Schema.safeParse(crossed);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(
      "address and actor must be on the same channel",
    );
  });

  test("the payload-carrying helper rejects it too", () => {
    // The helper is the path consumers reach for, so it must not be the loose
    // one: extending the field set without re-applying the refinement would
    // let a Slack conversation carry a Telegram sender.
    const WithPayload = channelEnvelopeV1(z.object({ text: z.string() }));
    expect(
      WithPayload.safeParse({ ...crossed, payload: { text: "hi" } }).success,
    ).toBe(false);
    expect(
      WithPayload.safeParse({ ...envelope(), payload: { text: "hi" } }).success,
    ).toBe(true);
  });

  test("every mismatched pair is rejected on both paths", () => {
    const WithPayload = channelEnvelopeV1(z.object({ text: z.string() }));
    const mismatches = [
      { address: ADDRESS, actor: TELEGRAM_ACTOR },
      {
        address: {
          channel: "telegram",
          scope: { botId: "8012345" },
          coordinates: { chatId: "-1001234567890" },
        },
        actor: ACTOR,
      },
    ];
    for (const pair of mismatches) {
      expect(ChannelEnvelopeV1Schema.safeParse(envelope(pair)).success).toBe(
        false,
      );
      expect(
        WithPayload.safeParse({ ...envelope(pair), payload: { text: "hi" } })
          .success,
      ).toBe(false);
    }
  });
});

describe("gateway authority carries the canonical verdict", () => {
  test("a real guardian verdict is accepted, not stripped or rejected", () => {
    // The gateway fills the guardian and member blocks whenever those records
    // resolve. A narrower verdict schema would reject exactly this envelope.
    const guardianVerdict = {
      trustClass: "guardian",
      canonicalSenderId: "U0123ABCD",
      guardianExternalUserId: "U0123ABCD",
      guardianPrincipalId: "prin_abc",
      guardianDisplayName: "Example User",
      guardianDeliveryChatId: "D0123ABCD",
      contactId: "ct_1",
      channelId: "ch_1",
      type: "slack",
      address: "U0123ABCD",
      status: "active",
      policy: "allow",
      verifiedAt: 1700000000,
      memberDisplayName: "Example User",
      interactionCount: 3,
      hasInterceptableVerificationSession: false,
    };
    const result = ChannelEnvelopeV1Schema.safeParse(
      envelope({
        gatewayAuthority: { ...AUTHORITY, trustVerdict: guardianVerdict },
      }),
    );
    expect(result.success).toBe(true);
    expect(result.data?.gatewayAuthority.trustVerdict.guardianPrincipalId).toBe(
      "prin_abc",
    );
    expect(result.data?.gatewayAuthority.trustVerdict.interactionCount).toBe(3);
  });

  test("the verdict is the canonical schema, not a copy of it", () => {
    // Anything the canonical schema accepts, the envelope accepts.
    const verdict = TrustVerdictSchema.parse({
      trustClass: "unverified_contact",
      canonicalSenderId: "u".repeat(600),
      contactId: "ct_9",
    });
    expect(
      ChannelEnvelopeV1Schema.safeParse(
        envelope({
          gatewayAuthority: { ...AUTHORITY, trustVerdict: verdict },
        }),
      ).success,
    ).toBe(true);
  });

  test("a resolver failure is distinguishable from a real stranger", () => {
    const failed = envelope({
      gatewayAuthority: {
        ...AUTHORITY,
        trustVerdict: {
          trustClass: "unknown",
          canonicalSenderId: null,
          resolutionFailed: true,
        },
      },
    });
    const parsed = ChannelEnvelopeV1Schema.parse(failed);
    expect(parsed.gatewayAuthority.trustVerdict.resolutionFailed).toBe(true);
  });

  test("a trust verdict and an admission stamp are both required", () => {
    for (const field of ["trustVerdict", "admission"]) {
      const partial: Record<string, unknown> = { ...AUTHORITY };
      delete partial[field];
      expect(GatewayAuthoritySchema.safeParse(partial).success).toBe(false);
    }
  });

  test("the admission stamp uses the canonical policy vocabulary", () => {
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

  test("an exempt channel stamps the short circuit explicitly", () => {
    expect(
      AdmissionStampSchema.safeParse({
        policy: "trusted_contacts",
        admitted: true,
        exempt: true,
      }).success,
    ).toBe(true);
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

  test("stampedBy catches a malformed assembler, and only that", () => {
    // It is a shape check, not an authenticity check: a caller that writes the
    // literal passes, which is why the docstring says authority rests on the
    // transport rather than on this field.
    for (const stampedBy of ["assistant", "client", "", "Gateway"]) {
      expect(
        GatewayAuthoritySchema.safeParse({ ...AUTHORITY, stampedBy }).success,
      ).toBe(false);
    }
    expect(
      GatewayAuthoritySchema.safeParse({ ...AUTHORITY, stampedBy: "gateway" })
        .success,
    ).toBe(true);
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
    const parsed = ChannelEnvelopeV1Schema.parse(
      envelope({
        address: {
          channel: "slack",
          scope: { teamId: "T0123ABCD" },
          coordinates: {
            conversationId: "C0123ABCD",
            threadTs: "1700000000.000100",
          },
        },
      }),
    );
    expect(formatChannelAddress(parsed.address)).toBe(
      "slack:scope.teamId=T0123ABCD;conversationId=C0123ABCD;threadTs=1700000000.000100",
    );
  });

  test("a Telegram forum topic keeps the topic in the address", () => {
    const parsed = ChannelEnvelopeV1Schema.parse(
      envelope({
        address: {
          channel: "telegram",
          scope: { botId: "8012345" },
          coordinates: { chatId: "-1001234567890", topicId: "42" },
        },
        actor: TELEGRAM_ACTOR,
      }),
    );
    expect(formatChannelAddress(parsed.address)).toBe(
      "telegram:scope.botId=8012345;chatId=-1001234567890;topicId=42",
    );
  });

  test("a Discord thread keeps the thread in the address", () => {
    const parsed = ChannelEnvelopeV1Schema.parse(
      envelope({
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
      }),
    );
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
    expect(
      WithPayload.safeParse({
        ...envelope(),
        payload: { content: "hello" },
        bogus: 1,
      }).success,
    ).toBe(false);
  });
});
