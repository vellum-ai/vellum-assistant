/**
 * Filesystem convention for per-subprocess runtime artifacts.
 *
 * Long-lived subprocesses the daemon manages (the route host, and future
 * peers) keep their runtime bookkeeping — IPC socket, PID file, and any other
 * per-process scratch — under a single well-known root:
 *
 *   $VELLUM_WORKSPACE_DIR/procs/<name>/
 *     <name>.sock   — the Unix domain socket the subprocess binds
 *     <name>.pid    — the PID file (readiness signal + liveness handle)
 *
 * This replaces the ad-hoc sprinkling of `.pid` / `.sock` files across the
 * workspace: everything a subprocess owns lives in one directory named for it,
 * so `ls $VELLUM_WORKSPACE_DIR/procs` is a census of managed subprocesses and
 * cleanup is a single `rm -rf` of the subdir.
 *
 * NOTE (sun_path limit): Unix socket paths are capped by the OS (~104 bytes on
 * macOS, ~108 on Linux). Keeping the socket basename short (`<name>.sock`)
 * leaves headroom, but a pathologically deep `$VELLUM_WORKSPACE_DIR` could
 * still overflow — {@link getProcSocketPath} is where a future short-path
 * fallback (e.g. hashing into `$TMPDIR`) would hook in if that ever bites.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { getWorkspaceDir } from "../util/platform.js";

/** Root holding every managed subprocess's runtime directory. */
export function getProcsDir(): string {
  return join(getWorkspaceDir(), "procs");
}

/** The runtime directory for one subprocess: `$WORKSPACE/procs/<name>/`. */
export function getProcDir(name: string): string {
  return join(getProcsDir(), name);
}

/** Create (if needed) and return the subprocess's runtime directory. */
export function ensureProcDir(name: string): string {
  const dir = getProcDir(name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Unix domain socket path the subprocess binds and the daemon connects to. */
export function getProcSocketPath(name: string): string {
  return join(getProcDir(name), `${name}.sock`);
}

/** PID file the subprocess writes on readiness (and that liveness probes read). */
export function getProcPidPath(name: string): string {
  return join(getProcDir(name), `${name}.pid`);
}
