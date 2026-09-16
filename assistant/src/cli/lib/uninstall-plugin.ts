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

import { runShutdownHook } from "../../hooks/hook-loader.js";
import { MESSAGE_KEYS, t } from "../../i18n/index.js";
import { isPluginDisabled } from "../../plugins/disabled-state.js";
import { PLUGIN_MCP_MANIFEST } from "../../plugins/mcp-servers.js";
import { getWorkspacePluginsDir } from "../../util/platform.js";
import {
  InvalidPluginNameError,
  readInstallMeta,
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

export const PLUGIN_UNINSTALL_WARNING_KEYS = {
  MCP_OAUTH_CREDENTIALS_UNCHECKED:
    MESSAGE_KEYS.PLUGIN_MCP_OAUTH_CREDENTIALS_UNCHECKED,
} as const;

export type PluginUninstallWarningKey =
  (typeof PLUGIN_UNINSTALL_WARNING_KEYS)[keyof typeof PLUGIN_UNINSTALL_WARNING_KEYS];

export function resolvePluginUninstallWarning(
  key: PluginUninstallWarningKey,
): string {
  return t(key);
}

/** Result of a successful uninstall. */
export interface UninstallPluginResult {
  readonly name: string;
  /** Absolute path that was removed. */
  readonly target: string;
  /** Stable keys for non-fatal cleanup limitations. */
  readonly warnings?: PluginUninstallWarningKey[];
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
 *
 * Before removing the directory, the plugin's `shutdown` hook (reason
 * `uninstall`) is resolved and run while its files are still present, so it can
 * clean up. It runs in whatever process performs the uninstall — both the CLI
 * command and the daemon's `DELETE` route call this — because a `shutdown` hook
 * must not assume it shares a process with its `init`. Resolving a hook that
 * imports `@vellumai/plugin-api` needs the workspace shim in place; each caller
 * ensures it first — the daemon `DELETE` route and the `plugins` CLI command
 * group. A missing, throwing, or slow hook is best-effort (time-boxed inside
 * {@link runShutdownHook}) and never blocks the removal.
 */
export async function uninstallPlugin(
  opts: UninstallPluginOptions,
): Promise<UninstallPluginResult> {
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

  const hasCurrentMcpManifest = existsSync(join(target, PLUGIN_MCP_MANIFEST));
  const recordedFiles = readInstallMeta(target)?.fingerprint?.files;
  const hasRecordedMcpManifest =
    recordedFiles !== undefined &&
    Object.hasOwn(recordedFiles, PLUGIN_MCP_MANIFEST);
  const warnings: PluginUninstallWarningKey[] = [];
  const { deletePluginMcpOAuthCredentials } =
    await import("../../mcp/mcp-oauth-provider.js");
  let credentialsReachable = true;
  let cleanup:
    | Awaited<ReturnType<typeof deletePluginMcpOAuthCredentials>>
    | undefined;
  try {
    cleanup = await deletePluginMcpOAuthCredentials(name);
    credentialsReachable = !cleanup.unreachable;
  } catch {
    credentialsReachable = false;
  }
  if (cleanup && !cleanup.unreachable && !cleanup.ok) {
    throw new Error(
      `Plugin "${name}" was not removed because its MCP OAuth credentials could not be deleted.`,
    );
  }

  if (!credentialsReachable) {
    if (hasCurrentMcpManifest || hasRecordedMcpManifest) {
      throw new Error(
        `Plugin "${name}" was not removed because credential storage is unavailable and its MCP OAuth credentials could not be checked.`,
      );
    }
    warnings.push(
      PLUGIN_UNINSTALL_WARNING_KEYS.MCP_OAUTH_CREDENTIALS_UNCHECKED,
    );
  }

  // Skip the shutdown hook when the plugin is disabled. A `.disabled` plugin
  // is never loaded — no hooks, tools, or init — so its shutdown was never
  // paired with an init. Running it on uninstall would be the first and only
  // execution of the plugin's code, which inverts the disabled contract and
  // is especially dangerous for untrusted/direct-installed plugins where
  // removal should never be the action that first runs plugin code.
  if (!isPluginDisabled(name)) {
    await runShutdownHook("plugin", name, "uninstall");
  }

  rmSync(target, { recursive: true, force: true });
  return {
    name,
    target,
    ...(warnings.length > 0 && { warnings }),
  };
}

export { InvalidPluginNameError };
