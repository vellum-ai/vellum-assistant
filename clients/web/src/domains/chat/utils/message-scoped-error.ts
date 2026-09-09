import type { ErrorEvent } from "@vellumai/assistant-api";

/**
 * Whether an `error` stream event belongs to one message rather than to the
 * turn. An explicit `scope` decides: the daemon sets `"message"` when it could
 * not persist a queued message while the batch that message was dequeued with
 * runs on, and `"turn"` is the turn's terminal whatever else the event names.
 * Only an event from a daemon that predates the scope field falls back to its
 * `clientMessageId`, which such a daemon sets on nothing but a message's own
 * error. Every consumer that decides whether an error ends a turn reads the
 * answer here, so no two of them can disagree.
 */
export function isMessageScopedError(event: ErrorEvent): boolean {
  if (event.scope !== undefined) {
    return event.scope === "message";
  }
  return event.clientMessageId !== undefined;
}
