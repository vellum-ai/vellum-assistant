/**
 * Generic control surface for a background worker OS process tracked via a
 * PID file: probe liveness, spawn an entry script and wait for readiness,
 * and signal the process to stop.
 *
 * Domain modules (memory jobs worker, resource monitor, schedule worker) wrap
 * these helpers with their own PID path, entry point, and error type — the
 * PID-file bookkeeping lives here in one place.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getCurrentLogFilePath, getLogger } from "./logger.js";
import { isProcessAlive } from "./process-liveness.js";
import {
  listProcessTable,
  type ProcessTableRow,
  readRawProcessCommand,
} from "./process-table.js";
import { workerMemoryEnv } from "./worker-memory.js";
import {
  classifyWorkerOwnership,
  isDaemonCommand,
  pid1OwnsWorkers,
} from "./worker-ownership.js";

const log = getLogger("worker-process");

export interface WorkerProcessStatus {
  status: "running" | "not_running";
  pid?: number;
}

/** True when `err` is a Node ESRCH error ("no such process"). */
function isEsrchError(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    "code" in err &&
    (err as { code?: unknown }).code === "ESRCH"
  );
}

/**
 * Read a PID file and report liveness. A missing or malformed file reports
 * not_running; a file pointing at a dead process is cleaned up and reported as
 * not_running. Intended for worker-process PID files whose PID is a normal
 * spawned child (never PID 1), so `process.kill(pid, 0)` liveness is reliable.
 */
export function probeWorkerPidFile(path: string): WorkerProcessStatus {
  if (!existsSync(path)) {
    return { status: "not_running" };
  }

  const raw = readFileSync(path, "utf-8").trim();
  const pid = parseInt(raw, 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    return { status: "not_running" };
  }

  try {
    process.kill(pid, 0);
    return { status: "running", pid };
  } catch (err: unknown) {
    if (isEsrchError(err)) {
      // Stale file — clean it up.
      try {
        unlinkSync(path);
      } catch {
        // best-effort
      }
      return { status: "not_running" };
    }
    // Any other error (e.g. EPERM: the process exists but this caller may not
    // signal it) means the process is alive. Report it running rather than
    // letting the error escape a status probe.
    return { status: "running", pid };
  }
}

/** Thrown when a worker process fails to come up within the wait window. */
export class WorkerProcessSpawnError extends Error {}

/**
 * How long {@link spawnWorkerProcess} waits for the freshly-spawned worker to
 * write its PID file before treating the spawn as failed. A cold `bun run`
 * start — new runtime, config load, DB open — routinely takes several
 * seconds, so this is deliberately generous: a premature timeout makes a
 * `start` command report failure for a worker that is merely slow.
 */
const PID_FILE_WAIT_TIMEOUT_MS = 15_000;

/** Poll interval while waiting for the worker's PID file to appear. */
const PID_FILE_POLL_INTERVAL_MS = 100;

export interface SpawnWorkerProcessOptions {
  /**
   * Override how long to wait for the worker's PID file, in ms. Defaults to
   * {@link PID_FILE_WAIT_TIMEOUT_MS}. Primarily a testing seam.
   */
  pidWaitTimeoutMs?: number;
  /**
   * Override the PID-file poll interval, in ms. Defaults to
   * {@link PID_FILE_POLL_INTERVAL_MS}. Primarily a testing seam.
   */
  pidPollIntervalMs?: number;
  /**
   * When the wait times out while the child is still alive (a hung or very
   * slow start), terminate that child before throwing. Callers whose failure
   * path leaves the worker's config flag off MUST set this: otherwise the
   * worker keeps coming up and runs alongside whatever in-process
   * fallback the flag re-enabled.
   */
  terminateOnTimeout?: boolean;
}

export type PackagedWorkerEntry =
  | "monitoring"
  | "schedule"
  | "memory"
  | "routes"
  | "db-integrity";

interface WorkerCommandRuntime {
  platform: NodeJS.Platform;
  execPath: string;
  executableExists: (path: string) => boolean;
}

function defaultWorkerCommandRuntime(): WorkerCommandRuntime {
  return {
    platform: process.platform,
    execPath: process.execPath,
    executableExists: existsSync,
  };
}

