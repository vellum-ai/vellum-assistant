/**
 * Backwards-compat gate: Discord on the Channels page.
 *
 * The web client talks to a locally installed daemon at any version, and a
 * daemon below the pinned one has no Discord readiness probe. Asked about a
 * channel it does not know, `ChannelReadinessService.getReadiness` answers
 * with its unsupported snapshot, so an ungated row would render as a
 * permanently broken Discord that no amount of setup fixes.
 *
 * A version gate rather than a feature flag: it resolves as daemons update
 * and leaves nothing to clean up. See `docs/BACKWARDS_COMPAT.md`.
 */
import { useAssistantSupports } from "./utils";

/**
 * First build that registers a Discord readiness probe: the dev build of the
 * enabling commit. Dev builds of main after it, and every stable release
 * from 0.11.6, compare at or above; stable 0.11.5 stays below.
 */
export const MIN_VERSION = "0.11.5-dev.202608242314.38e0513";

/** Whether this assistant can answer for Discord at all. */
export function useSupportsDiscordChannel(): boolean {
  return useAssistantSupports(MIN_VERSION);
}
