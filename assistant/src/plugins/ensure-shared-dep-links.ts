/**
 * Symlinks whitelisted shared dependencies from the assistant's own
 * `node_modules/` into `<workspace>/node_modules/` so user plugins can
 * resolve bare imports like:
 *
 *     import { z } from "zod";
 *
 * The plugin installer never runs `bun install`, so an installed plugin's
 * runtime dependencies are unresolvable — bare imports resolve Node-style
 * walking up from the plugin directory, and the assistant's own copies are
 * not on that path. This module bridges that gap by linking the real
 * package directories, not re-export shims: a plugin gets the actual zod
 * the assistant uses, subpaths and internal resolution included.
 *
 * ## Why symlinks (not generated re-export shims)
 *
 * Re-export shims re-bind each export from `globalThis`, which works for
 * the `@vellumai/plugin-api` surface (a small set of identifiers the
 * assistant controls) but is fragile for real npm packages: zod ships 238
 * exports including reserved words (`enum`, `function`, `instanceof`,
 * `void`, `default`) that need alias-form codegen, and any export added in
 * a zod update silently breaks until the shim is regenerated. A symlink to
 * the real package has none of these problems — it IS the package.
 *
 * ## Existing real installs are respected
 *
 * If `<workspace>/node_modules/<name>` already exists (a real package, a
 * prior symlink, or anything else), it is left untouched. We never clobber
 * user-managed files from daemon boot.
 *
 * ## Compiled-binary edge case
 *
 * `bun --compile` inlines the assistant's code graph into the binary; the
 * `node_modules/` directory may not exist on disk. When a package can't be
 * resolved to a real directory, it is skipped with a log line — plugins
 * importing it will fail individually with a clear module-not-found error.
 *
 * Called from `loadUserPlugins` alongside `ensurePluginApiShim`, before any
 * user plugin is dynamic-imported. Never throws — failures are logged
 * per-dep and the daemon must never block startup.
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdir,symlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { SHARED_DEPS } from "../embedded/shared-deps.js";
import { getLogger } from "../util/logger.js";
import { getWorkspaceDir } from "../util/platform.js";

const log = getLogger("shared-dep-links");

/**
 * Resolve a package to its on-disk directory by walking up from the entry
 * file to the nearest `package.json` with a matching `name` field. Returns
 * `null` when the package can't be resolved or isn't on disk (e.g. inside a
 * `bun --compile` binary).
 */
function resolvePackageDir(name: string): string | null {
  let entryPath: string;
  try {
    entryPath = require.resolve(name);
  } catch {
    return null;
  }

  let dir = dirname(entryPath);
  for (let depth = 0; depth < 8; depth++) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(
          readFileSync(pkgPath, "utf8"),
        ) as { name?: string };
        if (pkg.name === name) {return dir;}
      } catch {
        // corrupt package.json — keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {break;} // reached filesystem root
    dir = parent;
  }
  return null;
}

/**
 * Symlink every whitelisted shared dep into `<workspace>/node_modules/`.
 * Idempotent; per-dep failures are logged and do not abort the remaining
 * deps. Never throws.
 */
export async function ensureSharedDepLinks(opts?: {
  /** Override the workspace root. Defaults to `getWorkspaceDir()`. */
  workspaceDir?: string;
}): Promise<void> {
  const workspaceDir = opts?.workspaceDir ?? getWorkspaceDir();
  const nodeModulesDir = join(workspaceDir, "node_modules");

  for (const name of SHARED_DEPS) {
    try {
      const sourceDir = resolvePackageDir(name);
      if (!sourceDir) {
        log.warn(
          { dep: name },
          "shared-dep link skipped — package not resolvable on disk (compiled binary?)",
        );
        continue;
      }

      const linkPath = join(nodeModulesDir, ...name.split("/"));

      // Don't clobber anything already there — a real install, a prior
      // symlink, or even a stale link all qualify. The user can clear it
      // manually if they want a refresh.
      if (existsSync(linkPath)) {
        log.debug(
          { dep: name, linkPath },
          "shared-dep link skipped — already exists in workspace node_modules",
        );
        continue;
      }

      await mkdir(dirname(linkPath), { recursive: true });
      await symlink(sourceDir, linkPath, "dir");

      log.info(
        { dep: name, source: sourceDir, link: linkPath },
        "shared-dep symlinked into workspace node_modules",
      );
    } catch (err) {
      log.warn(
        { err, dep: name },
        "shared-dep link failed — plugins importing it will fail individually",
      );
    }
  }
}
