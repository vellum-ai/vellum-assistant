import { spawn } from "node:child_process";

export {
  buildShellInvocation,
  buildShellSpawnFlags,
  pathListDelimiter,
  prependUniquePathEntries,
} from "@vellumai/environments/shell";

export interface ShellProcessStartWatch {
  didStart(): boolean;
}

/**
 * Record whether a spawned child actually started. A `close` with exit 0 and
 * empty stdio is not proof of execution: Windows can emit that when the
 * process was never created. Callers must treat `didStart() === false` as a
 * launch failure.
 */
export function watchShellProcessStart(child: {
  pid?: number;
  once(event: "spawn", listener: () => void): unknown;
}): ShellProcessStartWatch {
  let spawnSeen = child.pid != null;
  child.once("spawn", () => {
    spawnSeen = true;
  });
  return {
    didStart: () => spawnSeen || child.pid != null,
  };
}

export interface KillableProcess {
  pid?: number;
  kill: unknown;
}

type WindowsTreeTerminator = (pid: number, onFailure: () => void) => void;

export function terminateProcessTree(
  child: KillableProcess,
  hostPlatform: NodeJS.Platform = process.platform,
  terminateWindowsTree: WindowsTreeTerminator = runTaskkill,
): void {
  if (child.pid == null) {
    killDirectChild(child, hostPlatform);
    return;
  }

  if (hostPlatform === "win32") {
    let fellBack = false;
    const fallback = () => {
      if (!fellBack) {
        fellBack = true;
        killDirectChild(child, hostPlatform);
      }
    };
    terminateWindowsTree(child.pid, fallback);
    return;
  }

  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    killDirectChild(child, hostPlatform);
  }
}

function runTaskkill(pid: number, onFailure: () => void): void {
  const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true,
  });
  killer.once("error", onFailure);
  killer.once("close", (code) => {
    if (code !== 0) {
      onFailure();
    }
  });
}

function killDirectChild(
  child: KillableProcess,
  hostPlatform: NodeJS.Platform,
): void {
  if (typeof child.kill !== "function") {
    return;
  }
  try {
    const kill = child.kill as (signal?: NodeJS.Signals | number) => unknown;
    if (hostPlatform === "win32") {
      kill.call(child);
    } else {
      kill.call(child, "SIGKILL");
    }
  } catch {
    // The process may have already exited.
  }
}
