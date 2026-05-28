import { execFileSync } from "child_process";
import { existsSync, readFileSync, unlinkSync } from "fs";

import { httpHealthCheck, waitForDaemonReady } from "./http-client.js";

/**
 * Verify that a PID belongs to a vellum-related process by inspecting its
 * command line via `ps`. Prevents killing unrelated processes when a PID file
 * is stale and the OS has reused the PID.
 */
export function isVellumProcess(pid: number): boolean {
  try {
    const output = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return /vellum-daemon|vellum-cli|vellum-gateway|@vellumai|\/\.?vellum\/|\/daemon\/main|\/\.vellum\/.*qdrant\/bin\/qdrant/.test(
      output,
    );
  } catch {
    return false;
  }
}

/** Discriminated union: when `alive` is true, `pid` is guaranteed non-null. */
export type ProcessAliveResult =
  | { alive: true; pid: number }
  | { alive: false; pid: null };

/**
 * Check if a PID file's process is alive.
 */
export function isProcessAlive(pidFile: string): ProcessAliveResult {
  if (!existsSync(pidFile)) {
    return { alive: false, pid: null };
  }

  try {
    const pidStr = readFileSync(pidFile, "utf-8").trim();
    const pid = parseInt(pidStr, 10);
    if (isNaN(pid)) {
      return { alive: false, pid: null };
    }

    process.kill(pid, 0);
    return { alive: true, pid };
  } catch {
    return { alive: false, pid: null };
  }
}

/** Discriminated union: when `alive` is true, `pid` is guaranteed non-null. */
export type ProcessHealthResult =
  | { alive: true; healthy: boolean; pid: number }
  | { alive: false; healthy: false; pid: null };

/**
 * Check if a PID file's process is alive AND responding to HTTP health checks.
 *
 * Combines PID existence check with an HTTP `/healthz` probe. A process that
 * exists but does not respond (hung, deadlocked, at 100% CPU) returns
 * `alive: true, healthy: false` — callers should kill and restart it.
 */
export async function isProcessHealthy(
  pidFile: string,
  healthPort: number,
  timeoutMs: number = 3000,
): Promise<ProcessHealthResult> {
  const { alive, pid } = isProcessAlive(pidFile);
  if (!alive || pid === null) {
    return { alive: false, healthy: false, pid: null };
  }

  const healthy = await httpHealthCheck(healthPort, timeoutMs);
  return { alive: true, healthy, pid };
}

/**
 * Outcome of {@link resolveProcessState}. Callers switch on `status`:
 * - `"healthy"` — process is alive and responding; `pid` is the live PID.
 * - `"needs_start"` — process was dead, hung (and killed), or a stale PID
 *   was cleaned up. Caller should start a fresh process.
 */
export type ProcessState =
  | { status: "healthy"; pid: number }
  | { status: "needs_start"; pid: number | null };

/**
 * Determine whether a PID-tracked process is alive and healthy. If the
 * process exists but is unresponsive, waits up to `readinessWaitMs`
 * (default 60s — matches the spawner's own `waitForDaemonReady` timeout
 * so a concurrent caller never kills a daemon the spawner is still
 * waiting on) for it to finish initializing. If it remains unresponsive,
 * verifies it belongs to Vellum before killing it, then cleans up the
 * PID file.
 *
 * Encapsulates the full health → readiness-wait → guard → kill → cleanup
 * flow so callers don't need to reimplement it.
 */
export async function resolveProcessState(
  pidFile: string,
  healthPort: number,
  label: string,
  readinessWaitMs: number = 60_000,
): Promise<ProcessState> {
  const result = await isProcessHealthy(pidFile, healthPort);

  if (!result.alive) {
    return { status: "needs_start", pid: null };
  }

  if (result.healthy) {
    return { status: "healthy", pid: result.pid };
  }

  // Alive but not healthy — may still be starting up.
  const becameHealthy = await waitForDaemonReady(healthPort, readinessWaitMs);
  if (becameHealthy) {
    return { status: "healthy", pid: result.pid };
  }

  // Genuinely hung — kill if it belongs to Vellum, otherwise just clean up.
  if (isVellumProcess(result.pid)) {
    console.log(
      `${label} process alive (pid ${result.pid}) but not responding — killing and restarting...`,
    );
    await stopProcess(result.pid, label);
  } else {
    console.log(
      `Stale PID file (pid ${result.pid} is not a Vellum process) — cleaning up...`,
    );
  }
  removeFiles(pidFile);
  return { status: "needs_start", pid: result.pid };
}

/**
 * Stop a process by PID: SIGTERM, wait up to `timeoutMs`, then SIGKILL if still alive.
 * Returns true if the process was stopped, false if it wasn't alive.
 */
export async function stopProcess(
  pid: number,
  label: string,
  timeoutMs: number = 2000,
): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }

  console.log(`Stopping ${label} (pid ${pid})...`);
  process.kill(pid, "SIGTERM");

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((r) => setTimeout(r, 100));
    } catch {
      break;
    }
  }

  try {
    process.kill(pid, 0);
    console.log(`${label} did not exit after SIGTERM, sending SIGKILL...`);
    process.kill(pid, "SIGKILL");
  } catch {
    // Already dead
  }

  return true;
}

/** Remove one or more files, ignoring missing-file errors. */
function removeFiles(...files: (string | string[] | undefined)[]): void {
  for (const entry of files) {
    if (!entry) continue;
    for (const f of Array.isArray(entry) ? entry : [entry]) {
      try {
        unlinkSync(f);
      } catch {}
    }
  }
}

/**
 * Stop a process tracked by a PID file, then clean up the file.
 * Returns true if the process was stopped, false if it wasn't alive.
 */
export async function stopProcessByPidFile(
  pidFile: string,
  label: string,
  extraCleanupFiles?: string[],
  timeoutMs?: number,
): Promise<boolean> {
  const { alive, pid } = isProcessAlive(pidFile);

  if (!alive || pid === null) {
    removeFiles(pidFile, extraCleanupFiles);
    return false;
  }

  // Verify the PID actually belongs to a vellum process before killing.
  // If the PID file is stale and the OS reused the PID, skip the kill
  // and clean up the stale files instead.
  if (!isVellumProcess(pid)) {
    console.log(
      `PID ${pid} is not a vellum process — cleaning up stale ${label} PID file.`,
    );
    removeFiles(pidFile, extraCleanupFiles);
    return false;
  }

  const stopped = await stopProcess(pid, label, timeoutMs);
  removeFiles(pidFile, extraCleanupFiles);
  return stopped;
}

/**
 * Find and stop any vellum daemon processes that may not be tracked by a PID
 * file. Scans `ps` output for the `vellum-daemon` binary name.
 *
 * Returns true if at least one process was stopped.
 */
export async function stopOrphanedDaemonProcesses(): Promise<boolean> {
  let output: string;
  try {
    output = execFileSync("ps", ["-axww", "-o", "pid=,command="], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return false;
  }

  let stopped = false;
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const spaceIdx = trimmed.indexOf(" ");
    if (spaceIdx === -1) continue;
    const pid = parseInt(trimmed.slice(0, spaceIdx), 10);
    if (isNaN(pid) || pid === process.pid) continue;
    const cmd = trimmed.slice(spaceIdx + 1);

    if (cmd.includes("vellum-daemon")) {
      const result = await stopProcess(pid, "orphaned daemon");
      if (result) stopped = true;
    }
  }
  return stopped;
}
