import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
      if (!entry.isDirectory()) continue;
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
