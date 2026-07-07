/**
 * Backwards-compat gate: the Slack sub-tab's presence channel list.
 *
 * The list is fed by `GET /v1/slack/channels?memberOnly=true`, which
 * first ships in the assistant version below. The web app always serves
 * the latest bundle, but the assistant can be any locally-installed
 * version — on an older assistant the route is missing, the query 404s,
 * and the Slack sub-tab would show an error card on an otherwise
 * healthy connection.
 *
 * Old behavior (< MIN_VERSION): the Slack sub-tab shows only the
 * connection state and thread-behavior controls — exactly the
 * pre-feature layout — and the channels query never fires.
 * New behavior (≥ MIN_VERSION): the presence channel list renders below
 * the thread controls.
 *
 * This is a pure read path with a hide-the-surface fallback, so the
 * conservative `false`-on-unknown default is safe: the list simply
 * appears once the version hydrates. Only the hook variant exists.
 *
 * TODO(version): MIN_VERSION is a near-future placeholder. The current
 * assistant release is 0.10.6 and the route is on `main` unreleased;
 * confirm 0.10.7 is the release that ships it once cut.
 */
import { useAssistantSupports } from "./utils";

export const MIN_VERSION = "0.10.7";

/**
 * Hook gate: `true` when the active assistant serves
 * `GET /v1/slack/channels`. Subscribes to the identity store so the
 * Slack sub-tab re-renders (and the query enables) when the version
 * hydrates or crosses `MIN_VERSION`.
 */
export function useSupportsSlackChannelList(): boolean {
  return useAssistantSupports(MIN_VERSION);
}
