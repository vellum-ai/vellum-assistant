import { describe, expect, test } from "bun:test";

import { writeSlackMetadata } from "./providers/slack/message-metadata.js";
import {
  buildNeutralReactionMeta,
  buildSlackReactionMeta,
  type ReactionEnvelopeFacts,
} from "./reaction-envelopes.js";
import { readProviderMetadata } from "./read-provider-metadata.js";

const typedFacts: ReactionEnvelopeFacts = {
  channel: "slack",
  chatId: "C1",
  targetMessageId: "1700000000.000100",
  emoji: "blob_wave",
  emojiKind: "shortcode",
  emojiName: "blob_wave",
  op: "added",
  actorExternalId: "U1",
  actorDisplayName: "Alice",
};

describe("a reaction's typed emoji survives the stored envelope", () => {
  test("the Slack envelope writes the fields and reads them back", () => {
    const read = readProviderMetadata(
      JSON.stringify({
        slackMeta: writeSlackMetadata(buildSlackReactionMeta(typedFacts)),
      }),
    );

    expect(read?.reaction).toMatchObject({
      emoji: "blob_wave",
      emojiKind: "shortcode",
      emojiName: "blob_wave",
      op: "added",
      targetMessageId: "1700000000.000100",
    });
  });

  test("the neutral envelope writes the fields and reads them back", () => {
    const stored = buildNeutralReactionMeta({
      ...typedFacts,
      channel: "discord",
      emoji: "<:party_blob:111>",
      emojiKind: "custom",
      emojiName: "party_blob",
      emojiId: "111",
      emojiAnimated: true,
    });
    const read = readProviderMetadata(
      JSON.stringify({ providerMeta: JSON.stringify(stored) }),
    );

    expect(read?.reaction).toMatchObject({
      emojiKind: "custom",
      emojiName: "party_blob",
      emojiId: "111",
      emojiAnimated: true,
    });
  });

  test("a Slack row carrying only the spelling still reads", () => {
    const { emojiKind: _k, emojiName: _n, ...spellingOnly } = typedFacts;
    const read = readProviderMetadata(
      JSON.stringify({
        slackMeta: writeSlackMetadata(buildSlackReactionMeta(spellingOnly)),
      }),
    );

    expect(read?.reaction?.emoji).toBe("blob_wave");
    expect(read?.reaction?.emojiKind).toBeUndefined();
  });
});
