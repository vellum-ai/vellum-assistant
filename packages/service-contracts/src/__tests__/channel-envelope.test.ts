import { describe, expect, test } from "bun:test";
import { z } from "zod";

import {
  CHANNEL_ENVELOPE_VERSION,
  ChannelAuthoritySchema,
  ChannelDeliveryRouteSchema,
  ChannelEnvelopeV1Schema,
  channelEnvelopeV1,
} from "../channel-envelope.js";

const AUTHORITY = {
  stampedBy: "gateway",
  ingressId: "ing_01HZY",
  receivedAt: "2026-07-30T12:00:00.000Z",
} as const;

const ACTOR = {
  channel: "slack",
  scope: { teamId: "T0123ABCD" },
  coordinates: { userId: "U0123ABCD" },
} as const;

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    version: CHANNEL_ENVELOPE_VERSION,
    actor: ACTOR,
    authority: AUTHORITY,
    ...overrides,
  };
}

describe("channel envelope v1", () => {
  test("accepts an envelope with identity and authority", () => {
    const result = ChannelEnvelopeV1Schema.safeParse(envelope());
    expect(result.success).toBe(true);
    expect(result.data?.route).toBeUndefined();
  });

  test("accepts delivery routing alongside identity", () => {
    const result = ChannelEnvelopeV1Schema.safeParse(
      envelope({
        route: {
          conversationExternalId: "C0123ABCD",
          replyCallbackUrl:
            "https://gateway.example.com/deliver/slack?token=abc",
        },
      }),
    );
    expect(result.success).toBe(true);
  });

  test("rejects an unversioned or future-versioned envelope", () => {
    expect(
      ChannelEnvelopeV1Schema.safeParse(envelope({ version: "v2" })).success,
    ).toBe(false);
    const { version: _dropped, ...unversioned } = envelope();
    expect(ChannelEnvelopeV1Schema.safeParse(unversioned).success).toBe(false);
  });

  test("rejects an envelope with no actor identity", () => {
    const { actor: _dropped, ...withoutActor } = envelope();
    expect(ChannelEnvelopeV1Schema.safeParse(withoutActor).success).toBe(false);
  });

  test("validates the actor through the address union", () => {
    expect(
      ChannelEnvelopeV1Schema.safeParse(
        envelope({
          actor: { channel: "slack", coordinates: { userId: "U0123ABCD" } },
        }),
      ).success,
    ).toBe(false);
    expect(
      ChannelEnvelopeV1Schema.safeParse(
        envelope({
          actor: { channel: "mastodon", coordinates: { userId: "1" } },
        }),
      ).success,
    ).toBe(false);
  });

  test("rejects unknown fields so routing cannot leak in as identity", () => {
    expect(
      ChannelEnvelopeV1Schema.safeParse(
        envelope({
          replyCallbackUrl: "https://gateway.example.com/deliver/slack",
        }),
      ).success,
    ).toBe(false);
  });
});

describe("gateway-owned authority", () => {
  test("an envelope without an authority block is rejected", () => {
    const { authority: _dropped, ...unstamped } = envelope();
    expect(ChannelEnvelopeV1Schema.safeParse(unstamped).success).toBe(false);
  });

  test("only the gateway can claim to have stamped an envelope", () => {
    for (const stampedBy of ["assistant", "client", "", "Gateway"]) {
      expect(
        ChannelAuthoritySchema.safeParse({ ...AUTHORITY, stampedBy }).success,
      ).toBe(false);
    }
  });

  test("receivedAt must be an ISO 8601 UTC instant", () => {
    for (const receivedAt of [
      "2026-07-30",
      "2026-07-30T12:00:00+02:00",
      "30 July 2026",
      "not-a-time",
    ]) {
      expect(
        ChannelAuthoritySchema.safeParse({ ...AUTHORITY, receivedAt }).success,
      ).toBe(false);
    }
    expect(ChannelAuthoritySchema.safeParse(AUTHORITY).success).toBe(true);
  });

  test("ingressId is required and bounded", () => {
    expect(
      ChannelAuthoritySchema.safeParse({ ...AUTHORITY, ingressId: "" }).success,
    ).toBe(false);
    expect(
      ChannelAuthoritySchema.safeParse({
        ...AUTHORITY,
        ingressId: "i".repeat(257),
      }).success,
    ).toBe(false);
  });

  test("the authority block admits no extra claims", () => {
    expect(
      ChannelAuthoritySchema.safeParse({ ...AUTHORITY, trustClass: "guardian" })
        .success,
    ).toBe(false);
  });
});

describe("delivery routing", () => {
  test("both routing coordinates are optional", () => {
    expect(ChannelDeliveryRouteSchema.safeParse({}).success).toBe(true);
  });

  test("a reply callback must be a URL", () => {
    expect(
      ChannelDeliveryRouteSchema.safeParse({ replyCallbackUrl: "not-a-url" })
        .success,
    ).toBe(false);
  });

  test("routing carries no identity fields", () => {
    expect(Object.keys(ChannelDeliveryRouteSchema.shape).sort()).toEqual([
      "conversationExternalId",
      "replyCallbackUrl",
    ]);
  });
});

describe("envelope payloads", () => {
  const WithPayload = channelEnvelopeV1(
    z.object({ content: z.string().min(1) }),
  );

  test("validates the payload in the same pass as identity and authority", () => {
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
        ...envelope({ version: "v2" }),
        payload: { content: "hello" },
      }).success,
    ).toBe(false);
  });
});
