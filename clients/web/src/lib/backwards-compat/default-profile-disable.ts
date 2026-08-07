/**
 * Backwards-compat gate: hiding a default (managed) model profile by
 * disabling it.
 *
 * Old behavior (< MIN_VERSION): managed profiles were enable-only. The daemon
 * rejected `status: "disabled"` on a managed-source entry outright
 * (`assertInvariantProfilesPreserved`), so the Profiles rows offered Disable
 * for custom profiles only. Offering it for a managed profile against such an
 * assistant produces a 400 the user can do nothing about, since there is no
 * other way to remove a default from their pickers there.
 *
 * New behavior (>= MIN_VERSION): a default profile can be disabled, which
 * hides it from every picker and stops the resolver selecting it at any rung.
 * The daemon refuses a disable on a code-owned profile (`latency-optimized`),
 * whose body resolves from the catalog verbatim so a persisted status would
 * never take effect; that refusal carries a message the row surfaces
 * verbatim.
 *
 * Enabling is deliberately NOT gated: it was always accepted, and a profile
 * left disabled by a newer assistant must stay recoverable after a downgrade.
 */
import { useAssistantSupports } from "./utils";

export const MIN_VERSION = "0.11.4";

/**
 * Render-path gate for the Disable action on a MANAGED profile row. Custom
 * profiles have always been disableable and must not consult this.
 * Conservative `false` on an unknown or unparseable version.
 */
export function useSupportsDefaultProfileDisable(): boolean {
  return useAssistantSupports(MIN_VERSION);
}
