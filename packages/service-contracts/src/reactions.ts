/**
 * Canonical vocabulary for a reaction's emoji, shared by every service that
 * handles one: the gateway that normalizes it, the daemon that stores and
 * projects it, and the web that renders it.
 *
 * The kind is said by the channel rather than inferred from how the emoji
 * is spelled. Modelled on Zulip's `reaction_type`, the one surveyed system
 * that separates the namespace from the name.
 *
 * `shortcode` is a name in a channel's own namespace that the channel's
 * adapter could not place among the standard emoji. Slack sends `+1` and
 * `blob_wave` alike, as names; its normalizer resolves the standard ones to
 * `unicode` from Slack's own list, and what remains is a workspace upload
 * only the workspace can render. It is a distinct kind from `unicode`, not
 * a stand-in for an unknown one, and nothing past an adapter needs a
 * channel's naming to read it.
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

/** The typed fields with the kind and name known. */
export type ReactionEmojiIdentity = ReactionEmojiFields & {
  emojiKind: ReactionEmojiKind;
  emojiName: string;
};

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

/**
 * Parse Discord's custom-emoji mention form. The form travels the wire as a
 * reaction's spelling, so more than one package reads it: the daemon rebuilds
 * a REST path from it when the assistant reacts, and a row carrying only the
 * spelling recovers its kind from it. One parser, so the two cannot disagree
 * about what counts as one.
 *
 * `animated` reports whether the spelling carries the `a` marker. Discord's
 * normalizer never writes that marker, so it is read only from spellings that
 * arrive from elsewhere: a row written by another producer, or a value the
 * model hands back as it received it.
 */
export function parseDiscordEmojiMention(
  emoji: string,
): { name: string; id: string; animated: boolean } | null {
  const match = /^<(a?):([^:>]+):(\d+)>$/.exec(emoji);
  return match
    ? { name: match[2]!, id: match[3]!, animated: match[1] === "a" }
    : null;
}

/**
 * Recover an emoji's kind from its spelling alone. This is the one inference
 * the design permits, reserved for a value that carries the string and no
 * typed fields: a persisted row or a replayed retry payload. A value that
 * declares its kind never reaches this; `reactionEmojiIdentity` makes that
 * choice for every reader.
 *
 * A mention form is unambiguous. Past that the two remaining kinds are told
 * apart by whether the string is a name at all: a channel's shortcode is
 * ASCII word characters, optionally carrying Slack's `::skin-tone-N`
 * suffix, and anything else is the character itself.
 */
export function classifyReactionEmojiSpelling(
  emoji: string,
): ReactionEmojiIdentity {
  const custom = parseDiscordEmojiMention(emoji);
  if (custom) {
    // The plain `<:name:id>` form says nothing about animation: the
    // normalizer spells every custom emoji that way and reports animation
    // in the typed field instead, so a spelling without the `a` marker is
    // "unrecorded", not "not animated". Only the `<a:` form asserts it.
    return {
      emojiKind: "custom",
      emojiName: custom.name,
      emojiId: custom.id,
      ...(custom.animated ? { emojiAnimated: true } : {}),
    };
  }
  return /^[\w+-]+(::skin-tone-[2-6])?$/.test(emoji)
    ? { emojiKind: "shortcode", emojiName: emoji }
    : { emojiKind: "unicode", emojiName: emoji };
}

/**
 * The typed identity of a reaction's emoji: the fields it declares when it
 * declares a kind, otherwise the kind recovered from its spelling. Every
 * reader that must know what an emoji is goes through this, so the wire
 * contract and the web agree on when the spelling is consulted.
 */
export function reactionEmojiIdentity(
  reaction: { emoji: string } & ReactionEmojiFields,
): ReactionEmojiIdentity {
  return reaction.emojiKind !== undefined && reaction.emojiName !== undefined
    ? {
        ...pickReactionEmojiFields(reaction),
        emojiKind: reaction.emojiKind,
        emojiName: reaction.emojiName,
      }
    : classifyReactionEmojiSpelling(reaction.emoji);
}
