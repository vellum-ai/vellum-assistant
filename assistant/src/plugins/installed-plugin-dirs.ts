/**
 * Enumerate installed plugin directories under the workspace plugins dir.
 *
 * An installed plugin is a non-hidden directory carrying a `package.json`,
 * whose realpath stays under the realpath of the plugins directory. This walk
 * is shared by the plugin source-version collector
 * (`./collect-source-versions.ts`) and the schedule reconciler
 * (`../schedule/plugin-schedule-reconciler.ts`) so both agree on what counts
 * as an installed plugin. Disabled-state and manifest validation are caller
 * concerns: the source collector fingerprints disabled plugins too, while the
 * reconciler skips them and additionally gates on `parsePluginManifest`.
 */

import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";

import { getWorkspacePluginsDir } from "../util/platform.js";

export interface InstalledPluginDir {
  /** Directory basename: the plugin's install identity. */
  readonly name: string;
  /** Absolute path to the plugin directory. */
  readonly dir: string;
}

/**
 * True when `dir` resolves to a location strictly inside `rootRealPath`.
 *
 * Both sides are realpaths, so a symlinked entry is judged by where it points
 * rather than by where it sits. The plugin loader applies the same boundary
 * before it dynamic-imports a plugin directory (`isAllowedPluginDir` in
 * `./mtime-cache.ts`); enumeration has to agree with it, or a caller acting on
 * this list arms and runs code from a root the loader refuses to activate.
 * A link pointing at the plugins directory itself is outside the boundary too:
 * it aliases the root, not a plugin.
 */
function isInsidePluginsRoot(dir: string, rootRealPath: string): boolean {
  try {
    return realpathSync(dir).startsWith(rootRealPath + sep);
  } catch {
    // Unresolvable (dangling link, races with an uninstall, unreadable): not
    // provably contained, so it is not installed.
    return false;
  }
}

/**
 * List every installed plugin directory, sorted by the underlying readdir
 * order. A missing plugins directory yields `[]`.
 */
export function listInstalledPluginDirs(): InstalledPluginDir[] {
  const pluginsDir = getWorkspacePluginsDir();
  let entries: string[] = [];
  try {
    entries = readdirSync(pluginsDir);
  } catch {
    // No plugins directory yet, so nothing installed.
    return [];
  }
  // Resolve the root once. The workspace can itself sit behind a symlinked
  // path component, so containment has to compare realpath to realpath.
  let rootRealPath: string;
  try {
    rootRealPath = realpathSync(pluginsDir);
  } catch {
    return [];
  }
  const out: InstalledPluginDir[] = [];
  for (const entry of entries) {
    if (entry.startsWith(".")) {
      continue;
    }
    const dir = join(pluginsDir, entry);
    try {
      if (!statSync(dir).isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }
    if (!isInsidePluginsRoot(dir, rootRealPath)) {
      continue;
    }
    if (!existsSync(join(dir, "package.json"))) {
      continue;
    }
    out.push({ name: entry, dir });
  }
  return out;
}
