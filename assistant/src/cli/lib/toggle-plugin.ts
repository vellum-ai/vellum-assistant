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
 * For default plugins (which live in the source tree) the directory may not
 * exist yet, so `disable` creates a stub directory and drops the sentinel
 * inside it. `enable` removes the sentinel and cleans up the stub directory
 * if it becomes empty (so the workspace stays tidy when the only thing in
 * it was the sentinel).
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { getWorkspacePluginsDir } from "../../util/platform.js";

const DISABLED_FILE = ".disabled";

/**
 * Plugin name pattern: single path segment, kebab-case alphanumerics.
 * Rejects path traversal (`../`, slashes, null bytes) and any name that
 * is not a flat directory entry. Same pattern as {@link sanitizePluginName}
 * but does NOT reject the `default-` prefix, since enable/disable must
 * accept default plugin names.
 */
const PLUGIN_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

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

/** The plugin name contains invalid characters or path segments. */
export class InvalidPluginNameError extends Error {
  constructor(public readonly name: string) {
    super(
      `Invalid plugin name "${name}". Names must be kebab-case alphanumerics (a-z, 0-9, -, _).`,
    );
    this.name = "InvalidPluginNameError";
  }
}

/** No plugin directory found for the given name. */
export class PluginDirectoryNotFoundError extends Error {
  constructor(public readonly name: string) {
    super(
      `No plugin directory found for "${name}". Run \`assistant plugins list\` to see installed plugins. To disable a default plugin, prefix the name with "default-" (e.g. "default-advisor").`,
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
 * Validate a plugin name for enable/disable. Same kebab-case rule as
 * {@link sanitizePluginName} but allows the `default-` prefix (needed for
 * toggling default plugins).
 */
function validatePluginName(name: string): string {
  const trimmed = name.trim();
  if (!PLUGIN_NAME_RE.test(trimmed)) {
    throw new InvalidPluginNameError(name);
  }
  return trimmed;
}

/**
 * Disable a plugin by creating a `.disabled` sentinel file in its workspace
 * directory. For default plugins (names starting with `default-`), creates a
 * stub directory under `<workspace>/plugins/<name>/` if one does not exist.
 * For user plugins, the directory must already exist.
 */
export function disablePlugin(name: string): TogglePluginResult {
  const validated = validatePluginName(name);
  const pluginsDir = getWorkspacePluginsDir();
  const pluginDir = join(pluginsDir, validated);
  const sentinelPath = join(pluginDir, DISABLED_FILE);

  if (existsSync(sentinelPath)) {
    throw new PluginAlreadyInStateException(validated, "disable");
  }

  if (!existsSync(pluginDir)) {
    // Only create stub directories for default plugins. User plugins must
    // already be installed — creating a directory for a name that has no
    // plugin would be misleading.
    if (!validated.startsWith("default-")) {
      throw new PluginDirectoryNotFoundError(validated);
    }
    mkdirSync(pluginDir, { recursive: true });
  }

  // Write empty sentinel file — content is irrelevant, existence is the signal.
  // Synchronous (like `enablePlugin`'s `unlinkSync`) so the sentinel is durable
  // before the caller publishes `sync_changed`/returns 200, and a write failure
  // throws synchronously into the route's try/catch instead of an unawaited
  // `Bun.write` promise that could resolve/reject after the response.
  writeFileSync(sentinelPath, "");
  return { name: validated, action: "disable", sentinelPath };
}

/**
 * Enable a plugin by removing the `.disabled` sentinel file from its
 * workspace directory. If the directory was a stub created by `disable`
 * (i.e. it contains nothing but the sentinel), it is removed entirely.
 */
export function enablePlugin(name: string): TogglePluginResult {
  const validated = validatePluginName(name);
  const pluginsDir = getWorkspacePluginsDir();
  const pluginDir = join(pluginsDir, validated);
  const sentinelPath = join(pluginDir, DISABLED_FILE);

  // A missing user plugin is a 404, not a no-op: without this, a typo/deleted
  // name has no sentinel and would fall through to "already enabled" (409),
  // indistinguishable from a genuinely-enabled plugin. Default plugins have no
  // directory when enabled, so they skip this check (their no-op stays 409).
  if (!validated.startsWith("default-") && !existsSync(pluginDir)) {
    throw new PluginDirectoryNotFoundError(validated);
  }

  if (!existsSync(sentinelPath)) {
    throw new PluginAlreadyInStateException(validated, "enable");
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

  return { name: validated, action: "enable", sentinelPath };
}
