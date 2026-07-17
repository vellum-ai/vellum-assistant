/**
 * Walk the workspace's plugin directories and snapshot each one's current
 * source version.
 *
 * This is the single collector shared by the two producers of a source-versions
 * map: the resource monitor's watcher (which fingerprints on a timer and writes
 * the sentinel — see `../monitoring/plugin-source-watch.ts`) and the daemon's
 * imperative reconcile (which applies the walk directly, without waiting on the
 * watcher — see `reconcilePluginSourcesNow` in `./mtime-cache.ts`). Keeping the
 * walk in one place guarantees both paths produce byte-identical maps, so an
 * imperative reconcile never disagrees with the watcher's next publish and
 * causes a spurious reload.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  getWorkspaceHooksDir,
  getWorkspacePluginsDir,
} from "../util/platform.js";
import { snapshotPluginSource } from "./source-fingerprint.js";
import type { PluginSourceVersion } from "./source-versions.js";

/**
 * Collect the current source version of every watched directory: each plugin
 * directory under `<workspace>/plugins/` (a directory with a `package.json`),
 * plus the standalone workspace hooks directory when it exists. Disabled
 * plugins are fingerprinted too: consumers need fresh state the moment a plugin
 * is re-enabled, and the `disabled` field is how they observe the toggle itself
 * (dotfiles are excluded from the fingerprint).
 */
export function collectSourceVersions(): Record<string, PluginSourceVersion> {
  const out: Record<string, PluginSourceVersion> = {};

  const pluginsDir = getWorkspacePluginsDir();
  let entries: string[] = [];
  try {
    entries = readdirSync(pluginsDir);
  } catch {
    // No plugins directory yet — nothing to watch there.
  }
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
    const snapshot = snapshotPluginSource(dir);
    out[dir] = {
      fingerprint: snapshot.fingerprint,
      evictionPaths: snapshot.evictionPaths,
      disabled: existsSync(join(dir, ".disabled")),
    };
  }

  const workspaceHooksDir = getWorkspaceHooksDir();
  if (existsSync(workspaceHooksDir)) {
    const snapshot = snapshotPluginSource(workspaceHooksDir);
    out[workspaceHooksDir] = {
      fingerprint: snapshot.fingerprint,
      evictionPaths: snapshot.evictionPaths,
      disabled: false,
    };
  }

  return out;
}
