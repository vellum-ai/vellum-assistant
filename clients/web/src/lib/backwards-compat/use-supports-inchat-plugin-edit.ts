/**
 * Backwards-compat gate: in-chat plugin editing.
 *
 * The in-chat plugin pill reads a conversation's plugin scope, which the daemon
 * only serializes onto the conversation GET (and exposes for edit via
 * `PUT /conversations/:id/enabledplugins`) in the release below.
 *
 * The web app always serves the latest bundle, but the assistant can be any
 * locally-installed version. On an older daemon the GET omits `enabledPlugins`,
 * so the pill would misrepresent per-chat state — keep it hidden until the
 * active assistant is known to support it. Conservative on unknown.
 *
 * MIN_VERSION targets 0.11.0 — the manage-plugins surface (this in-chat pill
 * plus the new-chat plugin picker) ships in that release, so the gate holds
 * until the active assistant is on 0.11.0 or newer, keeping the pill hidden on
 * every older assistant until the surface lands.
 */
import { useAssistantSupports } from "./utils";

export const MIN_VERSION = "0.11.0";

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
