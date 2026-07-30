import { describe, expect, test } from "bun:test";

import {
  CHANNEL_ADDRESS_SCHEMAS,
  ChannelAddressSchema,
  formatChannelAddress,
  parseChannelAddress,
  safeParseChannelAddress,
  type ChannelAddress,
} from "../channel-address.js";
import { CHANNEL_IDS, type ChannelId } from "../channels.js";

/**
 * One valid address per canonical channel, plus its canonical projection.
 *
 * The `satisfies Record<ChannelId, …>` is deliberate: a channel added to
 * `CHANNEL_IDS` fails to compile here until someone states what one of its
 * addresses actually looks like, which is the point at which the shape stops
 * being a guess.
 */
const VALID = {
  a2a: {
    address: {
      channel: "a2a",
      coordinates: { assistantId: "peer-assistant-1" },
    },
    projection: "a2a:assistantId=peer-assistant-1",
  },
  discord: {
    address: {
      channel: "discord",
      coordinates: { userId: "123456789012345678" },
    },
    projection: "discord:userId=123456789012345678",
  },
  email: {
    address: {
      channel: "email",
      coordinates: { address: "contact@example.com" },
    },
    projection: "email:address=contact%40example.com",
  },
  phone: {
    address: { channel: "phone", coordinates: { e164: "+15555550123" } },
    projection: "phone:e164=%2B15555550123",
  },
  platform: {
    address: {
      channel: "platform",
      scope: { platformAssistantId: "asst_1" },
      coordinates: { principalId: "prin_abc" },
    },
    projection:
      "platform:scope.platformAssistantId=asst_1;principalId=prin_abc",
  },
  slack: {
    address: {
      channel: "slack",
      scope: { teamId: "T0123ABCD" },
      coordinates: { userId: "U0123ABCD" },
    },
    projection: "slack:scope.teamId=T0123ABCD;userId=U0123ABCD",
  },
  telegram: {
    address: { channel: "telegram", coordinates: { userId: "987654321" } },
    projection: "telegram:userId=987654321",
  },
  vellum: {
    address: { channel: "vellum", coordinates: { principalId: "prin_abc" } },
    projection: "vellum:principalId=prin_abc",
  },
  whatsapp: {
    address: {
      channel: "whatsapp",
      scope: { businessPhoneNumberId: "109876543210987" },
      coordinates: { waId: "+15555550188" },
    },
    projection:
      "whatsapp:scope.businessPhoneNumberId=109876543210987;waId=%2B15555550188",
  },
} as const satisfies Record<
  ChannelId,
  { address: ChannelAddress; projection: string }
>;

const CHANNELS: readonly ChannelId[] = CHANNEL_IDS;

describe("ChannelAddress exhaustiveness", () => {
  test("every canonical channel has an address variant", () => {
    expect(Object.keys(CHANNEL_ADDRESS_SCHEMAS).sort()).toEqual(
      [...CHANNELS].sort(),
    );
  });

  test("the union carries exactly the variants in the schema map", () => {
    const inUnion = ChannelAddressSchema.options
      .map((option) => option.shape.channel.value)
      .sort();
    expect(inUnion).toEqual([...CHANNELS].sort());
  });

  test("each variant's discriminator matches the key it is filed under", () => {
    for (const channel of CHANNELS) {
      expect(CHANNEL_ADDRESS_SCHEMAS[channel].shape.channel.value).toBe(
        channel,
      );
    }
  });

  test("an address for a channel outside the canonical vocabulary is rejected", () => {
    expect(
      ChannelAddressSchema.safeParse({
        channel: "mastodon",
        coordinates: { userId: "1" },
      }).success,
    ).toBe(false);
  });
});

