import { describe, expect, test } from "bun:test";

import {
  CHANNEL_ACTOR_SCHEMAS,
  ChannelActorSchema,
  formatChannelActor,
  parseChannelActor,
  safeParseChannelActor,
  type ChannelActor,
} from "../channel-actor.js";
import { safeParseChannelAddress } from "../channel-address.js";
import { CHANNEL_IDS, type ChannelId } from "../channels.js";

/** One valid actor identity per canonical channel, plus its projection. */
const VALID = {
  a2a: {
    actor: { channel: "a2a", coordinates: { assistantId: "peer-one" } },
    projection: "a2a:assistantId=peer-one",
  },
  discord: {
    actor: {
      channel: "discord",
      coordinates: { userId: "123456789012345678" },
    },
    projection: "discord:userId=123456789012345678",
  },
  email: {
    actor: {
      channel: "email",
      coordinates: { address: "contact@example.com" },
    },
    projection: "email:address=contact%40example.com",
  },
  phone: {
    actor: { channel: "phone", coordinates: { e164: "+15555550123" } },
    projection: "phone:e164=%2B15555550123",
  },
  platform: {
    actor: {
      channel: "platform",
      scope: { platformAssistantId: "asst_1" },
      coordinates: { principalId: "prin_abc" },
    },
    projection:
      "platform:scope.platformAssistantId=asst_1;principalId=prin_abc",
  },
  slack: {
    actor: {
      channel: "slack",
      scope: { teamId: "T0123ABCD" },
      coordinates: { userId: "U0123ABCD" },
    },
    projection: "slack:scope.teamId=T0123ABCD;userId=U0123ABCD",
  },
  telegram: {
    actor: { channel: "telegram", coordinates: { userId: "987654321" } },
    projection: "telegram:userId=987654321",
  },
  vellum: {
    actor: { channel: "vellum", coordinates: { principalId: "prin_abc" } },
    projection: "vellum:principalId=prin_abc",
  },
  whatsapp: {
    actor: { channel: "whatsapp", coordinates: { waId: "+15555550188" } },
    projection: "whatsapp:waId=%2B15555550188",
  },
} as const satisfies Record<
  ChannelId,
  { actor: ChannelActor; projection: string }
>;

const CHANNELS: readonly ChannelId[] = CHANNEL_IDS;

describe("ChannelActor exhaustiveness", () => {
  test("every canonical channel has an actor variant", () => {
    expect(Object.keys(CHANNEL_ACTOR_SCHEMAS).sort()).toEqual(
      [...CHANNELS].sort(),
    );
  });

  test("the union carries exactly the variants in the schema map", () => {
    const inUnion = ChannelActorSchema.options
      .map((option) => option.shape.channel.value)
      .sort();
    expect(inUnion).toEqual([...CHANNELS].sort());
  });

  test("an actor for a channel outside the canonical vocabulary is rejected", () => {
    expect(
      ChannelActorSchema.safeParse({
        channel: "mastodon",
        coordinates: { userId: "1" },
      }).success,
    ).toBe(false);
  });
});

