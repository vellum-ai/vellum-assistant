import { describe, expect, test } from "bun:test";

import {
  hasChannelSidecarContent,
  isReferenceableChannelEntry,
  partitionChannelTranscript,
  resolveChannelSidecarTarget,
} from "@/domains/chat/channel-sidecar/channel-sidecar-transcript";
import type { DisplayMessage } from "@/domains/chat/types/types";
import type { Conversation } from "@/types/conversation-types";

function vellumRow(id: string, text: string): DisplayMessage {
  return {
    id,
    role: "user",
    contentBlocks: [{ type: "text", text }],
  };
}

function slackRow(
  id: string,
  text: string,
  overrides: Partial<NonNullable<DisplayMessage["slackMessage"]>> = {},
): DisplayMessage {
  return {
    id,
    role: "user",
    contentBlocks: [{ type: "text", text }],
    slackMessage: {
      channelId: "C0123",
      channelTs: `${id}.000100`,
      channelName: "general",
      sender: { displayName: "Alice" },
      ...overrides,
    },
  };
}

const slackConversation: Pick<
  Conversation,
  "channelBinding" | "originChannel"
> = {
  originChannel: "slack",
  channelBinding: {
    sourceChannel: "slack",
    externalChatId: "C0123",
    externalChatName: "general",
  },
};

const telegramConversation: Pick<
  Conversation,
  "channelBinding" | "originChannel"
> = {
  originChannel: "telegram",
  channelBinding: {
    sourceChannel: "telegram",
    externalChatId: "998877",
    displayName: "Bob",
    sourceLink: { webUrl: "https://t.me/c/998877" },
  },
};

describe("partitionChannelTranscript", () => {
  test("moves attributable rows out of the Vellum lane", () => {
    const messages = [
      vellumRow("v1", "typed in Vellum"),
      slackRow("s1", "typed in Slack"),
      vellumRow("v2", "also Vellum"),
    ];

    const { vellumMessages, entries } = partitionChannelTranscript({
      messages,
      conversation: slackConversation,
    });

    expect(vellumMessages.map((m) => m.id)).toEqual(["v1", "v2"]);
    expect(entries.map((e) => e.id)).toEqual(["s1"]);
    expect(entries[0]!.text).toBe("typed in Slack");
    expect(entries[0]!.provenance.channelId).toBe("slack");
    expect(entries[0]!.provenance.senderName).toBe("Alice");
  });

  test("leaves an ordinary Vellum conversation untouched, by reference", () => {
    const messages = [vellumRow("v1", "hello")];

    const { vellumMessages, entries } = partitionChannelTranscript({
      messages,
      conversation: { originChannel: "vellum" },
    });

    expect(vellumMessages).toBe(messages);
    expect(entries).toEqual([]);
  });

  test("treats notification origins as native, not as a bound channel", () => {
    const messages = [vellumRow("v1", "reminder fired")];

    const { vellumMessages, entries } = partitionChannelTranscript({
      messages,
      conversation: { originChannel: "notification:slack" },
    });

    expect(vellumMessages).toBe(messages);
    expect(entries).toEqual([]);
  });

  test("keeps every row in the lane for a channel with no per-row envelope", () => {
    // Telegram is bound and eligible for the drawer, but the wire carries no
    // per-message envelope for it, so no row is attributable and the lane is
    // the unpartitioned transcript. Nothing is guessed out of it.
    const messages = [vellumRow("v1", "hi"), vellumRow("v2", "there")];

    const { vellumMessages, entries } = partitionChannelTranscript({
      messages,
      conversation: telegramConversation,
    });

    expect(vellumMessages).toBe(messages);
    expect(entries).toEqual([]);
  });

  test("does not read a foreign channel's envelope", () => {
    // A row carrying Slack metadata inside a Telegram-bound conversation is
    // not attributed to Telegram (or to Slack): the reader is keyed on the
    // conversation's own binding.
    const messages = [slackRow("s1", "stray envelope")];

    const { vellumMessages, entries } = partitionChannelTranscript({
      messages,
      conversation: telegramConversation,
    });

    expect(vellumMessages).toBe(messages);
    expect(entries).toEqual([]);
  });

  test("keeps the full body on drawer entries", () => {
    // The drawer is the canonical home of the rows it holds, so no display
    // truncation: only the composer reference bounds its snippet.
    const long = "x".repeat(5_000);

    const { entries } = partitionChannelTranscript({
      messages: [slackRow("s1", long)],
      conversation: slackConversation,
    });

    expect(entries[0]!.text).toBe(long);
  });

  test("keeps attributed rows the drawer cannot render losslessly", () => {
    // Rows carrying more than plain text (non-text blocks, attachments) stay
    // in the Vellum lane even when the channel attributes them: moving them
    // would drop the content the drawer's text row cannot show.
    const withThinking: DisplayMessage = {
      ...slackRow("s1", "final reply text"),
      contentBlocks: [
        { type: "thinking", thinking: "reasoning" },
        { type: "text", text: "final reply text" },
      ],
    };
    const withAttachment: DisplayMessage = {
      ...slackRow("s2", "see attached"),
      attachments: [
        {
          id: "attachment-1",
          filename: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 12,
          previewUrl: null,
          thumbnailUrl: null,
        },
      ],
    };
    const plain = slackRow("s3", "plain text row");

    const { vellumMessages, entries } = partitionChannelTranscript({
      messages: [withThinking, withAttachment, plain],
      conversation: slackConversation,
    });

    expect(vellumMessages.map((m) => m.id)).toEqual(["s1", "s2"]);
    expect(entries.map((e) => e.id)).toEqual(["s3"]);
  });

  test("carries reaction events through as their own kind", () => {
    const { entries } = partitionChannelTranscript({
      messages: [
        slackRow("s1", "", {
          eventKind: "reaction",
          reaction: {
            emoji: "tada",
            op: "added",
            targetChannelTs: "s0.000100",
          },
        }),
      ],
      conversation: slackConversation,
    });

    expect(entries[0]!.provenance.kind).toBe("reaction");
    expect(entries[0]!.provenance.reaction).toEqual({
      emoji: "tada",
      op: "added",
      actorName: undefined,
    });
  });
});

