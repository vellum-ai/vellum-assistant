import { describe, expect, test } from "bun:test";

import { admitDiscordMessage } from "./admit.js";
import {
  DiscordInteractionSchema,
  DiscordMessageCreateSchema,
  DiscordMessageDeleteSchema,
  DiscordMessageReactionSchema,
} from "./message-schemas.js";
import {
  normalizeDiscordInteraction,
  normalizeDiscordMessage,
  normalizeDiscordMessageDelete,
  normalizeDiscordMessageReaction,
  toAdmissionCandidate,
} from "./normalize.js";
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
    // `guild_id` is deliberately absent from this list: it gates admission, so
    // it collapses to a sentinel rather than to undefined. See the
    // fail-closed test below.
    const message = parse(
      messagePayload({
        mentions: "not-an-array",
        author: { id: "user-1", username: 7 },
      }),
    );
    expect(message.mentions).toBeUndefined();
    expect(message.author?.id).toBe("user-1");
    expect(message.author?.username).toBeUndefined();
  });

  test("a malformed guild id fails closed, not to absent", () => {
    // Absence marks a DM, and a DM is admitted without a mention. Collapsing
    // a parse failure to undefined would hand a guild message that exemption,
    // so it collapses to a truthy sentinel instead and stays on the guild
    // path. Same reasoning as the bot indicators.
    const message = parse(messagePayload({ guild_id: 42 }));
    expect(message.guild_id).toBeDefined();
    expect(message.guild_id).not.toBeUndefined();
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

  test("maps attachment media types to canonical kinds", () => {
    const raw = messagePayload({
      attachments: [
        {
          id: "image-1",
          filename: "photo.png",
          size: 10,
          content_type: "image/png",
          url: "https://cdn.discord.test/photo.png",
        },
        {
          id: "video-1",
          filename: "clip.mp4",
          size: 11,
          content_type: "video/mp4",
          url: "https://cdn.discord.test/clip.mp4",
        },
        {
          id: "audio-1",
          filename: "voice.ogg",
          size: 12,
          content_type: "audio/ogg",
          url: "https://cdn.discord.test/voice.ogg",
        },
        {
          id: "document-1",
          filename: "notes.bin",
          size: 13,
          content_type: "application/octet-stream",
          url: "https://cdn.discord.test/notes.bin",
        },
        {
          id: "missing-type-1",
          filename: "unknown",
          size: 14,
          url: "https://cdn.discord.test/unknown",
        },
      ],
    });
    const event = normalizeDiscordMessage(parse(raw), { raw });

    expect(event?.message.attachments).toEqual([
      {
        type: "image",
        fileId: "image-1",
        fileName: "photo.png",
        mimeType: "image/png",
        fileSize: 10,
      },
      {
        type: "video",
        fileId: "video-1",
        fileName: "clip.mp4",
        mimeType: "video/mp4",
        fileSize: 11,
      },
      {
        type: "audio",
        fileId: "audio-1",
        fileName: "voice.ogg",
        mimeType: "audio/ogg",
        fileSize: 12,
      },
      {
        type: "document",
        fileId: "document-1",
        fileName: "notes.bin",
        mimeType: "application/octet-stream",
        fileSize: 13,
      },
      {
        type: "document",
        fileId: "missing-type-1",
        fileName: "unknown",
        fileSize: 14,
      },
    ]);
  });

  test("omits attachments that do not have a download URL", () => {
    const raw = messagePayload({
      attachments: [
        {
          id: "missing-url",
          filename: "missing.txt",
          size: 10,
          content_type: "text/plain",
        },
      ],
    });
    const event = normalizeDiscordMessage(parse(raw), { raw });
    expect(event?.message.attachments).toBeUndefined();
  });

  test("omits the attachments key when the payload has no attachments", () => {
    const raw = messagePayload();
    const event = normalizeDiscordMessage(parse(raw), { raw });
    expect("attachments" in (event?.message ?? {})).toBe(false);
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

  test("a DM is its own conversation and is marked as one", () => {
    // `chatType` is what tells the seeding path that this conversation address
    // is private. A guild channel wrongly marked "dm" would be recorded as the
    // actor's delivery address and later receive their private notices.
    const raw = messagePayload({
      guild_id: undefined,
      channel_id: "dm-channel-1",
      content: "123456",
      mentions: [],
    });
    const event = normalizeDiscordMessage(parse(raw), { raw });
    expect(event?.source.chatType).toBe("dm");
    expect(event?.source.isDirectMessage).toBe(true);
    expect(event?.message.eventKind).toBe("message");
    expect(event?.message.conversationExternalId).toBe("dm-channel-1");
    expect(event?.source.threadId).toBeUndefined();
    expect(event?.actor.actorExternalId).toBe("user-1");
  });

  test("keeps a file-only DM routable with empty content", () => {
    const raw = messagePayload({
      guild_id: undefined,
      channel_id: "dm-channel-1",
      content: "",
      mentions: [],
      attachments: [
        {
          id: "file-only-1",
          filename: "report.pdf",
          size: 10,
          content_type: "application/pdf",
          url: "https://cdn.discord.test/report.pdf",
        },
      ],
    });
    const parsed = parse(raw);
    const event = normalizeDiscordMessage(parsed, { raw });
    const candidate = toAdmissionCandidate(parsed, undefined);

    expect(event?.source.chatType).toBe("dm");
    expect(event?.message.content).toBe("");
    expect(event?.message.attachments).toEqual([
      {
        type: "document",
        fileId: "file-only-1",
        fileName: "report.pdf",
        mimeType: "application/pdf",
        fileSize: 10,
      },
    ]);
    expect(candidate).not.toBeNull();
    expect(
      admitDiscordMessage(candidate!, {
        botUserId: "bot-1",
      }),
    ).toEqual({ admitted: true });
  });

  test("a malformed guild id stays a guild message, not a DM", () => {
    // The DM lane reads an absent guild as private and skips the mention
    // check, so a parse failure must not land there. The schema collapses a
    // bad `guild_id` to a sentinel rather than to undefined, which keeps it
    // on the guild path.
    const raw = messagePayload({ guild_id: 12345, mentions: [] });
    const parsed = parse(raw);
    expect(parsed.guild_id).toBeDefined();

    const event = normalizeDiscordMessage(parsed, { raw });
    expect(event?.source.chatType).toBe("channel");
    expect(event?.source.isDirectMessage).toBe(false);

    // And the gate keeps applying the guild controls to it.
    const candidate = toAdmissionCandidate(parsed, undefined);
    expect(candidate).not.toBeNull();
    const verdict = admitDiscordMessage(candidate!, {
      botUserId: "bot-1",
    });
    expect(verdict).toEqual({ admitted: false, reason: "bot_not_mentioned" });
  });

  test("a guild message is never marked as a DM", () => {
    const raw = messagePayload();
    const event = normalizeDiscordMessage(parse(raw), { raw });
    expect(event?.source.chatType).toBe("channel");
  });

  test("a thread message is never marked as a DM", () => {
    // A thread carries its parent's guild, so the DM test must key on the
    // guild rather than on the absence of a parent channel.
    const raw = messagePayload({ channel_id: "thread-1" });
    const event = normalizeDiscordMessage(parse(raw), {
      raw,
    });
    expect(event?.source.chatType).toBe("channel");
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

describe("normalizeDiscordMessage: edits", () => {
  test("an edit names its family and revision without carrying media", () => {
    const message = parse(
      messagePayload({
        edited_timestamp: "2026-08-27T10:00:00.000000+00:00",
        attachments: [{ id: "att-1", filename: "photo.png" }],
      }),
    );
    const event = normalizeDiscordMessage(message, {
      raw: {},
      edit: { revision: message.edited_timestamp! },
    });

    expect(event).not.toBeNull();
    expect(event!.message.eventKind).toBe("edit");
    // The dedup id is unique per revision so successive edits of one message
    // never swallow each other; the source id keeps naming the message the
    // edit rewrites.
    expect(event!.message.externalMessageId).toBe(
      "msg-1:edit:2026-08-27T10:00:00.000000+00:00",
    );
    expect(event!.source.messageId).toBe("msg-1");
    // An edit refers to another message and ingests no media of its own.
    expect(event!.message.attachments).toBeUndefined();
  });
});

describe("normalizeDiscordMessageDelete", () => {
  test("a delete states its family and its unattributed actor", () => {
    const parsed = DiscordMessageDeleteSchema.safeParse({
      id: "msg-9",
      channel_id: "channel-1",
      guild_id: "guild-1",
    });
    expect(parsed.success).toBe(true);
    const event = normalizeDiscordMessageDelete(
      parsed.success ? parsed.data : (undefined as never),
      { raw: {} },
    );

    expect(event).not.toBeNull();
    expect(event!.message.eventKind).toBe("delete");
    expect(event!.message.externalMessageId).toBe("msg-9:delete");
    expect(event!.source.messageId).toBe("msg-9");
    // The wire names no actor: the synthetic id is not an identity claim,
    // and the flag is what lets the daemon treat it that way.
    expect(event!.actor.actorExternalId).toBe("discord-system");
    expect(event!.source.actorUnattributed).toBe(true);
    expect(event!.source.isDirectMessage).toBe(false);
  });

  test("a DM delete proves its lane by guild absence", () => {
    const parsed = DiscordMessageDeleteSchema.safeParse({
      id: "msg-10",
      channel_id: "dm-channel-1",
    });
    expect(parsed.success).toBe(true);
    const event = normalizeDiscordMessageDelete(
      parsed.success ? parsed.data : (undefined as never),
      { raw: {} },
    );

    expect(event!.source.isDirectMessage).toBe(true);
    expect(event!.source.conversationType).toBe("dm");
  });
});
describe("normalizeDiscordMessageReaction", () => {
  function parseReaction(payload: Record<string, unknown>) {
    const parsed = DiscordMessageReactionSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error("schema unexpectedly rejected payload");
    }
    return parsed.data;
  }

  test("a unicode reaction carries the structured payload", () => {
    const event = normalizeDiscordMessageReaction(
      parseReaction({
        user_id: "user-1",
        channel_id: "channel-1",
        message_id: "msg-1",
        guild_id: "guild-1",
        emoji: { id: null, name: "\u{1F44D}" },
      }),
      { op: "added", raw: {} },
    );

    expect(event).not.toBeNull();
    expect(event!.message.eventKind).toBe("reaction");
    expect(event!.message.content).toBe("");
    expect(event!.message.reaction).toEqual({
      op: "added",
      emoji: "\u{1F44D}",
      targetMessageId: "msg-1",
    });
    expect(event!.message.externalMessageId).toBe(
      "msg-1:reaction:\u{1F44D}:user-1",
    );
    expect(event!.source.messageId).toBe("msg-1");
    expect(event!.actor.actorExternalId).toBe("user-1");
    expect(event!.source.isDirectMessage).toBe(false);
  });

  test("a removal appends the op suffix so it never dedups against the add", () => {
    const event = normalizeDiscordMessageReaction(
      parseReaction({
        user_id: "user-1",
        channel_id: "channel-1",
        message_id: "msg-1",
        guild_id: "guild-1",
        emoji: { id: null, name: "\u{1F44D}" },
      }),
      { op: "removed", raw: {} },
    );

    expect(event!.message.reaction!.op).toBe("removed");
    expect(event!.message.externalMessageId).toBe(
      "msg-1:reaction:\u{1F44D}:user-1:removed",
    );
  });

  test("a custom emoji forwards its mention form, never its bare name", () => {
    const event = normalizeDiscordMessageReaction(
      parseReaction({
        user_id: "user-1",
        channel_id: "channel-1",
        message_id: "msg-1",
        guild_id: "guild-1",
        emoji: { id: "111222333", name: "party_blob" },
      }),
      { op: "added", raw: {} },
    );

    expect(event!.message.reaction!.emoji).toBe("<:party_blob:111222333>");
  });

  test("a custom emoji squatting on approval vocabulary stays inert", () => {
    // A guild can name a custom emoji anything, including a Slack decision
    // name. The mention form is what keeps it out of the approval map.
    const event = normalizeDiscordMessageReaction(
      parseReaction({
        user_id: "user-1",
        channel_id: "channel-1",
        message_id: "msg-1",
        guild_id: "guild-1",
        emoji: { id: "999888777", name: "white_check_mark" },
      }),
      { op: "added", raw: {} },
    );

    expect(event!.message.reaction!.emoji).toBe(
      "<:white_check_mark:999888777>",
    );
  });

  test("an emoji with no name cannot be expressed and drops", () => {
    const event = normalizeDiscordMessageReaction(
      parseReaction({
        user_id: "user-1",
        channel_id: "channel-1",
        message_id: "msg-1",
        guild_id: "guild-1",
        emoji: { id: "111222333", name: null },
      }),
      { op: "removed", raw: {} },
    );

    expect(event).toBeNull();
  });

  test("a DM reaction proves its lane by guild absence", () => {
    const event = normalizeDiscordMessageReaction(
      parseReaction({
        user_id: "user-1",
        channel_id: "dm-channel-1",
        message_id: "msg-2",
        emoji: { id: null, name: "\u2705" },
      }),
      { op: "added", raw: {} },
    );

    expect(event!.source.isDirectMessage).toBe(true);
    expect(event!.source.conversationType).toBe("dm");
  });

  test("a thread reaction addresses the parent conversation and names the thread", () => {
    const event = normalizeDiscordMessageReaction(
      parseReaction({
        user_id: "user-1",
        channel_id: "thread-1",
        message_id: "msg-3",
        guild_id: "guild-1",
        emoji: { id: null, name: "\u{1F44D}" },
      }),
      { op: "added", parentChannelId: "channel-1", raw: {} },
    );

    expect(event!.message.conversationExternalId).toBe("channel-1");
    expect(event!.source.threadId).toBe("thread-1");
  });
});
describe("normalizeDiscordInteraction", () => {
  function parseInteraction(payload: Record<string, unknown>) {
    const parsed = DiscordInteractionSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error("schema unexpectedly rejected payload");
    }
    return parsed.data;
  }

  const base = (overrides: Record<string, unknown> = {}) => ({
    id: "inter-1",
    token: "inter-token-1",
    type: 3,
    channel_id: "dm-channel-1",
    data: { custom_id: "apr:req-1:approve_once", component_type: 2 },
    message: { id: "card-msg-1" },
    user: { id: "user-1", username: "alice", global_name: "Alice" },
    ...overrides,
  });

  test("a DM button press takes the button family with the card's id", () => {
    const event = normalizeDiscordInteraction(parseInteraction(base()), {
      raw: {},
    });

    expect(event).not.toBeNull();
    expect(event!.message.eventKind).toBe("button");
    expect(event!.message.callbackData).toBe("apr:req-1:approve_once");
    expect(event!.message.content).toBe("apr:req-1:approve_once");
    expect(event!.message.externalMessageId).toBe("inter-1");
    expect(event!.source.messageId).toBe("card-msg-1");
    expect(event!.actor.actorExternalId).toBe("user-1");
    expect(event!.actor.displayName).toBe("Alice");
    expect(event!.source.isDirectMessage).toBe(true);
    expect(event!.source.conversationType).toBe("dm");
  });

  test("a guild press names its actor from member.user and proves no DM", () => {
    const event = normalizeDiscordInteraction(
      parseInteraction(
        base({
          guild_id: "guild-1",
          user: undefined,
          member: { user: { id: "user-2", username: "bob" } },
        }),
      ),
      { raw: {} },
    );

    expect(event!.actor.actorExternalId).toBe("user-2");
    expect(event!.source.isDirectMessage).toBe(false);
    expect(event!.source.conversationType).toBeUndefined();
  });

  test("a bot actor cannot press a real button and drops", () => {
    const event = normalizeDiscordInteraction(
      parseInteraction(
        base({ user: { id: "bot-x", username: "x", bot: true } }),
      ),
      { raw: {} },
    );

    expect(event).toBeNull();
  });

  test("an interaction naming no actor drops", () => {
    const event = normalizeDiscordInteraction(
      parseInteraction(base({ user: undefined })),
      { raw: {} },
    );

    expect(event).toBeNull();
  });

  test("a thread press addresses the parent conversation", () => {
    const event = normalizeDiscordInteraction(
      parseInteraction(base({ channel_id: "thread-1", guild_id: "guild-1" })),
      { parentChannelId: "channel-1", raw: {} },
    );

    expect(event!.message.conversationExternalId).toBe("channel-1");
    expect(event!.source.threadId).toBe("thread-1");
  });
});