/**
 * How a packaged Windows runtime spawns this worker, or null when the worker
 * runs from source. Only packaged Windows runtimes ship the executable.
 */
function packagedWorkerSpawn(
  packagedEntry: PackagedWorkerEntry | undefined,
  runtime: WorkerCommandRuntime,
): { executable: string; entry: PackagedWorkerEntry } | null {
  if (runtime.platform === "win32" && packagedEntry) {
    const executable = join(dirname(runtime.execPath), "vellum-worker.exe");
    if (runtime.executableExists(executable)) {
      return { executable, entry: packagedEntry };
    }
  }
  return null;
}

export function resolveWorkerCommand(
  entry: URL,
  packagedEntry: PackagedWorkerEntry | undefined,
  runtime: WorkerCommandRuntime = defaultWorkerCommandRuntime(),
): string[] {
  const packaged = packagedWorkerSpawn(packagedEntry, runtime);
  if (packaged) {
    return [packaged.executable, packaged.entry];
  }
  return ["bun", "--smol", "run", fileURLToPath(entry)];
}

type WorkerReadyOutcome = "ready" | "exited" | "timeout";

/**
 * Wait for the worker to signal readiness by writing its PID file.
 *
 *   - `"ready"`   — the PID file appeared.
 *   - `"exited"`  — the child exited first (it crashed during startup).
 *   - `"timeout"` — neither happened within `timeoutMs`.
 *
 * Polls for the PID file but also watches `exited`, so a crash-on-startup
 * fails fast instead of waiting out the whole timeout.
 */
async function waitForWorkerPidFile(
  pidPath: string,
  exited: Promise<unknown> | undefined,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<WorkerReadyOutcome> {
  let childExited = false;
  const markExited = () => {
    childExited = true;
  };
  // A pending `exited` promise does not keep the event loop alive once the
  // child is unref'd, so this floating wait won't hang the process.
  void exited?.then(markExited, markExited);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(pidPath)) {
      return "ready";
    }
    if (childExited) {
      // The worker could write the PID file and exit in the same tick —
      // re-check before declaring it dead.
      return existsSync(pidPath) ? "ready" : "exited";
    }
    await Bun.sleep(pollIntervalMs);
  }
  return existsSync(pidPath) ? "ready" : "timeout";
}

/** Path separators differ by platform; compare command lines on one form. */
function normalizeSeparators(value: string): string {
  return value.replaceAll("\\", "/");
}

/** Whether a command line carries every fragment that marks this worker. */
function matchesSignature(
  command: string,
  signature: readonly string[],
): boolean {
  const normalized = normalizeSeparators(command);
  return signature.every((part) =>
    normalized.includes(normalizeSeparators(part)),
  );
}

/**
 * Fragments of a command line that together mark a process as this worker,
 * whichever install it came from. All must be present.
 *
 * This is a safety guard, not the ownership test. Ownership is decided by
 * parentage; this only keeps us from signalling a process that happens to hold
 * a recycled PID. Three trailing path segments are specific enough
 * (`src/schedule/worker.ts`, `defaults/memory/worker.ts`) that an unrelated
 * program running some other `worker.ts` does not match. Packaged workers all
 * run one executable and are told apart by the subcommand, so the signature
 * carries both: matching on the executable alone would let one packaged
 * worker's slot reclaim another's process.
 */
export function workerKindSignature(
  entry: URL,
  packagedEntry: PackagedWorkerEntry | undefined,
  runtime: WorkerCommandRuntime = defaultWorkerCommandRuntime(),
): readonly string[] {
  const packaged = packagedWorkerSpawn(packagedEntry, runtime);
  if (packaged) {
    // Matched as separate fragments rather than one adjacent string: a Windows
    // command line may quote the executable path, so the two are not reliably
    // neighbours.
    return ["vellum-worker", packaged.entry];
  }
  return [
    normalizeSeparators(fileURLToPath(entry))
      .split("/")
      .filter(Boolean)
      .slice(-3)
      .join("/"),
  ];
}

