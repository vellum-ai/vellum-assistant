/**
 * Canonical vocabulary for a reaction's emoji, shared by every service that
 * handles one: the gateway that normalizes it, the daemon that stores and
 * projects it, and the web that renders it.
 *
 * The kind is said by the channel rather than inferred from how the emoji
 * is spelled. Modelled on Zulip's `reaction_type`, the one surveyed system
 * that separates the namespace from the name.
 *
 * `shortcode` is a name in a channel's own namespace whose kind the channel
 * does not disclose: Slack sends `+1` for the standard emoji and `blob_wave`
 * for a workspace upload with nothing to tell them apart, and only the
 * workspace token can resolve the second. It is a distinct kind from
 * `unicode`, not a stand-in for an unknown one.
 */
import { z } from "zod";

export const REACTION_EMOJI_KINDS = ["unicode", "shortcode", "custom"] as const;
export type ReactionEmojiKind = (typeof REACTION_EMOJI_KINDS)[number];

/**
 * The typed emoji fields every schema that carries a reaction spreads in,
 * so the wire contract, the stored envelopes, and the response projection
 * describe one shape. Optional throughout: a persisted row or a replayed
 * payload may carry only the spelling.
 */
export const ReactionEmojiFieldsSchema = z.object({
  /** Which namespace the emoji was drawn from. */
  emojiKind: z.enum(REACTION_EMOJI_KINDS).optional(),
  /**
   * The emoji's name in that namespace: the character itself for `unicode`,
   * the bare name for `shortcode` and `custom`. Never a mention form.
   */
  emojiName: z.string().optional(),
  /** The channel's id for a `custom` emoji, absent for every other kind. */
  emojiId: z.string().optional(),
  /** Whether a `custom` emoji animates. Absent for every other kind. */
  emojiAnimated: z.boolean().optional(),
});
export type ReactionEmojiFields = z.infer<typeof ReactionEmojiFieldsSchema>;

/**
 * The typed emoji fields a source actually carries, with undefined ones
 * omitted: an absent key and a present-but-undefined one serialize alike, but the
 * stored envelope and the response should carry only what was declared. Every writer of a reaction shape (the wire
 * payload, both stored envelopes, the response projection) copies the
 * fields through this rather than restating the four-way pick.
 */
export function pickReactionEmojiFields(
  source: ReactionEmojiFields,
): ReactionEmojiFields {
  return {
    ...(source.emojiKind !== undefined ? { emojiKind: source.emojiKind } : {}),
    ...(source.emojiName !== undefined ? { emojiName: source.emojiName } : {}),
    ...(source.emojiId !== undefined ? { emojiId: source.emojiId } : {}),
    ...(source.emojiAnimated !== undefined
      ? { emojiAnimated: source.emojiAnimated }
      : {}),
  };
}
