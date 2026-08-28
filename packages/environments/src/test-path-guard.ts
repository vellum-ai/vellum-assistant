/**
 * Live-path guard for test processes, shared by every service that resolves
 * install-layout paths (the assistant daemon's workspace/root, the gateway's
 * workspace and security dirs).
 *
 * A test process must never resolve one of those paths to a real, non-temp
 * directory: production code exercised by a test would then read and
 * destructively write live state. The tmpdir redirection normally comes from
 * each package's bunfig.toml test preload, but bun only loads bunfig from
 * the cwd, so `bun test` run from any other directory skips the preload and
 * inherits the ambient env (or a ~/.vellum fallback). The containment
 * assertion therefore lives in production code, where it fires no matter how
 * the test process was launched.
 *
 * assistant/src/__tests__/assert-not-live-db.ts keeps its own containment
 * check: test machinery must not import production dependencies.
 */

import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, resolve, sep } from "node:path";

/**
 * Resolve symlinks in the deepest existing ancestor of `path`, then
 * re-append the not-yet-created tail. This keeps containment checks honest
 * both for paths under a symlinked temp root (macOS /var/folders) and for
 * symlinks that point outside it, whether or not the leaf exists yet.
 */
export function canonicalizePathThroughExistingParent(path: string): string {
  const resolvedPath = resolve(path);
  const pendingSegments: string[] = [];
  let currentPath = resolvedPath;

  while (true) {
    try {
      return resolve(realpathSync(currentPath), ...pendingSegments.reverse());
    } catch {
      const parentPath = dirname(currentPath);
      if (parentPath === currentPath) {
        return resolvedPath;
      }
      pendingSegments.push(basename(currentPath));
      currentPath = parentPath;
    }
  }
}

/** Lazily computed: is this process a `bun test` run? */
let isTestProcess: boolean | undefined;

/**
 * True when this process is a `bun test` run. Computed once and cached for
 * the process lifetime, so a runtime flip of NODE_ENV or BUN_TEST does not
 * change the answer. Test-mode behavior toggles that must observe such
 * flips read the env directly instead of calling this.
 */
export function isBunTestProcess(): boolean {
  isTestProcess ??=
    process.env.NODE_ENV === "test" ||
    process.env.BUN_TEST === "1" ||
    // `bun test` sets NODE_ENV=test only when unset; Bun.main being the test
    // file itself is the backstop signal that survives a preset NODE_ENV.
    (typeof Bun !== "undefined" &&
      /\.(test|spec)\.[cm]?[jt]sx?$/.test(Bun.main));
  return isTestProcess;
}

export interface EphemeralTestPathOptions {
  /**
   * Escape hatch for the rare intentional run against real state: setting
   * this env var to "1" bypasses the guard. Callers reuse the variable their
   * DB-open guard already honors. Deliberately not forwarded into
   * agent-spawned shells (assistant/src/tools/terminal/safe-env.ts), so a
   * daemon-level opt-out cannot disarm the guard for tests run from there.
   */
  allowEnvVar: string;
  /** Package-specific line telling the reader where to run tests from. */
  runHint: string;
}

/**
 * Throws when called in a bun-test process and `dir` does not resolve under
 * `os.tmpdir()`. Inert outside test processes. Canonicalizes on every call
 * (no memo): a previously validated path could later be replaced by a
 * symlink, and the guard only runs in test processes anyway.
 */
export function assertTestPathIsEphemeral(
  dir: string,
  options: EphemeralTestPathOptions,
): void {
  if (!isBunTestProcess()) {
    return;
  }
  if (process.env[options.allowEnvVar] === "1") {
    return;
  }
  const tmpRoot = canonicalizePathThroughExistingParent(tmpdir());
  const resolved = canonicalizePathThroughExistingParent(dir);
  if (resolved !== tmpRoot && !resolved.startsWith(tmpRoot + sep)) {
    throw new Error(
      [
        `Refusing to use ${dir} (resolves to ${resolved}) in a test process: it is not under the temp directory (${tmpRoot}).`,
        "",
        "Tests must only touch ephemeral state; a real directory would expose",
        "live install state to destructive test fixtures. This usually means",
        "`bun test` ran from a cwd without the package's bunfig.toml, so the",
        "test preload that redirects paths to a tmpdir never loaded.",
        options.runHint,
        `Set ${options.allowEnvVar}=1 to bypass deliberately.`,
      ].join("\n"),
    );
  }
}
