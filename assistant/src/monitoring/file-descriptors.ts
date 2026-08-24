/**
 * Open file-descriptor accounting for the container's processes, polled by the
 * resource monitor.
 *
 * Descriptor exhaustion is the memory limit's quieter twin: a process that
 * reaches its `RLIMIT_NOFILE` soft limit starts failing every `open()`,
 * `accept()`, and `socket()` with EMFILE, so a leak surfaces as unrelated
 * connection and file errors scattered across the daemon rather than as a
 * single recognizable failure. The limit is per process (unlike the cgroup
 * memory limit, which is shared), so usage is measured per PID: the open count
 * from `/proc/<pid>/fd` against the soft limit from `/proc/<pid>/limits`.
 *
 * Enumerating descriptors costs a readdir plus a small read per process, which
 * is why this polls on its own slow timer instead of riding the 250ms resource
 * sampler. Descriptor counts climb over minutes, not milliseconds.
 *
 * Reads are best-effort: a process that exits mid-walk, or one owned by another
 * user, is skipped rather than failing the pass.
 */

import { readdirSync, readFileSync } from "node:fs";

import type { MonitoringConfig } from "../config/schemas/monitoring.js";
import { getLogger } from "../util/logger.js";
import {
  getProcessTableRows,
  type ProcessTableOptions,
  type ProcessTableRow,
} from "../util/process-table.js";
import { deriveName, readProcessCommand } from "../util/process-tree.js";

const log = getLogger("file-descriptors");

/** How many over-threshold processes a single warn line reports. */
const WARN_PROCESS_LIMIT = 5;

export interface OpenFileLimits {
  /** The limit actually enforced on `open()`; null when unlimited or absent. */
  soft: number | null;
  /** Ceiling the process may raise its soft limit to; null when unlimited. */
  hard: number | null;
}

export interface ProcessFdUsage {
  pid: number;
  /** Redacted process descriptor (see {@link readProcessCommand}). */
  command: string;
  /** Open descriptor count, or handle count on Windows. */
  openCount: number;
  softLimit: number | null;
  hardLimit: number | null;
  /** openCount / softLimit, or null when the soft limit is unknown. */
  ratio: number | null;
}

/** A process whose soft limit is known, so its usage ratio is comparable. */
export type ProcessFdPressure = ProcessFdUsage & { ratio: number };

/** `Max open files  <soft>  <hard>  files` in `/proc/<pid>/limits`. */
const MAX_OPEN_FILES_RE = /^Max open files\s+(\S+)\s+(\S+)/m;

/**
 * Parse the descriptor limits out of `/proc/<pid>/limits`. Both fields are null
 * when the row is missing, and an individual field is null when the kernel
 * reports `unlimited`.
 */
export function parseOpenFileLimits(raw: string): OpenFileLimits {
  const match = MAX_OPEN_FILES_RE.exec(raw);
  if (!match) {
    return { soft: null, hard: null };
  }
  const count = (field: string) => {
    const parsed = parseInt(field, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  };
  return { soft: count(match[1]), hard: count(match[2]) };
}

/**
 * Descriptor usage for one PID, or null when the process is gone or its `/proc`
 * entry is unreadable. The count includes the descriptor `readdirSync` itself
 * holds when reading this process's own `/proc/self/fd`, so a process's
 * self-measurement runs one high.
 */
function readProcessFdUsage(pid: number): ProcessFdUsage | null {
  let openCount: number;
  try {
    openCount = readdirSync(`/proc/${pid}/fd`).length;
  } catch {
    // Exited between readdir and read, or owned by another user.
    return null;
  }
  const command = readProcessCommand(pid);
  if (command == null) {
    return null;
  }
  let limits: OpenFileLimits = { soft: null, hard: null };
  try {
    limits = parseOpenFileLimits(readFileSync(`/proc/${pid}/limits`, "utf-8"));
  } catch {
    // Limits unreadable; the raw count is still worth reporting.
  }
  return {
    pid,
    command,
    openCount,
    softLimit: limits.soft,
    hardLimit: limits.hard,
    ratio: limits.soft != null ? openCount / limits.soft : null,
  };
}

/**
 * Descriptor usage for every readable process, closest to its soft limit first
 * (processes with an unknown limit sort last, by raw count). Empty when
 * `/proc` is unavailable. Windows reports process handle counts without a
 * comparable soft limit.
 */
export function collectFdUsage(
  options: ProcessTableOptions = {},
): ProcessFdUsage[] {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    try {
      return getProcessTableRows(options)
        .filter(
          (row): row is ProcessTableRow & { handleCount: number } =>
            row.handleCount != null,
        )
        .map((row) => ({
          pid: row.pid,
          command: deriveName(row.command),
          openCount: row.handleCount,
          softLimit: null,
          hardLimit: null,
          ratio: null,
        }))
        .sort((a, b) => b.openCount - a.openCount);
    } catch {
      return [];
    }
  }

  let entries: string[];
  try {
    entries = readdirSync("/proc").filter((entry) => /^\d+$/.test(entry));
  } catch {
    return [];
  }

  const rows: ProcessFdUsage[] = [];
  for (const entry of entries) {
    const usage = readProcessFdUsage(Number(entry));
    if (usage != null) {
      rows.push(usage);
    }
  }

  rows.sort(
    (a, b) => (b.ratio ?? -1) - (a.ratio ?? -1) || b.openCount - a.openCount,
  );
  return rows;
}

