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
 * One valid conversation address per canonical channel, plus its canonical
 * projection.
 *
 * The `satisfies Record<ChannelId, …>` is deliberate: a channel added to
 * `CHANNEL_IDS` fails to compile here until someone states what one of its
 * conversations actually looks like, which is the point at which the shape
 * stops being a guess.
 */
const VALID = {
  a2a: {
    address: { channel: "a2a", coordinates: { peerAssistantId: "peer-one" } },
    projection: "a2a:peerAssistantId=peer-one",
  },
  discord: {
    address: {
      channel: "discord",
      scope: {
        applicationId: "111111111111111111",
        guildId: "222222222222222222",
      },
      coordinates: { channelId: "333333333333333333" },
    },
    projection:
      "discord:scope.applicationId=111111111111111111;scope.guildId=222222222222222222;channelId=333333333333333333",
  },
  email: {
    address: {
      channel: "email",
      scope: { mailbox: "assistant@example.com" },
      coordinates: { threadId: "thread-abc" },
    },
    projection:
      "email:scope.mailbox=assistant%40example.com;threadId=thread-abc",
  },
  phone: {
    address: {
      channel: "phone",
      scope: { assistantNumber: "+15555550100" },
      coordinates: { peerNumber: "+15555550123" },
    },
    projection:
      "phone:scope.assistantNumber=%2B15555550100;peerNumber=%2B15555550123",
  },
  platform: {
    address: {
      channel: "platform",
      scope: { platformAssistantId: "asst_1" },
      coordinates: { conversationId: "conv-xyz" },
    },
    projection:
      "platform:scope.platformAssistantId=asst_1;conversationId=conv-xyz",
  },
  slack: {
    address: {
      channel: "slack",
      scope: { teamId: "T0123ABCD" },
      coordinates: { conversationId: "C0123ABCD" },
    },
    projection: "slack:scope.teamId=T0123ABCD;conversationId=C0123ABCD",
  },
  telegram: {
    address: {
      channel: "telegram",
      scope: { botId: "8012345" },
      coordinates: { chatId: "-1001234567890" },
    },
    projection: "telegram:scope.botId=8012345;chatId=-1001234567890",
  },
  vellum: {
    address: { channel: "vellum", coordinates: { conversationId: "conv-xyz" } },
    projection: "vellum:conversationId=conv-xyz",
  },
  whatsapp: {
    address: {
      channel: "whatsapp",
      scope: { businessPhoneNumberId: "109876543210987" },
      coordinates: { chatId: "+15555550188" },
    },
    projection:
      "whatsapp:scope.businessPhoneNumberId=109876543210987;chatId=%2B15555550188",
  },
} as const satisfies Record<
  ChannelId,
  { address: ChannelAddress; projection: string }
>;

const CHANNELS: readonly ChannelId[] = CHANNEL_IDS;

describe("ChannelAddress exhaustiveness", () => {
  test("every canonical channel has a conversation address variant", () => {
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
        coordinates: { conversationId: "1" },
      }).success,
    ).toBe(false);
  });
});

