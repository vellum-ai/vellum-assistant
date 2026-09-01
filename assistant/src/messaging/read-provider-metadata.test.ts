import { describe, expect, it } from "bun:test";

import {
  groupingMessageId,
  type ProviderMessageMetadata,
} from "./provider-message-metadata.js";
import type { SlackMessageMetadata } from "./providers/slack/message-metadata.js";
import { readProviderMetadata } from "./read-provider-metadata.js";

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

describe("readProviderMetadata", () => {
  it("reads a row that only has the legacy Slack envelope", () => {
    // Slack's own envelope is mapped on read, so no row is rewritten.
    const metadata = JSON.stringify({
      slackMeta: JSON.stringify(slackRow({ threadTs: TARGET_TS })),
    });

    expect(readProviderMetadata(metadata)).toEqual({
      source: "slack",
      conversationExternalId: CHANNEL,
      messageId: MESSAGE_TS,
      threadId: TARGET_TS,
      eventKind: "message",
    } satisfies ProviderMessageMetadata);
  });

  it("carries the actor's provider id, not just a display name", () => {
    // Trust is keyed on the actor everywhere else, and a channel describing
    // who reacted needs an identity rather than a label.
    const metadata = JSON.stringify({
      slackMeta: JSON.stringify(
        slackRow({ actorExternalUserId: "U0123", displayName: "Jason" }),
      ),
    });

    const meta = readProviderMetadata(metadata);
    expect(meta?.actorExternalId).toBe("U0123");
    expect(meta?.displayName).toBe("Jason");
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

    const meta = readProviderMetadata(metadata);
    expect(meta?.eventKind).toBe("reaction");
    // No channel gives a reaction an id of its own, so the row must not claim
    // its target's: two rows sharing one id break resolution by message id.
    expect(meta?.messageId).toBeUndefined();
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

    const meta = readProviderMetadata(metadata);
    expect(meta).not.toBeNull();
    expect(meta?.threadId).toBeUndefined();
    expect(meta?.messageId).toBe(MESSAGE_TS);
  });

  it("reads a channel this repo has no code for", () => {
    // The point of the neutral shape. A plugin channel cannot add an adapter
    // here, so it describes its own rows directly and every channel-agnostic
    // reader understands them with no Vellum code naming that channel.
    const metadata = JSON.stringify({
      providerMeta: JSON.stringify({
        source: "plugin",
        conversationExternalId: "room-42",
        messageId: "evt-9",
        threadId: "evt-1",
        eventKind: "reaction",
        reaction: {
          targetMessageId: "evt-1",
          emoji: "tada",
          op: "added",
        },
      } satisfies ProviderMessageMetadata),
    });

    const meta = readProviderMetadata(metadata);
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

    expect(groupingMessageId(readProviderMetadata(metadata)!)).toBe(MESSAGE_TS);
  });

  it("keeps provider fields the neutral schema does not name", () => {
    // The schema passes through, so a channel can carry its own fields on the
    // same object instead of getting a second envelope.
    const metadata = JSON.stringify({
      providerMeta: JSON.stringify({
        source: "slack",
        conversationExternalId: CHANNEL,
        messageId: MESSAGE_TS,
        eventKind: "message",
        slackFiles: [{ name: "diagram.png" }],
      }),
    });

    expect(
      (readProviderMetadata(metadata) as Record<string, unknown> | null)
        ?.slackFiles,
    ).toEqual([{ name: "diagram.png" }]);
  });

  it("reads as null when the row carries neither envelope", () => {
    expect(readProviderMetadata(JSON.stringify({ other: 1 }))).toBeNull();
    expect(readProviderMetadata("not json")).toBeNull();
    expect(readProviderMetadata(null)).toBeNull();
  });
});
