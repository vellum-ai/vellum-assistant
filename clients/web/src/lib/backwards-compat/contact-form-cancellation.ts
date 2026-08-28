/**
 * Backwards-compat gate: server-side dismissal of a contact form.
 *
 * Dismissing a contact form posts `{ requestId, cancelled: true }` to the
 * submit route, which unblocks the waiting command and closes the form on
 * every other client showing it. Assistants before the version below serve a
 * submit route that requires `address` and `channelType` and knows nothing of
 * `cancelled`, so that post comes back 400 and the guardian is left with a
 * card that will not go away.
 *
 * On the `false` branch the card is dismissed locally, which is what those
 * assistants have always done: the command waits out its own timeout, and
 * other clients keep the card until theirs closes it.
 *
 * MIN_VERSION targets 0.12.0, the release this ships in.
 */
import { assistantSupports } from "./utils";

export const MIN_VERSION = "0.12.0";

/**
 * Whether the active assistant understands a dismissal on the contact-form
 * submit routes. Snapshot variant: the dismissal runs from an event handler,
 * not a render path.
 *
 * Answers `false` while the version is unknown or unparseable, keeping the
 * local-only dismissal that every supported assistant tolerates.
 */
export function supportsContactFormCancellation(): boolean {
  return assistantSupports(MIN_VERSION);
}
