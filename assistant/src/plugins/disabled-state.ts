/**
 * Plugin disabled-state check.
 *
 * A plugin is disabled when a `.disabled` sentinel file exists inside its
 * workspace plugin directory (`<workspace>/plugins/<name>/.disabled`). This
 * is the single source of truth for the enabled/disabled state of both
 * user-installed and default plugins.
 *
 * Each surface that exposes plugin contributions (hooks, tools, routes) calls
 * {@link isPluginDisabled} at read time so that toggling a plugin via the CLI
 * (`assistant plugins disable/enable <name>`) takes effect on the next turn
 * without a daemon restart.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { getWorkspacePluginsDir } from "../util/platform.js";

/**
 * Return `true` when the `.disabled` sentinel exists for `pluginName`.
 *
 * The check is a synchronous `existsSync` — the same primitive already used
 * by `scanPlugins` and `bootstrapPlugins`. It is cheap (one `stat` syscall)
 * and does not need caching for the current call pattern: `getHooksFor` is
 * invoked a handful of times per turn, one per hook event, and the number of
 * default plugins is small.
 */
export function isPluginDisabled(pluginName: string): boolean {
  return existsSync(join(getWorkspacePluginsDir(), pluginName, ".disabled"));
}
