import { describe, it, expect } from "bun:test";
import type { GatewayInboundEvent } from "../types.js";
import {
  normalizeTelegramUpdate,
  type TelegramDropReason,
  type TelegramNormalization,
} from "./normalize.js";

/** The event a normalization produced, failing the test if it dropped. */
function eventOf(result: TelegramNormalization): GatewayInboundEvent {
  if (result.dropped) {
    throw new Error(`expected an event, got drop: ${result.reason}`);
  }
  return result.event;
}

function expectDrop(
  result: TelegramNormalization,
  reason: TelegramDropReason,
): void {
  expect(result.dropped).toBe(true);
  if (result.dropped) {
    expect(result.reason).toBe(reason);
  }
}

function makeCallbackQueryPayload(overrides?: {
  chatType?: string;
  chatId?: number;
  data?: string;
  fromId?: number;
}) {
  const hasChatType = overrides !== undefined && "chatType" in overrides;
  return {
    update_id: 100,
    callback_query: {
      id: "cbq-1",
      from: { id: overrides?.fromId ?? 42, first_name: "Alice" },
      message: {
        message_id: 10,
        chat: {
          id: overrides?.chatId ?? 42,
          type: hasChatType ? overrides!.chatType : "private",
        },
      },
      data: overrides?.data ?? "apr:run1:approve",
    },
  };
}

describe("normalizeTelegramUpdate — private-chat topics", () => {
  it("maps message_thread_id to source.threadId", () => {
    const result = eventOf(
      normalizeTelegramUpdate({
        update_id: 500,
        message: {
          message_id: 50,
          message_thread_id: 777,
          text: "hello topic",
          chat: { id: 42, type: "private" },
          from: { id: 42, first_name: "Alice" },
        },
      }),
    );

    expect(result.source.threadId).toBe("777");
    expect(result.message.content).toBe("hello topic");
  });

  it("leaves source.threadId undefined for messages outside a topic", () => {
    const result = eventOf(
      normalizeTelegramUpdate({
        update_id: 501,
        message: {
          message_id: 51,
          text: "plain dm",
          chat: { id: 42, type: "private" },
          from: { id: 42, first_name: "Alice" },
        },
      }),
    );

    expect(result.source.threadId).toBeUndefined();
  });

  it("maps callback_query message_thread_id to source.threadId", () => {
    const result = eventOf(
      normalizeTelegramUpdate({
        update_id: 502,
        callback_query: {
          id: "cbq-topic",
          from: { id: 42, first_name: "Alice" },
          message: {
            message_id: 52,
            message_thread_id: 777,
            chat: { id: 42, type: "private" },
          },
          data: "apr:run1:approve",
        },
      }),
    );

    expect(result.source.threadId).toBe("777");
  });

  it("drops a room message when the bot does not know its own identity, thread id or not", () => {
    const result = normalizeTelegramUpdate({
      update_id: 503,
      message: {
        message_id: 53,
        message_thread_id: 777,
        text: "forum topic message",
        chat: { id: -100123, type: "supergroup" },
        from: { id: 42, first_name: "Alice" },
      },
    });

    expectDrop(result, "bot_identity_unknown");
  });
});

describe("normalizeTelegramUpdate: event kinds", () => {
  it("classifies an edited_message as an edit", () => {
    const result = eventOf(
      normalizeTelegramUpdate({
        update_id: 600,
        edited_message: {
          message_id: 60,
          text: "fixed",
          chat: { id: 42, type: "private" },
          from: { id: 42, first_name: "Alice" },
        },
      }),
    );

    expect(result.message.eventKind).toBe("edit");
    expect(result.message.eventKind).toBe("edit");
  });

  it("classifies a plain message as a message", () => {
    const result = eventOf(
      normalizeTelegramUpdate({
        update_id: 601,
        message: {
          message_id: 61,
          text: "hello",
          chat: { id: 42, type: "private" },
          from: { id: 42, first_name: "Alice" },
        },
      }),
    );

    expect(result.message.eventKind).toBe("message");
  });
});

