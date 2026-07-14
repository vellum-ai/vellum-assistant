/**
 * Per-plugin source snapshots — the change detector behind plugin live
 * reload.
 *
 * A hook or tool file may import helper modules from anywhere inside its
 * plugin directory, and the runtime module registry caches every one of
 * them independently. Watching only the entry file's mtime therefore misses
 * helper edits, and evicting only the entry file would re-bind it to stale
 * cached helpers (or worse, to a stale intermediate module in a
 * `hook → a → b` chain). Instead of tracking the real import graph, the
 * source watcher (`../monitoring/plugin-source-watch.ts`) treats the whole
 * plugin directory as the reload unit: one walk produces both a
 * **fingerprint** (did any source file change?) and the **eviction list**
 * (every path that must leave a module registry so the next imports
 * re-evaluate a mutually consistent set). Evicting a path that was never
 * imported is a harmless no-op, so the walk doesn't need to know what the
 * plugin actually imported.
 *
 * Exclusions: dot-entries anywhere (`.disabled`, `.git`, …), `node_modules`
 * anywhere (vendored deps change only through install flows, which recycle
 * the plugin directory), generated app build output ({@link
 * isGeneratedAppBuildDir}, so the watcher's own compile does not re-trigger a
 * pass), and — at the plugin root only — the runtime-owned
 * {@link PRESERVED_ENTRIES} (`data/`, `config.json`, `install-meta.json`),
 * none of which are importable source. Symlinked entries inside the tree are
 * neither watched nor followed (see {@link walkPluginTree}); a symlinked
 * plugin *root* is supported via realpath resolution. Imports that reach
 * *outside* the plugin directory are out of scope by design: shared deps
 * keep their module identity across reloads, and cross-plugin imports are
 * unsupported.
 */

import { realpathSync, statSync } from "node:fs";

import {
  isGeneratedAppBuildDir,
  PRESERVED_ENTRIES,
  walkPluginTree,
} from "./plugin-tree-walk.js";

/** Directory names skipped at any depth. */
const EXCLUDED_DIRS_ANYWHERE = new Set(["node_modules"]);

/**
 * The result of one source walk over a plugin directory.
 */
export interface SourceSnapshot {
  /**
   * Opaque version stamp for the plugin's source: the sorted
   * `(path, mtimeMs)` pairs of every included file. Two snapshots compare
   * equal iff no source file was edited, added, removed, or renamed —
   * unlike a max-mtime scheme, which misses swaps that don't advance the
   * clock.
   */
  readonly fingerprint: string;
  /**
   * Absolute paths to evict from the module registry when the fingerprint
   * changes. Contains the realpath form of every included file, plus the
   * symlink-rooted alias of each when the plugin directory is reached
   * through a symlink — the registry may key a module under either form
   * depending on the path the importer used.
   */
  readonly evictionPaths: readonly string[];
}

/**
 * Walk `pluginDir` and snapshot its source files. Best-effort on a directory
 * that's being mutated mid-walk: unreadable entries are skipped, and a
 * missing directory yields an empty snapshot (the plugin-deletion path in
 * the scan handles that case before fingerprints are compared).
 */
export function snapshotPluginSource(pluginDir: string): SourceSnapshot {
  let realRoot = pluginDir;
  try {
    realRoot = realpathSync(pluginDir);
  } catch {
    // Unresolvable (deleted mid-scan) — walk the given path; it will yield
    // an empty file list.
  }

  const files: Array<{ path: string; mtimeMs: number }> = [];
  walkPluginTree(
    realRoot,
    {
      excludeRootEntries: PRESERVED_ENTRIES,
      excludeDirsAnywhere: EXCLUDED_DIRS_ANYWHERE,
      excludeDir: isGeneratedAppBuildDir,
      excludeDotEntries: true,
      bestEffort: true,
    },
    (_rel, abs) => {
      try {
        files.push({ path: abs, mtimeMs: statSync(abs).mtimeMs });
      } catch {
        // Deleted between readdir and stat — the next pass sees the removal.
      }
    },
  );

  // readdir order is platform-dependent; sort for a stable fingerprint.
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const fingerprint = files
    .map((f) => `${f.path}\u0000${f.mtimeMs}`)
    .join("\n");

  const evictionPaths = files.map((f) => f.path);
  if (realRoot !== pluginDir) {
    for (const f of files) {
      evictionPaths.push(pluginDir + f.path.slice(realRoot.length));
    }
  }

  return { fingerprint, evictionPaths };
}
