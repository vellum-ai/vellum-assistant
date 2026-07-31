import { describe, expect, test } from "bun:test";

import { CHANNEL_IDS } from "../channels.js";
import {
  CONVERSATION_HANDLE_PROVIDERS,
  ConversationHandleSchema,
  deserializeConversationHandle,
  safeDeserializeConversationHandle,
  serializeConversationHandle,
  type ConversationHandle,
} from "../conversation-handle.js";

// Representative handles, one per provider surface the contract must cover.
const slackChannel: ConversationHandle = {
  provider: "slack",
  connectionId: "conn-slack-1",
  teamId: "T0123ABCD",
  channelId: "C0123ABCD",
};

const slackThread: ConversationHandle = {
  provider: "slack",
  connectionId: "conn-slack-1",
  teamId: "T0123ABCD",
  channelId: "C0123ABCD",
  threadTs: "1700000000.000100",
};

const slackDm: ConversationHandle = {
  provider: "slack",
  connectionId: "conn-slack-1",
  teamId: "T0123ABCD",
  channelId: "D0456EFGH",
};

const telegramChat: ConversationHandle = {
  provider: "telegram",
  connectionId: "conn-telegram-1",
  chatId: "123456789",
  subconversation: { kind: "chat" },
};

const telegramMessageThread: ConversationHandle = {
  provider: "telegram",
  connectionId: "conn-telegram-1",
  chatId: "-1001234567890",
  subconversation: { kind: "message_thread", id: "42" },
};

const telegramDirectMessagesTopic: ConversationHandle = {
  provider: "telegram",
  connectionId: "conn-telegram-1",
  chatId: "-1009876543210",
  subconversation: { kind: "direct_messages_topic", id: "77" },
};

const discordChannel: ConversationHandle = {
  provider: "discord",
  connectionId: "conn-discord-1",
  guildId: "123456789012345678",
  channelId: "223456789012345678",
};

const discordThread: ConversationHandle = {
  provider: "discord",
  connectionId: "conn-discord-1",
  guildId: "123456789012345678",
  channelId: "223456789012345678",
  threadId: "323456789012345678",
};

const REPRESENTATIVE_HANDLES: ConversationHandle[] = [
  slackChannel,
  slackThread,
  slackDm,
  telegramChat,
  telegramMessageThread,
  telegramDirectMessagesTopic,
  discordChannel,
  discordThread,
];

describe("CONVERSATION_HANDLE_PROVIDERS", () => {
  test("is a subset of the canonical channel ids", () => {
    for (const provider of CONVERSATION_HANDLE_PROVIDERS) {
      expect(CHANNEL_IDS).toContain(provider);
    }
  });
});

describe("round-trip", () => {
  test.each(REPRESENTATIVE_HANDLES.map((h) => [h] as const))(
    "serialization and schema parsing preserve %j",
    (handle) => {
      const wire = serializeConversationHandle(handle);
      expect(safeDeserializeConversationHandle(wire)).toEqual(handle);
      expect(deserializeConversationHandle(wire)).toEqual(handle);
      // The wire form is plain JSON, so a generic JSON hop plus schema parse
      // reconstructs the same handle.
      expect(ConversationHandleSchema.parse(JSON.parse(wire))).toEqual(handle);
    },
  );
});

describe("provider discrimination", () => {
  test("rejects unknown providers", () => {
    expect(
      ConversationHandleSchema.safeParse({
        provider: "mastodon",
        connectionId: "conn-1",
      }).success,
    ).toBe(false);
  });

  test("rejects canonical channels that have no handle shape", () => {
    // whatsapp is a canonical ChannelId but not (yet) a handle provider, so
    // it must fail schema parsing rather than fall through to some default.
    expect(
      ConversationHandleSchema.safeParse({
        provider: "whatsapp",
        connectionId: "conn-1",
        chatId: "+15555550100",
      }).success,
    ).toBe(false);
  });

  test("rejects cross-provider coordinate mixes", () => {
    // Telegram handle carrying Slack routing fields.
    expect(
      ConversationHandleSchema.safeParse({
        provider: "telegram",
        connectionId: "conn-1",
        teamId: "T0123ABCD",
        channelId: "C0123ABCD",
      }).success,
    ).toBe(false);
    // Slack handle carrying Telegram routing fields.
    expect(
      ConversationHandleSchema.safeParse({
        ...slackChannel,
        chatId: "123456789",
      }).success,
    ).toBe(false);
    // Discord handle carrying a Telegram subconversation.
    expect(
      ConversationHandleSchema.safeParse({
        ...discordChannel,
        subconversation: { kind: "chat" },
      }).success,
    ).toBe(false);
  });
});

