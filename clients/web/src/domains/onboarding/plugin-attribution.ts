/**
 * Plugins the user should start with based on where they came from.
 *
 * When a logged-in user with no assistant clicks "Hatch an assistant with this
 * plugin" on a marketing plugin page, the marketing side (platform repo
 * `web/src/app/(marketing)/plugins/[slug]/_components/plugin-install-in-assistant-button.tsx`)
 * routes them into onboarding with the plugin carried as a `?plugin=<name>`
 * query parameter. Onboarding folds this into the set it installs (see
 * `onboarding-plugin-affinity`), so the user arrives with it already set up.
 *
 * A query parameter — not `localStorage`, which this replaced — so the hand-off
 * is visible to marketing analytics on the landing URL (the whole point of the
 * switch). It rides the current onboarding URL: the research route holds a
 * stable URL across its internal steps, so the param is readable for the whole
 * flow, and it's naturally gone once the user leaves that URL (no TTL needed).
 *
 * It's a signal, not a one-shot command: reads are idempotent (an already-
 * installed plugin 409s and is ignored) and everything is narrowed to the live
 * catalog downstream, so an off-catalog or malformed value is simply dropped.
 *
 * Both repos MUST agree on {@link ATTRIBUTED_PLUGIN_PARAM}.
 */

/** Query-param name carrying the marketing-attributed plugin. */
export const ATTRIBUTED_PLUGIN_PARAM = "plugin";

/**
 * The attributed plugin id from a query string, or `null` when there is none.
 * `search` defaults to the current URL's query so the runner can read it
 * without threading; pass an explicit string in tests.
 */
function readAttributedPluginId(search: string): string | null {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return null;
  }
  const id = params.get(ATTRIBUTED_PLUGIN_PARAM)?.trim();
  return id ? id : null;
}

/**
 * Plugin names to install for the user based on marketing attribution — the
 * plugin they clicked "Hatch an assistant with this plugin" on before
 * onboarding. Empty when there's none.
 */
export function pluginsFromAttribution(
  search: string = typeof window !== "undefined" ? window.location.search : "",
): string[] {
  const pluginId = readAttributedPluginId(search);
  return pluginId ? [pluginId] : [];
}
