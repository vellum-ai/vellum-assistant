/**
 * Backwards-compat gate: per-channel admission floors (trust floors).
 *
 * The admission-policy list/set routes behind `useChannelTrustFloors`
 * and `useChannelProvenance` shipped with 0.10.0 (PR #35150) — the
 * pinned version below. Now that the `channel-trust-floors` flag
 * defaults on, an older gateway that omits the flag from
 * `/feature-flags` leaves the registry default (`true`) in place, so
 * without this gate the queries would fire against a gateway that
 * lacks the routes and render a dead error state. When unsupported,
 * the channel list renders without floor controls or provenance pills
 * (read-path degrade), matching `channel-access-controls.ts`.
 */
import { useAssistantSupports } from "./utils";

export const MIN_VERSION = "0.10.0";

/** Render-path gate for the per-channel admission-floor queries. */
export function useSupportsChannelTrustFloors(): boolean {
  return useAssistantSupports(MIN_VERSION);
}
