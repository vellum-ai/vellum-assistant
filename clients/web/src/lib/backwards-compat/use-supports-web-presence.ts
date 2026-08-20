/**
 * Backwards-compat gate: the web-presence POST route.
 *
 * Old behavior (< MIN_VERSION): the assistant does not expose
 * `POST /v1/assistants/{assistant_id}/clients/web-presence`. The web client
 * must not send mount, lifecycle-edge, focused-conversation, SSE-reopen, or
 * reconciliation reports because those requests would 404 on older
 * assistants.
 *
 * New behavior (>= MIN_VERSION): the route records the browser tab's current
 * visibility and focused conversation so the daemon can suppress a redundant
 * APNs push for a reply already visible in that conversation.
 *
 * The floor is a dev build rather than a predicted release number. The hook
 * uses the assistant-scoped gate so a version hydrated for a different
 * assistant cannot authorize writes to this one, and remains conservatively
 * disabled while identity is unknown.
 *
 * The sha below is a branch commit, so it never appears on `main` under a
 * squash merge, and dev builds cut from `main` between its timestamp and the
 * merge pass the floor without carrying the route. Their reports 404 into
 * `postWebPresence`'s catch until the next dev build. Re-pin this to the
 * landing commit once this merges, per `docs/BACKWARDS_COMPAT.md`.
 */
import { useAssistantScopedSupports } from "./utils";

export const MIN_VERSION = "0.11.4-dev.202608192259.e726ce0";

/**
 * Returns whether `ownerAssistantId` supports the web-presence report route.
 * Unknown versions and identity-owner mismatches return `false`.
 */
export function useSupportsWebPresence(
  ownerAssistantId: string | null | undefined,
): boolean {
  return useAssistantScopedSupports(MIN_VERSION, ownerAssistantId);
}