/**
 * What became of the orphan after an awaited gap, from liveness plus a fresh
 * command-line read.
 *
 *   - `gone`: the PID is dead, or alive under a command line that is not this
 *     worker (the orphan exited and the OS recycled its PID). The slot may be
 *     released.
 *   - `orphan`: still alive and still reads as this worker. Escalation may
 *     proceed.
 *   - `identity-unreadable`: alive, but the command line could not be read, so
 *     "still the orphan" and "recycled PID" cannot be told apart. Uncertainty
 *     must resolve to reuse: no signal, and the slot must NOT be released, or
 *     a second worker would be spawned next to a live one.
 */
export type OrphanFate = "gone" | "orphan" | "identity-unreadable";

export function classifyOrphanAfterWait(
  alive: boolean,
  command: string | null,
  signature: readonly string[],
): OrphanFate {
  if (!alive) {
    return "gone";
  }
  if (command == null) {
    return "identity-unreadable";
  }
  return matchesSignature(command, signature) ? "orphan" : "gone";
}

/** Re-read the orphan's fate for `pid` from the live process table. */
function orphanFate(pid: number, signature: readonly string[]): OrphanFate {
  return classifyOrphanAfterWait(
    isProcessAlive(pid),
    readRawProcessCommand(pid),
    signature,
  );
}

/**
 * How long an orphaned worker gets to exit after SIGTERM.
 *
 * Derived from the longest shutdown any worker can legitimately take, not
 * picked. The memory worker reaps the ONNX embedding subprocess it owns before
 * exiting and bounds that at `EMBEDDING_SHUTDOWN_BUDGET_MS + 1s`, so a shorter
 * ceiling here would SIGKILL it mid-reap and strand the very subprocess that
 * reap exists to collect. A test asserts this stays above that bound.
 */
export const ORPHAN_STOP_TIMEOUT_MS = 15_000;

/** Poll interval while waiting for a stopped worker to exit. */
const ORPHAN_STOP_POLL_INTERVAL_MS = 100;

/**
 * How long to wait for a SIGKILLed worker to actually disappear. Signal
 * delivery and reaping are asynchronous, so a liveness probe taken straight
 * after the kill can still see a process that is on its way out.
 */
const ORPHAN_KILL_CONFIRM_MS = 1_000;

/** Poll until `pid` is gone or `timeoutMs` elapses. */
async function waitForExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isProcessAlive(pid)) {
    await Bun.sleep(ORPHAN_STOP_POLL_INTERVAL_MS);
  }
}

/**
 * Stop a worker orphaned by a previous owner and release its PID file.
 * Reports whether it actually exited.
 *
 * Escalates to SIGKILL because the orphan runs a different generation's
 * shutdown path, which this process cannot make assumptions about. Signalling
 * can still fail outright, most plausibly EPERM for a process owned by another
 * user, so the PID file is released only once the process is confirmed gone:
 * dropping it while the worker still runs would let the caller spawn a second
 * one against the same workspace. The unlink is also identity-checked, since a
 * concurrent launcher may already have replaced the worker and deleting that
 * successor's entry would strand it.
 */
async function stopOrphanedWorker(
  pid: number,
  pidPath: string,
  workerLabel: string,
  signature: readonly string[],
): Promise<boolean> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Exited between the probe and the signal.
  }

  await waitForExit(pid, ORPHAN_STOP_TIMEOUT_MS);
  // Identity is re-proven after every awaited gap, not carried by the PID:
  // the orphan may have exited during the wait and the OS may have handed its
  // PID to a stranger. Only a positive re-match escalates, and only a proven
  // "gone" releases the slot.
  let fate = orphanFate(pid, signature);
  if (fate === "orphan") {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Best-effort.
    }
    await waitForExit(pid, ORPHAN_KILL_CONFIRM_MS);
    fate = orphanFate(pid, signature);
  }

  if (fate !== "gone") {
    log.warn(
      { pid, pidPath, fate },
      fate === "orphan"
        ? `${workerLabel} orphaned by a previous owner could not be stopped; reusing it rather than running a second one`
        : `${workerLabel} is still live but its identity could not be re-read; reusing it rather than risking a duplicate`,
    );
    return false;
  }

  unlinkPidFileIfNames(pidPath, pid);
  log.warn(
    { pid, pidPath },
    `${workerLabel} orphaned by a previous owner was stopped so this process can start its own`,
  );
  return true;
}

