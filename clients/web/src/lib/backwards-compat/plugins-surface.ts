/**
 * Backwards-compat gate: the assistant Plugins surface (the Plugins tab
 * under "About Assistant" plus the `/assistant/plugins` routes).
 *
 * The Plugins surface is driven by the daemon's plugin routes
 * (`GET /plugins`, `GET /plugins/search`, `GET /plugins/:name`, etc.).
 * Those routes first ship in the assistant version below. The web app
 * always serves the latest bundle, so when it connects to an older
 * assistant whose plugin routes are absent the catalog/detail queries
 * 404 and the surface renders a broken error state.
 *
 * Gating the tab and routes on `MIN_VERSION` keeps the surface hidden
 * (and direct deep-links redirected) on assistants that predate the
 * plugin routes, instead of exposing a dead surface. The
 * `external-plugins` feature flag that previously gated this surface was
 * removed when plugins went GA; this version gate replaces it as the
 * remaining compatibility boundary.
 */
import { useAssistantSupports } from "./utils";

export const MIN_VERSION = "0.10.3";

/**
 * Returns `true` when the active assistant exposes the plugin routes that
 * back the Plugins surface. Subscribes to the identity store so consumers
 * re-render when the assistant version crosses `MIN_VERSION`.
 *
 * Returns `false` while the identity store has no version yet, when the
 * version is unparseable, or when it falls below `MIN_VERSION` — callers
 * hide the tab / redirect the route on the `false` branch.
 */
export function useSupportsPluginsSurface(): boolean {
  return useAssistantSupports(MIN_VERSION);
}
