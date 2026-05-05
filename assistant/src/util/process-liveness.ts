/**
 * Cross-process liveness probe shared by file-locking helpers.
 *
 * Uses `kill(pid, 0)`, which sends no signal but probes the OS for whether a
 * process exists and whether the caller has permission to signal it. Returns
 * `false` for obviously invalid PIDs and for any error indicating the process
 * is gone (most commonly ESRCH). Returns `true` for ESRCH-negative results
 * (process exists) and for EPERM (process exists but is owned by another user
 * — still alive, still must not be taken over).
 */

import { kill } from "node:process";

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM means the PID exists but we cannot signal it — treat as alive so
    // we don't accidentally take over another user's lock.
    if (code === "EPERM") return true;
    return false;
  }
}