/**
 * What to do about the process a worker's PID file currently names.
 *
 *   - `adopt`: reuse it. Either it is this process's own worker, or it belongs
 *     to another live owner, or it is not recognisably one of our workers at
 *     all and must never be signalled.
 *   - `reclaim`: an orphan left by an owner that is gone. Stop it, then spawn.
 *   - `spawn`: nothing is holding the slot.
 */
export type WorkerSlotDecision =
  | { action: "adopt"; pid: number }
  | { action: "reclaim"; pid: number }
  | { action: "spawn" };

/**
 * The whole safety decision, with no IO, so every branch is testable.
 *
 * `reclaim` is the only outcome that signals a process, and it requires two
 * independent things to agree: the command line marks the process as this
 * worker, and parentage says no daemon owns it. A missing row, an unreadable
 * command line, and a command line that does not match all fall back to
 * `adopt`, so an uncertain answer never costs a process its life.
 *
 * `isOwnerAlive` is the caller's definition of a legitimate owner. These
 * workers have exactly one, the daemon, so passing a plain liveness probe
 * would let a recycled owner PID keep a stranded worker looking owned forever.
 * The embed worker passes a liveness probe instead, because two processes may
 * each legitimately run one of its workers.
 */
export function decideWorkerSlot(
  status: WorkerProcessStatus,
  row: Pick<ProcessTableRow, "pid" | "ppid" | "command"> | null,
  signature: readonly string[],
  selfPid: number,
  isOwnerAlive: (pid: number) => boolean,
  pid1OwnsWorkers: boolean,
): WorkerSlotDecision {
  if (status.status !== "running" || status.pid == null) {
    return { action: "spawn" };
  }
  if (!row) {
    return { action: "adopt", pid: status.pid };
  }
  if (!matchesSignature(row.command, signature)) {
    return { action: "adopt", pid: status.pid };
  }
  const ownership = classifyWorkerOwnership(
    row,
    selfPid,
    isOwnerAlive,
    pid1OwnsWorkers,
  );
  return ownership === "orphan"
    ? { action: "reclaim", pid: status.pid }
    : { action: "adopt", pid: status.pid };
}

/**
 * The slot decision for the worker at `pidPath`, made without yielding.
 *
 * Callers spawn inside their own synchronous prefix, so this stays sync: an
 * `await` here would let a caller's next tick run before the child exists.
 */
function inspectWorkerSlot(
  pidPath: string,
  signature: readonly string[],
): WorkerSlotDecision {
  const status = probeWorkerPidFile(pidPath);
  if (status.status !== "running" || status.pid == null) {
    return { action: "spawn" };
  }

  // The worker's row, its owner's identity, and what PID 1 is all come from
  // one snapshot. Reading the table is a subprocess on most platforms, so
  // asking three separate times would be three of them per worker.
  let table: readonly ProcessTableRow[];
  try {
    table = listProcessTable();
  } catch {
    table = [];
  }
  const commandOf = (pid: number): string | null =>
    table.find((row) => row.pid === pid)?.command ?? null;

  const row = table.find((entry) => entry.pid === status.pid) ?? null;
  if (row && !matchesSignature(row.command, signature)) {
    log.info(
      { pid: row.pid, pidPath },
      "Worker PID file names a live process this runtime does not recognise as its worker; reusing it rather than signalling it",
    );
  }

  return decideWorkerSlot(
    status,
    row,
    signature,
    process.pid,
    (pid) => isDaemonCommand(commandOf(pid)),
    pid1OwnsWorkers(commandOf(1)),
  );
}

/**
 * Stop the orphan holding the slot, then report a PID to adopt instead of
 * spawning: either the orphan itself when it could not be stopped, or a
 * replacement a concurrent launcher brought up while we waited.
 */
