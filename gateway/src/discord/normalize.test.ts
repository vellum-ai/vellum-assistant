import { describe, expect, test } from "bun:test";

import { admitDiscordMessage } from "./admit.js";
import { DiscordMessageCreateSchema } from "./message-schemas.js";
import { normalizeDiscordMessage, toAdmissionCandidate } from "./normalize.js";
import "../__tests__/test-preload.js";

/** A well-formed guild MESSAGE_CREATE payload, as Discord sends it. */
function messagePayload(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg-1",
    channel_id: "channel-1",
    guild_id: "guild-1",
    content: "<@bot-1> hello",
    author: {
      id: "user-1",
      username: "alice",
      global_name: "Alice Example",
      bot: false,
    },
    mentions: [{ id: "bot-1", username: "vellum" }],
    ...overrides,
  };
}

function parse(payload: Record<string, unknown>) {
  const parsed = DiscordMessageCreateSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("schema unexpectedly rejected payload");
  }
  return parsed.data;
}

describe("DiscordMessageCreateSchema", () => {
  test("keeps the fields admission and normalization read", () => {
    const message = parse(messagePayload());
    expect(message.id).toBe("msg-1");
    expect(message.channel_id).toBe("channel-1");
    expect(message.content).toBe("<@bot-1> hello");
    expect(message.author?.id).toBe("user-1");
    expect(message.mentions?.map((m) => m.id)).toEqual(["bot-1"]);
  });

  test("accepts an empty-content message without complaint", () => {
    // Without MESSAGE_CONTENT, non-exempt messages arrive with content
    // *empty* — a steady stream of these is normal, not a schema violation.
    const message = parse(
      messagePayload({
        content: "",
        mentions: [],
        embeds: [],
        attachments: [],
      }),
    );
    expect(message.content).toBe("");
  });

  test("accepts an absent poll — omitted, not empty, without the intent", () => {
    const payload = messagePayload();
    expect("poll" in payload).toBe(false);
    expect(() => parse(payload)).not.toThrow();
  });

  test("collapses malformed optional fields instead of rejecting", () => {
    const message = parse(
      messagePayload({
        guild_id: 42,
        mentions: "not-an-array",
        author: { id: "user-1", username: 7 },
      }),
    );
    expect(message.guild_id).toBeUndefined();
    expect(message.mentions).toBeUndefined();
    expect(message.author?.id).toBe("user-1");
    expect(message.author?.username).toBeUndefined();
  });

  test("malformed bot indicators fail closed, not to human", () => {
    // `author.bot` and `webhook_id` are the classifiers standing between the
    // admission gate and a bot reply loop, so unlike the tolerant fields a
    // malformed value collapses to the bot-indicating side. Absence is still
    // `undefined` — Discord omits `bot` for humans.
    expect(
      parse(messagePayload({ author: { id: "user-1", bot: "yes" } })).author
        ?.bot,
    ).toBe(true);
    expect(parse(messagePayload({ webhook_id: 42 })).webhook_id).toBe(
      "malformed-webhook-id",
    );
    expect(parse(messagePayload()).author?.bot).toBe(false);
    const humanShaped = parse(messagePayload({ author: { id: "user-1" } }));
    expect(humanShaped.author?.bot).toBeUndefined();
    expect(humanShaped.webhook_id).toBeUndefined();
  });

  test("collapses malformed content to empty rather than rejecting", () => {
    expect(parse(messagePayload({ content: 42 })).content).toBe("");
  });
});

