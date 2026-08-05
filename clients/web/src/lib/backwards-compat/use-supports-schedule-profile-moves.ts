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
 */
import {
  assistantSupports,
  useAssistantSupports,
  whenAssistantVersionKnown,
} from "./utils";

export const MIN_VERSION = "0.12.0";

/**
 * Render-path gate. Subscribes to the identity store, so a surface that
 * depends on the reassign route appears once the active assistant's version
 * crosses `MIN_VERSION`. Conservative on an unknown or unparseable version.
 */
export function useSupportsScheduleProfileMoves(): boolean {
  return useAssistantSupports(MIN_VERSION);
}

/**
 * Write-path gate. Waits for the version to hydrate before reading the
 * snapshot, so a profile delete confirmed moments after load is answered by
 * the assistant's real version rather than by the conservative
 * `false`-on-unknown default, which would silently skip the schedule move.
 */
export async function resolveSupportsScheduleProfileMoves(): Promise<boolean> {
  await whenAssistantVersionKnown();
  return assistantSupports(MIN_VERSION);
}
