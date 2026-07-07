/**
 * Backwards-compat gate: per-channel Assistant Access controls on the
 * Channels tab (tier badges, the segmented picker, the legend card).
 *
 * The surface depends on the gateway's channel-permission-overrides HTTP
 * routes — list/set/delete (shipped with 0.10.7) and the read-only
 * `/resolve` operation the default badges use (first ships in the
 * assistant release below). The web bundle always serves latest while
 * gateways update on the user's schedule, so on an older assistant the
 * requests 404 and the panel would render a dead error state with a
 * permanently disabled picker. When unsupported, the channel list renders
 * without access controls instead (read-path degrade); channels remain
 * visible and the rest of the tab works.
 *
 * This gate replaced the `channel-trust-floors` feature flag: the flag
 * gated *who saw* the surface, which said nothing about whether the
 * connected gateway could serve it — the two failure axes are
 * independent, and version support is the one that matters now that the
 * surface is generally available.
 *
 * TODO(version): MIN_VERSION is a near-future placeholder. The current
 * assistant release is 0.10.7; bump this to the exact release that ships
 * the gateway `/v1/channel-permission-overrides/resolve` route once it
 * is cut.
 */
import { useAssistantSupports } from "./utils";

export const MIN_VERSION = "0.10.8";

/** Render-path gate for the Channels tab's Assistant Access controls. */
export function useSupportsChannelAccessControls(): boolean {
  return useAssistantSupports(MIN_VERSION);
}