describe("ChannelActor variants", () => {
  for (const channel of CHANNELS) {
    test(`${channel}: accepts a well-formed actor`, () => {
      const result = ChannelActorSchema.safeParse(VALID[channel].actor);
      expect(result.success).toBe(true);
      expect(result.data).toEqual(VALID[channel].actor);
    });

    test(`${channel}: rejects an unknown coordinate`, () => {
      const actor = VALID[channel].actor;
      expect(
        ChannelActorSchema.safeParse({
          ...actor,
          coordinates: { ...actor.coordinates, smuggled: "x" },
        }).success,
      ).toBe(false);
    });

    test(`${channel}: rejects an empty coordinate value`, () => {
      const actor = VALID[channel].actor;
      const [first] = Object.keys(actor.coordinates);
      expect(
        ChannelActorSchema.safeParse({
          ...actor,
          coordinates: { ...actor.coordinates, [first!]: "" },
        }).success,
      ).toBe(false);
    });
  }

  test("an actor carries no conversation coordinate", () => {
    for (const channel of CHANNELS) {
      const coordinates = Object.keys(
        CHANNEL_ACTOR_SCHEMAS[channel].shape.coordinates.shape,
      );
      for (const name of coordinates) {
        expect(name.toLowerCase()).not.toContain("conversation");
        expect(name.toLowerCase()).not.toContain("thread");
        expect(name.toLowerCase()).not.toContain("callback");
      }
    }
  });

  test("slack: a user slot will not hold a workspace, channel, or bot id", () => {
    for (const userId of ["T0123ABCD", "E0123ABCD", "C0123ABCD", "B0123ABCD"]) {
      expect(
        ChannelActorSchema.safeParse({
          channel: "slack",
          scope: { teamId: "T0123ABCD" },
          coordinates: { userId },
        }).success,
      ).toBe(false);
    }
  });

  test("slack: an Enterprise Grid user id is accepted", () => {
    expect(
      ChannelActorSchema.safeParse({
        channel: "slack",
        scope: { teamId: "T0123ABCD", enterpriseId: "E9876ZZZZ" },
        coordinates: { userId: "W0123ABCD" },
      }).success,
    ).toBe(true);
  });

  test("slack: an actor with no workspace scope is rejected", () => {
    expect(
      ChannelActorSchema.safeParse({
        channel: "slack",
        coordinates: { userId: "U0123ABCD" },
      }).success,
    ).toBe(false);
  });

  test("telegram: a user id is unsigned, unlike a chat id", () => {
    expect(
      ChannelActorSchema.safeParse({
        channel: "telegram",
        coordinates: { userId: "-1001234567890" },
      }).success,
    ).toBe(false);
  });

  test("whatsapp: the bare-digit wa_id canonicalizes to E.164", () => {
    expect(
      ChannelActorSchema.parse({
        channel: "whatsapp",
        coordinates: { waId: "15555550188" },
      }),
    ).toEqual({
      channel: "whatsapp",
      coordinates: { waId: "+15555550188" },
    });
  });

  test("case-insensitive namespaces are canonicalized on parse", () => {
    expect(
      ChannelActorSchema.parse({
        channel: "email",
        coordinates: { address: "Contact.User+Tag@example.com" },
      }),
    ).toEqual({
      channel: "email",
      coordinates: { address: "contact.user+tag@example.com" },
    });
    expect(
      ChannelActorSchema.parse({
        channel: "a2a",
        coordinates: { assistantId: "Peer-One" },
      }),
    ).toEqual({ channel: "a2a", coordinates: { assistantId: "peer-one" } });
  });
});

describe("actor projection", () => {
  for (const channel of CHANNELS) {
    test(`${channel}: round trips through the projection`, () => {
      const projection = formatChannelActor(VALID[channel].actor);
      expect(projection).toBe(VALID[channel].projection);
      expect(parseChannelActor(projection)).toEqual(VALID[channel].actor);
      expect(formatChannelActor(parseChannelActor(projection))).toBe(
        projection,
      );
    });
  }

  test("two channels never collide on one projection", () => {
    const projections = CHANNELS.map((channel) =>
      formatChannelActor(VALID[channel].actor),
    );
    expect(new Set(projections).size).toBe(projections.length);
  });

  test("a prototype-shaped field is rejected here too", () => {
    expect(
      safeParseChannelActor("vellum:principalId=prin_abc;__proto__=x"),
    ).toBeNull();
    expect(Object.hasOwn(Object.prototype, "x")).toBe(false);
  });

  test("the throwing form does not echo the projection", () => {
    const attempt = () => parseChannelActor("email:address=secret-user");
    expect(attempt).toThrow("not a valid channel actor projection");
    expect(attempt).not.toThrow("secret-user");
  });
});

describe("actors and addresses are separate contracts", () => {
  test("an address projection does not parse as an actor", () => {
    expect(
      safeParseChannelActor(
        "slack:scope.teamId=T0123ABCD;conversationId=C0123ABCD",
      ),
    ).toBeNull();
  });

  test("an actor projection does not parse as an address", () => {
    expect(
      safeParseChannelAddress("slack:scope.teamId=T0123ABCD;userId=U0123ABCD"),
    ).toBeNull();
  });
});