describe("normalizeTelegramUpdate: callback_query chat scope", () => {
  it("accepts callback_query from private chat", () => {
    const result = eventOf(
      normalizeTelegramUpdate(
        makeCallbackQueryPayload({ chatType: "private" }),
      ),
    );
    expect(result.message.callbackQueryId).toBe("cbq-1");
    expect(result.message.eventKind).toBe("button");
    expect(result.message.callbackData).toBe("apr:run1:approve");
  });

  it("forwards the button message's id so the card can be edited later", () => {
    // The approval-card edit after a decision addresses exactly the message
    // holding the inline keyboard. Dropping this id would leave stale
    // buttons on every decided card, silently: the daemon's interception
    // reads it off sourceMetadata.messageId.
    const result = eventOf(normalizeTelegramUpdate(makeCallbackQueryPayload()));

    expect(result.source.messageId).toBe("10");
    expect(result.message.eventKind).toBe("button");
  });

  it("admits callback_query from a group and states the room has other readers", () => {
    // A tap on a keyboard the bot posted is addressed to the bot by
    // construction; who may press it is the runtime's decision.
    const result = eventOf(
      normalizeTelegramUpdate(makeCallbackQueryPayload({ chatType: "group" })),
    );
    expect(result.message.eventKind).toBe("button");
    expect(result.source.isDirectMessage).toBe(false);
    expect(result.source.conversationType).toBe("private");
  });

  it("admits callback_query from a supergroup", () => {
    const result = eventOf(
      normalizeTelegramUpdate(
        makeCallbackQueryPayload({ chatType: "supergroup" }),
      ),
    );
    expect(result.source.isDirectMessage).toBe(false);
  });

  it("rejects callback_query from channel chat", () => {
    const result = normalizeTelegramUpdate(
      makeCallbackQueryPayload({ chatType: "channel" }),
    );
    expectDrop(result, "chat_not_supported");
  });

  it("rejects callback_query when chat type is undefined", () => {
    const result = normalizeTelegramUpdate(
      makeCallbackQueryPayload({ chatType: undefined as unknown as string }),
    );
    expectDrop(result, "chat_not_supported");
  });
});

function makeVoicePayload(overrides?: {
  chatType?: string;
  fromId?: number | null;
  caption?: string;
}) {
  return {
    update_id: 200,
    message: {
      message_id: 20,
      chat: { id: 42, type: overrides?.chatType ?? "private" },
      from:
        overrides?.fromId === null
          ? undefined
          : { id: overrides?.fromId ?? 42, first_name: "Alice" },
      ...(overrides?.caption ? { caption: overrides.caption } : {}),
      voice: {
        file_id: "voice-file-id-123",
        file_unique_id: "voice-unique-123",
        duration: 5,
        mime_type: "audio/ogg",
        file_size: 12345,
      },
    },
  };
}

function makeAudioPayload(overrides?: {
  chatType?: string;
  fromId?: number | null;
  caption?: string;
}) {
  return {
    update_id: 300,
    message: {
      message_id: 30,
      chat: { id: 42, type: overrides?.chatType ?? "private" },
      from:
        overrides?.fromId === null
          ? undefined
          : { id: overrides?.fromId ?? 42, first_name: "Alice" },
      ...(overrides?.caption ? { caption: overrides.caption } : {}),
      audio: {
        file_id: "audio-file-id-456",
        file_unique_id: "audio-unique-456",
        duration: 180,
        performer: "Artist",
        title: "Song Title",
        file_name: "song.mp3",
        mime_type: "audio/mpeg",
        file_size: 5000000,
      },
    },
  };
}

describe("normalizeTelegramUpdate — voice messages", () => {
  it("voice message produces an audio attachment with empty content", () => {
    const result = eventOf(normalizeTelegramUpdate(makeVoicePayload()));
    expect(result.message.content).toBe("");
    expect(result.message.attachments).toEqual([
      {
        type: "audio",
        fileId: "voice-file-id-123",
        mimeType: "audio/ogg",
        fileSize: 12345,
      },
    ]);
  });

  it("voice message from a room drops without the bot's identity", () => {
    const result = normalizeTelegramUpdate(
      makeVoicePayload({ chatType: "group" }),
    );
    expectDrop(result, "bot_identity_unknown");
  });

  it("voice message with missing sender is rejected", () => {
    const result = normalizeTelegramUpdate(makeVoicePayload({ fromId: null }));
    expectDrop(result, "missing_sender");
  });
});

