/**
 * Backwards-compat gate: moving schedules between inference profiles.
 *
 * Old behavior (< MIN_VERSION): the daemon has no
 * `POST /schedules/reassign-profile` route, ignores the `inference_profile`
 * filter on `GET /schedules` (so the whole list comes back), and omits
 * `isDeferred` from each serialized schedule. Deleting an inference profile
 * therefore skips the schedule scan entirely and behaves as it did before
 * schedules carried a pin: the active selection and any call-site overrides
 * move to the replacement, and a schedule's pin is left naming the deleted
 * profile. That dangling pin is not fatal at run time, since the resolver
 * drops a missing override and falls through to the call site's own
 * selection.
 *
 * New behavior (>= MIN_VERSION): the delete flow scans for the schedules
 * pinned to the profile, names them in the confirmation dialog, and moves
 * them onto the replacement before the delete lands.
 *
 * The gate is what keeps an older assistant usable at all here. Without it
 * the unfiltered list makes every schedule look like a reference to the
 * profile being deleted, and the reassign the user then confirms 404s, so a
 * user with any schedules could not delete a profile.
 *
 * MIN_VERSION names the next scheduled cut from main (0.12.0), the first
 * release carrying the reassign route and the profile-filtered list. A
 * hotfix release branches from the latest release tag instead, so a hotfix
 * claiming this number would NOT carry them; if that happens, retarget to
 * the next scheduled cut.
 *
 * Both entry points are scoped to the assistant that owns the surface. The
 * identity store is not safe to pair across an assistant switch: it holds the
 * outgoing assistant's version until the clear and refetch in
 * `useAssistantIdentityInit` settle, so an unscoped read could authorize
 * these routes for an assistant the settings page has just switched to and
 * re-enter exactly the failure mode above. Scoping compares against the
 * identity store's own `assistantId`, written in the same `set()` as the
 * version, so version and owner are one atomic snapshot.
 */
import {
  assistantScopedSupports,
  useAssistantScopedSupports,
  whenAssistantVersionKnownFor,
} from "./utils";

export const MIN_VERSION = "0.12.0";

/**
 * Render-path gate. Subscribes to the identity store, so a surface that
 * depends on the reassign route appears once `ownerAssistantId`'s version
 * crosses `MIN_VERSION`. Conservative on an unknown or unparseable version,
 * and on an identity fetched for a different assistant.
 */
export function useSupportsScheduleProfileMoves(
  ownerAssistantId: string | null | undefined,
): boolean {
  return useAssistantScopedSupports(MIN_VERSION, ownerAssistantId);
}

/**
 * Write-path gate. Waits for `ownerAssistantId`'s own version to hydrate
 * before reading the snapshot, so a profile delete confirmed moments after
 * load — or moments after an assistant switch — is answered by that
 * assistant's real version rather than by the conservative
 * `false`-on-unknown default (which silently skips the schedule move) or by
 * the outgoing assistant's version (which would call routes the incoming one
 * may not have).
 */
export async function resolveSupportsScheduleProfileMoves(
  ownerAssistantId: string | null | undefined,
): Promise<boolean> {
  await whenAssistantVersionKnownFor(ownerAssistantId);
  return assistantScopedSupports(MIN_VERSION, ownerAssistantId);
}
