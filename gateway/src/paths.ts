/**
 * Core path helpers for the gateway module.
 *
 * These live in their own file (rather than credential-reader.ts) so that
 * lightweight consumers like CLI scripts can resolve workspace / root paths
 * without pulling in the full credential-reader dependency tree.
 */

import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { homedir, tmpdir, userInfo } from "node:os";

function safeUserInfoHomedir(): string {
  try {
    return userInfo().homedir;
  } catch {
    return "";
  }
}

/**
 * @deprecated Only used as a fallback when VELLUM_WORKSPACE_DIR /
 * GATEWAY_SECURITY_DIR are not set. Logs a warning so we can identify
 * hatch entrypoints that still rely on the old path.
 *
 * Home fallback chain: `$HOME` → `userInfo().homedir` → `homedir()`.
 * `homedir()` alone is insufficient because libuv's `uv_os_homedir` returns
 * `$HOME` as-is when set (even to `""`) and only consults `getpwuid_r` when
 * `HOME` is unset entirely. `userInfo()` calls `getpwuid_r` directly, so it
 * returns the passwd-table home regardless of `HOME`. The `userInfo()` call
 * is guarded via `safeUserInfoHomedir()` because it throws `SystemError`
 * when the current UID has no passwd entry (common in containers run with
 * `--user <uid>` without a matching `/etc/passwd` line); catching keeps the
 * `homedir()` fallback reachable.
 */
export function getLegacyRootDir(): string {
  return join(
    process.env.HOME || safeUserInfoHomedir() || homedir(),
    ".vellum",
  );
}

let warnedWorkspaceDir = false;
let warnedSecurityDir = false;

// --- Live-path guard for test processes ------------------------------------
//
// A test process must never resolve the workspace or the gateway security
// directory to a real, non-temp path: gateway code exercised by a test would
// then read and write live state (the gateway DB, the actor-token signing
// key, the backup key). The tmpdir redirection normally comes from the
// bunfig.toml test preload, but bun only loads bunfig from the cwd, so
// `bun test` run from any other directory skips the preload and inherits the
// ambient env (or the ~/.vellum fallback). The containment assertion
// therefore lives here, in production code, where it fires no matter how the
// test process was launched.
//
// Detection and containment mirror assistant/src/util/platform.ts, which
// cannot be imported here (cross-package boundary).

/** Lazily computed: is this process a `bun test` run? */
let isTestProcess: boolean | undefined;

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

function assertTestPathIsEphemeral(dir: string, allowEnvVar: string): void {
  isTestProcess ??=
    process.env.NODE_ENV === "test" ||
    process.env.BUN_TEST === "1" ||
    // `bun test` sets NODE_ENV=test only when unset; Bun.main being the test
    // file itself is the backstop signal that survives a preset NODE_ENV.
    (typeof Bun !== "undefined" &&
      /\.(test|spec)\.[cm]?[jt]sx?$/.test(Bun.main));
  if (!isTestProcess) {
    return;
  }
  // Escape hatch for the rare intentional run against real state, shared
  // with the DB-open guard in db/connection.ts. Deliberately not forwarded
  // into agent-spawned shells (assistant/src/tools/terminal/safe-env.ts), so
  // a daemon-level opt-out cannot disarm the guard for tests run from there.
  if (process.env[allowEnvVar] === "1") {
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
        "live gateway state (DB, signing keys) to test fixtures. This usually",
        "means `bun test` ran from a cwd without the gateway bunfig.toml, so",
        "the test preload that redirects paths to a tmpdir never loaded.",
        "Run tests from the gateway package root, or set",
        `${allowEnvVar}=1 to bypass deliberately.`,
      ].join("\n"),
    );
  }
}

/**
 * Returns the workspace root for user-facing state.
 *
 * When VELLUM_WORKSPACE_DIR is set, returns that value (used in containerized
 * deployments where the workspace is a separate volume). Otherwise falls back
 * to ~/.vellum/workspace via getLegacyRootDir() and logs a warning (once).
 */
export function getWorkspaceDir(): string {
  const override = process.env.VELLUM_WORKSPACE_DIR?.trim();
  if (override) {
    assertTestPathIsEphemeral(override, "VELLUM_ALLOW_REAL_WORKSPACE_IN_TESTS");
    return override;
  }
  if (!warnedWorkspaceDir) {
    warnedWorkspaceDir = true;
    console.warn(
      "[gateway/paths] VELLUM_WORKSPACE_DIR is not set — falling back to getLegacyRootDir(). " +
        "Set VELLUM_WORKSPACE_DIR explicitly in the entrypoint.",
    );
  }
  const dir = join(getLegacyRootDir(), "workspace");
  assertTestPathIsEphemeral(dir, "VELLUM_ALLOW_REAL_WORKSPACE_IN_TESTS");
  return dir;
}

/**
 * Directory containing files private to the gateway container.
 *
 * In Docker, this is a dedicated volume mounted at /gateway-security via the
 * GATEWAY_SECURITY_DIR env var. In local (non-Docker) mode, falls back to
 * ~/.vellum/protected/ via getLegacyRootDir() and logs a warning (once).
 */
export function getGatewaySecurityDir(): string {
  const override = process.env.GATEWAY_SECURITY_DIR?.trim();
  if (override) {
    assertTestPathIsEphemeral(
      override,
      "VELLUM_ALLOW_REAL_GATEWAY_SECURITY_IN_TESTS",
    );
    return override;
  }
  if (!warnedSecurityDir) {
    warnedSecurityDir = true;
    console.warn(
      "[gateway/paths] GATEWAY_SECURITY_DIR is not set — falling back to getLegacyRootDir(). " +
        "Set GATEWAY_SECURITY_DIR explicitly in the entrypoint.",
    );
  }
  const dir = join(getLegacyRootDir(), "protected");
  assertTestPathIsEphemeral(dir, "VELLUM_ALLOW_REAL_GATEWAY_SECURITY_IN_TESTS");
  return dir;
}
