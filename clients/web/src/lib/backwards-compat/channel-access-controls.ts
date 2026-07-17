/**
 * Backwards-compat gate: per-channel Assistant Access controls on the
 * Channels tab (tier badges, the segmented picker, the legend card).
 *
 * The surface requires the gateway's channel-permission-overrides
 * list/set/delete routes, which shipped with 0.10.7 — the pinned version
 * below. The web bundle always serves latest while gateways update on the
 * user's schedule, so on an older assistant the requests 404 and the
 * panel would render a dead error state with a permanently disabled
 * picker. When unsupported, the channel list renders without access
 * controls instead (read-path degrade); channels remain visible and the
 * rest of the tab works.
 *
 * The read-only `/resolve` operation behind the "{Tier} • default"
 * badges ships after 0.10.7 and degrades on its own: while resolve is
 * unavailable the badge reads a plain "Default" (the resolve query
 * fail-softs), so it needs no version pin of its own.
 *
 * This gate replaced the `channel-trust-floors` feature flag: the flag
 * gated *who saw* the surface, which said nothing about whether the
 * connected gateway could serve it — the two failure axes are
 * independent, and version support is the one that matters now that the
 * surface is generally available.
 */
import { useAssistantSupports } from "./utils";

export const MIN_VERSION = "0.10.7";

/** Render-path gate for the Channels tab's Assistant Access controls. */
export function useSupportsChannelAccessControls(): boolean {
  return useAssistantSupports(MIN_VERSION);
}