async function reclaimWorkerSlot(
  pid: number,
  pidPath: string,
  workerLabel: string,
  signature: readonly string[],
): Promise<number | null> {
  if (!(await stopOrphanedWorker(pid, pidPath, workerLabel, signature))) {
    // Still running and beyond our reach. One stale worker beats two live ones.
    return pid;
  }
  const replacement = probeWorkerPidFile(pidPath);
  return replacement.status === "running" && replacement.pid != null
    ? replacement.pid
    : null;
}

/**
 * Spawn a worker entry script as a background process, as a child of this
 * process, and wait for it to report readiness by writing its PID file. The
 * child is `unref`'d, so the spawning process never blocks on it.
 *
 * If a worker is already running (per the PID file), returns its PID with
 * `alreadyRunning: true` rather than spawning a second one. Throws
 * {@link WorkerProcessSpawnError} if the child crashes during startup or
 * never writes its PID file within the wait window.
 */
export async function spawnWorkerProcess(args: {
  /** PID file the worker writes on startup (and that probes read). */
  pidPath: string;
  /** Worker entry script, e.g. `new URL("./worker.ts", import.meta.url)`. */
  entry: URL;
  /** Entry bundled into vellum-worker.exe for packaged Windows runtimes. */
  packagedEntry?: PackagedWorkerEntry;
  /** Human-readable name used in spawn-failure messages, e.g. "Memory worker". */
  workerLabel: string;
  options?: SpawnWorkerProcessOptions;
}): Promise<{ pid: number; alreadyRunning: boolean }> {
  const opts = args.options ?? {};
  const pidWaitTimeoutMs = opts.pidWaitTimeoutMs ?? PID_FILE_WAIT_TIMEOUT_MS;
  const pidPollIntervalMs = opts.pidPollIntervalMs ?? PID_FILE_POLL_INTERVAL_MS;

  const signature = workerKindSignature(args.entry, args.packagedEntry);
  const decision = inspectWorkerSlot(args.pidPath, signature);
  if (decision.action === "adopt") {
    return { pid: decision.pid, alreadyRunning: true };
  }
  if (decision.action === "reclaim") {
    const adopted = await reclaimWorkerSlot(
      decision.pid,
      args.pidPath,
      args.workerLabel,
      signature,
    );
    if (adopted != null) {
      return { pid: adopted, alreadyRunning: true };
    }
  }

  // Pipe the worker's stderr into the same daily log file the daemon writes
  // to. The worker's pino logger already writes there directly, but stderr
  // captures crash traces (uncaught exceptions that bypass the catch handler)
  // and pino's fallback output if the file logger fails to initialize.
  // Without this, any such output is lost to /dev/null and the worker dies
  // silently.
  let stderrFd: number | "inherit" = "inherit";
  try {
    const logPath = getCurrentLogFilePath();
    mkdirSync(dirname(logPath), { recursive: true });
    stderrFd = openSync(logPath, "a", 0o600);
  } catch {
    // If the log file can't be opened, inherit the parent's stderr so crash
    // output is at least visible to the spawning process.
  }

  // Source workers use bun's small-heap mode. Packaged Windows workers use the
  // compiled worker executable. Both receive the RAM hint from worker-memory.
  //
  // `fileURLToPath`, not `.pathname`: a URL's pathname is percent-encoded, so
  // an install path containing a space (every macOS desktop install lives
  // under "Application Support") would reach bun as "Application%20Support"
  // and the entry would not be found.
  const child = Bun.spawn({
    cmd: resolveWorkerCommand(args.entry, args.packagedEntry),
    env: workerMemoryEnv(),
    stdio: ["ignore", "ignore", stderrFd],
    // Every worker is a direct child of the daemon. That parentage is the
    // ownership record `classifyWorkerOwnership` reads, so it is not optional.
    detached: false,
    windowsHide: true,
  });

  // Close our copy of the log fd — the child has its own.
  if (typeof stderrFd === "number") {
    closeSync(stderrFd);
  }

  // Unreference so the spawning process doesn't wait for the child.
  child.unref();

  // The child is `unref`'d, so a worker that is merely slow keeps coming up
  // after we stop waiting.
  const outcome = await waitForWorkerPidFile(
    args.pidPath,
    child.exited,
    pidWaitTimeoutMs,
    pidPollIntervalMs,
  );

  if (outcome !== "ready") {
    // On a plain timeout the child may still be alive (hung or very slow
    // start). Terminate it when asked so a worker we are reporting as failed
    // cannot come up later. On an early exit the child is already gone, so
    // there is nothing to kill.
    if (outcome === "timeout" && opts.terminateOnTimeout) {
      try {
        child.kill();
      } catch {
        // best-effort — the child may already be gone
      }
    }
    throw new WorkerProcessSpawnError(
      outcome === "exited"
        ? `${args.workerLabel} exited during startup before writing its PID file`
        : `${args.workerLabel} was spawned but did not write its PID file within ${Math.round(
            pidWaitTimeoutMs / 1000,
          )}s`,
    );
  }

  const pid = parseInt(readFileSync(args.pidPath, "utf-8").trim(), 10);
  return { pid, alreadyRunning: false };
}

