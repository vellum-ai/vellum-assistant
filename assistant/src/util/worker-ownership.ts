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

/** The packaged daemon binary, with or without a Windows extension. */
const PACKAGED_DAEMON_ARGV0 = /^vellum-daemon(\.exe)?$/i;

/** The runtime the source daemon is launched under. */
const BUN_ARGV0 = /^bun(\.exe)?$/i;

/** The daemon entry script, as a whole trailing path segment pair. */
const DAEMON_ENTRY_ARG = /(^|\/)daemon\/main\.(ts|js)$/;

/**
 * Split a command line into argv, keeping quoted paths whole.
 *
 * Splitting on whitespace first would shred the ordinary Windows install path
 * `"C:\\Program Files\\Vellum\\...\\vellum-daemon.exe"` into `"C:\\Program` and
 * make the packaged daemon unrecognisable, which is the very install this
 * recovery path exists for. Separators are normalised per token so a caller
 * can take a basename either way.
 */
function tokenizeCommandLine(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | null = null;
  let started = false;

  for (const ch of command) {
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) {
    tokens.push(current);
  }
  return tokens.map((token) => token.replaceAll("\\", "/"));
}

/**
 * Whether a command line is an assistant daemon, judged by argv shape rather
 * than by substring.
 *
 * Two accepted shapes: the packaged binary as argv0 (which also covers the
 * source daemon once `process.title` rewrites its argv), or bun as argv0 with
 * the daemon entry script among its arguments.
 *
 * The shape matters because this authorises an irreversible signal. A
 * substring test would accept any command line that merely mentions a
 * `daemon/main` path, so an unrelated service, an editor, or a test runner
 * holding a recycled PID would qualify. `cli/src/lib/orphan-detection.test.ts`
 * already pins that exact collision (`node /opt/unrelated-service/daemon/main.ts`)
 * as something we must not claim.
 */
export function isDaemonCommand(command: string | null): boolean {
  if (command == null) {
    return false;
  }
  const tokens = tokenizeCommandLine(command);
  const argv0 = tokens[0]?.split("/").pop() ?? "";
  if (PACKAGED_DAEMON_ARGV0.test(argv0)) {
    return true;
  }
  if (!BUN_ARGV0.test(argv0)) {
    return false;
  }
  return tokens.slice(1).some((token) => DAEMON_ENTRY_ARG.test(token));
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