describe("resolveChannelSidecarTarget", () => {
  test("returns null for an unbound conversation", () => {
    expect(
      resolveChannelSidecarTarget({
        conversationId: "conv-1",
        conversation: { originChannel: "vellum" },
        entries: [],
      }),
    ).toBeNull();
  });

  test("describes a bound channel that ships no rows", () => {
    const target = resolveChannelSidecarTarget({
      conversationId: "conv-1",
      conversation: telegramConversation,
      entries: [],
    });

    expect(target).toEqual({
      conversationId: "conv-1",
      channelId: "telegram",
      threadName: "Bob",
      sourceHref: "https://t.me/c/998877",
    });
  });

  test("prefers the caller's richer link over the binding's", () => {
    const target = resolveChannelSidecarTarget({
      conversationId: "conv-1",
      conversation: telegramConversation,
      entries: [],
      sourceHref: "https://t.me/c/998877/42",
    });

    expect(target?.sourceHref).toBe("https://t.me/c/998877/42");
  });

  test("falls back to a row's channel name when the binding has none", () => {
    const { entries } = partitionChannelTranscript({
      messages: [slackRow("s1", "hi")],
      conversation: {
        originChannel: "slack",
        channelBinding: { sourceChannel: "slack", externalChatId: "C0123" },
      },
    });

    const target = resolveChannelSidecarTarget({
      conversationId: "conv-1",
      conversation: {
        originChannel: "slack",
        channelBinding: { sourceChannel: "slack", externalChatId: "C0123" },
      },
      entries,
    });

    expect(target?.threadName).toBe("general");
  });
});

describe("hasChannelSidecarContent", () => {
  test("is false for a binding with neither rows nor a link", () => {
    const target = resolveChannelSidecarTarget({
      conversationId: "conv-1",
      conversation: {
        originChannel: "telegram",
        channelBinding: { sourceChannel: "telegram", externalChatId: "998877" },
      },
      entries: [],
    });

    expect(target).not.toBeNull();
    expect(hasChannelSidecarContent(target, [])).toBe(false);
  });

  test("is true once there is a link to offer", () => {
    const target = resolveChannelSidecarTarget({
      conversationId: "conv-1",
      conversation: telegramConversation,
      entries: [],
    });

    expect(hasChannelSidecarContent(target, [])).toBe(true);
  });
});

describe("isReferenceableChannelEntry", () => {
  test("message rows can be staged; reaction rows cannot", () => {
    const { entries } = partitionChannelTranscript({
      messages: [
        slackRow("s1", "look at this"),
        slackRow("s2", "", {
          eventKind: "reaction",
          reaction: {
            emoji: "tada",
            op: "added",
            targetChannelTs: "s1.000100",
          },
        }),
      ],
      conversation: slackConversation,
    });

    expect(isReferenceableChannelEntry(entries[0]!)).toBe(true);
    expect(isReferenceableChannelEntry(entries[1]!)).toBe(false);
  });
});
