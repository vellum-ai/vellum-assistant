import { CHANNEL_IDS } from "@vellumai/service-contracts";
import { z } from "zod";

/**
 * What a stored channel message row knows about itself, in terms no single
 * provider owns.
 *
 * Every channel needs the same facts to reconstruct a transcript: which chat
 * the row belongs to, the provider's id for the row itself, the thread it sits
 * in, whether it is a message or a reaction, and, when it is a reaction, which
 * message it was attached to.
 *
 * Those facts were previously spelled in Slack's vocabulary (`channelTs`,
 * `threadTs`, `reaction.targetChannelTs`) inside `slackMeta`, which is why
 * history assembly reads as Slack logic despite being purely structural: it
 * groups a reaction with the message it targets, inside a thread. That rule
 * holds for any thread-scoped channel, and Telegram and Discord both are one.
 *
 * The schema passes through what it does not name, so a provider carries its
 * own fields (Slack's file markers and timezone labels) on this same object
 * and validates them with its own schema. This is how `SourceMetadataSchema`
 * already carries `slackBotMentioned` and the email fields on the wire: one
 * object per row, no per-provider sub-envelope, and no second copy of
 * anything named here.
 */

const channelReactionMetadataSchema = z.object({
  /**
   * Provider id of the message this reaction was attached to, in the same
   * namespace as `messageId`. Resolution is keyed on it, so it is required.
   */
  targetMessageId: z.string(),
  emoji: z.string(),
  op: z.enum(["added", "removed"]),
  actorDisplayName: z.string().optional(),
});

export const channelMessageMetadataSchema = z
  .object({
    source: z.enum(CHANNEL_IDS),
    /**
     * Provider id of the chat, channel or room this row belongs to. Named for
     * the conversation address rather than the provider, so it cannot be read as
     * the `ChannelId` union ("slack", "telegram", ...) that `source` carries.
     */
    chatId: z.string(),
    /** Provider id of this row itself. */
    messageId: z.string(),
    /**
     * Provider id of the thread this row sits in, absent when it is not in one.
     * Never synthesized from `messageId`: a value here asserts that a thread
     * exists, and inventing one keys conversations on threads that never do.
     */
    threadId: z.string().optional(),
    displayName: z.string().optional(),
    /**
     * Only reactions get a row of their own. An edit rewrites the row it
     * targets and a delete stamps `deletedAt` on it, so neither appears here.
     */
    eventKind: z.enum(["message", "reaction"]),
    reaction: channelReactionMetadataSchema.optional(),
    editedAt: z.number().optional(),
    deletedAt: z.number().optional(),
  })
  .passthrough();

export type ChannelReactionMetadata = z.infer<
  typeof channelReactionMetadataSchema
>;
export type ChannelMessageMetadata = z.infer<
  typeof channelMessageMetadataSchema
>;

/**
 * Parse and validate a serialized `ChannelMessageMetadata`, the counterpart of
 * `readSlackMetadata` for the neutral shape. Anything that does not parse or
 * does not validate reads as null.
 */
export function readChannelMessageMetadata(
  raw: unknown,
): ChannelMessageMetadata | null {
  if (typeof raw !== "string") {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = channelMessageMetadataSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/**
 * The id a row is grouped by when assembling a thread: its own for a message,
 * its target's for a reaction, so a reaction lands beside the message it was
 * attached to rather than in a block of its own.
 */
export function groupingMessageId(meta: ChannelMessageMetadata): string {
  return meta.reaction?.targetMessageId ?? meta.messageId;
}
