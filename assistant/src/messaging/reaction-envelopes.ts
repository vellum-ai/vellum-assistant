/**
 * The two persisted envelope shapes of a reaction row, built from one set of
 * facts so the inbound intercept and the assistant's own reaction records
 * cannot drift apart.
 *
 * The assistant's own reaction rows write the neutral shape on every channel,
 * as every row the daemon authors does. Inbound Slack reaction rows still
 * write Slack's own envelope, which `readProviderMetadata` maps on read; the
 * Slack transcript reads the neutral envelope through its Slack view.
 */
import {
  pickReactionEmojiFields,
  type ReactionEmojiFields,
} from "@vellumai/service-contracts/reactions";

import type { ChannelId } from "../channels/types.js";
import type { ProviderMessageMetadata } from "./provider-message-metadata.js";
import type { SlackMessageMetadata } from "./providers/slack/message-metadata.js";
import { writeSlackMetadata } from "./providers/slack/message-metadata.js";

/**
 * The emoji's typed identity is optional on the facts because the assistant's
 * own reaction carries only the spelling it chose: it names an emoji rather
 * than reporting one a channel described.
 */
export interface ReactionEnvelopeFacts extends ReactionEmojiFields {
  channel: ChannelId;
  /** Provider id of the chat the reaction belongs to. */
  chatId: string;
  /** Target message id, in the channel's own id space. */
  targetMessageId: string;
  emoji: string;
  op: "added" | "removed";
  /** Absent on the assistant's own reactions. */
  actorExternalId?: string;
  /** Absent on the assistant's own reactions. */
  actorDisplayName?: string;
}

export function buildNeutralReactionMeta(
  facts: ReactionEnvelopeFacts,
): ProviderMessageMetadata {
  return {
    source: facts.channel,
    conversationExternalId: facts.chatId,
    eventKind: "reaction",
    ...(facts.actorExternalId
      ? { actorExternalId: facts.actorExternalId }
      : {}),
    ...(facts.actorDisplayName ? { displayName: facts.actorDisplayName } : {}),
    reaction: {
      targetMessageId: facts.targetMessageId,
      emoji: facts.emoji,
      ...pickReactionEmojiFields(facts),
      op: facts.op,
      ...(facts.actorDisplayName
        ? { actorDisplayName: facts.actorDisplayName }
        : {}),
    },
  };
}

/**
 * The serialized metadata key an inbound reaction row stores, chosen per
 * channel: Slack rows write `slackMeta`, every other channel the neutral
 * `providerMeta`. The one owner of that choice, so the two inbound writers
 * (the intercept and the reaction-wake turn) cannot drift. The assistant's
 * own reaction records write `buildNeutralReactionMeta` directly.
 */
export function buildReactionRowEnvelope(
  facts: ReactionEnvelopeFacts,
): { slackMeta: string } | { providerMeta: string } {
  return facts.channel === "slack"
    ? { slackMeta: writeSlackMetadata(buildSlackReactionMeta(facts)) }
    : { providerMeta: JSON.stringify(buildNeutralReactionMeta(facts)) };
}

export function buildSlackReactionMeta(
  facts: ReactionEnvelopeFacts,
): SlackMessageMetadata {
  return {
    source: "slack",
    channelId: facts.chatId,
    // A reaction row stores the reacted message's ts in `channelTs`, which
    // is its target rather than an id of its own.
    channelTs: facts.targetMessageId,
    eventKind: "reaction",
    // No `threadTs`: Slack sends none on a reaction, so any thread id in
    // scope is the reacted message's own ts. It equals `channelTs`, which
    // every reader treats as "not in a thread" anyway, and storing it makes
    // the row false evidence that a thread belongs to this conversation
    // (`legacySlackConversationHasThreadEvidence`).
    ...(facts.actorExternalId
      ? { actorExternalUserId: facts.actorExternalId }
      : {}),
    ...(facts.actorDisplayName ? { displayName: facts.actorDisplayName } : {}),
    reaction: {
      emoji: facts.emoji,
      ...pickReactionEmojiFields(facts),
      targetChannelTs: facts.targetMessageId,
      op: facts.op,
      ...(facts.actorDisplayName
        ? { actorDisplayName: facts.actorDisplayName }
        : {}),
    },
  };
}
