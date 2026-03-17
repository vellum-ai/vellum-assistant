import { execFileSync } from "child_process";
import { existsSync, readFileSync, unlinkSync } from "fs";

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

/**
 * Check if a PID file's process is alive.
 */
export function isProcessAlive(pidFile: string): {
  alive: boolean;
  pid: number | null;
} {
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

/**
 * Stop a process tracked by a PID file, then clean up the file.
 * Returns true if the process was stopped, false if it wasn't alive.
 */
export async function stopProcessByPidFile(
  pidFile: string,
  label: string,
  cleanupFiles?: string[],
  timeoutMs?: number,
): Promise<boolean> {
  const { alive, pid } = isProcessAlive(pidFile);

  if (!alive || pid === null) {
    if (existsSync(pidFile)) {
      try {
        unlinkSync(pidFile);
      } catch {}
    }
    if (cleanupFiles) {
      for (const f of cleanupFiles) {
        try {
          unlinkSync(f);
        } catch {}
      }
    }
    return false;
  }

  // Verify the PID actually belongs to a vellum process before killing.
  // If the PID file is stale and the OS reused the PID, skip the kill
  // and clean up the stale files instead.
  if (!isVellumProcess(pid)) {
    console.log(
      `PID ${pid} is not a vellum process — cleaning up stale ${label} PID file.`,
    );
    try {
      unlinkSync(pidFile);
    } catch {}
    if (cleanupFiles) {
      for (const f of cleanupFiles) {
        try {
          unlinkSync(f);
        } catch {}
      }
    }
    return false;
  }

  const stopped = await stopProcess(pid, label, timeoutMs);

  try {
    unlinkSync(pidFile);
  } catch {}
  if (cleanupFiles) {
    for (const f of cleanupFiles) {
      try {
        unlinkSync(f);
      } catch {}
    }
  }

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
