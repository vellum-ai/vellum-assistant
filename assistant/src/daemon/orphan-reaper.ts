/**
 * Periodic reaper for orphaned subprocesses that reparent to the daemon.
 *
 * Tools run commands in their own process group (`detached: true`) and, on
 * timeout/abort, group-kill with `process.kill(-pgid, SIGKILL)` (the bash and
 * host_bash tools, the skill sandbox runner, and the debug-bash route). The
 * immediate child is reaped by Bun/libuv, but its descendants — e.g. git's
 * transport helpers or a skill runner's `bun` process — were never spawned by
 * the daemon, so when the group dies they reparent to PID 1. When the daemon
 * runs as PID 1 in a container, Bun is not an init: it never calls `waitpid()`
 * on those reparented orphans, so they accumulate as `<defunct>` entries that
 * consume PID slots until the container is recycled.
 *
 * This reaper scans `/proc` for zombie children of the daemon and reaps each
 * by **specific PID** with `WNOHANG`. It deliberately does NOT use
 * `waitpid(-1)`: libuv reaps the children it spawned by specific PID on
 * `SIGCHLD`, and a blanket `waitpid(-1)` would race libuv and could swallow a
 * tracked child's exit status — libuv's own source handles the lost race by
 * dropping the exit callback ("someone else stole the waitpid from us. Handle
 * this by not handling it at all."). To stay clear of that race we only reap a
 * zombie after it has survived at least one scan interval: libuv reaps its own
 * within milliseconds of `SIGCHLD`, so anything still defunct a full interval
 * later is a genuine orphan libuv is not tracking.
 *
 * The reaper is a no-op unless the daemon is PID 1 on Linux. Off PID 1 (local
 * macOS dev, or if an init such as tini is ever placed above the daemon),
 * orphans reparent to that init and are reaped there, so there is nothing for
 * this to do. Because the daemon is PID 1, orphans already reparent to it and
 * `PR_SET_CHILD_SUBREAPER` is unnecessary. It is additionally gated behind the
 * `daemon.reapOrphanedSubprocesses` config flag (default off) so the behavior
 * can be enabled per workspace for validation before becoming the default.
 *
 * References:
 * - libuv reaps its own children by pid on SIGCHLD (`uv__wait_children`):
 *   https://github.com/nodejs/node/blob/main/deps/uv/src/unix/process.c
 * - Subreaper reaping pattern for runtimes embedding libuv (specific-pid +
 *   WNOHANG, never `waitpid(-1)`, grace window for libuv co-existence):
 *   https://github.com/coopergwrenn/prctl-subreaper
 * - waitpid(2): https://man7.org/linux/man-pages/man2/waitpid.2.html
 */

import { readdirSync, readFileSync } from "node:fs";
import { dlopen, FFIType, ptr } from "bun:ffi";

import { getConfigReadOnly } from "../config/loader.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("orphan-reaper");

/** Linux `WNOHANG` — return immediately if no child has changed state. */
const WNOHANG = 1;

const SCAN_INTERVAL_MS = 60_000;

let scanTimer: ReturnType<typeof setInterval> | null = null;

/** Zombie child PIDs observed on the previous scan (the grace set). */
let seenLastScan: Set<number> = new Set();

type WaitpidFn = (pid: number, statusPtr: unknown, options: number) => number;

let waitpid: WaitpidFn | null = null;
// Held at module scope so the backing buffer is not GC'd while `waitStatusPtr`
// keeps only a raw pointer into it (waitpid writes the exit status here).
let waitStatusBuf: Int32Array | null = null;
let waitStatusPtr: unknown = null;

/**
 * Bind libc `waitpid` via FFI. Returns false (and disables the reaper) if FFI
 * is unavailable so daemon startup never fails on this subsystem.
 */
function initWaitpid(): boolean {
  if (waitpid) return true;
  try {
    const lib = dlopen("libc.so.6", {
      waitpid: {
        args: [FFIType.i32, FFIType.ptr, FFIType.i32],
        returns: FFIType.i32,
      },
    });
    // Reusable out-param buffer for the wstatus we don't inspect.
    waitStatusBuf = new Int32Array(1);
    waitStatusPtr = ptr(waitStatusBuf);
    waitpid = lib.symbols.waitpid as unknown as WaitpidFn;
    return true;
  } catch (err) {
    log.warn(
      { err },
      "Orphan reaper unavailable: failed to bind libc waitpid via FFI",
    );
    return false;
  }
}

export interface ZombieChild {
  pid: number;
  comm: string;
}