describe("normalizeTelegramUpdate — audio messages", () => {
  it("audio message with caption produces audio attachment and caption as content", () => {
    const result = eventOf(
      normalizeTelegramUpdate(
        makeAudioPayload({ caption: "Check out this song" }),
      ),
    );
    expect(result.message.content).toBe("Check out this song");
    expect(result.message.attachments).toEqual([
      {
        type: "audio",
        fileId: "audio-file-id-456",
        fileName: "song.mp3",
        mimeType: "audio/mpeg",
        fileSize: 5000000,
      },
    ]);
  });

  it("audio message without caption has empty content", () => {
    const result = eventOf(normalizeTelegramUpdate(makeAudioPayload()));
    expect(result.message.content).toBe("");
    expect(result.message.attachments).toHaveLength(1);
    expect(result.message.attachments![0].type).toBe("audio");
  });

  it("audio message from a room drops without the bot's identity", () => {
    const result = normalizeTelegramUpdate(
      makeAudioPayload({ chatType: "supergroup" }),
    );
    expectDrop(result, "bot_identity_unknown");
  });

  it("audio message with missing sender is rejected", () => {
    const result = normalizeTelegramUpdate(makeAudioPayload({ fromId: null }));
    expectDrop(result, "missing_sender");
  });
});

describe("normalizeTelegramUpdate — malformed input is validated, not trusted", () => {
  it("drops a message whose chat.id is not a number", () => {
    // A non-number chat.id must be dropped, not coerced to
    // `String({...})` = "[object Object]" and forwarded as the conversation id.
    const result = normalizeTelegramUpdate({
      update_id: 600,
      message: {
        message_id: 60,
        text: "hi",
        chat: { id: { nested: true }, type: "private" },
        from: { id: 42, first_name: "Alice" },
      },
    });
    expectDrop(result, "missing_chat");
  });

  it("ignores a non-array photo instead of treating it like an array", () => {
    // A non-array photo must be ignored: `.length` on a string would otherwise
    // produce a garbage single-character attachment with an undefined fileId.
    const result = eventOf(
      normalizeTelegramUpdate({
        update_id: 601,
        message: {
          message_id: 61,
          text: "caption text",
          photo: "not-an-array",
          chat: { id: 42, type: "private" },
          from: { id: 42, first_name: "Alice" },
        },
      }),
    );
    expect(result.message.content).toBe("caption text");
    expect(result.message.attachments).toBeUndefined();
  });

  it("drops a non-numeric message_thread_id rather than stringifying it", () => {
    const result = eventOf(
      normalizeTelegramUpdate({
        update_id: 602,
        message: {
          message_id: 62,
          message_thread_id: { bad: true },
          text: "hi",
          chat: { id: 42, type: "private" },
          from: { id: 42, first_name: "Alice" },
        },
      }),
    );
    expect(result.source.threadId).toBeUndefined();
  });

  it("preserves the original payload verbatim as `raw`, unknown keys included", () => {
    const payload = {
      update_id: 603,
      message: {
        message_id: 63,
        text: "hi",
        chat: { id: 42, type: "private" },
        from: { id: 42, first_name: "Alice" },
      },
      // The schema strips this from the parsed working copy; `raw` must keep it.
      unknown_future_field: { anything: 1 },
    };
    const result = eventOf(normalizeTelegramUpdate(payload));
    expect(result.raw).toEqual(payload);
  });
});

const BOT = { userId: "123456789", username: "Vellum_Bot" };
const GROUP_CHAT = { id: -1001234567890, type: "supergroup" };

function makeGroupMessage(overrides: Record<string, unknown> = {}) {
  return {
    update_id: 700,
    message: {
      message_id: 70,
      chat: GROUP_CHAT,
      from: { id: 42, first_name: "Alice" },
      text: "hello",
      ...overrides,
    },
  };
}