describe("toAdmissionCandidate", () => {
  test("maps the fields the admission gate reads", () => {
    const candidate = toAdmissionCandidate(parse(messagePayload()), undefined);
    expect(candidate).toEqual({
      channelId: "channel-1",
      guildId: "guild-1",
      authorId: "user-1",
      authorIsBot: false,
      mentionedUserIds: ["bot-1"],
    });
  });

  test("threads carry their resolved parent", () => {
    const candidate = toAdmissionCandidate(
      parse(messagePayload({ channel_id: "thread-1" })),
      "channel-1",
    );
    expect(candidate?.channelId).toBe("thread-1");
    expect(candidate?.parentChannelId).toBe("channel-1");
  });

  test("webhook messages read as bot-authored", () => {
    const candidate = toAdmissionCandidate(
      parse(messagePayload({ webhook_id: "wh-1" })),
      undefined,
    );
    expect(candidate?.authorIsBot).toBe(true);
  });

  test("a malformed bot indicator is dropped at the admission gate", () => {
    // End-to-end check of the fail-closed collapse: a message whose bot flag
    // is garbage must never pass the gate as human.
    for (const overrides of [
      { author: { id: "user-1", bot: "yes" } },
      { webhook_id: 42 },
    ]) {
      const candidate = toAdmissionCandidate(
        parse(messagePayload(overrides)),
        undefined,
      );
      expect(candidate?.authorIsBot).toBe(true);
      const verdict = admitDiscordMessage(candidate!, {
        botUserId: "bot-1",
        allowedChannelIds: new Set(["channel-1"]),
      });
      expect(verdict).toEqual({ admitted: false, reason: "bot_authored" });
    }
  });

  test("returns null without author identity", () => {
    expect(
      toAdmissionCandidate(parse(messagePayload({ author: {} })), undefined),
    ).toBeNull();
    const noAuthor = messagePayload();
    delete (noAuthor as Record<string, unknown>).author;
    expect(toAdmissionCandidate(parse(noAuthor), undefined)).toBeNull();
  });
});

describe("normalizeDiscordMessage", () => {
  test("produces a discord inbound event with the identity vocabulary", () => {
    const raw = messagePayload();
    const event = normalizeDiscordMessage(parse(raw), { raw });
    expect(event).not.toBeNull();
    expect(event?.sourceChannel).toBe("discord");
    expect(event?.version).toBe("v1");
    expect(event?.message.content).toBe("<@bot-1> hello");
    expect(event?.message.conversationExternalId).toBe("channel-1");
    expect(event?.message.externalMessageId).toBe("msg-1");
    expect(event?.actor.actorExternalId).toBe("user-1");
    expect(event?.actor.username).toBe("alice");
    expect(event?.actor.displayName).toBe("Alice Example");
    expect(event?.actor.isBot).toBe(false);
    expect(event?.source.updateId).toBe("msg-1");
    expect(event?.source.threadId).toBeUndefined();
    // receivedAt is the gateway's wall clock, never provider-supplied.
    expect(Number.isNaN(Date.parse(event?.receivedAt ?? ""))).toBe(false);
  });

  test("thread messages deliver on the parent with the thread as threadId", () => {
    const raw = messagePayload({ channel_id: "thread-1" });
    const event = normalizeDiscordMessage(parse(raw), {
      parentChannelId: "channel-1",
      raw,
    });
    expect(event?.message.conversationExternalId).toBe("channel-1");
    expect(event?.source.threadId).toBe("thread-1");
  });

  test("preserves the raw payload verbatim", () => {
    const raw = messagePayload({ unmodeled_field: { nested: true } });
    const event = normalizeDiscordMessage(parse(raw), { raw });
    expect(event?.raw).toBe(raw);
  });

  test("a null global_name never becomes a display name", () => {
    const raw = messagePayload({
      author: { id: "user-1", username: "alice", global_name: null },
    });
    const event = normalizeDiscordMessage(parse(raw), { raw });
    expect(event?.actor.displayName).toBeUndefined();
    expect(event?.actor.username).toBe("alice");
  });

  test("returns null when identity fields are missing", () => {
    const noId = parse(messagePayload({ id: 42 }));
    expect(normalizeDiscordMessage(noId, { raw: {} })).toBeNull();
    const noChannel = parse(messagePayload({ channel_id: undefined }));
    expect(normalizeDiscordMessage(noChannel, { raw: {} })).toBeNull();
    const noAuthor = parse(messagePayload({ author: undefined }));
    expect(normalizeDiscordMessage(noAuthor, { raw: {} })).toBeNull();
  });
});