/**
 * Parse a `/proc/<pid>/stat` line into its leading fields. `comm` (the
 * executable name) may itself contain spaces and parentheses, so the fixed
 * fields are read relative to the final `)` rather than by naive splitting.
 * Returns null if the line is malformed.
 */
export function parseProcStat(
  content: string,
): { comm: string; state: string; ppid: number } | null {
  const lparen = content.indexOf("(");
  const rparen = content.lastIndexOf(")");
  if (lparen === -1 || rparen === -1 || rparen < lparen) return null;
  const comm = content.slice(lparen + 1, rparen);
  const rest = content.slice(rparen + 2).split(" ");
  const state = rest[0];
  const ppid = Number(rest[1]);
  if (!state || !Number.isInteger(ppid)) return null;
  return { comm, state, ppid };
}

/**
 * Given the zombie child PIDs seen this scan and those seen on the previous
 * scan, decide which to reap now. A zombie is only reaped once it has
 * survived a full interval (present in `seenLast`), leaving newly-defunct
 * children for libuv to reap first. Returns the PIDs to reap and the set to
 * carry into the next scan.
 */
export function selectReapable(
  current: number[],
  seenLast: Set<number>,
): { reap: number[]; nextSeen: Set<number> } {
  const reap = current.filter((pid) => seenLast.has(pid));
  return { reap, nextSeen: new Set(current) };
}

/**
 * Scan `/proc` for zombie (`Z`) processes whose parent is this daemon.
 * Reparented orphans keep their original process group but their parent
 * becomes PID 1 (the daemon), so they appear here once defunct.
 */
function findZombieChildren(): ZombieChild[] {
  const selfPid = process.pid;
  const zombies: ZombieChild[] = [];
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return zombies;
  }
  for (const entry of entries) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid <= 1) continue;
    let stat: string;
    try {
      stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    } catch {
      // Process exited between readdir and read — skip.
      continue;
    }
    const parsed = parseProcStat(stat);
    if (parsed && parsed.state === "Z" && parsed.ppid === selfPid) {
      zombies.push({ pid, comm: parsed.comm });
    }
  }
  return zombies;
}

/**
 * Reap zombie children that have persisted for at least one scan interval,
 * leaving newly-defunct children for libuv to reap first.
 */
function reapScan(): void {
  if (!waitpid) return;
  const zombies = findZombieChildren();
  const byPid = new Map(zombies.map((z) => [z.pid, z]));
  const { reap, nextSeen } = selectReapable([...byPid.keys()], seenLastScan);
  const reaped: ZombieChild[] = [];
  for (const pid of reap) {
    const rc = waitpid(pid, waitStatusPtr, WNOHANG);
    // rc > 0: reaped. rc <= 0 (0 = not yet, -1 = ECHILD/raced): leave it.
    if (rc > 0) reaped.push(byPid.get(pid)!);
  }
  seenLastScan = nextSeen;
  if (reaped.length > 0) {
    log.info(
      {
        count: reaped.length,
        pids: reaped.map((z) => z.pid),
        comms: reaped.map((z) => z.comm),
      },
      "Reaped orphaned subprocesses reparented to the daemon (PID 1)",
    );
  }
}

/**
 * Read the opt-in gate from workspace config (`daemon.reapOrphanedSubprocesses`),
 * tolerating a missing or malformed config so startup never fails on it.
 */
function isReaperEnabled(): boolean {
  try {
    return getConfigReadOnly().daemon.reapOrphanedSubprocesses;
  } catch {
    return false;
  }
}

/**
 * Start the periodic orphan reaper. No-op unless the daemon is PID 1 on Linux
 * (otherwise reparented orphans are reaped by the real init) and the
 * `daemon.reapOrphanedSubprocesses` config gate is enabled.
 */
export function startOrphanReaper(): void {
  if (scanTimer) return;
  if (process.platform !== "linux" || process.pid !== 1) {
    log.info(
      { platform: process.platform, pid: process.pid },
      "Orphan reaper not started: daemon is not PID 1 on Linux",
    );
    return;
  }
  if (!isReaperEnabled()) {
    log.info(
      "Orphan reaper not started: daemon.reapOrphanedSubprocesses is disabled",
    );
    return;
  }
  if (!initWaitpid()) return;
  seenLastScan = new Set();
  scanTimer = setInterval(reapScan, SCAN_INTERVAL_MS);
  scanTimer.unref?.();
  log.info({ intervalMs: SCAN_INTERVAL_MS }, "Orphan reaper started");
}

export function stopOrphanReaper(): void {
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }
  seenLastScan = new Set();
}
