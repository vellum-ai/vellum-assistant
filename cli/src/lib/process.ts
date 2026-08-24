import { execFileSync } from "child_process";
import { existsSync, readFileSync, unlinkSync } from "fs";
import { platform } from "os";

import {
  httpHealthCheck,
  type HttpProbeEndpoint,
  probeDaemonReadinessWithRetry,
  waitForDaemonReady,
} from "./http-client.js";

const VELLUM_COMMAND_PATTERN =
  /vellum-daemon|vellum-cli|vellum-gateway|credential-executor|@vellumai|[\\/]\.?vellum[\\/]|[\\/]daemon[\\/]main|[\\/]\.vellum[\\/].*qdrant[\\/]bin[\\/]qdrant/;

export const isVellumCommandLine = (command: string): boolean =>
  VELLUM_COMMAND_PATTERN.test(command);

/**
 * Verify that a PID belongs to a vellum-related process by inspecting its
 * command line via `ps`. Prevents killing unrelated processes when a PID file
 * is stale and the OS has reused the PID.
 */
export function executableName(
  name: string,
  hostPlatform: NodeJS.Platform = platform(),
): string {
  return hostPlatform === "win32" && !name.endsWith(".exe")
    ? `${name}.exe`
    : name;
}

export function pathListDelimiter(
  hostPlatform: NodeJS.Platform = platform(),
): string {
  return hostPlatform === "win32" ? ";" : ":";
}

export interface TasklistProcess {
  imageName: string;
  pid: number;
}

export function parseTasklistCsv(output: string): TasklistProcess[] {
  const processes: TasklistProcess[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^"([^"]+)","(\d+)"/);
    if (match) {
      processes.push({ imageName: match[1], pid: Number(match[2]) });
    }
  }
  return processes;
}