/**
 * Send SIGTERM to the worker process behind `pidPath` if it is actually
 * running.
 *
 * Returns the status observed before signalling, so callers can report
 * whether anything was stopped. Only throws if `process.kill` itself fails
 * (e.g. EPERM) — a not-running worker is a no-op.
 */
export function stopWorkerProcess(pidPath: string): WorkerProcessStatus {
  const current = probeWorkerPidFile(pidPath);
  if (current.status === "running" && current.pid != null) {
    process.kill(current.pid, "SIGTERM");
  }
  return current;
}

// ---------------------------------------------------------------------------
// PID-file identity
// ---------------------------------------------------------------------------

/**
 * Remove `pidPath` only while it still names `pid`.
 *
 * A successor worker overwrites the file with its own PID at startup, so an
 * unconditional unlink would delete the successor's entry: the liveness
 * supervisor would then respawn a duplicate and orphan the successor.
 */
export function unlinkPidFileIfNames(pidPath: string, pid: number): void {
  try {
    const raw = readFileSync(pidPath, "utf-8").trim();
    if (parseInt(raw, 10) === pid) {
      unlinkSync(pidPath);
    }
  } catch {
    // best-effort: a missing or unreadable file needs no cleanup
  }
}

/** Release this process's own PID file on the way out. */
export function cleanupWorkerPidFile(pidPath: string): void {
  unlinkPidFileIfNames(pidPath, process.pid);
}

/**
 * Watch the worker PID file and evict this process when the file stops
 * naming it. The PID file is a worker's sole tracking handle: stop
 * commands and daemon shutdown signal only the PID it names, so a worker
 * the file does not name can never be stopped externally — it must stop
 * itself. Eviction fires when the file names another process (a successor
 * spawned over this one) or is missing (untracked). A worker a successor
 * daemon reuses via the `alreadyRunning` path is still named by the file,
 * so the guard never fires for it.
 *
 * Checks immediately on arm and then every `intervalMs` (default 15s) on an
 * unref'd timer so the guard never keeps the process alive, calls `onEvicted`
 * at most once, and stops checking after eviction. The synchronous on-arm
 * check is what closes the startup window: a worker superseded before it
 * begins work evicts during arm — so callers arm the guard just before their
 * first tick — instead of running one orphaned interval's work first. Returns
 * a disposer; call it before {@link cleanupWorkerPidFile} on the normal
 * shutdown path so shutdown never reads as an eviction. The eviction path must
 * not delete the PID file — it names the successor.
 */
export function startWorkerPidFileGuard(
  pidPath: string,
  opts: { onEvicted: (reason: string) => void; intervalMs?: number },
): () => void {
  const intervalMs = opts.intervalMs ?? 15_000;
  let evicted = false;

  const check = (): void => {
    if (evicted) {
      return;
    }
    let reason: string | null = null;
    try {
      const raw = readFileSync(pidPath, "utf-8").trim();
      if (parseInt(raw, 10) !== process.pid) {
        reason = `PID file names ${raw || "nothing"}, not this process (${process.pid})`;
      }
    } catch {
      reason = "PID file is missing";
    }
    if (reason != null) {
      evicted = true;
      clearInterval(timer);
      opts.onEvicted(reason);
    }
  };

  const timer = setInterval(check, intervalMs);
  timer.unref();

  // Synchronous check on arm: a worker already superseded at startup evicts
  // here, before its caller starts work, rather than waiting a full interval.
  check();

  return () => clearInterval(timer);
}

