/**
 * Backwards-compat gate: the daemon's conversation attachment listing.
 *
 * Below `MIN_VERSION` there is no `GET /v1/attachments?conversationId=` route,
 * so the request 404s. The Chat Info panel then lists whatever attachments the
 * loaded transcript happens to carry: it cannot tell a camera frame from a
 * photo the user attached, and its per-category counts cover the pages that
 * have been loaded rather than the conversation. At or above it the panel
 * lists every attachment from the daemon, with exact totals and a Camera
 * Frames category of its own.
 *
 * `MIN_VERSION` names the lowest assistant version whose route this gate
 * relies on. A build that reports at least that version and still answers 404
 * is read by the consumer as unsupported, so it falls back to the transcript
 * path.
 *
 * A dev build stamps the base version in `package.json`, so a floor above that
 * base leaves the daemon path off on every dev build until the base moves. A
 * temporary local pin exercises it earlier.
 *
 * Unscoped, since the panel lists the active assistant's conversation, which
 * is the assistant the identity store holds a version for. A caller that ever
 * lists another assistant's conversation wants `useAssistantScopedSupports`
 * instead, so a version held for the outgoing assistant cannot authorize a
 * listing against the incoming one.
 *
 * Delete this gate, and the transcript fallback at its call site, once the
 * minimum supported assistant is >= MIN_VERSION.
 */
import { useAssistantSupports } from "./utils";

export const MIN_VERSION = "0.11.11";

/**
 * Returns `true` when the active assistant serves the conversation attachment
 * listing, so the Chat Info panel can read its assets from the daemon.
 * Subscribes to the identity store, so the panel switches paths as the active
 * assistant's version crosses `MIN_VERSION`. Conservative on an unknown or
 * unparseable version (returns `false`).
 */
export function useSupportsAttachmentList(): boolean {
  return useAssistantSupports(MIN_VERSION);
}
