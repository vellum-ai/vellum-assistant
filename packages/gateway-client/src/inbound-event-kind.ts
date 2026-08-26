/**
 * The inbound event families, named.
 *
 * Every inbound event is one of these, and the kind decides which pipeline
 * stages apply: only user-authored text (message, edit) can carry a
 * verification code or an invite, only a message starts an agent turn, and
 * edit/delete/reaction/button all refer to another message rather than
 * standing alone. Before the kind existed, each family was inferred from
 * the field that happened to carry it: `isEdit`, the sentinel string
 * `"message_deleted"`, the `"reaction:"` prefix, the presence of
 * `callbackData` at all. Those encodings still arrive on replayed retry
 * payloads persisted before the kind, so {@link resolveInboundEventKind}
 * derives the kind from them exactly once; nothing else may sniff them.
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
 * The one place the legacy encodings are read. A payload stamped with a
 * kind wins outright; an unstamped one (a retry payload persisted before
 * the kind existed) is classified by the fields that used to carry the
 * family. The fallback order mirrors the old consumers' precedence:
 * reaction prefixes and the delete sentinel are specific `callbackData`
 * values, so they are tested before the generic button reading.
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
