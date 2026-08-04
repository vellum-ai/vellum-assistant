/**
 * Backwards-compat gate: per-channel Assistant Access controls on the
 * Channels tab (tier badges, the segmented picker, the legend card).
 *
 * The surface requires the gateway's channel-permission-overrides
 * list/set/delete routes (0.10.8+) AND the assistant-side two-level channel
 * contract — the runtime collapse of `medium`/`high` cells, the room
 * default for cell-less rooms, and the sensitive-tool floor lift — which
 * ships in the pinned version below. The web bundle always serves latest
 * while assistants update on the user's schedule; the picker renders
 * exactly two levels and shows a stored `medium`/`high` cell as the level
 * it behaves as, which is only truthful against an assistant that applies
 * the same collapse at the resolve point. Rendering it against an older
 * assistant would display Conservative for a cell that backend still
 * treats as its raw threshold. When unsupported, the channel list renders
 * without access controls instead (read-path degrade); channels remain
 * visible and the rest of the tab works.
 *
 * The pin must be the first release that actually carries the contract —
 * verify against the GitHub Releases API, not local tag state, and if the
 * carrying merge misses this release's cut, move the pin to the release
 * that does carry it.
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

export const MIN_VERSION = "0.11.0";

/** Render-path gate for the Channels tab's Assistant Access controls. */
export function useSupportsChannelAccessControls(): boolean {
  return useAssistantSupports(MIN_VERSION);
}
