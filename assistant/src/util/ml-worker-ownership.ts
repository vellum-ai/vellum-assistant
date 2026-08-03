/**
 * Process-tree ownership for the local ML worker subprocesses (embed, rerank).
 *
 * These workers are pipe-attached children, not the detached PID-file workers
 * `worker-process.ts` supervises, so ownership is answered by the OS process
 * tree instead: a worker's parent IS its owner. That survives a crash and
 * cannot be overwritten by a second owner racing on a shared PID file, which
 * were the two failure modes behind JARVIS-1125.
 *
 * Nothing here is specific to one worker kind. `listWorkerProcesses` matches on
 * the absolute worker script path, which is unique per kind and per workspace,
 * so the embed and rerank backends can each enumerate only their own workers.
 */

import { readdirSync, readFileSync } from "node:fs";

export interface WorkerProcess {
  pid: number;
  ppid: number;
}

/**
 * What this process may do with an ML worker it found in the process table.
 *
 * - `reclaim`: parented to us, a worker we started and lost track of. Reaping
 *   it is what enforces one live worker per owning process.
 * - `orphan`: reparented to init, or its owner is gone. Nobody else will ever
 *   clean it up.
 * - `foreign`: owned by another live process. The memory-worker process runs
 *   its own backend against this same workspace and is entitled to its own
 *   worker; signalling it is what made the two replace each other in a loop.
 *
 * A parent of PID 1 is ambiguous, and resolving it wrongly in either direction
 * costs something real. `docker-entrypoint.sh` execs the daemon, so PID 1 can
 * BE the daemon and its child a healthy sibling's worker. Under `docker run
 * --init`, and on any host, PID 1 is an init process instead, so the same
 * parentage means the owner died and the worker needs reclaiming. Callers
 * therefore pass what PID 1 actually is rather than inferring it from whether
 * the deployment is containerized, which is true in both container shapes.
 */
export type WorkerOwnership = "reclaim" | "orphan" | "foreign";

export function classifyWorkerOwnership(
  worker: WorkerProcess,
  selfPid: number,
  isOwnerAlive: (pid: number) => boolean,
  pid1OwnsWorkers: boolean,
): WorkerOwnership {
  if (worker.ppid === selfPid) {
    return "reclaim";
  }
  if (worker.ppid <= 1) {
    return pid1OwnsWorkers ? "foreign" : "orphan";
  }
  if (!isOwnerAlive(worker.ppid)) {
    return "orphan";
  }
  return "foreign";
}

/** Entrypoint the daemon is exec'd with, including inside a container. */
const DAEMON_ENTRYPOINT_MARKER = "daemon/main";

/**
 * Whether PID 1 is an assistant daemon rather than an init process.
 *
 * True only where the daemon was exec'd as PID 1 (`docker-entrypoint.sh`),
 * which is what makes a worker parented to 1 a live sibling's rather than an
 * orphan. Under `docker run --init` PID 1 is docker-init and under launchd or
 * systemd it is the system init, so both answer false and PID-1 orphans stay
 * reclaimable. Unreadable means false, which keeps the reclaiming behaviour.
 */
export function pid1OwnsMlWorkers(): boolean {
  if (process.pid === 1) {
    return true;
  }
  let cmd: string;
  try {
    cmd = readFileSync("/proc/1/cmdline", "utf8").split("\0").join(" ");
  } catch {
    const result = Bun.spawnSync({
      cmd: ["ps", "-ww", "-p", "1", "-o", "command="],
      stdout: "pipe",
      stderr: "ignore",
    });
    if (result.exitCode !== 0) {
      return false;
    }
    cmd = new TextDecoder().decode(result.stdout);
  }
  return cmd.includes(DAEMON_ENTRYPOINT_MARKER);
}

/** Enumerate `(pid, ppid, rawCommand)` rows from Linux `/proc`. */
function listProcessRowsFromProc(): {
  pid: number;
  ppid: number;
  cmd: string;
}[] {
  const rows: { pid: number; ppid: number; cmd: string }[] = [];
  for (const entry of readdirSync("/proc")) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid <= 0) {
      continue;
    }
    try {
      // `stat` field 4 is ppid, but `comm` (field 2) may contain spaces or
      // parens, so parse from the last ')' and a weird comm cannot shift fields.
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const ppid = Number(after[1]);
      const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8")
        .split("\0")
        .filter(Boolean)
        .join(" ");
      if (Number.isInteger(ppid)) {
        rows.push({ pid, ppid, cmd });
      }
    } catch {
      // Process exited between readdir and read, so skip it.
    }
  }
  return rows;
}

/** Enumerate `(pid, ppid, rawCommand)` rows via `ps` (macOS / no `/proc`). */
function listProcessRowsFromPs(): { pid: number; ppid: number; cmd: string }[] {
  // `-ww` disables column-width truncation. Without it, macOS `ps` clips the
  // command field to the terminal width, which can cut off the workerPath
  // argument and hide a genuine match. Same flag is used by
  // daemon-control.ts:123 for exactly this reason.
  const result = Bun.spawnSync({
    cmd: ["ps", "-A", "-ww", "-o", "pid=,ppid=,command="],
    stdout: "pipe",
    stderr: "ignore",
  });
  if (result.exitCode !== 0) {
    return [];
  }
  const rows: { pid: number; ppid: number; cmd: string }[] = [];
  for (const line of new TextDecoder().decode(result.stdout).split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (m) {
      rows.push({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3].trim() });
    }
  }
  return rows;
}

/**
 * Live worker processes for this workspace, as `(pid, ppid)` pairs.
 *
 * Matches on the absolute worker script path, which lives under THIS
 * workspace's embedding-models directory and is therefore unique per assistant
 * instance and per worker kind, so neither a sibling instance's workers nor the
 * other kind's workers ever match. Raw command lines are read for matching
 * only, never stored or logged: process arguments can carry secrets (see the
 * redaction note in `util/process-tree.ts`).
 */
export function listWorkerProcesses(
  workerPath: string,
  model?: string,
): WorkerProcess[] {
  let rows: { pid: number; ppid: number; cmd: string }[];
  try {
    rows = listProcessRowsFromProc();
  } catch {
    rows = listProcessRowsFromPs();
  }
  return rows
    .filter(
      (r) =>
        r.cmd.includes(workerPath) &&
        // An argv token, not a substring: `foo/bar-small` must not match a
        // `foo/bar-small-v2` worker, or a backend for the shorter name would
        // reclaim the longer one's live worker. Model names carry no spaces.
        (!model || r.cmd.split(/\s+/).includes(model)),
    )
    .map((r) => ({ pid: r.pid, ppid: r.ppid }));
}
