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
import { dirname, join } from "node:path";

import { getWorkspacePluginsDir } from "../../util/platform.js";
import { parsePluginIcon } from "./plugin-artifact.js";
import { readValidatedPluginIcon } from "./plugin-icon-file.js";

/**
 * Directory containing first-party default plugin packages. Each subdirectory
 * has a `package.json` with `name` (prefixed `default-`) and `version`.
 * Read from the filesystem at call time to avoid pulling hook/tool
 * implementations into the CLI process (which would create circular
 * dependencies in test environments).
 */
const DEFAULT_PLUGINS_DIR = join(
  dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
  "plugins",
  "defaults",
);

/** Minimal manifest fields surfaced to the CLI. */
export interface PluginPackageMetadata {
  readonly name?: string;
  readonly version?: string;
  readonly description?: string;
  readonly peerDependencies?: Record<string, string>;
  /** Author-supplied short glyph (emoji) from `vellum.icon`, when present. */
  readonly icon?: string;
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
  /** Whether a valid author-bundled `icon.png` was found in the plugin dir. */
  readonly hasIcon: boolean;
  /** Content-hash version of the validated `icon.png`, when {@link hasIcon}. */
  readonly iconVersion?: string;
}

/** Where the plugin comes from. */
export type PluginSource = "user" | "default";

/**
 * Extended plugin entry that includes source (`user` vs `default`) and
 * disabled status. Used by {@link listAllPlugins}.
 */
export interface AllPluginInfo extends InstalledPluginInfo {
  /** Whether this is a user-installed or first-party default plugin. */
  readonly source: PluginSource;
  /** Whether the plugin is disabled via a `.disabled` sentinel file. */
  readonly disabled: boolean;
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

  // Icon validation is independent of package.json parsing, so resolve it
  // once and attach to every return below (including error paths).
  const iconFields = pluginIconFields(target);

  if (!existsSync(pkgJsonPath)) {
    issues.push("missing package.json");
    return { name, target, packageJson: null, issues, ...iconFields };
  }

  let raw: string;
  try {
    raw = readFileSync(pkgJsonPath, "utf8");
  } catch (err) {
    issues.push(
      `package.json unreadable: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { name, target, packageJson: null, issues, ...iconFields };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    issues.push(
      `package.json invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { name, target, packageJson: null, issues, ...iconFields };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    issues.push("package.json is not an object");
    return { name, target, packageJson: null, issues, ...iconFields };
  }

  const meta = parsed as Record<string, unknown>;
  const icon = parsePluginIcon(meta);
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
    ...(icon ? { icon } : {}),
  };

  return { name, target, packageJson, issues, ...iconFields };
}

/**
 * Validate `<dir>/icon.png` and shape the result into the two fields surfaced
 * on {@link InstalledPluginInfo}. `iconVersion` is omitted when no valid icon
 * is present.
 */
function pluginIconFields(
  dir: string,
): Pick<InstalledPluginInfo, "hasIcon" | "iconVersion"> {
  const icon = readValidatedPluginIcon(dir);
  return icon.hasIcon
    ? { hasIcon: true, iconVersion: icon.iconVersion }
    : { hasIcon: false };
}

/**
 * List all plugins — both user-installed (from `<workspace>/plugins/`) and
 * first-party defaults (from the source tree). Each entry is annotated with
 * its `source` (`"user"` or `"default"`) and `disabled` status (whether a
 * `.disabled` sentinel file exists in the plugin's workspace directory).
 *
 * For user plugins, the `.disabled` file lives in the plugin's own install
 * directory. For default plugins, it lives in a stub directory at
 * `<workspace>/plugins/<manifest-name>/` (created by `plugins disable`).
 *
 * Stub directories created by `plugins disable <default-name>` are excluded
 * from the user listing so a disabled default plugin appears only once (as a
 * default entry, not a duplicate user entry with "missing package.json").
 *
 * Sort order:
 * 1. Enabled user plugins (by install date, oldest first — matches
 *    hook/tool resolution order)
 * 2. Disabled user plugins (by install date)
 * 3. Enabled default plugins (by repo array order — matches registration
 *    order which fixes hook-chain order)
 * 4. Disabled default plugins (by repo array order)
 */
