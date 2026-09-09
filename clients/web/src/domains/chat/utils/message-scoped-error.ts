import type { ErrorEvent } from "@vellumai/assistant-api";

/**
 * Whether an `error` stream event belongs to one message rather than to the
 * turn. The daemon marks it with `scope: "message"` when it could not persist
 * a queued message while the batch that message was dequeued with runs on,
 * and a daemon from before the scope field still names the message by its
 * `clientMessageId`. Every consumer that decides whether an error ends a turn
 * reads the answer here, so no two of them can disagree.
 */
export function isMessageScopedError(event: ErrorEvent): boolean {
  return event.scope === "message" || event.clientMessageId !== undefined;
}