describe("normalizeTelegramUpdate: rooms", () => {
  it("admits a supergroup message that mentions the bot and states the room facts", () => {
    const result = eventOf(
      normalizeTelegramUpdate(
        makeGroupMessage({
          text: "@vellum_bot what is the plan",
          entities: [{ type: "mention", offset: 0, length: 11 }],
        }),
        { bot: BOT },
      ),
    );
    expect(result.message.conversationExternalId).toBe("-1001234567890");
    expect(result.source.chatType).toBe("supergroup");
    expect(result.source.isDirectMessage).toBe(false);
    expect(result.source.botMentioned).toBe(true);
    expect(result.source.conversationType).toBe("private");
    expect(result.source.threadId).toBeUndefined();
  });

  it("drops a supergroup message that does not address the bot", () => {
    expectDrop(
      normalizeTelegramUpdate(makeGroupMessage(), { bot: BOT }),
      "bot_not_mentioned",
    );
  });

  it("a command addressed to the bot counts as a mention and loses its suffix", () => {
    // `/new@bot` must reach the route's command parsers as `/new`; the
    // username is Telegram's addressing, not part of the command.
    const result = eventOf(
      normalizeTelegramUpdate(
        makeGroupMessage({
          text: "/summary@Vellum_Bot last week",
          entities: [{ type: "bot_command", offset: 0, length: 19 }],
        }),
        { bot: BOT },
      ),
    );
    expect(result.message.content).toBe("/summary last week");
  });

  it("a command addressed to another bot keeps its suffix", () => {
    // Admitted only because the text also mentions this bot; the other
    // bot's command is content, not addressing.
    const result = eventOf(
      normalizeTelegramUpdate(
        makeGroupMessage({
          text: "/stats@other_bot cc @vellum_bot",
          entities: [
            { type: "bot_command", offset: 0, length: 16 },
            { type: "mention", offset: 20, length: 11 },
          ],
        }),
        { bot: BOT },
      ),
    );
    expect(result.message.content).toBe("/stats@other_bot cc @vellum_bot");
  });

  it("a mention inside a photo caption counts", () => {
    const result = normalizeTelegramUpdate(
      makeGroupMessage({
        text: undefined,
        caption: "look @vellum_bot",
        caption_entities: [{ type: "mention", offset: 5, length: 11 }],
        photo: [{ file_id: "p1", file_unique_id: "u1", width: 1, height: 1 }],
      }),
      { bot: BOT },
    );
    expect(result.dropped).toBe(false);
  });

  it("a text_mention names the bot by id when it has no username in the text", () => {
    const result = normalizeTelegramUpdate(
      makeGroupMessage({
        text: "Vellum, thoughts?",
        entities: [
          {
            type: "text_mention",
            offset: 0,
            length: 6,
            user: { id: 123456789 },
          },
        ],
      }),
      { bot: BOT },
    );
    expect(result.dropped).toBe(false);
  });

  it("a reply to one of the bot's posts is addressed to it", () => {
    const result = eventOf(
      normalizeTelegramUpdate(
        makeGroupMessage({
          reply_to_message: {
            message_id: 69,
            from: { id: 123456789, is_bot: true, first_name: "Vellum" },
          },
        }),
        { bot: BOT },
      ),
    );
    expect(result.source.botMentioned).toBe(true);
  });

  it("a forum topic message keys on its topic", () => {
    const result = eventOf(
      normalizeTelegramUpdate(
        makeGroupMessage({
          text: "@vellum_bot hi",
          entities: [{ type: "mention", offset: 0, length: 11 }],
          message_thread_id: 555,
          is_topic_message: true,
        }),
        { bot: BOT },
      ),
    );
    expect(result.source.threadId).toBe("555");
  });

  it("a reply chain in a supergroup is not a topic and does not fork the conversation", () => {
    // Telegram sets message_thread_id on reply chains in supergroups too; only
    // is_topic_message says it is a forum topic.
    const result = eventOf(
      normalizeTelegramUpdate(
        makeGroupMessage({
          text: "@vellum_bot hi",
          entities: [{ type: "mention", offset: 0, length: 11 }],
          message_thread_id: 12,
        }),
        { bot: BOT },
      ),
    );
    expect(result.source.threadId).toBeUndefined();
  });

  it("a private-chat message states it was not named and has one reader", () => {
    const result = eventOf(
      normalizeTelegramUpdate(
        makeGroupMessage({ chat: { id: 42, type: "private" } }),
        { bot: BOT },
      ),
    );
    expect(result.source.isDirectMessage).toBe(true);
    expect(result.source.botMentioned).toBe(false);
    expect(result.source.conversationType).toBe("dm");
  });

  it("refuses a channel post", () => {
    expectDrop(
      normalizeTelegramUpdate(
        makeGroupMessage({ chat: { id: -100999, type: "channel" } }),
        { bot: BOT },
      ),
      "chat_not_supported",
    );
  });
});
