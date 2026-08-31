/**
 * The two persisted envelope shapes of a reaction row, built from one set of
 * facts so the inbound intercept and the assistant's own reaction records
 * cannot drift apart.
 *
 * Slack keeps its own envelope because its transcript context builds
 * provider history from rows and reads only `slackMeta`; every other channel
 * writes the neutral shape `readProviderMetadata` serves to channel-agnostic
 * readers.
 */
import type { ChannelId } from "../channels/types.js";
import type { ProviderMessageMetadata } from "./provider-message-metadata.js";
import type { SlackMessageMetadata } from "./providers/slack/message-metadata.js";

export interface ReactionEnvelopeFacts {
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
      op: facts.op,
      ...(facts.actorDisplayName
        ? { actorDisplayName: facts.actorDisplayName }
        : {}),
    },
  };
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
      targetChannelTs: facts.targetMessageId,
      op: facts.op,
      ...(facts.actorDisplayName
        ? { actorDisplayName: facts.actorDisplayName }
        : {}),
    },
  };
}
