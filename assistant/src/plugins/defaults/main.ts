import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Filesystem-backed access to the first-party default plugins. This module
 * will eventually replace `defaults/index.ts`.
 *
 * The barrel (`defaults/index.ts`) derives everything from static imports of
 * every plugin's hook and injector modules, so any consumer that only needs
 * plugin *identity* still ends up downstream of the entire plugin
 * implementation graph. This module answers identity questions from the
 * source tree instead: each immediate subdirectory of `plugins/defaults/`
 * that carries a `package.json` is one plugin, named by that manifest — the
 * same `package.json` the barrel imports for its `manifest.name`.
 *
 * Relying on the directory layout is safe because the assistant ships its
 * source hierarchy as-is (`bun --compile` is not supported), so the tree this
 * module reads in production is the tree the plugins are loaded from.
 */

const DEFAULTS_DIR = import.meta.dir;

/**
 * Route-namespace prefix for default plugins. A default plugin's route
 * namespace is `default-<directory-name>` by convention (matching its
 * `package.json` name and its `.disabled` sentinel key), so route resolution
 * derives the namespace from the directory name directly — no manifest read.
 */
const DEFAULT_PLUGIN_NAMESPACE_PREFIX = "default-";

let cachedNames: readonly string[] | null = null;
let cachedDirToManifest: ReadonlyMap<string, string> | null = null;

/**
 * Names of every first-party default plugin (their `package.json` names,
 * e.g. `default-memory`), read from the `plugins/defaults/` directory tree.
 * Read once and memoized: the plugin set is fixed for the lifetime of the
 * process — the source tree does not change under a running assistant.
 */
export function getAllDefaultPluginNames(): readonly string[] {
  if (cachedNames === null) {
    const names: string[] = [];
    for (const entry of readdirSync(DEFAULTS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      let manifest: { name?: unknown };
      try {
        manifest = JSON.parse(
          readFileSync(join(DEFAULTS_DIR, entry.name, "package.json"), "utf-8"),
        ) as { name?: unknown };
      } catch {
        // A subdirectory without a readable package.json is not a plugin.
        continue;
      }
      if (typeof manifest.name === "string" && manifest.name.length > 0) {
        names.push(manifest.name);
      }
    }
    cachedNames = names.sort();
  }
  return cachedNames;
}

/**
 * Manifest name (e.g. `default-platform-hosted`) for a default plugin's
 * *directory* name (e.g. `platform-hosted`), or `null` when `<dirName>` is not
 * a default plugin. Memoized alongside {@link getAllDefaultPluginNames}.
 *
 * Default-plugin `.disabled` sentinels are keyed by the manifest name (the CLI
 * and bootstrap write `<workspace>/plugins/<manifest-name>/.disabled`), while a
 * default plugin's route namespace is its directory name — this bridges the two
 * so the disabled gate can be checked from a route path segment.
 */
export function getDefaultPluginManifestName(dirName: string): string | null {
  if (cachedDirToManifest === null) {
    const map = new Map<string, string>();
    for (const entry of readdirSync(DEFAULTS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      try {
        const manifest = JSON.parse(
          readFileSync(join(DEFAULTS_DIR, entry.name, "package.json"), "utf-8"),
        ) as { name?: unknown };
        if (typeof manifest.name === "string" && manifest.name.length > 0) {
          map.set(entry.name, manifest.name);
        }
      } catch {
        // A subdirectory without a readable package.json is not a plugin.
      }
    }
    cachedDirToManifest = map;
  }
  return cachedDirToManifest.get(dirName) ?? null;
}

/**
 * Absolute path to a default plugin's `routes/` directory in the source tree,
 * or `null` when `<name>` is not a default plugin's route namespace.
 *
 * A default plugin's route namespace is `default-<directory-name>` (e.g.
 * `default-platform-hosted`) — the same `default-…` name its `.disabled`
 * sentinel and per-chat scoping are keyed by. `<name>` is the namespace: the
 * `default-` prefix is stripped to recover the source directory, so a name
 * without the prefix (e.g. the bare directory name) resolves to `null`. The
 * containment guard rejects any `..`/nested segment taken from a URL path so it
 * can never escape the defaults tree. The path is derived from this module's
 * own location (`import.meta.dir`), so it resolves relative to the app source,
 * which the assistant always ships and runs un-bundled.
 */
export function getDefaultPluginRoutesDir(name: string): string | null {
  if (!name.startsWith(DEFAULT_PLUGIN_NAMESPACE_PREFIX)) {
    return null;
  }
  const dirName = name.slice(DEFAULT_PLUGIN_NAMESPACE_PREFIX.length);
  const pluginDir = resolve(join(DEFAULTS_DIR, dirName));
  if (dirname(pluginDir) !== resolve(DEFAULTS_DIR)) {
    return null;
  }
  if (!existsSync(pluginDir) || !statSync(pluginDir).isDirectory()) {
    return null;
  }
  return join(pluginDir, "routes");
}

/**
 * Enumerate default plugins that ship a `routes/` directory, keyed by their
 * route namespace (`default-<directory-name>`, e.g. `default-platform-hosted`).
 * Mirrors {@link getDefaultPluginRoutesDir} so route discovery and dispatch
 * agree on which default plugin routes exist and under which namespace.
 */
export function getDefaultPluginRouteRoots(): {
  pluginName: string;
  routesDir: string;
}[] {
  const roots: { pluginName: string; routesDir: string }[] = [];
  for (const entry of readdirSync(DEFAULTS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const routesDir = join(DEFAULTS_DIR, entry.name, "routes");
    if (existsSync(routesDir) && statSync(routesDir).isDirectory()) {
      roots.push({
        pluginName: DEFAULT_PLUGIN_NAMESPACE_PREFIX + entry.name,
        routesDir,
      });
    }
  }
  return roots;
}