describe("telegram subconversations", () => {
  test("chat, message_thread, and direct_messages_topic are distinct", () => {
    const parsedThread = ConversationHandleSchema.parse(telegramMessageThread);
    const parsedTopic = ConversationHandleSchema.parse(
      telegramDirectMessagesTopic,
    );
    if (
      parsedThread.provider !== "telegram" ||
      parsedTopic.provider !== "telegram"
    ) {
      throw new Error("expected telegram handles");
    }
    expect(parsedThread.subconversation.kind).toBe("message_thread");
    expect(parsedTopic.subconversation.kind).toBe("direct_messages_topic");
  });

  test("rejects a chat subconversation carrying an id", () => {
    expect(
      ConversationHandleSchema.safeParse({
        ...telegramChat,
        subconversation: { kind: "chat", id: "42" },
      }).success,
    ).toBe(false);
  });

  test("rejects a message_thread subconversation missing its id", () => {
    expect(
      ConversationHandleSchema.safeParse({
        ...telegramChat,
        subconversation: { kind: "message_thread" },
      }).success,
    ).toBe(false);
  });

  test("rejects an unknown subconversation kind", () => {
    expect(
      ConversationHandleSchema.safeParse({
        ...telegramChat,
        subconversation: { kind: "topic", id: "42" },
      }).success,
    ).toBe(false);
  });

  test("rejects flattened untyped topic fields", () => {
    // message_thread_id and direct_messages_topic_id must not ride along as
    // loose fields next to (or instead of) the typed subconversation.
    for (const extra of [
      { topicId: "42" },
      { messageThreadId: "42" },
      { directMessagesTopicId: "42" },
    ]) {
      expect(
        ConversationHandleSchema.safeParse({
          ...telegramChat,
          ...extra,
        }).success,
      ).toBe(false);
    }
  });
});

describe("message coordinates stay out of the handle", () => {
  test.each([
    [{ ...telegramChat, messageId: "9001" }],
    [{ ...telegramChat, replyToMessageId: "9001" }],
    [{ ...slackThread, messageTs: "1700000000.000200" }],
    [{ ...discordThread, messageId: "423456789012345678" }],
  ])("rejects %j", (value) => {
    expect(ConversationHandleSchema.safeParse(value).success).toBe(false);
  });

  test("rejects a smuggled internal conversationId", () => {
    // The Vellum internal conversation id is a separate identity and never
    // lives inside the provider handle.
    expect(
      ConversationHandleSchema.safeParse({
        ...slackChannel,
        conversationId: "conv-xyz",
      }).success,
    ).toBe(false);
  });
});

describe("field validation", () => {
  test("requires a non-empty connectionId on every variant", () => {
    for (const handle of [slackChannel, telegramChat, discordChannel]) {
      expect(
        ConversationHandleSchema.safeParse({
          ...handle,
          connectionId: "",
        }).success,
      ).toBe(false);
      const { connectionId: _omitted, ...withoutConnection } = handle;
      expect(ConversationHandleSchema.safeParse(withoutConnection).success).toBe(
        false,
      );
    }
  });

  test("rejects whitespace and control characters in connectionId", () => {
    expect(
      ConversationHandleSchema.safeParse({
        ...slackChannel,
        connectionId: "conn 1",
      }).success,
    ).toBe(false);
    expect(
      ConversationHandleSchema.safeParse({
        ...slackChannel,
        connectionId: "conn\n1",
      }).success,
    ).toBe(false);
  });

  test.each([
    [{ ...slackChannel, teamId: "C0123ABCD" }],
    [{ ...slackChannel, channelId: "T0123ABCD" }],
    [{ ...slackThread, threadTs: "not-a-ts" }],
    // The gateway's block-actions reply routing falls back to a Slack
    // envelope id (a UUID) when no thread_ts exists. A handle only ever
    // carries a real thread_ts, so envelope-id-shaped values must fail here
    // instead of becoming durable identity.
    [{ ...slackThread, threadTs: "8a17bf85-6a58-4b60-8c81-63d8b5ab8c73" }],
    [{ ...telegramChat, chatId: "12ab34" }],
    [{ ...telegramMessageThread, subconversation: { kind: "message_thread", id: "-42" } }],
    [{ ...discordChannel, guildId: "123456789012345678901" }],
    [{ ...discordThread, threadId: "thread-1" }],
  ])("rejects malformed coordinates in %j", (value) => {
    expect(ConversationHandleSchema.safeParse(value).success).toBe(false);
  });

  test("coordinates are strings, not numbers", () => {
    expect(
      ConversationHandleSchema.safeParse({
        ...telegramChat,
        chatId: 123456789,
      }).success,
    ).toBe(false);
  });
});

describe("serialization helpers", () => {
  test("serializeConversationHandle validates before serializing", () => {
    expect(() =>
      serializeConversationHandle({
        ...telegramChat,
        chatId: "not-a-chat-id",
      } as ConversationHandle),
    ).toThrow();
  });

  test("safeDeserializeConversationHandle returns null on malformed input", () => {
    expect(safeDeserializeConversationHandle("not json")).toBeNull();
    expect(safeDeserializeConversationHandle("42")).toBeNull();
    expect(safeDeserializeConversationHandle('{"provider":"slack"}')).toBeNull();
  });

  test("deserializeConversationHandle throws on malformed input", () => {
    expect(() => deserializeConversationHandle("not json")).toThrow(
      "not a valid conversation handle serialization",
    );
  });
});
