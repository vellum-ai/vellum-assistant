/**
 * Backwards-compat gate: voice profiles on a contact.
 *
 * The voice profile card reads `GET contacts/:id/voiceprints` and writes
 * `POST contacts/:id/voiceprints`, `PATCH contacts/voiceprints/:id`, and
 * `DELETE contacts/voiceprints/:id`. None of those routes exist before
 * `MIN_VERSION`.
 *
 * Ungated, an older assistant 404s the list query while the card still
 * renders its empty-enrollment state, so the card reads as "no voice profile
 * yet" and invites the user to record two clips. The POST that follows then
 * 404s and the recording is thrown away. That is the worst shape this can
 * take: the failure lands after the user has done the work, not before.
 *
 * So this is a WRITE gate and it hides the affordance rather than letting it
 * fail (see docs/BACKWARDS_COMPAT.md). Below `MIN_VERSION` the card is not
 * mounted at all and the contact detail view is exactly what it was before
 * this feature, with no query issued and nothing to explain.
 *
 * MIN_VERSION is `0.11.7-dev.0`, which reads as "anything after 0.11.7
 * stable". 0.11.7 was cut on 2026-08-27 without the routes, so the stable
 * release must be excluded while dev builds cut after it pass. See
 * `use-supports-voice-camera.ts` for the full writeup of how a `dev` suffix
 * compares against the stable release with the same base.
 *
 * Accepted edge, the same one that gate accepts: a STALE dev build of 0.11.7
 * made before the routes landed also passes, and shows a card whose query
 * 404s. Pinning a timestamp would exclude it at the cost of a constant nobody
 * can reason about later; rebuilding fixes it, and only developers on dev
 * builds are exposed.
 *
 * Scoped to the assistant that owns the contact, so a version held for the
 * outgoing assistant cannot light the card up against the incoming one.
 *
 * Delete this gate, and the `MIN_VERSION` branch at the card in
 * `contact-detail-view.tsx`, once the minimum supported assistant is
 * >= MIN_VERSION.
 */
import { useAssistantScopedSupports } from "@/lib/backwards-compat/utils";

export const MIN_VERSION = "0.11.7-dev.0";

/**
 * Returns `true` when the assistant that owns the contact
 * (`ownerAssistantId`) serves the voiceprint routes, so the contact detail
 * view can offer the voice profile card.
 *
 * On the `false` branch (below `MIN_VERSION`, or any of
 * `useAssistantScopedSupports`'s conservative unknown/mismatch cases) the
 * detail view renders no voice profile card.
 */
export function useSupportsContactVoiceprints(
  ownerAssistantId: string | null | undefined,
): boolean {
  return useAssistantScopedSupports(MIN_VERSION, ownerAssistantId);
}
