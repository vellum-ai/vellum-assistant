/**
 * Shared plugin-tree walking rules.
 *
 * Two subsystems walk installed plugin trees and must agree on what "the
 * plugin's tree" means: install-time content fingerprinting
 * (`../cli/lib/plugin-fingerprint.ts`, drift detection against the pinned
 * commit) and the live-reload source fingerprint
 * (`./source-fingerprint.ts`, change detection for redeploys). This module
 * owns the walk and the excluded-entry constants so the two can't drift.
 *
 * Symlinks are never followed, at any depth: install never materializes
 * them, and following a symlinked directory would let a link like
 * `hooks/loop -> ..` cycle the walk or escape the plugin root entirely. A
 * plugin whose *root* is a symlink is supported by callers resolving the
 * root (`realpathSync`) before walking.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Top-level entries that are preserved across upgrades and excluded from
 * fingerprinting / drift detection / content hashing. These are runtime-owned
 * state, not part of the plugin's source tree at the pinned commit:
 *
 * - `install-meta.json` — provenance sidecar written at install time.
 * - `config.json` — user-editable plugin config (lives in the plugin dir but
 *   is not tracked as source content, so user edits don't count as drift).
 * - `data` — runtime data directory (plugin writes whatever it wants here).
 * - `.disabled` — sentinel file created by `assistant plugins disable`.
 *
 * Without these exclusions, a user editing `config.json` or the plugin writing
 * to `data/` would surface as drift against the install-time baseline, and an
 * upgrade would try to overwrite or merge around user-owned state.
 */
export const PRESERVED_ENTRIES = [
  "install-meta.json",
  "config.json",
  "data",
  ".disabled",
] as const;

/**
 * A generated app build directory: `apps/<app>/dist`. This is compiled output
 * (the plugin source watcher builds each multi-file app's `src/` into its
 * sibling `dist/`), never tracked source, so every fingerprint walk excludes
 * it:
 *
 * - the **live-reload** change detector (`./source-fingerprint.ts`), so the
 *   watcher's own compile does not read as a source change and re-trigger
 *   itself in a loop, and
 * - the **install/drift** fingerprint (`../cli/lib/plugin-fingerprint.ts`), so
 *   generated output is not reported as drift/added against the pinned commit.
 *
 * Scoped to `apps/<app>/dist` specifically — a plugin's own top-level `dist/`
 * (if it ships built code its hooks import) is still tracked.
 */
export function isGeneratedAppBuildDir(relDir: string): boolean {
  const parts = relDir.split("/");
  return parts.length === 3 && parts[0] === "apps" && parts[2] === "dist";
}

/** Options controlling which entries a {@link walkPluginTree} visits. */
export interface PluginTreeWalkOptions {
  /** Top-level entry names to skip (e.g. {@link PRESERVED_ENTRIES}). */
  readonly excludeRootEntries?: Iterable<string>;
  /** Directory names skipped at any depth (e.g. `node_modules`). */
  readonly excludeDirsAnywhere?: ReadonlySet<string>;
  /**
   * Skip a directory (and its whole subtree) by its POSIX path relative to the
   * walk root. Called for each directory before descending — use for
   * path-scoped exclusions a bare directory name can't express (e.g. generated
   * `apps/<app>/dist`, via {@link isGeneratedAppBuildDir}).
   */
  readonly excludeDir?: (relDir: string) => boolean;
  /** Skip entries whose name starts with `.`, at any depth. */
  readonly excludeDotEntries?: boolean;
  /**
   * Skip directories that fail to read instead of throwing. Change
   * detection wants this (a tree being mutated mid-walk is retried on the
   * next pass); install fingerprinting does not (a vanished tree is an
   * error the caller must see).
   */
  readonly bestEffort?: boolean;
}

/**
 * Visit every regular file under `root`, depth-first in `readdir` order.
 * `rel` is the POSIX-style (forward-slash) path relative to `root`; `abs`
 * is the absolute path. Symlinked entries are never visited or followed.
 */
export function walkPluginTree(
  root: string,
  options: PluginTreeWalkOptions,
  visit: (rel: string, abs: string) => void,
): void {
  const excludedRoot = new Set(options.excludeRootEntries ?? []);

  const walk = (relDir: string): void => {
    const absDir = relDir ? join(root, relDir) : root;
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch (err) {
      if (options.bestEffort === true) {
        return;
      }
      throw err;
    }
    for (const entry of entries) {
      const name = entry.name;
      if (relDir === "" && excludedRoot.has(name)) {
        continue;
      }
      if (options.excludeDotEntries === true && name.startsWith(".")) {
        continue;
      }
      if (entry.isSymbolicLink()) {
        continue;
      }
      const rel = relDir ? `${relDir}/${name}` : name;
      if (entry.isDirectory()) {
        if (options.excludeDirsAnywhere?.has(name) === true) {
          continue;
        }
        if (options.excludeDir?.(rel) === true) {
          continue;
        }
        walk(rel);
      } else if (entry.isFile()) {
        visit(rel, join(absDir, name));
      }
    }
  };

  walk("");
}