describe("ChannelAddress variants", () => {
  for (const channel of CHANNELS) {
    test(`${channel}: accepts a well-formed address`, () => {
      const result = ChannelAddressSchema.safeParse(VALID[channel].address);
      expect(result.success).toBe(true);
      expect(result.data).toEqual(VALID[channel].address);
    });

    test(`${channel}: rejects an unknown coordinate`, () => {
      const address = VALID[channel].address;
      expect(
        ChannelAddressSchema.safeParse({
          ...address,
          coordinates: { ...address.coordinates, smuggled: "x" },
        }).success,
      ).toBe(false);
    });

    test(`${channel}: rejects an unknown top-level field`, () => {
      expect(
        ChannelAddressSchema.safeParse({
          ...VALID[channel].address,
          replyCallbackUrl: "https://gateway.example.com/deliver/abc",
        }).success,
      ).toBe(false);
    });

    test(`${channel}: rejects an empty coordinate value`, () => {
      const address = VALID[channel].address;
      const [first] = Object.keys(address.coordinates);
      expect(
        ChannelAddressSchema.safeParse({
          ...address,
          coordinates: { ...address.coordinates, [first!]: "" },
        }).success,
      ).toBe(false);
    });

    test(`${channel}: rejects a missing coordinates block`, () => {
      const { coordinates: _dropped, ...rest } = VALID[channel].address;
      expect(ChannelAddressSchema.safeParse(rest).success).toBe(false);
    });
  }

  test("slack: rejects an address with no workspace scope", () => {
    expect(
      ChannelAddressSchema.safeParse({
        channel: "slack",
        coordinates: { userId: "U0123ABCD" },
      }).success,
    ).toBe(false);
  });

  test("slack: accepts an enterprise grid scope", () => {
    expect(
      ChannelAddressSchema.safeParse({
        channel: "slack",
        scope: { teamId: "T0123ABCD", enterpriseId: "E9876ZZZZ" },
        coordinates: { userId: "W0123ABCD" },
      }).success,
    ).toBe(true);
  });

  test("slack: rejects lowercase and too-short object ids", () => {
    for (const userId of ["u0123abcd", "U1", ""]) {
      expect(
        ChannelAddressSchema.safeParse({
          channel: "slack",
          scope: { teamId: "T0123ABCD" },
          coordinates: { userId },
        }).success,
      ).toBe(false);
    }
  });

  test("slack: a workspace scope will not hold some other object's id", () => {
    for (const teamId of ["U0123ABCD", "E0123ABCD", "C0123ABCD", "B0123ABCD"]) {
      expect(
        ChannelAddressSchema.safeParse({
          channel: "slack",
          scope: { teamId },
          coordinates: { userId: "U0123ABCD" },
        }).success,
      ).toBe(false);
    }
  });

  test("slack: an enterprise scope will not hold a workspace or user id", () => {
    for (const enterpriseId of ["T0123ABCD", "U0123ABCD", "W0123ABCD"]) {
      expect(
        ChannelAddressSchema.safeParse({
          channel: "slack",
          scope: { teamId: "T0123ABCD", enterpriseId },
          coordinates: { userId: "U0123ABCD" },
        }).success,
      ).toBe(false);
    }
  });

  test("slack: a user coordinate will not hold a workspace, channel, or bot id", () => {
    for (const userId of ["T0123ABCD", "E0123ABCD", "C0123ABCD", "B0123ABCD"]) {
      expect(
        ChannelAddressSchema.safeParse({
          channel: "slack",
          scope: { teamId: "T0123ABCD" },
          coordinates: { userId },
        }).success,
      ).toBe(false);
    }
  });

  test("whatsapp: rejects an address with no business number scope", () => {
    expect(
      ChannelAddressSchema.safeParse({
        channel: "whatsapp",
        coordinates: { waId: "+15555550188" },
      }).success,
    ).toBe(false);
  });

  test("whatsapp: accepts the bare-digit wa_id Meta actually sends", () => {
    // `messages[].from` / `contacts[].wa_id` on the Cloud API are full
    // international digits with no `+`, which is what a producer holds.
    expect(
      ChannelAddressSchema.parse({
        channel: "whatsapp",
        scope: { businessPhoneNumberId: "109876543210987" },
        coordinates: { waId: "15555550188" },
      }),
    ).toEqual({
      channel: "whatsapp",
      scope: { businessPhoneNumberId: "109876543210987" },
      coordinates: { waId: "+15555550188" },
    });
  });

  test("whatsapp: prefixing the country code needs no country to be guessed", () => {
    // A national format would need a country guess; a wa_id never does, so a
    // non-US number canonicalizes exactly as cleanly as a US one.
    expect(
      ChannelAddressSchema.parse({
        channel: "whatsapp",
        scope: { businessPhoneNumberId: "109876543210987" },
        coordinates: { waId: "447700900123" },
      }),
    ).toEqual({
      channel: "whatsapp",
      scope: { businessPhoneNumberId: "109876543210987" },
      coordinates: { waId: "+447700900123" },
    });
  });

  test("whatsapp: both spellings land on one address and one projection", () => {
    const bare = ChannelAddressSchema.parse({
      channel: "whatsapp",
      scope: { businessPhoneNumberId: "109876543210987" },
      coordinates: { waId: "15555550188" },
    });
    const prefixed = ChannelAddressSchema.parse({
      channel: "whatsapp",
      scope: { businessPhoneNumberId: "109876543210987" },
      coordinates: { waId: "+15555550188" },
    });
    expect(bare).toEqual(prefixed);
    expect(formatChannelAddress(bare)).toBe(formatChannelAddress(prefixed));
  });

  test("whatsapp: still rejects anything that is not a full international number", () => {
    for (const waId of [
      "(555) 555-0123",
      "+1-555-555-0123",
      "+1",
      "555012",
      "not-a-number",
      "++15555550188",
    ]) {
      expect(
        ChannelAddressSchema.safeParse({
          channel: "whatsapp",
          scope: { businessPhoneNumberId: "109876543210987" },
          coordinates: { waId },
        }).success,
      ).toBe(false);
    }
  });

  test("phone coordinates must already be E.164", () => {
    // Twilio hands over `From` with its `+`, so unlike a wa_id there is no
    // second provider-native spelling to accept.
    for (const value of [
      "15555550123",
      "(555) 555-0123",
      "+1-555-555-0123",
      "+1",
    ]) {
      expect(
        ChannelAddressSchema.safeParse({
          channel: "phone",
          coordinates: { e164: value },
        }).success,
      ).toBe(false);
    }
  });

  test("telegram and discord ids must be decimal digits", () => {
    expect(
      ChannelAddressSchema.safeParse({
        channel: "telegram",
        coordinates: { userId: "not-a-number" },
      }).success,
    ).toBe(false);
    expect(
      ChannelAddressSchema.safeParse({
        channel: "discord",
        coordinates: { userId: "-123" },
      }).success,
    ).toBe(false);
  });

  test("email: rejects anything that is not an address", () => {
    for (const address of ["not-an-email", "@example.com", "user@"]) {
      expect(
        ChannelAddressSchema.safeParse({
          channel: "email",
          coordinates: { address },
        }).success,
      ).toBe(false);
    }
  });

  test("opaque coordinates reject whitespace and control characters", () => {
    for (const principalId of ["prin abc", "prin\nabc", "prin\tabc"]) {
      expect(
        ChannelAddressSchema.safeParse({
          channel: "vellum",
          coordinates: { principalId },
        }).success,
      ).toBe(false);
    }
  });

  test("coordinates are bounded", () => {
    expect(
      ChannelAddressSchema.safeParse({
        channel: "vellum",
        coordinates: { principalId: "p".repeat(257) },
      }).success,
    ).toBe(false);
  });

  test("case-insensitive namespaces are canonicalized on parse", () => {
    expect(
      ChannelAddressSchema.parse({
        channel: "email",
        coordinates: { address: "Contact.User+Tag@example.com" },
      }),
    ).toEqual({
      channel: "email",
      coordinates: { address: "contact.user+tag@example.com" },
    });

    expect(
      ChannelAddressSchema.parse({
        channel: "a2a",
        coordinates: { assistantId: "Peer-Assistant-1" },
      }),
    ).toEqual({
      channel: "a2a",
      coordinates: { assistantId: "peer-assistant-1" },
    });
  });
});

