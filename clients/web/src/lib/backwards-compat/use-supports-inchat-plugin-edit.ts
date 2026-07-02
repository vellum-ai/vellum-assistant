/**
 * Backwards-compat gate: in-chat plugin editing.
 *
 * The in-chat plugin pill reads a conversation's plugin scope, which the daemon
 * only serializes onto the conversation GET (and exposes for edit via
 * `PUT /conversations/:id/enabledplugins`) in the release below — the same
 * release that ships #36678's per-chat plugin support.
 *
 * The web app always serves the latest bundle, but the assistant can be any
 * locally-installed version. On an older daemon the GET omits `enabledPlugins`,
 * so the pill would misrepresent per-chat state — keep it hidden until the
 * active assistant is known to support it. Conservative on unknown.
 *
 * NOTE: the pill stays hidden until the monorepo version reaches MIN_VERSION,
 * so bump the monorepo version to 0.10.5 when cutting this release.
 */
import { useAssistantSupports } from "./utils";

export const MIN_VERSION = "0.10.5";

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
