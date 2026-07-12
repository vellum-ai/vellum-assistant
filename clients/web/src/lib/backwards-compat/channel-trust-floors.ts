/**
 * Backwards-compat gate: per-channel admission floors (trust floors).
 *
 * Gateways below the pinned version lack the admission-policy list/set
 * routes behind `useChannelTrustFloors` and `useChannelProvenance`.
 * Such a gateway also omits the `channel-trust-floors` flag from
 * `/feature-flags`, leaving the registry default (`true`) in place, so
 * the flag alone cannot keep the queries from firing against a gateway
 * that 404s them into a dead error state. When unsupported, the
 * channel list renders without floor controls or provenance pills
 * (read-path degrade), matching `channel-access-controls.ts`.
 */
import { useAssistantSupports } from "./utils";

export const MIN_VERSION = "0.10.0";

/** Render-path gate for the per-channel admission-floor queries. */
export function useSupportsChannelTrustFloors(): boolean {
  return useAssistantSupports(MIN_VERSION);
}