describe("identity is not delivery routing", () => {
  test("no variant carries a reply callback or conversation coordinate", () => {
    for (const channel of CHANNELS) {
      const shape = CHANNEL_ADDRESS_SCHEMAS[channel].shape;
      expect(Object.keys(shape).sort()).toEqual(
        "scope" in shape
          ? ["channel", "coordinates", "scope"]
          : ["channel", "coordinates"],
      );
      const coordinates = Object.keys(
        CHANNEL_ADDRESS_SCHEMAS[channel].shape.coordinates.shape,
      );
      for (const name of coordinates) {
        expect(name.toLowerCase()).not.toContain("callback");
        expect(name.toLowerCase()).not.toContain("conversation");
        expect(name.toLowerCase()).not.toContain("url");
      }
    }
  });
});

describe("string projection", () => {
  for (const channel of CHANNELS) {
    test(`${channel}: projects to its canonical form`, () => {
      expect(formatChannelAddress(VALID[channel].address)).toBe(
        VALID[channel].projection,
      );
    });

    test(`${channel}: round trips through the projection`, () => {
      const projection = formatChannelAddress(VALID[channel].address);
      expect(parseChannelAddress(projection)).toEqual(VALID[channel].address);
      expect(formatChannelAddress(parseChannelAddress(projection))).toBe(
        projection,
      );
    });
  }

  test("projection does not depend on the order fields were written in", () => {
    const written = formatChannelAddress({
      channel: "slack",
      coordinates: { userId: "U0123ABCD" },
      scope: { enterpriseId: "E9876ZZZZ", teamId: "T0123ABCD" },
    });
    const rewritten = formatChannelAddress({
      channel: "slack",
      scope: { teamId: "T0123ABCD", enterpriseId: "E9876ZZZZ" },
      coordinates: { userId: "U0123ABCD" },
    });
    expect(written).toBe(rewritten);
    expect(written).toBe(
      "slack:scope.enterpriseId=E9876ZZZZ;scope.teamId=T0123ABCD;userId=U0123ABCD",
    );
  });

  test("projection is canonical even when the input spelling is not", () => {
    expect(
      formatChannelAddress({
        channel: "email",
        coordinates: { address: "Contact@example.com" },
      }),
    ).toBe("email:address=contact%40example.com");
  });

  test("absent optional scope coordinates are omitted, not emitted empty", () => {
    expect(
      formatChannelAddress({
        channel: "slack",
        scope: { teamId: "T0123ABCD" },
        coordinates: { userId: "U0123ABCD" },
      }),
    ).toBe("slack:scope.teamId=T0123ABCD;userId=U0123ABCD");
  });

  test("separators inside a coordinate value are escaped", () => {
    const projection = formatChannelAddress({
      channel: "a2a",
      coordinates: { assistantId: "a;b=c%d" },
    });
    expect(projection).toBe("a2a:assistantId=a%3Bb%3Dc%25d");
    expect(parseChannelAddress(projection)).toEqual({
      channel: "a2a",
      coordinates: { assistantId: "a;b=c%d" },
    });
  });

  test("two channels never collide on one projection", () => {
    const projections = CHANNELS.map((channel) =>
      formatChannelAddress(VALID[channel].address),
    );
    expect(new Set(projections).size).toBe(projections.length);
  });

  test("formatting validates rather than trusting the caller", () => {
    expect(() =>
      formatChannelAddress({
        channel: "phone",
        coordinates: { e164: "555-0123" },
      }),
    ).toThrow();
  });
});

