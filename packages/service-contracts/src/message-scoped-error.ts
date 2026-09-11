/**
 * Whether an `error` stream event belongs to one message rather than to the
 * turn. An explicit `scope` decides. When the scope is absent, a
 * `clientMessageId` still identifies an error belonging to that one message.
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
