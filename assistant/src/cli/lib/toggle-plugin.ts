/**
 * Enable / disable plugins by creating or removing a `.disabled` sentinel
 * file inside the plugin's workspace directory.
 *
 * The sentinel is read by the daemon at boot:
 * - User plugins: {@link ../../plugins/mtime-cache.ts} skips any plugin
 *   whose directory contains `.disabled`.
 * - Default plugins: {@link ../../daemon/external-plugins-bootstrap.ts}
 *   checks `<workspace>/plugins/<manifest-name>/.disabled` before init.
 *
 * For user plugins the directory already exists (it is the install target).
 * For default plugins the directory may not exist yet, so `disable` creates
 * a stub directory and drops the sentinel inside it. `enable` removes the
 * sentinel and cleans up the stub directory if it becomes empty (so the
 * workspace stays tidy when the only thing in it was the sentinel).
 */

import { existsSync, mkdirSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { getWorkspacePluginsDir } from "../../util/platform.js";

const DISABLED_FILE = ".disabled";

/** The plugin is already in the requested state. */
export class PluginAlreadyInStateException extends Error {
  constructor(
    public readonly name: string,
    public readonly action: "enable" | "disable",
  ) {
    super(
      `Plugin "${name}" is already ${action === "disable" ? "disabled" : "enabled"}.`,
    );
    this.name = "PluginAlreadyInStateException";
  }
}

/** No plugin directory found for the given name. */
export class PluginDirectoryNotFoundError extends Error {
  constructor(public readonly name: string) {
    super(
      `No plugin directory found for "${name}". Run \`assistant plugins list\` to see installed plugins.`,
    );
    this.name = "PluginDirectoryNotFoundError";
  }
}

export interface TogglePluginResult {
  readonly name: string;
  readonly action: "enable" | "disable";
  readonly sentinelPath: string;
}

/**
 * Disable a plugin by creating a `.disabled` sentinel file in its workspace
 * directory. For default plugins (which live in the source tree), creates a
 * stub directory under `<workspace>/plugins/<name>/` if one does not exist.
 */
export function disablePlugin(name: string): TogglePluginResult {
  const pluginsDir = getWorkspacePluginsDir();
  const pluginDir = join(pluginsDir, name);
  const sentinelPath = join(pluginDir, DISABLED_FILE);

  if (existsSync(sentinelPath)) {
    throw new PluginAlreadyInStateException(name, "disable");
  }

  // User plugins already have a directory with package.json. Default plugins
  // may need a stub directory created so the sentinel has somewhere to live.
  if (!existsSync(pluginDir)) {
    mkdirSync(pluginDir, { recursive: true });
  }

  // Touch the sentinel file.
  mkdirSync(pluginDir, { recursive: true });
  // Write empty file — content is irrelevant, existence is the signal.
  Bun.write(sentinelPath, "");
  return { name, action: "disable", sentinelPath };
}

/**
 * Enable a plugin by removing the `.disabled` sentinel file from its
 * workspace directory. If the directory was a stub created by `disable`
 * (i.e. it contains nothing but the sentinel), it is removed entirely.
 */
export function enablePlugin(name: string): TogglePluginResult {
  const pluginsDir = getWorkspacePluginsDir();
  const pluginDir = join(pluginsDir, name);
  const sentinelPath = join(pluginDir, DISABLED_FILE);

  if (!existsSync(sentinelPath)) {
    throw new PluginAlreadyInStateException(name, "enable");
  }

  unlinkSync(sentinelPath);

  // Clean up the stub directory if it is now empty (default plugin case).
  // A user plugin directory has package.json and source files, so it will
  // never be empty after removing the sentinel.
  if (existsSync(pluginDir)) {
    const remaining = readdirSync(pluginDir);
    if (remaining.length === 0) {
      rmSync(pluginDir, { recursive: true });
    }
  }

  return { name, action: "enable", sentinelPath };
}
