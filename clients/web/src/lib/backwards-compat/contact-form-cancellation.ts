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
 * MIN_VERSION is the dev build that first carries the field rather than the
 * release it lands in: builds from this source report `0.11.7-dev.*`, and a
 * future release number would put them on the legacy path while they serve the
 * new one, which is the wrong way round for a gate whose false branch degrades
 * a working feature.
 */
import { assistantSupports, whenAssistantVersionKnown } from "./utils";

export const MIN_VERSION = "0.11.7-dev.202608281600.dd01e22";

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

/**
 * Awaited variant for the dismissal itself.
 *
 * The snapshot reads `false` until the identity store hydrates, and this gate
 * is on a write path where that default is not safe: a dismissal in the first
 * moments after a page load would take the legacy branch on an assistant that
 * understands the field, dropping the card while the command it belongs to
 * keeps waiting. Waiting (bounded) for the version means the path is chosen
 * against a resolved one.
 */
export async function resolveSupportsContactFormCancellation(): Promise<boolean> {
  await whenAssistantVersionKnown();
  return supportsContactFormCancellation();
}
