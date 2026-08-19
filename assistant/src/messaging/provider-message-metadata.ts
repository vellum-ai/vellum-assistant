import { z } from "zod";

import { CHANNEL_IDS } from "../channels/types.js";

/**
 * What a stored channel message row knows about itself, in terms no single
 * provider owns.
 *
 * "Provider" here is the channel sense, the one `messaging/providers/*` uses:
 * Slack, Telegram, Discord. It is not the inference sense in `providers/*`,
 * whose `providerMetadata` rides on a content block and describes a model.
 *
 * Named for the provider rather than the channel because `channel metadata`
 * is already taken: `buildChannelMetadata` builds the whole envelope a
 * message row carries (provenance, `userMessageChannel`, interfaces), and
 * this is one key inside that envelope. This is the neutral counterpart of
 * `slackMeta`, so it reads as the generalization of what `providers/slack`
 * stores.
 *
 * Every channel needs the same facts to reconstruct a transcript: which chat
 * the row belongs to, the provider's id for the row itself, the thread it sits
 * in, whether it is a message or a reaction, and, when it is a reaction, which
 * message it was attached to.
 *
 * History assembly is structural, not Slack logic: it groups a reaction with
 * the message it targets, inside a thread. That rule holds for any
 * thread-scoped channel.
 *
 * The schema passes through what it does not name, so a provider carries its
 * own fields (Slack's file markers and timezone labels) on this same object
 * and validates them with its own schema. This is how `SourceMetadataSchema`
 * already carries `slackBotMentioned` and the email fields on the wire: one
 * object per row, no per-provider sub-envelope, and no second copy of
 * anything named here.
 */

const providerReactionMetadataSchema = z.object({
  /**
   * Provider id of the message this reaction was attached to, in the same
   * namespace as `messageId`. Resolution is keyed on it, so it is required.
   */
  targetMessageId: z.string(),
  emoji: z.string(),
  op: z.enum(["added", "removed"]),
  actorDisplayName: z.string().optional(),
});

export const providerMessageMetadataSchema = z
  .object({
    source: z.enum(CHANNEL_IDS),
    /**
     * Provider id of the chat, channel or room this row belongs to. Same name
     * and meaning as on the inbound wire, where "conversation" is the canonical
     * word for a delivery address and "channel" names the provider.
     */
    conversationExternalId: z.string(),
    /**
     * Provider id of this row itself. Absent on a reaction, which no channel
     * gives an id of its own: a reaction event names the chat, the message it
     * was attached to, the actor and the emoji, and nothing identifies the
     * reaction. The message it acts on is `reaction.targetMessageId`.
     */
    messageId: z.string().optional(),
    /**
     * Provider id of the thread this row sits in, absent when it is not in one.
     * Never synthesized from `messageId`: a value here asserts that a thread
     * exists, and inventing one keys conversations on threads that never do.
     */
    threadId: z.string().optional(),
    /**
     * Provider id of whoever authored the row or performed the reaction. Trust
     * is keyed on this everywhere else, and it is what lets a channel say who
     * acted; a display name is a label, not an identity. Optional because a
     * provider envelope need not carry one.
     */
    actorExternalId: z.string().optional(),
    displayName: z.string().optional(),
    /**
     * Only reactions get a row of their own. An edit rewrites the row it
     * targets and a delete stamps `deletedAt` on it, so neither appears here.
     */
    eventKind: z.enum(["message", "reaction"]),
    reaction: providerReactionMetadataSchema.optional(),
    editedAt: z.number().optional(),
    deletedAt: z.number().optional(),
  })
  .passthrough();

export type ProviderReactionMetadata = z.infer<
  typeof providerReactionMetadataSchema
>;
export type ProviderMessageMetadata = z.infer<
  typeof providerMessageMetadataSchema
>;

/**
 * Parse and validate a serialized `ProviderMessageMetadata`, the counterpart of
 * `readSlackMetadata` for the neutral shape. Anything that does not parse or
 * does not validate reads as null.
 */
export function readProviderMessageMetadata(
  raw: unknown,
): ProviderMessageMetadata | null {
  if (typeof raw !== "string") {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = providerMessageMetadataSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/**
 * The id a row is grouped by when assembling a thread: its own for a message,
 * its target's for a reaction, so a reaction lands beside the message it was
 * attached to rather than in a block of its own.
 *
 * Undefined for a row that identifies neither, which cannot be placed.
 */
export function groupingMessageId(
  meta: ProviderMessageMetadata,
): string | undefined {
  return meta.reaction?.targetMessageId ?? meta.messageId;
}