export function listAllPlugins(
  opts: ListInstalledPluginsOptions = {},
): AllPluginInfo[] {
  const pluginsDir = opts.workspacePluginsDir ?? getWorkspacePluginsDir();

  // ── User plugins ───────────────────────────────────────────────────────
  // Filter out default-plugin stub directories (created by `plugins disable
  // default-<name>`) so they don't show up as duplicate user entries.
  const defaultNames = new Set(readDefaultPluginManifests().map((m) => m.name));
  const userPlugins: AllPluginInfo[] = listInstalledPlugins(opts)
    .filter((entry) => !defaultNames.has(entry.name))
    .map((entry) => ({
      ...entry,
      source: "user" as const,
      disabled: existsSync(join(entry.target, ".disabled")),
    }));

  // ── Default plugins ────────────────────────────────────────────────────
  // Default plugins live in the source tree at src/plugins/defaults/<name>/.
  // Read each package.json from the filesystem to get name+version without
  // importing hook/tool implementations (which would create circular
  // dependencies in test environments). The .disabled sentinel lives in a
  // stub directory at <workspace>/plugins/<manifest-name>/.
  // readDefaultPluginManifests returns in repo array (registration) order.
  const defaultPlugins: AllPluginInfo[] = readDefaultPluginManifests().map(
    (manifest) => {
      const target = join(pluginsDir, manifest.name);
      const disabled = existsSync(join(target, ".disabled"));
      // A default plugin's files (including icon.png) live in the source tree,
      // not the workspace stub dir that only holds the `.disabled` sentinel.
      return {
        name: manifest.name,
        target,
        packageJson: {
          name: manifest.name,
          version: manifest.version,
        },
        issues: [],
        source: "default" as const,
        disabled,
        ...pluginIconFields(join(DEFAULT_PLUGINS_DIR, manifest.name)),
      };
    },
  );

  // Sort: enabled user (install date), disabled user (install date),
  // enabled default (repo order), disabled default (repo order).
  const enabledUser = userPlugins.filter((p) => !p.disabled);
  const disabledUser = userPlugins.filter((p) => p.disabled);
  const enabledDefault = defaultPlugins.filter((p) => !p.disabled);
  const disabledDefault = defaultPlugins.filter((p) => p.disabled);

  enabledUser.sort((a, b) => getPluginInstallDate(a) - getPluginInstallDate(b));
  disabledUser.sort(
    (a, b) => getPluginInstallDate(a) - getPluginInstallDate(b),
  );
  // enabledDefault and disabledDefault keep repo array order (no sort).

  return [
    ...enabledUser,
    ...disabledUser,
    ...enabledDefault,
    ...disabledDefault,
  ];
}

interface DefaultPluginManifest {
  readonly name: string;
  readonly version?: string;
}

/**
 * Read first-party default plugin manifests from the filesystem. Each
 * subdirectory under {@link DEFAULT_PLUGINS_DIR} that has a `package.json`
 * with a `name` field is included. This avoids importing `defaults/index.ts`
 * (which would pull in hook/tool implementations and create circular
 * dependencies in test environments).
 */
function readDefaultPluginManifests(): readonly DefaultPluginManifest[] {
  if (!existsSync(DEFAULT_PLUGINS_DIR)) return [];

  const entries = readdirSync(DEFAULT_PLUGINS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  const manifests: DefaultPluginManifest[] = [];
  for (const name of entries) {
    const pkgJsonPath = join(DEFAULT_PLUGINS_DIR, name, "package.json");
    if (!existsSync(pkgJsonPath)) continue;
    try {
      const raw = readFileSync(pkgJsonPath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed.name === "string") {
        manifests.push({
          name: parsed.name,
          version:
            typeof parsed.version === "string" ? parsed.version : undefined,
        });
      }
    } catch {
      // Skip malformed entries — lenient like listInstalledPlugins.
    }
  }
  return manifests;
}

/**
 * Resolve the install date for a user plugin directory, in epoch ms.
 * Reads `install-meta.json`'s `installedAt` field first, falling back to
 * the directory's birthtime. Mirrors the logic in mtime-cache's
 * `getInstallDate` so the sort order matches hook/tool resolution order.
 */
function getPluginInstallDate(plugin: AllPluginInfo): number {
  const metaPath = join(plugin.target, "install-meta.json");
  try {
    if (existsSync(metaPath)) {
      const raw = JSON.parse(readFileSync(metaPath, "utf8")) as Record<
        string,
        unknown
      >;
      if (typeof raw.installedAt === "string") {
        const ms = Date.parse(raw.installedAt);
        if (Number.isFinite(ms)) return ms;
      }
    }
  } catch {
    // Fall through to birthtime.
  }
  try {
    return statSync(plugin.target).birthtimeMs;
  } catch {
    return 0;
  }
}
