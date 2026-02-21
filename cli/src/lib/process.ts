import { existsSync, readFileSync, unlinkSync } from "fs";

/**
 * Check if a PID file's process is alive.
 */
export function isProcessAlive(pidFile: string): { alive: boolean; pid: number | null } {
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
 * Stop a process by PID: SIGTERM, wait up to 2s, then SIGKILL if still alive.
 * Returns true if the process was stopped, false if it wasn't alive.
 */
export async function stopProcess(pid: number, label: string): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }

  console.log(`Stopping ${label} (pid ${pid})...`);
  process.kill(pid, "SIGTERM");

  const deadline = Date.now() + 2000;
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
): Promise<boolean> {
  const { alive, pid } = isProcessAlive(pidFile);

  if (!alive || pid === null) {
    if (existsSync(pidFile)) {
      try { unlinkSync(pidFile); } catch {}
    }
    if (cleanupFiles) {
      for (const f of cleanupFiles) {
        try { unlinkSync(f); } catch {}
      }
    }
    return false;
  }

  const stopped = await stopProcess(pid, label);

  try { unlinkSync(pidFile); } catch {}
  if (cleanupFiles) {
    for (const f of cleanupFiles) {
      try { unlinkSync(f); } catch {}
    }
  }

  return stopped;
}
