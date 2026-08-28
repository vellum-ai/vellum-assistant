/**
 * Process-tree ownership for background worker processes.
 *
 * A worker's parent IS its owner. The process table is therefore the
 * authoritative answer to "whose worker is this": unlike a PID file it
 * survives a crash, and a second owner cannot overwrite it.
 *
 * Nothing here is specific to one worker kind. `listWorkerProcesses` matches
 * on the absolute worker path the caller passes, and `classifyWorkerOwnership`
 * takes injected liveness and PID-1 predicates, so any worker whose spawner
 * knows its own PID can use both.
 */

import { listProcessTable, readRawProcessCommand } from "./process-table.js";

export interface WorkerProcess {
  pid: number;
  ppid: number;
}

/**
 * What this process may do with a worker it found in the process table.
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

/**
 * Command lines that identify an assistant daemon, running from source
 * (`.../daemon/main.ts`) or as the packaged binary.
 */
const DAEMON_PROCESS_PATTERN = /vellum-daemon|[\\/]daemon[\\/]main/;

/**
 * Whether a command line belongs to an assistant daemon.
 *
 * For a worker with exactly one legitimate owner, "is the owner alive" is not
 * the same question as "does some process still hold that PID". The OS recycles
 * PIDs, and a recycled owner PID would otherwise leave a stranded worker
 * looking owned, and therefore untouchable, indefinitely.
 */
export function isDaemonCommand(command: string | null): boolean {
  return command != null && DAEMON_PROCESS_PATTERN.test(command);
}

/**
 * Whether PID 1 is an assistant daemon rather than an init process.
 *
 * True only where the daemon was exec'd as PID 1 (`docker-entrypoint.sh`),
 * which is what makes a worker parented to 1 a live sibling's rather than an
 * orphan. Under `docker run --init` PID 1 is docker-init and under launchd or
 * systemd it is the system init, so both answer false and PID-1 orphans stay
 * reclaimable. Unreadable means false, which keeps the reclaiming behaviour.
 *
 * Callers that already hold a process-table snapshot pass PID 1's command line
 * so this does not read the table a second time.
 */
export function pid1OwnsWorkers(pid1Command?: string | null): boolean {
  if (process.pid === 1) {
    return true;
  }
  return isDaemonCommand(
    pid1Command === undefined ? readRawProcessCommand(1) : pid1Command,
  );
}

/**
 * Live worker processes matching `workerPath`, as `(pid, ppid)` pairs.
 *
 * `workerPath` is an absolute path unique to one worker of one install, so a
 * sibling instance's workers never match. `model`, when given, must appear as
 * a whole argv token rather than a substring, so a backend for `bge-small`
 * cannot reclaim a live `bge-small-v2` worker.
 *
 * Raw command lines are read for matching only, never stored or logged:
 * process arguments can carry secrets (see the redaction note in
 * `util/process-tree.ts`).
 */
export function listWorkerProcesses(
  workerPath: string,
  model?: string,
): WorkerProcess[] {
  try {
    return listProcessTable()
      .filter(
        (row) =>
          row.command.includes(workerPath) &&
          (!model || row.command.split(/\s+/).includes(model)),
      )
      .map(({ pid, ppid }) => ({ pid, ppid }));
  } catch {
    return [];
  }
}
