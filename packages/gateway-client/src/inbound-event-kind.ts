/**
 * The inbound event families, named.
 *
 * Every inbound event is one of these, and the kind decides which pipeline
 * stages apply: only user-authored text (message, edit) can carry a
 * verification code or an invite, only a message starts an agent turn, and
 * edit/delete/reaction/button all refer to another message rather than
 * standing alone. A payload can also encode its family in the field that
 * carries it: `isEdit`, the sentinel string `"message_deleted"`, the
 * `"reaction:"` prefix, the presence of `callbackData` at all. Replayed
 * retry payloads arrive with only those encodings, so
 * {@link resolveInboundEventKind} derives the kind from them exactly once;
 * nothing else may sniff them.
 */

export const INBOUND_EVENT_KINDS = [
  "message",
  "edit",
  "delete",
  "reaction",
  "button",
] as const;

export type InboundEventKind = (typeof INBOUND_EVENT_KINDS)[number];

export function isInboundEventKind(value: string): value is InboundEventKind {
  return (INBOUND_EVENT_KINDS as readonly string[]).includes(value);
}

/**
 * The one place the field encodings are read. A payload stamped with a
 * kind wins outright; an unstamped one (a replayed retry payload) is
 * classified by the fields that carry its family. The fallback order is
 * specific-before-generic: reaction prefixes and the delete sentinel are
 * particular `callbackData` values, so they are tested before the generic
 * button reading.
 */
export function resolveInboundEventKind(fields: {
  eventKind?: string;
  isEdit?: boolean;
  callbackData?: string;
  callbackQueryId?: string;
}): InboundEventKind {
  if (fields.eventKind !== undefined && isInboundEventKind(fields.eventKind)) {
    return fields.eventKind;
  }
  if (fields.isEdit === true) {
    return "edit";
  }
  const cb = fields.callbackData;
  if (cb !== undefined && cb.length > 0) {
    if (cb === "message_deleted") {
      return "delete";
    }
    if (cb.startsWith("reaction:") || cb.startsWith("reaction_removed:")) {
      return "reaction";
    }
    return "button";
  }
  if (fields.callbackQueryId !== undefined) {
    return "button";
  }
  return "message";
}

/**
 * Whether an event of this kind refers to another message rather than
 * standing alone as new content. Referring events never mint a
 * conversation of their own and never carry ingestable attachments.
 */
export function inboundEventRefersToAnotherMessage(
  kind: InboundEventKind,
): boolean {
  return kind !== "message";
}

import {
  pickReactionEmojiFields,
  type ReactionEmojiKind,
} from "@vellumai/service-contracts/reactions";

/** The structured payload of a reaction event. */
export interface InboundReactionPayload {
  op: "added" | "removed";
  /**
   * The emoji in the channel's own spelling, which is what the channel's
   * write path and the model both consume: Discord's outbound route parses
   * a custom emoji back out of its `<:name:id>` mention form. Kept as the
   * wire's token rather than replaced by the typed fields below, because
   * the dedup id embeds it and the model hands it back to `react_to_message`
   * verbatim.
   */
  emoji: string;
  /** Which namespace {@link emoji} was drawn from. */
  emojiKind: ReactionEmojiKind;
  /**
   * The emoji's name in that namespace: the character itself for `unicode`,
   * the bare name for `shortcode` and `custom`. Never the mention form.
   */
  emojiName: string;
  /** The channel's id for a `custom` emoji, absent for every other kind. */
  emojiId?: string;
  /** Whether a `custom` emoji animates. Absent for every other kind. */
  emojiAnimated?: boolean;
  /**
   * Provider id of the message reacted to, in the same namespace as
   * `source.messageId`.
   */
  targetMessageId: string;
}

/**
 * The one reader of a reaction event's payload. A structured `reaction`
 * field wins; a replayed retry payload persisted before the field carries
 * the `"reaction:<emoji>"` / `"reaction_removed:<emoji>"` string in
 * `callbackData` with the target on `sourceMetadata.messageId`, and is
 * parsed here alone. Returns null when the event is not a reaction or
 * names no emoji or target.
 */
export function resolveInboundReactionPayload(fields: {
  eventKind?: string;
  reaction?: Omit<InboundReactionPayload, "emojiKind" | "emojiName"> &
    Partial<Pick<InboundReactionPayload, "emojiKind" | "emojiName">>;
  callbackData?: string;
  sourceMetadata?: { messageId?: string };
}): InboundReactionPayload | null {
  if (fields.reaction) {
    const { op, emoji, targetMessageId } = fields.reaction;
    if (emoji.length === 0 || targetMessageId.length === 0) {
      return null;
    }
    // A payload carrying only the spelling has its kind recovered from
    // the string, the one source left.
    const typed =
      fields.reaction.emojiKind !== undefined &&
      fields.reaction.emojiName !== undefined
        ? {
            ...pickReactionEmojiFields(fields.reaction),
            emojiKind: fields.reaction.emojiKind,
            emojiName: fields.reaction.emojiName,
          }
        : classifyLegacyReactionEmoji(emoji);
    return { op, emoji, targetMessageId, ...typed };
  }
  const cb = fields.callbackData;
  const target = fields.sourceMetadata?.messageId;
  if (cb === undefined || target === undefined || target.length === 0) {
    return null;
  }
  const removed = cb.startsWith("reaction_removed:");
  const added = !removed && cb.startsWith("reaction:");
  if (!added && !removed) {
    return null;
  }
  const emoji = cb.slice(cb.indexOf(":") + 1);
  return emoji.length > 0
    ? {
        op: removed ? "removed" : "added",
        emoji,
        targetMessageId: target,
        ...classifyLegacyReactionEmoji(emoji),
      }
    : null;
}

/**
 * Parse Discord's custom-emoji mention form. The form travels the wire as a
 * reaction's spelling, so more than one package reads it: the daemon rebuilds
 * a REST path from it when the assistant reacts, and a row carrying only the
 * spelling recovers its kind from it. One parser, so the two cannot disagree
 * about what counts as one.
 *
 * `animated` reports whether the spelling carries the `a` marker. This
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
 * the design permits, reserved for a payload that carries the string and no
 * typed fields: a persisted row or a replayed retry payload. A payload that
 * declares its kind never reaches this.
 *
 * A mention form is unambiguous. Past that the two remaining kinds are told
 * apart by whether the string is a name at all: a channel's shortcode is
 * ASCII word characters, and anything else is the character itself.
 */
function classifyLegacyReactionEmoji(
  emoji: string,
): Pick<
  InboundReactionPayload,
  "emojiKind" | "emojiName" | "emojiId" | "emojiAnimated"
> {
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
  return /^[\w+-]+$/.test(emoji)
    ? { emojiKind: "shortcode", emojiName: emoji }
    : { emojiKind: "unicode", emojiName: emoji };
}
