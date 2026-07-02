/**
 * Backwards-compat gate: in-chat plugin editing.
 *
 * The in-chat plugin pill lets a user change an EXISTING conversation's plugin
 * set mid-chat via the standalone `PUT /conversations/:id/enabledplugins` route.
 * That route is a newer daemon capability than send-path per-chat plugin
 * selection (see `use-supports-new-chat-plugins.ts`, which gates on 0.10.4).
 *
 * The web app always serves the latest bundle, but the assistant can be any
 * locally-installed version. Without the edit route the pill cannot persist a
 * change, so it must stay hidden until the active assistant is known to support
 * it — gated on the identity store's resolved version, conservative on unknown.
 *
 * TODO(version): MIN_VERSION is temporarily set to the current in-development
 * version (0.10.4) so the pill is visible on feature-branch builds before this
 * ships. When the release that ships `PUT /conversations/:id/enabledplugins` is
 * cut, bump the monorepo version and set MIN_VERSION to that exact release so
 * the pill stays hidden on older daemons that lack the route/GET serialization.
 */
import { useAssistantSupports } from "./utils";

export const MIN_VERSION = "0.10.4";

/**
 * Returns `true` when the active assistant exposes the standalone
 * edit-chat-plugins route, so the in-chat plugin pill can be shown. Subscribes
 * to the identity store, so the pill appears/disappears as the active
 * assistant's version crosses `MIN_VERSION`. Conservative on an unknown or
 * unparseable version (returns `false`).
 */
export function useSupportsInchatPluginEdit(): boolean {
  return useAssistantSupports(MIN_VERSION);
}