/** The top `limit` processes by descriptor pressure, most pressured first. */
export function topProcessesByFd(
  limit: number,
  options: ProcessTableOptions = {},
): ProcessFdUsage[] {
  return collectFdUsage(options).slice(0, limit);
}

/** What a pass concluded about the container's descriptor pressure. */
export type FdPressureAction =
  | { kind: "none" }
  | { kind: "warn"; processes: ProcessFdPressure[] }
  | { kind: "recovered" };

/** Pass-to-pass state, so a sustained condition warns on a cooldown. */
export interface FdPressureState {
  /** When the last warn was emitted; 0 when none has been. */
  lastWarnAt: number;
  /** Whether the previous pass found any process over the threshold. */
  overThreshold: boolean;
}

export function createFdPressureState(): FdPressureState {
  return { lastWarnAt: 0, overThreshold: false };
}

/**
 * Decide what a pass should report, given the pressure it measured and the
 * previous pass's state. Crossing the threshold warns immediately; staying over
 * it re-warns at most once per `warnCooldownMs`, so a leak logs a rising count
 * instead of a line per poll. Dropping back under reports a single recovery.
 */
export function evaluateFdPressure(
  usage: readonly ProcessFdUsage[],
  options: { thresholdRatio: number; warnCooldownMs: number },
  state: FdPressureState,
  now: number,
): { action: FdPressureAction; state: FdPressureState } {
  const over = usage.filter(
    (p): p is ProcessFdPressure =>
      p.ratio != null && p.ratio >= options.thresholdRatio,
  );

  if (over.length === 0) {
    return {
      action: state.overThreshold ? { kind: "recovered" } : { kind: "none" },
      state: createFdPressureState(),
    };
  }

  if (state.overThreshold && now - state.lastWarnAt < options.warnCooldownMs) {
    return { action: { kind: "none" }, state };
  }

  return {
    action: { kind: "warn", processes: over },
    state: { lastWarnAt: now, overThreshold: true },
  };
}

function logFdPressure(action: FdPressureAction, thresholdRatio: number): void {
  if (action.kind === "warn") {
    log.warn(
      {
        thresholdRatio,
        processCount: action.processes.length,
        // PID only, no command: a command line can carry secrets passed as
        // arguments, and this line lands in the rotating workspace log.
        processes: action.processes.slice(0, WARN_PROCESS_LIMIT).map((p) => ({
          pid: p.pid,
          openCount: p.openCount,
          softLimit: p.softLimit,
          hardLimit: p.hardLimit,
          ratio: Math.round(p.ratio * 1000) / 1000,
        })),
      },
      "Processes near their open file-descriptor limit",
    );
    return;
  }
  if (action.kind === "recovered") {
    log.info(
      { thresholdRatio },
      "Open file-descriptor usage back under threshold",
    );
  }
}

export interface FileDescriptorMonitorHandle {
  stop: () => void;
}

/**
 * Start the descriptor poller. The first pass runs one interval in, not at
 * boot: descriptor counts are still ramping while the daemon opens its sockets
 * and database handles, and the walk is I/O the boot path does not need.
 *
 * The timer is unref'd: the resource sampler is the monitor process's
 * keep-alive, and this loop must not extend its life on its own.
 */
export function startFileDescriptorMonitor(
  config: MonitoringConfig,
  clock: () => number = Date.now,
): FileDescriptorMonitorHandle {
  let state = createFdPressureState();

  const poll = () => {
    try {
      const result = evaluateFdPressure(
        collectFdUsage(),
        {
          thresholdRatio: config.highFdThresholdRatio,
          warnCooldownMs: config.fdWarnCooldownMs,
        },
        state,
        clock(),
      );
      state = result.state;
      logFdPressure(result.action, config.highFdThresholdRatio);
    } catch (err) {
      log.warn({ err }, "File-descriptor poll failed");
    }
  };

  const timer = setInterval(poll, config.fdPollIntervalMs);
  timer.unref?.();

  return {
    stop: () => clearInterval(timer),
  };
}