describe("projection parsing", () => {
  test("rejects malformed projections", () => {
    const malformed = [
      "",
      "telegram",
      ":userId=1",
      "telegram:",
      "telegram:userId",
      "telegram:=1",
      "telegram:userId=1;",
      "telegram:userId=1;userId=2",
      "telegram:scope.=1;userId=1",
      "telegram:userId=%E0%A4%A",
      "mastodon:userId=1",
      "telegram:userId=1;bogus=2",
      "telegram:scope.botId=1;userId=1",
      "slack:userId=U0123ABCD",
      "slack:scope.teamId=T0123ABCD",
      "phone:e164=5555550123",
    ];
    for (const text of malformed) {
      expect(safeParseChannelAddress(text)).toBeNull();
    }
  });

  test("a field named after a prototype member is rejected, not swallowed", () => {
    // `__proto__` is an accessor on `Object.prototype`, so a parser that
    // assigns decoded names onto a `{}` literal loses the field instead of
    // keeping it, and a projection with junk appended parses as if it were
    // clean. Every one of these carries an otherwise valid address.
    for (const text of [
      "telegram:userId=987654321;__proto__=x",
      "telegram:userId=987654321;scope.__proto__=x",
      "telegram:userId=987654321;constructor=x",
      "telegram:userId=987654321;prototype=x",
      "telegram:userId=987654321;toString=x",
      "telegram:userId=987654321;hasOwnProperty=x",
      "slack:scope.teamId=T0123ABCD;userId=U0123ABCD;__proto__=junk",
      "slack:scope.__proto__=x;scope.teamId=T0123ABCD;userId=U0123ABCD",
    ]) {
      expect(safeParseChannelAddress(text)).toBeNull();
    }
  });

  test("a repeated prototype-shaped field is caught like any other duplicate", () => {
    for (const text of [
      "telegram:__proto__=a;__proto__=b;userId=987654321",
      "telegram:constructor=a;constructor=b;userId=987654321",
      "slack:scope.__proto__=a;scope.__proto__=b;scope.teamId=T0123ABCD;userId=U0123ABCD",
    ]) {
      expect(safeParseChannelAddress(text)).toBeNull();
    }
  });

  test("parsing never mutates Object.prototype", () => {
    safeParseChannelAddress("telegram:userId=987654321;__proto__=polluted");
    safeParseChannelAddress("telegram:__proto__=polluted;userId=987654321");
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
    expect("polluted" in {}).toBe(false);
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  test("the throwing form does not echo the projection", () => {
    const attempt = () => parseChannelAddress("email:address=secret-user");
    expect(attempt).toThrow("not a valid channel address projection");
    expect(attempt).not.toThrow("secret-user");
  });

  test("parsing canonicalizes a non-canonical projection", () => {
    expect(parseChannelAddress("email:address=Contact%40example.com")).toEqual({
      channel: "email",
      coordinates: { address: "contact@example.com" },
    });
  });
});
