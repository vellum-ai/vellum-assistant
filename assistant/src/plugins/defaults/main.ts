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

let cachedNames: readonly string[] | null = null;

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
 * Absolute path to a default plugin's `routes/` directory in the source tree,
 * or `null` when `<name>` is not a default plugin.
 *
 * A default plugin's route namespace is its *directory* name (e.g.
 * `platform-hosted`), matching how a workspace plugin's namespace is its
 * directory name — not the `default-…` manifest name. The path is derived
 * from this module's own location (`import.meta.dir`), so it resolves relative
 * to the app source, which the assistant always ships and runs un-bundled.
 *
 * `name` is taken from a URL path segment, so the resolved directory is
 * required to sit directly under `plugins/defaults/` — a `..` or nested
 * segment that escapes the defaults tree returns `null`.
 */
export function getDefaultPluginRoutesDir(name: string): string | null {
  const pluginDir = resolve(join(DEFAULTS_DIR, name));
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
 * directory name (the route namespace). Mirrors {@link getDefaultPluginRoutesDir}
 * so route discovery and dispatch agree on which default plugin routes exist.
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
      roots.push({ pluginName: entry.name, routesDir });
    }
  }
  return roots;
}