describe("ChannelAddress variants", () => {
  for (const channel of CHANNELS) {
    test(`${channel}: accepts a well-formed conversation address`, () => {
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
});

describe("thread and topic coordinates", () => {
  test("slack: a threaded reply carries the parent thread_ts", () => {
    expect(
      ChannelAddressSchema.parse({
        channel: "slack",
        scope: { teamId: "T0123ABCD" },
        coordinates: {
          conversationId: "C0123ABCD",
          threadTs: "1700000000.000100",
        },
      }),
    ).toEqual({
      channel: "slack",
      scope: { teamId: "T0123ABCD" },
      coordinates: {
        conversationId: "C0123ABCD",
        threadTs: "1700000000.000100",
      },
    });
  });

  test("slack: a thread key must be a Slack message timestamp", () => {
    for (const threadTs of ["170000000", "170000000.1", "not-a-ts", ""]) {
      expect(
        ChannelAddressSchema.safeParse({
          channel: "slack",
          scope: { teamId: "T0123ABCD" },
          coordinates: { conversationId: "C0123ABCD", threadTs },
        }).success,
      ).toBe(false);
    }
  });

  test("telegram: a forum topic is part of the address", () => {
    expect(
      ChannelAddressSchema.safeParse({
        channel: "telegram",
        scope: { botId: "8012345" },
        coordinates: { chatId: "-1001234567890", topicId: "42" },
      }).success,
    ).toBe(true);
  });

  test("discord: a thread message carries the thread snowflake", () => {
    expect(
      ChannelAddressSchema.safeParse({
        channel: "discord",
        scope: {
          applicationId: "111111111111111111",
          guildId: "222222222222222222",
        },
        coordinates: {
          channelId: "333333333333333333",
          threadId: "444444444444444444",
        },
      }).success,
    ).toBe(true);
  });

  test("a thread key distinguishes two addresses in one conversation", () => {
    const unthreaded = formatChannelAddress({
      channel: "slack",
      scope: { teamId: "T0123ABCD" },
      coordinates: { conversationId: "C0123ABCD" },
    });
    const threaded = formatChannelAddress({
      channel: "slack",
      scope: { teamId: "T0123ABCD" },
      coordinates: {
        conversationId: "C0123ABCD",
        threadTs: "1700000000.000100",
      },
    });
    expect(unthreaded).not.toBe(threaded);
    expect(parseChannelAddress(threaded)).not.toEqual(
      parseChannelAddress(unthreaded),
    );
  });
});

describe("per-channel coordinate formats", () => {
  test("slack: a conversation slot will not hold a user or workspace id", () => {
    for (const conversationId of ["U0123ABCD", "T0123ABCD", "E0123ABCD"]) {
      expect(
        ChannelAddressSchema.safeParse({
          channel: "slack",
          scope: { teamId: "T0123ABCD" },
          coordinates: { conversationId },
        }).success,
      ).toBe(false);
    }
  });

  test("slack: DM and private conversation prefixes are accepted", () => {
    for (const conversationId of ["D0123ABCD", "G0123ABCD"]) {
      expect(
        ChannelAddressSchema.safeParse({
          channel: "slack",
          scope: { teamId: "T0123ABCD" },
          coordinates: { conversationId },
        }).success,
      ).toBe(true);
    }
  });

  test("slack: a workspace scope will not hold some other object's id", () => {
    for (const teamId of ["U0123ABCD", "E0123ABCD", "C0123ABCD"]) {
      expect(
        ChannelAddressSchema.safeParse({
          channel: "slack",
          scope: { teamId },
          coordinates: { conversationId: "C0123ABCD" },
        }).success,
      ).toBe(false);
    }
  });

  test("slack: an enterprise scope will not hold a workspace id", () => {
    expect(
      ChannelAddressSchema.safeParse({
        channel: "slack",
        scope: { teamId: "T0123ABCD", enterpriseId: "T0123ABCD" },
        coordinates: { conversationId: "C0123ABCD" },
      }).success,
    ).toBe(false);
  });

  test("slack: an address with no workspace scope is rejected", () => {
    expect(
      ChannelAddressSchema.safeParse({
        channel: "slack",
        coordinates: { conversationId: "C0123ABCD" },
      }).success,
    ).toBe(false);
  });

  test("telegram: a group chat id is negative and still valid", () => {
    expect(
      ChannelAddressSchema.safeParse({
        channel: "telegram",
        scope: { botId: "8012345" },
        coordinates: { chatId: "-1001234567890" },
      }).success,
    ).toBe(true);
  });

  test("telegram: an address with no bot scope is rejected", () => {
    expect(
      ChannelAddressSchema.safeParse({
        channel: "telegram",
        coordinates: { chatId: "123456789" },
      }).success,
    ).toBe(false);
  });

  test("discord: an address without a guild is rejected", () => {
    // The admission gate drops non-guild messages outright, so a DM never
    // reaches the point of needing an address.
    expect(
      ChannelAddressSchema.safeParse({
        channel: "discord",
        scope: { applicationId: "111111111111111111" },
        coordinates: { channelId: "333333333333333333" },
      }).success,
    ).toBe(false);
  });

  test("whatsapp: accepts the bare-digit wa_id Meta actually sends", () => {
    expect(
      ChannelAddressSchema.parse({
        channel: "whatsapp",
        scope: { businessPhoneNumberId: "109876543210987" },
        coordinates: { chatId: "15555550188" },
      }),
    ).toEqual({
      channel: "whatsapp",
      scope: { businessPhoneNumberId: "109876543210987" },
      coordinates: { chatId: "+15555550188" },
    });
  });

  test("whatsapp: prefixing the country code needs no country to be guessed", () => {
    expect(
      ChannelAddressSchema.parse({
        channel: "whatsapp",
        scope: { businessPhoneNumberId: "109876543210987" },
        coordinates: { chatId: "447700900123" },
      }),
    ).toEqual({
      channel: "whatsapp",
      scope: { businessPhoneNumberId: "109876543210987" },
      coordinates: { chatId: "+447700900123" },
    });
  });

  test("whatsapp: both spellings land on one address and one projection", () => {
    const bare = ChannelAddressSchema.parse({
      channel: "whatsapp",
      scope: { businessPhoneNumberId: "109876543210987" },
      coordinates: { chatId: "15555550188" },
    });
    const prefixed = ChannelAddressSchema.parse({
      channel: "whatsapp",
      scope: { businessPhoneNumberId: "109876543210987" },
      coordinates: { chatId: "+15555550188" },
    });
    expect(bare).toEqual(prefixed);
    expect(formatChannelAddress(bare)).toBe(formatChannelAddress(prefixed));
  });

  test("phone coordinates must already be E.164", () => {
    // Twilio hands over From and To with their `+`, so unlike a wa_id there is
    // no second provider-native spelling to accept.
    for (const value of ["15555550123", "(555) 555-0123", "+1"]) {
      expect(
        ChannelAddressSchema.safeParse({
          channel: "phone",
          coordinates: { peerNumber: value },
          scope: { assistantNumber: "+15555550100" },
        }).success,
      ).toBe(false);
    }
  });

  test("email: the mailbox scope must be an address and is lower cased", () => {
    expect(
      ChannelAddressSchema.parse({
        channel: "email",
        scope: { mailbox: "Assistant@example.com" },
        coordinates: { threadId: "thread-abc" },
      }),
    ).toEqual({
      channel: "email",
      scope: { mailbox: "assistant@example.com" },
      coordinates: { threadId: "thread-abc" },
    });
    expect(
      ChannelAddressSchema.safeParse({
        channel: "email",
        scope: { mailbox: "not-an-email" },
        coordinates: { threadId: "thread-abc" },
      }).success,
    ).toBe(false);
  });

  test("opaque coordinates reject whitespace and control characters", () => {
    for (const conversationId of ["conv abc", "conv\nabc", "conv\tabc"]) {
      expect(
        ChannelAddressSchema.safeParse({
          channel: "vellum",
          coordinates: { conversationId },
        }).success,
      ).toBe(false);
    }
  });

  test("coordinates are bounded", () => {
    expect(
      ChannelAddressSchema.safeParse({
        channel: "vellum",
        coordinates: { conversationId: "c".repeat(257) },
      }).success,
    ).toBe(false);
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
      coordinates: {
        threadTs: "1700000000.000100",
        conversationId: "C0123ABCD",
      },
      scope: { enterpriseId: "E9876ZZZZ", teamId: "T0123ABCD" },
    });
    const rewritten = formatChannelAddress({
      channel: "slack",
      scope: { teamId: "T0123ABCD", enterpriseId: "E9876ZZZZ" },
      coordinates: {
        conversationId: "C0123ABCD",
        threadTs: "1700000000.000100",
      },
    });
    expect(written).toBe(rewritten);
    expect(written).toBe(
      "slack:scope.enterpriseId=E9876ZZZZ;scope.teamId=T0123ABCD;conversationId=C0123ABCD;threadTs=1700000000.000100",
    );
  });

  test("absent optional coordinates are omitted, not emitted empty", () => {
    expect(
      formatChannelAddress({
        channel: "telegram",
        scope: { botId: "8012345" },
        coordinates: { chatId: "123456789" },
      }),
    ).toBe("telegram:scope.botId=8012345;chatId=123456789");
  });

  test("separators inside a coordinate value are escaped", () => {
    const projection = formatChannelAddress({
      channel: "a2a",
      coordinates: { peerAssistantId: "a;b=c%d" },
    });
    expect(projection).toBe("a2a:peerAssistantId=a%3Bb%3Dc%25d");
    expect(parseChannelAddress(projection)).toEqual({
      channel: "a2a",
      coordinates: { peerAssistantId: "a;b=c%d" },
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
        scope: { assistantNumber: "+15555550100" },
        coordinates: { peerNumber: "555-0123" },
      }),
    ).toThrow();
  });
});

