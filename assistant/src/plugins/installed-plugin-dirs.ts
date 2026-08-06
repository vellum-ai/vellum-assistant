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
 *
 * The containment half of that definition is exported on its own
 * ({@link isInsidePluginRoot}) for the plugin loader, which applies the same
 * boundary at boot discovery and before it imports a plugin directory, and for
 * the schedule fire-time probe, which applies it before answering that a
 * declaration is available to run.
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
 * True when `dir` resolves to a location strictly inside `root`, where `root`
 * is the tree the caller requires `dir` to stay in: an allowed plugin root
 * (the workspace plugins directory, or the standalone workspace hooks
 * directory) for a plugin directory, or a plugin directory for something
 * installed under it.
 *
 * Both sides are resolved before the comparison. Resolving the candidate is
 * what judges a symlinked entry by where it points rather than by where it
 * sits; resolving the root is what keeps a root that itself sits behind a
 * symlinked path component (macOS `/tmp` to `/private/tmp`, a workspace under
 * a linked home) matching its own children. A resolved candidate compared
 * against an unresolved root reports every entry as outside.
 *
 * This is the one containment boundary the plugin loader applies: enumeration
 * here, boot discovery, and the pre-import check before a plugin directory is
 * dynamic-imported (`scanPlugins` and `isAllowedPluginDir` in
 * `./mtime-cache.ts`) all go through it, so a root the loader refuses to
 * activate is never reported as installed either. A link pointing at the root
 * itself is outside the boundary: it aliases the root, not a plugin. The
 * schedule fire-time probe
 * (`../schedule/plugin-schedule-declarations.ts`) applies the same boundary,
 * so such a root cannot be run by a declared schedule either.
 */
export function isInsidePluginRoot(dir: string, root: string): boolean {
  try {
    return realpathSync(dir).startsWith(realpathSync(root) + sep);
  } catch {
    // Unresolvable (dangling link, races with an uninstall, unreadable): not
    // provably contained, so it is not inside.
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
    if (!isInsidePluginRoot(dir, pluginsDir)) {
      continue;
    }
    if (!existsSync(join(dir, "package.json"))) {
      continue;
    }
    out.push({ name: entry, dir });
  }
  return out;
}
