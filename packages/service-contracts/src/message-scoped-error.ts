/**
 * Whether a compatibility `error` stream event belongs to one message rather
 * than to the turn. An explicit `scope` decides. An event from a build that
 * predates the field falls back to its `clientMessageId`, which those builds
 * set only on a message's own error.
 *
 * Current assistants emit `message_failed` instead. This predicate lets a new
 * client preserve the same nonterminal behavior with older assistants.
 */
export function isMessageScopedError(event: {
  scope?: "turn" | "message";
  clientMessageId?: string;
}): boolean {
  if (event.scope !== undefined) {
    return event.scope === "message";
  }
  return event.clientMessageId !== undefined;
}