describe("projection parsing", () => {
  test("rejects malformed projections", () => {
    const malformed = [
      "",
      "telegram",
      ":chatId=1",
      "telegram:",
      "telegram:chatId",
      "telegram:=1",
      "telegram:scope.botId=8012345;chatId=1;",
      "telegram:scope.botId=8012345;chatId=1;chatId=2",
      "telegram:scope.=1;chatId=1",
      "telegram:scope.botId=8012345;chatId=%E0%A4%A",
      "mastodon:chatId=1",
      "telegram:scope.botId=8012345;chatId=1;bogus=2",
      "telegram:scope.bogus=1;scope.botId=8012345;chatId=1",
      "slack:conversationId=C0123ABCD",
      "slack:scope.teamId=T0123ABCD",
      "phone:scope.assistantNumber=%2B15555550100;peerNumber=5555550123",
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
      "vellum:conversationId=conv-xyz;__proto__=x",
      "vellum:conversationId=conv-xyz;scope.__proto__=x",
      "vellum:conversationId=conv-xyz;constructor=x",
      "vellum:conversationId=conv-xyz;prototype=x",
      "vellum:conversationId=conv-xyz;toString=x",
      "vellum:conversationId=conv-xyz;hasOwnProperty=x",
      "slack:scope.teamId=T0123ABCD;conversationId=C0123ABCD;__proto__=junk",
      "slack:scope.__proto__=x;scope.teamId=T0123ABCD;conversationId=C0123ABCD",
    ]) {
      expect(safeParseChannelAddress(text)).toBeNull();
    }
  });

  test("a repeated prototype-shaped field is caught like any other duplicate", () => {
    for (const text of [
      "vellum:__proto__=a;__proto__=b;conversationId=conv-xyz",
      "vellum:constructor=a;constructor=b;conversationId=conv-xyz",
      "slack:scope.__proto__=a;scope.__proto__=b;scope.teamId=T0123ABCD;conversationId=C0123ABCD",
    ]) {
      expect(safeParseChannelAddress(text)).toBeNull();
    }
  });

  test("parsing never mutates Object.prototype", () => {
    safeParseChannelAddress(
      "vellum:conversationId=conv-xyz;__proto__=polluted",
    );
    safeParseChannelAddress(
      "vellum:__proto__=polluted;conversationId=conv-xyz",
    );
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
    expect("polluted" in {}).toBe(false);
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  test("the throwing form does not echo the projection", () => {
    const attempt = () => parseChannelAddress("email:threadId=secret-thread");
    expect(attempt).toThrow("not a valid channel address projection");
    expect(attempt).not.toThrow("secret-thread");
  });

  test("parsing canonicalizes a non-canonical projection", () => {
    expect(
      parseChannelAddress(
        "email:scope.mailbox=Assistant%40example.com;threadId=thread-abc",
      ),
    ).toEqual({
      channel: "email",
      scope: { mailbox: "assistant@example.com" },
      coordinates: { threadId: "thread-abc" },
    });
  });
});
