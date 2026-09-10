/**
 * Whether an `error` stream event belongs to one message rather than to the
 * turn. An explicit `scope` decides: the daemon sets `"message"` on the error
 * for a queued message it could not persist while the batch that message was
 * dequeued with runs on, and `"turn"` on the turn's own terminal error. An
 * event from a daemon that predates the field falls back to its
 * `clientMessageId`, which such a daemon sets on nothing but a message's own
 * error. A message-scoped error leaves the turn generating, so no consumer
 * ends a turn on one.
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