function readWindowsProcesses(pid?: number): TasklistProcess[] {
  const args = pid
    ? ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]
    : ["/FO", "CSV", "/NH"];
  const output = execFileSync("tasklist.exe", args, {
    windowsHide: true,
    encoding: "utf-8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return parseTasklistCsv(output);
}

export function windowsCommandLineLookupArgs(pid: number): string[] {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`Invalid process ID: ${pid}`);
  }
  return [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`,
  ];
}

function readWindowsCommandLine(pid: number): string {
  return execFileSync("powershell.exe", windowsCommandLineLookupArgs(pid), {
    windowsHide: true,
    encoding: "utf8",
    timeout: 3000,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

export function isVellumWindowsProcess(
  imageName: string,
  commandLine = "",
): boolean {
  if (/^qdrant\.exe$/i.test(imageName)) {
    return isVellumCommandLine(commandLine);
  }
  if (
    /^(?:vellum|vellum-cli|vellum-daemon|vellum-gateway|credential-executor)\.exe$/i.test(
      imageName,
    )
  ) {
    return true;
  }
  return /^bun\.exe$/i.test(imageName) && isVellumCommandLine(commandLine);
}

export function isVellumProcess(
  pid: number,
  hostPlatform: NodeJS.Platform = platform(),
): boolean {
  try {
    if (hostPlatform === "win32") {
      const imageName = readWindowsProcesses(pid)[0]?.imageName ?? "";
      const commandLine = /^(?:bun|qdrant)\.exe$/i.test(imageName)
        ? readWindowsCommandLine(pid)
        : "";
      return isVellumWindowsProcess(imageName, commandLine);
    }
    const output = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return isVellumCommandLine(output);
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
 * - `"healthy"` — process is alive and ready; `pid` is the live PID.
 * - `"unready"` — process is alive and healthy, but DB migrations were still
 *   running when the readiness wait elapsed.
 * - `"migration_failed"` — process is alive and healthy, but its DB migrations
 *   failed: a terminal state that never recovers without a restart. The
 *   process is kept alive (same keep-alive rule as `"unready"`).
 * - `"stuck"`: process is unresponsive and could not be terminated.
 * - `"needs_start"` — process was dead, hung (and killed), or a stale PID
 *   was cleaned up. Caller should start a fresh process.
 */
export type ProcessState =
  | { status: "healthy"; pid: number }
  | { status: "unready"; pid: number }
  | { status: "migration_failed"; pid: number }
  | { status: "stuck"; pid: number }
  | { status: "needs_start"; pid: number | null };

/**
 * Determine whether a PID-tracked process is alive and healthy. If the process
 * exists but is unresponsive, waits up to `readinessWaitMs` (default 60s —
 * matches the spawner's own `waitForDaemonReady` timeout so a concurrent
 * caller never kills a process the spawner is still waiting on) for it to
 * start answering health checks. If it remains unresponsive, verifies it
 * belongs to Vellum before killing it, then cleans up the PID file.
 *
 * When callers pass the `"readyz"` readiness endpoint, this also CLASSIFIES
 * DB migration readiness with a single `/readyz` probe (read from the body —
 * the status code stays 200 during migrations for k8s). It never waits for
 * readiness: the kill/keep decision depends only on the health check, and
 * callers that want to wait out a migration own that wait themselves. A
 * health-checking process is kept alive when migrations are running or
 * failed.
 */
export async function resolveProcessState(
  pidFile: string,
  healthPort: number,
  label: string,
  readinessWaitMs: number = 60_000,
  readinessEndpoint: HttpProbeEndpoint = "healthz",
): Promise<ProcessState> {
  const result = await isProcessHealthy(pidFile, healthPort);

  if (!result.alive) {
    return { status: "needs_start", pid: null };
  }

  if (!result.healthy) {
    // Alive but not healthy — may still be starting up.
    const becameHealthy = await waitForDaemonReady(
      healthPort,
      readinessWaitMs,
      "healthz",
    );
    if (!becameHealthy) {
      // Genuinely hung — kill if it belongs to Vellum, otherwise just clean up.
      if (isVellumProcess(result.pid)) {
        console.log(
          `${label} process alive (pid ${result.pid}) but not responding — killing and restarting...`,
        );
        const stopped = await stopProcess(result.pid, label);
        if (!stopped && isProcessAlive(pidFile).alive) {
          return { status: "stuck", pid: result.pid };
        }
      } else {
        console.log(
          `Stale PID file (pid ${result.pid} is not a Vellum process) — cleaning up...`,
        );
      }
      removeFiles(pidFile);
      return { status: "needs_start", pid: result.pid };
    }
  }

  if (readinessEndpoint !== "healthz") {
    const readiness = await probeDaemonReadinessWithRetry(healthPort);
    if (readiness === "failed") {
      return { status: "migration_failed", pid: result.pid };
    }
    if (readiness === "unreachable") {
      // The daemon answered the health check moments ago but not /readyz —
      // it may have died in between (e.g. OOM during a heavy migration).
      // Re-verify liveness before reporting it alive, so callers don't skip
      // starting a replacement for a dead process.
      if (!isProcessAlive(pidFile).alive) {
        removeFiles(pidFile);
        return { status: "needs_start", pid: result.pid };
      }
      return { status: "unready", pid: result.pid };
    }
    if (readiness !== "ready") {
      return { status: "unready", pid: result.pid };
    }
  }

  return { status: "healthy", pid: result.pid };
}

/**
 * Stop a process by PID: SIGTERM, wait up to `timeoutMs`, then SIGKILL if still alive.
 * Returns true if the process was stopped, false if it wasn't alive or
 * termination failed.
 */
export async function stopProcess(
  pid: number,
  label: string,
  timeoutMs: number = 2000,
  hostPlatform: NodeJS.Platform = platform(),
  runTaskkill: (args: string[], timeout: number) => void = (args, timeout) => {
    execFileSync("taskkill.exe", args, {
      windowsHide: true,
      timeout,
      stdio: "ignore",
    });
  },
): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }

  console.log(`Stopping ${label} (pid ${pid})...`);
  let waitForGracefulExit = true;
  if (hostPlatform === "win32") {
    try {
      runTaskkill(["/PID", String(pid), "/T"], timeoutMs);
    } catch {
      waitForGracefulExit = false;
    }
  } else {
    process.kill(pid, "SIGTERM");
  }

  const deadline = Date.now() + timeoutMs;
  while (waitForGracefulExit && Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((r) => setTimeout(r, 100));
    } catch {
      break;
    }
  }

  try {
    process.kill(pid, 0);
  } catch {
    return true;
  }
  if (hostPlatform === "win32") {
    console.log(`${label} did not exit, terminating its process tree...`);
    try {
      runTaskkill(["/PID", String(pid), "/T", "/F"], timeoutMs);
    } catch {
      return false;
    }
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }
  console.log(`${label} did not exit after SIGTERM, sending SIGKILL...`);
  try {
    process.kill(pid, "SIGKILL");
    return true;
  } catch (error) {
    return (
      error instanceof Error &&
      (error as NodeJS.ErrnoException).code === "ESRCH"
    );
  }
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
  stop: (
    pid: number,
    label: string,
    timeoutMs?: number,
  ) => Promise<boolean> = stopProcess,
  ownsProcess: (pid: number) => boolean = isVellumProcess,
): Promise<boolean> {
  const { alive, pid } = isProcessAlive(pidFile);

  if (!alive || pid === null) {
    removeFiles(pidFile, extraCleanupFiles);
    return false;
  }

  // Verify the PID actually belongs to a vellum process before killing.
  // If the PID file is stale and the OS reused the PID, skip the kill
  // and clean up the stale files instead.
  if (!ownsProcess(pid)) {
    console.log(
      `PID ${pid} is not a vellum process — cleaning up stale ${label} PID file.`,
    );
    removeFiles(pidFile, extraCleanupFiles);
    return false;
  }

  const stopped = await stop(pid, label, timeoutMs);
  if (stopped || !isProcessAlive(pidFile).alive) {
    removeFiles(pidFile, extraCleanupFiles);
  }
  return stopped;
}

/**
 * Find and stop any vellum daemon processes that may not be tracked by a PID
 * file. Scans `ps` output for the `vellum-daemon` binary name.
 *
 * Returns true if at least one process was stopped.
 */
export async function stopOrphanedDaemonProcesses(
  excludePids: ReadonlySet<string> = new Set(),
  hostPlatform: NodeJS.Platform = platform(),
): Promise<boolean> {
  if (hostPlatform === "win32") {
    try {
      const results = await Promise.all(
        readWindowsProcesses()
          .filter(
            ({ imageName, pid }) =>
              pid !== process.pid &&
              !excludePids.has(String(pid)) &&
              (/^vellum-daemon\.exe$/i.test(imageName) ||
                (/^bun\.exe$/i.test(imageName) &&
                  /vellum-daemon|[\\/]assistant[\\/]src[\\/](?:index|daemon[\\/]main)\.ts/i.test(
                    readWindowsCommandLine(pid),
                  ))),
          )
          .map(({ pid }) =>
            stopProcess(pid, "orphaned assistant", 2000, hostPlatform),
          ),
      );
      return results.some(Boolean);
    } catch {
      return false;
    }
  }
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
    if (isNaN(pid) || pid === process.pid || excludePids.has(String(pid))) {
      continue;
    }
    const cmd = trimmed.slice(spaceIdx + 1);

    if (cmd.includes("vellum-daemon")) {
      const result = await stopProcess(pid, "orphaned daemon");
      if (result) stopped = true;
    }
  }
  return stopped;
}
