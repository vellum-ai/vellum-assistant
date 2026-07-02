/**
 * Backwards-compat gate: plugin custom icons.
 *
 * Plugins can carry a custom icon served by the daemon's plugin-icon
 * endpoint. The web app renders that icon via an `<img>` pointed at the
 * endpoint, so it must only do so when the active assistant is known to
 * serve it — an older daemon 404s the request and the image breaks.
 *
 * The web app always serves the latest bundle, but the assistant can be
 * any locally-installed version. Emoji/text icons degrade naturally via
 * the optional field, so this gate only guards the `<img>` path.
 *
 * MIN_VERSION is a placeholder for the release that ships the icon
 * endpoint; bump it to that release when it is cut.
 */
import { useAssistantSupports } from "./utils";

export const MIN_VERSION = "0.10.5";

/**
 * Returns `true` when the active assistant serves the plugin-icon
 * endpoint. Subscribes to the identity store so consumers re-render when
 * the assistant version crosses `MIN_VERSION`.
 *
 * Returns `false` while the identity store has no version yet, when the
 * version is unparseable, or when it falls below `MIN_VERSION` — callers
 * fall back to the non-`<img>` icon on the `false` branch.
 */
export function useSupportsPluginIcons(): boolean {
  return useAssistantSupports(MIN_VERSION);
}
