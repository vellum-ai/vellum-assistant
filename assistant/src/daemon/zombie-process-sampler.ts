/**
 * Periodic sampler that reports zombie (defunct) subprocesses reparented
 * to this daemon process.
 *
 * Why this exists: under the container image the daemon runs as PID 1
 * with no init wrapper, so any subprocess that gets orphaned (its
 * direct parent dies before reaping it) is reparented to PID 1 (the
 * daemon) and never reaped — bun has no SIGCHLD handler that calls
 * `waitpid(-1, …, WNOHANG)` for arbitrary children. The result is
 * `<defunct>` entries that accumulate until container restart.
 *
 * The sampler turns "unreported until a user notices" into a
 * first-class metric: every sample interval we count zombies parented
 * to us and break them down by command. Above a threshold we escalate
 * to `warn` so log search can find the moment the leak started.
 *
 * Linux-only (reads `/proc`). On non-Linux platforms `start()` is a
 * no-op — the macOS desktop app + dev hosts are unaffected.
 */
import { readdirSync, readFileSync } from "node:fs";

import { getLogger } from "../util/logger.js";
import { isLinux } from "../util/platform.js";

const log = getLogger("zombie-process-sampler");

/** Default sample interval. 5 min matches the cadence of other daemon samplers. */
const DEFAULT_SAMPLE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Threshold above which the sample line is emitted at `warn` instead of
 * `info`. Reported user incident showed 118 zombies over ~26 h, i.e. ~5
 * per hour — 25 is well above hourly noise but well below the incident
 * level, so it fires before the next report would come in.
 */
const DEFAULT_WARN_THRESHOLD = 25;

interface SamplerState {
  timer: ReturnType<typeof setInterval> | null;
  intervalMs: number;
  warnThreshold: number;
}

const state: SamplerState = {
  timer: null,
  intervalMs: DEFAULT_SAMPLE_INTERVAL_MS,
  warnThreshold: DEFAULT_WARN_THRESHOLD,
};

export interface ZombieSample {
  /** Total zombies parented to this daemon process. */
  total: number;
  /** Breakdown by `comm` (process name truncated to 15 chars by the kernel). */
  byCommand: Record<string, number>;
}

export interface ParsedProcStat {
  state: string;
  ppid: number;
  /** Process name as reported by the kernel — truncated to 15 chars and may contain spaces. */
  comm: string;
}

/**
 * Parse a single `/proc/<pid>/stat` line.
 *
 * `/proc/<pid>/stat` format:
 *   <pid> (<comm>) <state> <ppid> …
 *
 * `comm` is bracketed by `(` … `)` and may contain spaces, parentheses,
 * or newlines, so we anchor on the *last* `)` rather than tokenising on
 * whitespace. Returns `null` for malformed input — the sampler treats
 * malformed entries the same as missing entries (skip + continue).
 */
export function parseProcStat(content: string): ParsedProcStat | null {
  const closeIdx = content.lastIndexOf(")");
  if (closeIdx < 0) return null;
  const openIdx = content.indexOf("(");
  if (openIdx < 0 || openIdx >= closeIdx) return null;
  const comm = content.slice(openIdx + 1, closeIdx);
  const rest = content.slice(closeIdx + 2).split(" ");
  if (rest.length < 2) return null;
  const state = rest[0];
  const ppid = Number(rest[1]);
  if (!state || !Number.isFinite(ppid)) return null;
  return { state, ppid, comm };
}

/**
 * Scan `/proc` for zombie (state `Z`) processes whose `ppid` matches
 * the supplied pid (the daemon).
 *
 * Exposed for testing — production code calls the singleton sampler.
 */
export function sampleZombies(parentPid: number): ZombieSample {
  const byCommand: Record<string, number> = {};
  let total = 0;

  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    // `/proc` unavailable (non-Linux, sandboxed). Return empty sample.
    return { total: 0, byCommand: {} };
  }

  for (const entry of entries) {
    // Only PID-numbered subdirectories are processes; skip everything else
    // ("self", "loadavg", …) cheaply without a stat() syscall.
    if (
      entry.length === 0 ||
      entry.charCodeAt(0) < 0x30 ||
      entry.charCodeAt(0) > 0x39
    ) {
      continue;
    }
    let stat: string;
    try {
      stat = readFileSync(`/proc/${entry}/stat`, "utf8");
    } catch {
      // Process exited between readdir and read — common, ignore.
      continue;
    }
    const parsed = parseProcStat(stat);
    if (!parsed) continue;
    if (parsed.state !== "Z" || parsed.ppid !== parentPid) continue;
    total++;
    byCommand[parsed.comm] = (byCommand[parsed.comm] ?? 0) + 1;
  }

  return { total, byCommand };
}

function runOneSample(): void {
  let sample: ZombieSample;
  try {
    sample = sampleZombies(process.pid);
  } catch (err) {
    // Defensive: never let sampler errors crash the daemon.
    log.warn({ err }, "Zombie sampler failed to read /proc");
    return;
  }

  if (sample.total === 0) {
    // Steady-state silence. Drop to `debug` so quiet daemons don't fill
    // their logs but we can still confirm the sampler is alive when
    // diagnosing.
    log.debug({ total: 0 }, "Zombie sampler — no orphans reparented to daemon");
    return;
  }

  const fields = {
    parentPid: process.pid,
    total: sample.total,
    byCommand: sample.byCommand,
  };
  if (sample.total >= state.warnThreshold) {
    log.warn(
      fields,
      "Zombie sampler — orphan subprocesses reparented to daemon exceed threshold",
    );
  } else {
    log.info(
      fields,
      "Zombie sampler — orphan subprocesses reparented to daemon",
    );
  }
}

export interface ZombieSamplerOptions {
  intervalMs?: number;
  warnThreshold?: number;
}

/**
 * Start the periodic sampler. Linux-only; no-op elsewhere.
 *
 * Idempotent — calling `start()` while already running is a no-op so
 * the daemon main path can call this unconditionally during startup
 * without tracking state itself.
 *
 * The interval timer is `unref()`'d so it never prevents process exit.
 */
export function startZombieSampler(options: ZombieSamplerOptions = {}): void {
  if (!isLinux()) {
    log.debug("Zombie sampler not started — platform is not Linux");
    return;
  }
  if (state.timer !== null) return;

  state.intervalMs = options.intervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;
  state.warnThreshold = options.warnThreshold ?? DEFAULT_WARN_THRESHOLD;

  // Sample immediately so containers that crash-loop don't go a full
  // interval before producing a single data point.
  runOneSample();

  const timer = setInterval(runOneSample, state.intervalMs);
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
  state.timer = timer;

  log.info(
    { intervalMs: state.intervalMs, warnThreshold: state.warnThreshold },
    "Zombie sampler started",
  );
}

/**
 * Stop the sampler. Used by tests to keep timers from leaking between
 * runs; production never calls this — the sampler runs for the daemon
 * lifetime.
 */
export function stopZombieSampler(): void {
  if (state.timer !== null) {
    clearInterval(state.timer);
    state.timer = null;
  }
}