// ---------------------------------------------------------------------------
// Liveness supervisor
// ---------------------------------------------------------------------------

/**
 * A liveness supervisor that probes a worker process and respawns it when it
 * has died, subject to exponential backoff and a suppression hook. Detects
 * process *death* (via the PID-file probe) — not a worker that is alive but
 * wedged.
 */
export interface WorkerSupervisor {
  /** Probe liveness; respawn if dead (subject to backoff/suppression). Never throws. */
  ensureAlive(now?: number): Promise<void>;
  /**
   * Stop supervising: no further respawns, and a respawn already in flight is
   * killed via {@link WorkerSupervisorOptions.killChild} when it resolves.
   */
  dispose(): void;
}

export interface WorkerSupervisorOptions {
  label: string;
  probe: () => WorkerProcessStatus;
  respawn: () => Promise<{ pid: number; alreadyRunning: boolean }>;
  /**
   * Kill a child brought up by a respawn that resolved after the worker was
   * disposed ({@link WorkerSupervisor.dispose}) or administratively suppressed
   * ({@link WorkerSupervisorOptions.isSuppressed}) — closes the race where a
   * stop lands while a respawn is already in flight.
   */
  killChild?: (pid: number) => void;
  /**
   * When it returns true, `ensureAlive` skips respawning — e.g. an operator
   * administratively stopped the worker and the watchdog must not undo that.
   */
  isSuppressed?: () => boolean;
  /** Fired after a respawn actually started a new process (not `alreadyRunning`). */
  onRespawn?: (pid: number) => void;
  /** Fires once when consecutiveFailures first reaches the threshold. */
  onPersistentFailure?: (consecutiveFailures: number, err: unknown) => void;
  minBackoffMs?: number; // default 15_000 (one tick)
  maxBackoffMs?: number; // default 300_000 (5 min)
  persistentFailureThreshold?: number; // default 3
}

export function createWorkerSupervisor(
  opts: WorkerSupervisorOptions,
): WorkerSupervisor {
  let consecutiveFailures = 0;
  let nextAttemptAt = 0;
  let inFlight = false;
  let stopping = false;
  const minBackoff = opts.minBackoffMs ?? 15_000;
  const maxBackoff = opts.maxBackoffMs ?? 300_000;
  const threshold = opts.persistentFailureThreshold ?? 3;

  return {
    async ensureAlive(now = Date.now()): Promise<void> {
      if (stopping || inFlight) {
        return;
      }
      // Operator stop wins over the watchdog — never respawn while suppressed.
      if (opts.isSuppressed?.()) {
        return;
      }
      if (opts.probe().status === "running") {
        consecutiveFailures = 0;
        nextAttemptAt = 0;
        return;
      }
      if (now < nextAttemptAt) {
        return; // in a backoff window after a failed respawn
      }
      inFlight = true;
      try {
        const { pid, alreadyRunning } = await opts.respawn();
        consecutiveFailures = 0;
        nextAttemptAt = 0;
        if (stopping || opts.isSuppressed?.()) {
          // A stop landed while this respawn was in flight — either disposal
          // (shutdown) or an operator stop that set suppression. Kill the child
          // we just brought up so the stop is not silently undone; otherwise
          // the fresh worker survives past the stop.
          opts.killChild?.(pid);
          return;
        }
        if (!alreadyRunning) {
          opts.onRespawn?.(pid);
        }
      } catch (err) {
        consecutiveFailures += 1;
        const backoff = Math.min(
          maxBackoff,
          minBackoff * 2 ** (consecutiveFailures - 1),
        );
        nextAttemptAt = now + backoff;
        if (consecutiveFailures === threshold) {
          opts.onPersistentFailure?.(consecutiveFailures, err);
        }
      } finally {
        inFlight = false;
      }
    },
    dispose(): void {
      stopping = true;
    },
  };
}
