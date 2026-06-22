/**
 * Enumerate plugins materialized under `<workspaceDir>/plugins/`.
 *
 * The CLI command `assistant plugins list` is a thin wrapper. Downstream
 * callers (the daemon's diagnostics surface, a future TUI, scripted
 * audits) can call {@link listInstalledPlugins} directly without going
 * through commander.
 *
 * Designed to be lenient: a malformed `package.json` is reported as an
 * error on that one entry rather than failing the whole listing. The
 * daemon makes the same call on boot via `external-plugin-loader.ts`
 * and we want both surfaces to agree on what's present.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { getWorkspacePluginsDir } from "../../util/platform.js";

/** Minimal manifest fields surfaced to the CLI. */
export interface PluginPackageMetadata {
  readonly name?: string;
  readonly version?: string;
  readonly description?: string;
  readonly peerDependencies?: Record<string, string>;
}

/** One installed plugin entry. */
export interface InstalledPluginInfo {
  /** Directory name under `<workspaceDir>/plugins/`. */
  readonly name: string;
  /** Absolute path to the plugin directory. */
  readonly target: string;
  /** Parsed `package.json` content, when present and parseable. */
  readonly packageJson: PluginPackageMetadata | null;
  /**
   * Non-fatal issues with this entry (missing `package.json`, malformed
   * JSON, unexpected type, etc.). Empty when the entry parses cleanly.
   */
  readonly issues: readonly string[];
}

/** Options accepted by {@link listInstalledPlugins}. */
export interface ListInstalledPluginsOptions {
  /** Override the workspace plugins directory. Falls back to {@link getWorkspacePluginsDir}. */
  readonly workspacePluginsDir?: string;
}

/**
 * Return one entry per directory under the workspace plugins directory,
 * sorted alphabetically by name. Hidden entries (`.`-prefixed) and
 * non-directory entries are skipped silently — the daemon's loader does
 * the same. Returns `[]` if the plugins directory does not exist.
 */
export function listInstalledPlugins(
  opts: ListInstalledPluginsOptions = {},
): InstalledPluginInfo[] {
  const pluginsDir = opts.workspacePluginsDir ?? getWorkspacePluginsDir();
  if (!existsSync(pluginsDir)) return [];

  const entries = readdirSync(pluginsDir, { withFileTypes: true })
    .filter((e) => !e.name.startsWith("."))
    .filter((e) => {
      if (e.isDirectory()) return true;
      if (!e.isSymbolicLink()) return false;
      // Resolve the symlink and only keep it if it points to a directory.
      try {
        return statSync(join(pluginsDir, e.name)).isDirectory();
      } catch {
        return false;
      }
    })
    .map((e) => e.name)
    .sort();

  return entries.map((name) => readPluginEntry(pluginsDir, name));
}

/**
 * Read a single installed plugin entry by name, or `null` when no directory
 * for it exists under the workspace plugins directory. Parses leniently like
 * {@link listInstalledPlugins} — a malformed `package.json` surfaces as an
 * `issues` entry rather than throwing.
 */
export function readInstalledPlugin(
  name: string,
  opts: ListInstalledPluginsOptions = {},
): InstalledPluginInfo | null {
  const pluginsDir = opts.workspacePluginsDir ?? getWorkspacePluginsDir();
  const target = join(pluginsDir, name);
  if (!existsSync(target) || !statSync(target).isDirectory()) return null;
  return readPluginEntry(pluginsDir, name);
}

function readPluginEntry(
  pluginsDir: string,
  name: string,
): InstalledPluginInfo {
  const target = join(pluginsDir, name);
  const pkgJsonPath = join(target, "package.json");
  const issues: string[] = [];

  if (!existsSync(pkgJsonPath)) {
    issues.push("missing package.json");
    return { name, target, packageJson: null, issues };
  }

  let raw: string;
  try {
    raw = readFileSync(pkgJsonPath, "utf8");
  } catch (err) {
    issues.push(
      `package.json unreadable: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { name, target, packageJson: null, issues };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    issues.push(
      `package.json invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { name, target, packageJson: null, issues };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    issues.push("package.json is not an object");
    return { name, target, packageJson: null, issues };
  }

  const meta = parsed as Record<string, unknown>;
  const packageJson: PluginPackageMetadata = {
    name: typeof meta.name === "string" ? meta.name : undefined,
    version: typeof meta.version === "string" ? meta.version : undefined,
    description:
      typeof meta.description === "string" ? meta.description : undefined,
    peerDependencies:
      typeof meta.peerDependencies === "object" &&
      meta.peerDependencies !== null &&
      !Array.isArray(meta.peerDependencies)
        ? (meta.peerDependencies as Record<string, string>)
        : undefined,
  };

  return { name, target, packageJson, issues };
}
