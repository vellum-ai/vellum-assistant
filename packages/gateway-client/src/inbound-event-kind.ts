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

/** The structured payload of a reaction event. */
export interface InboundReactionPayload {
  op: "added" | "removed";
  /**
   * The emoji as the channel names it: Slack a colon-name ("+1"), Telegram
   * and Discord the unicode character, a Discord custom emoji its name.
   * Decision vocabulary is product policy resolved in the daemon, never
   * normalized here.
   */
  emoji: string;
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
  reaction?: InboundReactionPayload;
  callbackData?: string;
  sourceMetadata?: { messageId?: string };
}): InboundReactionPayload | null {
  if (fields.reaction) {
    const { op, emoji, targetMessageId } = fields.reaction;
    return emoji.length > 0 && targetMessageId.length > 0
      ? { op, emoji, targetMessageId }
      : null;
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
    ? { op: removed ? "removed" : "added", emoji, targetMessageId: target }
    : null;
}
