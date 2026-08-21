/**
 * Shared plugin-tree walking rules.
 *
 * Two subsystems walk installed plugin trees and must agree on what "the
 * plugin's tree" means: install-time content fingerprinting
 * (`../cli/lib/plugin-fingerprint.ts`, drift detection against the pinned
 * commit) and the live-reload source fingerprint
 * (`./source-fingerprint.ts`, change detection for redeploys). This module
 * owns the walk and its excluded-entry rules so the two can't drift.
 *
 * Symlinks are never followed, at any depth: install never materializes
 * them, and following a symlinked directory would let a link like
 * `hooks/loop -> ..` cycle the walk or escape the plugin root entirely. A
 * plugin whose *root* is a symlink is supported by callers resolving the
 * root (`realpathSync`) before walking.
 */

import {
  copyFileSync,
  cpSync,
  existsSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Top-level runtime-owned entries that belong to the live install, not the
 * plugin's source tree. An upgrade must never take these from the incoming
 * pin: `config.json` is user-edited, `data/` is whatever the plugin wrote at
 * runtime, and `.disabled` is created by `assistant plugins disable`.
 *
 * The provenance sidecar is not in this list. Install rewrites `install-meta.json`
 * at the swap boundary; carrying the outgoing copy forward would pin the
 * upgrade to the previous commit.
 */
export const USER_STATE_ENTRIES = ["config.json", "data", ".disabled"] as const;

const USER_STATE_NAME_SET: ReadonlySet<string> = new Set(USER_STATE_ENTRIES);

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
  ...USER_STATE_ENTRIES,
] as const;

/** True when `name` is a top-level user-state entry (`config.json`, `data`, `.disabled`). */
export function isPluginUserStateEntry(name: string): boolean {
  return USER_STATE_NAME_SET.has(name);
}

/**
 * Remove user-state entries from `dir` so a pin-shipped `config.json` or
 * `data/` cannot ride the swap. No-op when those paths are already absent.
 */
export function stripPreservedUserState(dir: string): void {
  for (const entry of USER_STATE_ENTRIES) {
    rmSync(join(dir, entry), { recursive: true, force: true });
  }
}

/**
 * Copy live user-state (`config.json`, `data/`, `.disabled`) from `fromDir`
 * into `toDir`, replacing any copy already at the destination so the live
 * bytes win whole-file / whole-tree.
 */
export function copyPreservedUserState(fromDir: string, toDir: string): void {
  if (!existsSync(fromDir)) {
    return;
  }
  for (const entry of USER_STATE_ENTRIES) {
    const src = join(fromDir, entry);
    if (!existsSync(src)) {
      continue;
    }
    const dest = join(toDir, entry);
    rmSync(dest, { recursive: true, force: true });
    const stat = statSync(src);
    if (stat.isDirectory()) {
      cpSync(src, dest, { recursive: true });
    } else {
      copyFileSync(src, dest);
    }
  }
}

/**
 * Directory names {@link walkPluginTree} skips at any depth, unconditionally.
 * `node_modules` holds a plugin's installed dependencies — derived from the
 * pinned `package.json` and re-installed on every (re)install and upgrade (see
 * `../cli/lib/install-plugin-dependencies.ts`), never tracked source. Excluding
 * it keeps installed dependencies out of the install fingerprint / content hash
 * (`../cli/lib/plugin-fingerprint.ts`) and the live-reload source fingerprint
 * (`./source-fingerprint.ts`), so a re-materialized baseline — which has no
 * `node_modules/` — still matches what install recorded. It is baked into the
 * walk rather than opted into per call because no plugin-tree walk ever wants
 * to descend it.
 */
const ALWAYS_EXCLUDED_DIRS: ReadonlySet<string> = new Set(["node_modules"]);

/**
 * Generated app build output: `apps/<app>/dist`. This is compiled output (the
 * plugin source watcher builds each multi-file app's `src/` into its sibling
 * `dist/`), never tracked source, so — like {@link PRESERVED_ENTRIES} — every
 * fingerprint walk excludes it:
 *
 * - the **live-reload** change detector (`./source-fingerprint.ts`), so the
 *   watcher's own compile does not read as a source change and re-trigger
 *   itself in a loop, and
 * - the **install/drift** fingerprint (`../cli/lib/plugin-fingerprint.ts`), so
 *   generated output is not reported as drift/added against the pinned commit.
 *
 * A path pattern rather than a bare name so it stays scoped to `apps/<app>/dist`
 * — a plugin's own top-level `dist/` (if it ships built code its hooks import)
 * is still tracked. Matched against the POSIX path relative to the plugin root.
 */
export const GENERATED_APP_BUILD_DIR = /^apps\/[^/]+\/dist$/;

/** Options controlling which entries a {@link walkPluginTree} visits. */
export interface PluginTreeWalkOptions {
  /**
   * Entries to exclude. A `string` matches a top-level entry by name (e.g.
   * {@link PRESERVED_ENTRIES}); a `RegExp` matches any entry — at any depth —
   * by its POSIX path relative to the walk root, and when it matches a
   * directory the whole subtree is skipped (e.g. {@link
   * GENERATED_APP_BUILD_DIR}).
   */
  readonly excludeRootEntries?: Iterable<string | RegExp>;
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
  // Split the exclusion list: bare strings match a top-level entry name;
  // RegExps match an entry's relative path at any depth.
  const excludedRootNames = new Set<string>();
  const excludePatterns: RegExp[] = [];
  for (const entry of options.excludeRootEntries ?? []) {
    if (typeof entry === "string") {
      excludedRootNames.add(entry);
    } else {
      excludePatterns.push(entry);
    }
  }

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
      if (relDir === "" && excludedRootNames.has(name)) {
        continue;
      }
      if (options.excludeDotEntries === true && name.startsWith(".")) {
        continue;
      }
      if (entry.isSymbolicLink()) {
        continue;
      }
      const rel = relDir ? `${relDir}/${name}` : name;
      if (excludePatterns.some((pattern) => pattern.test(rel))) {
        continue;
      }
      if (entry.isDirectory()) {
        if (ALWAYS_EXCLUDED_DIRS.has(name)) {
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
