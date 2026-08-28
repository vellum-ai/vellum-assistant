/**
 * Core path helpers for the gateway module.
 *
 * These live in their own file (rather than credential-reader.ts) so that
 * lightweight consumers like CLI scripts can resolve workspace / root paths
 * without pulling in the full credential-reader dependency tree.
 */

import { join } from "node:path";
import { homedir, userInfo } from "node:os";

import { assertTestPathIsEphemeral } from "@vellumai/environments/test-path-guard";

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

// In test processes both resolvers below must stay under os.tmpdir():
// gateway code exercised by a test would otherwise read and write live state
// (the gateway DB, the actor-token signing key, the backup key). The guard is
// shared with the assistant in @vellumai/environments/test-path-guard; the
// escape hatches are the same variables the DB-open guard in db/connection.ts
// honors.

const WORKSPACE_GUARD = {
  allowEnvVar: "VELLUM_ALLOW_REAL_WORKSPACE_IN_TESTS",
  runHint: "Run tests from the gateway package root.",
};

const SECURITY_GUARD = {
  allowEnvVar: "VELLUM_ALLOW_REAL_GATEWAY_SECURITY_IN_TESTS",
  runHint: "Run tests from the gateway package root.",
};

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
    assertTestPathIsEphemeral(override, WORKSPACE_GUARD);
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
  assertTestPathIsEphemeral(dir, WORKSPACE_GUARD);
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
    assertTestPathIsEphemeral(override, SECURITY_GUARD);
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
  assertTestPathIsEphemeral(dir, SECURITY_GUARD);
  return dir;
}
