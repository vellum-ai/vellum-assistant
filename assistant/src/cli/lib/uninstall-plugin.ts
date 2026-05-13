/**
 * Remove a plugin previously materialized under `<workspaceDir>/plugins/`.
 *
 * Symmetric to {@link ./install-from-github.installPlugin}. The CLI
 * command `assistant plugins uninstall <name>` is a thin wrapper that
 * supplies the live workspace directory and formats the result.
 *
 * The operation is destructive — a successful return means the plugin
 * directory and everything beneath it have been removed from disk.
 * Callers needing a confirmation prompt should run it before invoking
 * this function (the CLI command does this via `--force`).
 */

import { existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { getWorkspacePluginsDir } from "../../util/platform.js";
import {
  InvalidPluginNameError,
  sanitizePluginName,
} from "./install-from-github.js";

/** Plugin is not present in the workspace plugins directory. */
export class PluginNotInstalledError extends Error {
  constructor(
    readonly pluginName: string,
    readonly target: string,
  ) {
    super(`Plugin "${pluginName}" is not installed at ${target}.`);
    this.name = "PluginNotInstalledError";
  }
}

/** Options accepted by {@link uninstallPlugin}. */
export interface UninstallPluginOptions {
  readonly name: string;
  /** Override the workspace plugins directory. Falls back to {@link getWorkspacePluginsDir}. */
  readonly workspacePluginsDir?: string;
}

/** Result of a successful uninstall. */
export interface UninstallPluginResult {
  readonly name: string;
  /** Absolute path that was removed. */
  readonly target: string;
}

/**
 * Validate the name, confirm the plugin exists, then recursively remove
 * the install target. Throws {@link InvalidPluginNameError} if the name
 * fails sanitization or {@link PluginNotInstalledError} if no directory
 * (or symlink to a directory) is present at the resolved target.
 *
 * The name check is performed up front so an attacker-supplied
 * `../../etc/passwd` style argument never reaches `rmSync` — even
 * though commander typically prevents it at the argv level, defense in
 * depth.
 */
export function uninstallPlugin(
  opts: UninstallPluginOptions,
): UninstallPluginResult {
  const name = sanitizePluginName(opts.name);
  const pluginsDir = opts.workspacePluginsDir ?? getWorkspacePluginsDir();
  const target = join(pluginsDir, name);

  if (!existsSync(target)) {
    throw new PluginNotInstalledError(name, target);
  }

  // `existsSync` follows symlinks; guard against a stray file with the
  // plugin's name (which would be surprising rather than dangerous —
  // we'd refuse to delete it).
  const stats = statSync(target);
  if (!stats.isDirectory()) {
    throw new PluginNotInstalledError(name, target);
  }

  rmSync(target, { recursive: true, force: true });
  return { name, target };
}

export { InvalidPluginNameError };
