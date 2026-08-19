import { describe, expect, it } from "bun:test";

import {
  type ChannelMessageMetadata,
  groupingMessageId,
} from "./channel-message-metadata.js";
import type { SlackMessageMetadata } from "./providers/slack/message-metadata.js";
import { readChannelMetadata } from "./read-channel-metadata.js";

const CHANNEL = "C0123CHANNEL";
const MESSAGE_TS = "1700000000.000100";
const TARGET_TS = "1699999999.000001";

function slackRow(
  overrides: Partial<SlackMessageMetadata> = {},
): SlackMessageMetadata {
  return {
    source: "slack",
    channelId: CHANNEL,
    channelTs: MESSAGE_TS,
    eventKind: "message",
    ...overrides,
  };
}

describe("readChannelMetadata", () => {
  it("reads a row that only has the legacy Slack envelope", () => {
    // Rows written before `channelMeta` existed are mapped on read rather
    // than rewritten, so there is no migration.
    const metadata = JSON.stringify({
      slackMeta: JSON.stringify(slackRow({ threadTs: TARGET_TS })),
    });

    expect(readChannelMetadata(metadata)).toEqual({
      source: "slack",
      chatId: CHANNEL,
      messageId: MESSAGE_TS,
      threadId: TARGET_TS,
      eventKind: "message",
    } satisfies ChannelMessageMetadata);
  });

  it("maps a reaction's target onto the neutral name", () => {
    const metadata = JSON.stringify({
      slackMeta: JSON.stringify(
        slackRow({
          eventKind: "reaction",
          reaction: {
            emoji: "thumbsup",
            targetChannelTs: TARGET_TS,
            op: "added",
            actorDisplayName: "Jason",
          },
        }),
      ),
    });

    const meta = readChannelMetadata(metadata);
    expect(meta?.eventKind).toBe("reaction");
    expect(meta?.reaction).toEqual({
      targetMessageId: TARGET_TS,
      emoji: "thumbsup",
      op: "added",
      actorDisplayName: "Jason",
    });
  });

  it("leaves threadId absent when the row is not in a thread", () => {
    // A thread id here asserts that a thread exists. Synthesizing one from
    // the message's own id is what keyed conversations on threads that never
    // did (LUM-3330, LUM-3340), so absence has to survive the mapping.
    const metadata = JSON.stringify({
      slackMeta: JSON.stringify(slackRow()),
    });

    const meta = readChannelMetadata(metadata);
    expect(meta).not.toBeNull();
    expect(meta?.threadId).toBeUndefined();
    expect(meta?.messageId).toBe(MESSAGE_TS);
  });

  it("reads a channel this repo has no code for", () => {
    // The point of the neutral shape. A plugin channel cannot add an adapter
    // here, so it describes its own rows directly and every channel-agnostic
    // reader understands them with no Vellum code naming that channel.
    const metadata = JSON.stringify({
      channelMeta: JSON.stringify({
        source: "plugin",
        chatId: "room-42",
        messageId: "evt-9",
        threadId: "evt-1",
        eventKind: "reaction",
        reaction: {
          targetMessageId: "evt-1",
          emoji: "tada",
          op: "added",
        },
      } satisfies ChannelMessageMetadata),
    });

    const meta = readChannelMetadata(metadata);
    expect(meta?.source).toBe("plugin");
    expect(meta?.reaction?.targetMessageId).toBe("evt-1");
    // Grouping is what history assembly keys on, so a reaction from an
    // unknown channel lands beside the message it was attached to.
    expect(groupingMessageId(meta!)).toBe("evt-1");
  });

  it("groups a message by its own id", () => {
    const metadata = JSON.stringify({
      slackMeta: JSON.stringify(slackRow()),
    });

    expect(groupingMessageId(readChannelMetadata(metadata)!)).toBe(MESSAGE_TS);
  });

  it("keeps provider fields the neutral schema does not name", () => {
    // The schema passes through, so a channel can carry its own fields on the
    // same object instead of getting a second envelope.
    const metadata = JSON.stringify({
      channelMeta: JSON.stringify({
        source: "slack",
        chatId: CHANNEL,
        messageId: MESSAGE_TS,
        eventKind: "message",
        slackFiles: [{ name: "diagram.png" }],
      }),
    });

    expect(
      (readChannelMetadata(metadata) as Record<string, unknown> | null)
        ?.slackFiles,
    ).toEqual([{ name: "diagram.png" }]);
  });

  it("reads as null when the row carries neither envelope", () => {
    expect(readChannelMetadata(JSON.stringify({ other: 1 }))).toBeNull();
    expect(readChannelMetadata("not json")).toBeNull();
    expect(readChannelMetadata(null)).toBeNull();
  });
});
