/**
 * Enumerate installed plugin directories under the workspace plugins dir.
 *
 * An installed plugin is a non-hidden directory carrying a `package.json`.
 * This walk is shared by the plugin source-version collector
 * (`./collect-source-versions.ts`) and the schedule reconciler
 * (`../schedule/plugin-schedule-reconciler.ts`) so both agree on what counts
 * as an installed plugin. Disabled-state and manifest validation are caller
 * concerns: the source collector fingerprints disabled plugins too, while the
 * reconciler skips them and additionally gates on `parsePluginManifest`.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { getWorkspacePluginsDir } from "../util/platform.js";

export interface InstalledPluginDir {
  /** Directory basename: the plugin's install identity. */
  readonly name: string;
  /** Absolute path to the plugin directory. */
  readonly dir: string;
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
    if (!existsSync(join(dir, "package.json"))) {
      continue;
    }
    out.push({ name: entry, dir });
  }
  return out;
}
