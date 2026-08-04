/**
 * Backwards-compat gate: per-tier default-profile overrides.
 *
 * Old behavior (< MIN_VERSION): the daemon's `LLMSchema` has no
 * `defaultProfileOverrides` field, so a `PATCH /v1/config` carrying it
 * fails validation and the whole save is rejected. The Action Overrides
 * panel renders its apply-one-profile-to-all-actions affordance and never
 * sends the field.
 *
 * New behavior (>= MIN_VERSION): the daemon resolves
 * `llm.defaultProfileOverrides` (tier key to profile name) in its
 * call-site resolution chain. The panel replaces apply-to-all with the
 * per-tier Defaults rows and includes the map in its config patch.
 *
 * Reading needs no gate: an older daemon simply omits the field from
 * `GET /v1/config` and the panel treats every tier as unremapped.
 *
 * MIN_VERSION names the next scheduled cut from main. A hotfix release
 * branches from the latest release tag instead, so a hotfix that claims
 * this version number would NOT carry the feature; if that happens (or if
 * the daemon-side PR misses the cut), retarget this gate to the next
 * scheduled cut's number.
 */
import { useAssistantSupports } from "./utils";

export const MIN_VERSION = "0.11.1";

/**
 * Returns `true` when the active assistant resolves per-tier default
 * profile overrides. Subscribes to the identity store so consumers
 * re-render when the assistant version crosses `MIN_VERSION`;
 * conservative `false` while the version is unknown.
 */
export function useSupportsDefaultProfileOverrides(): boolean {
  return useAssistantSupports(MIN_VERSION);
}
