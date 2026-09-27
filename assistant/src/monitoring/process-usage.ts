/**
 * Per-process CPU and memory in the assistant container, sampled by the
 * resource monitor.
 *
 * The cgroup counters show that the container hit its CPU quota or filled
 * its memory, not which process did it. Background work can slow the
 * daemon without blocking its event loop: a worker, Qdrant, or a browser
 * uses the container's shared CPU while the daemon waits for a turn on it.
 * This tracker names the processes using the container's resources, so a
 * slow daemon can be told apart from a starved one.
 *
 * CPU is a rate, so it needs two readings: each scan reads every process's
 * cumulative CPU ticks from `/proc/<pid>/stat` and compares them with the
 * previous scan. Memory is the resident set size from the same file.
 *
 * Names are metadata only: the daemon is "daemon", the assistant's own
 * worker scripts use a fixed label from an allowlist, and any other process
 * uses its kernel `comm` (15 bytes, no arguments). Command-line content never
 * leaves the machine.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CLOCK_TICKS_PER_SECOND,
  parseProcStat,
  readKernelPageSizeBytes,
} from "./proc-wait-state.js";

/** Processes reported by CPU, busiest first. */
const TOP_BY_CPU = 4;
/** Further processes reported by resident memory, largest first. */
const TOP_BY_MEMORY = 2;
/** Minimum time between scans; a shorter tick reuses the last result. */
const DEFAULT_MIN_SCAN_INTERVAL_MS = 1_000;

/**
 * The assistant's own worker scripts, matched on the trailing path of a
 * command-line argument. Only these fixed labels are ever reported; any
 * other process is named by its kernel comm.
 */
const KNOWN_WORKERS: ReadonlyArray<{ pattern: RegExp; name: string }> = [
  {
    pattern: /(?:^|\/)src\/schedule\/worker\.[cm]?[jt]s$/,
    name: "schedule-worker",
  },
  {
    pattern: /(?:^|\/)defaults\/memory\/worker\.[cm]?[jt]s$/,
    name: "memory-worker",
  },
  {
    pattern: /(?:^|\/)src\/monitoring\/worker\.[cm]?[jt]s$/,
    name: "monitoring-worker",
  },
  {
    pattern: /(?:^|\/)src\/routes\/worker\.[cm]?[jt]s$/,
    name: "routes-worker",
  },
  { pattern: /(?:^|\/)embed-worker\.mjs$/, name: "embed-worker" },
  { pattern: /(?:^|\/)rerank-worker\.mjs$/, name: "rerank-worker" },
];

export interface ProcessUsage {
  pid: number;
  /** "daemon", an assistant worker name, or the kernel comm. */
  name: string;
  /** CPU used since the previous scan, as a percentage of one core. */
  cpuPct: number;
  rssMb: number;
}

interface ProcessCounters {
  cpuTicks: number;
  startTicks: number;
}

export interface ProcessUsageTracker {
  /**
   * Busiest processes since the previous scan, or null before the first
   * two scans complete or when `/proc` is unreadable. `nowMs` must be read
   * at the call, so the time between scans matches the counters' interval.
   */
  sample(nowMs: number, daemonPid: number | null): ProcessUsage[] | null;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/** A telemetry-safe name: never includes command-line arguments. */
function processName(
  procRoot: string,
  pid: number,
  comm: string,
  daemonPid: number | null,
): string {
  if (pid === daemonPid) {
    return "daemon";
  }
  const cmdline = readText(join(procRoot, String(pid), "cmdline"));
  for (const arg of cmdline?.split("\0") ?? []) {
    const path = arg.replaceAll("\\", "/");
    const worker = KNOWN_WORKERS.find(({ pattern }) => pattern.test(path));
    if (worker) {
      return worker.name;
    }
  }
  return comm;
}

export function createProcessUsageTracker(
  options: {
    procRoot?: string;
    minScanIntervalMs?: number;
    pageSizeBytes?: number;
  } = {},
): ProcessUsageTracker {
  const procRoot = options.procRoot ?? "/proc";
  const pageSizeBytes =
    options.pageSizeBytes ?? readKernelPageSizeBytes(procRoot);
  const minScanIntervalMs =
    options.minScanIntervalMs ?? DEFAULT_MIN_SCAN_INTERVAL_MS;
  let previous: Map<number, ProcessCounters> | null = null;
  let previousAt = 0;
  let last: ProcessUsage[] | null = null;

  return {
    sample(nowMs: number, daemonPid: number | null): ProcessUsage[] | null {
      if (previous != null && nowMs - previousAt < minScanIntervalMs) {
        return last;
      }

      let pids: number[];
      try {
        pids = readdirSync(procRoot)
          .filter((entry) => /^\d+$/.test(entry))
          .map(Number);
      } catch {
        return null;
      }

      const elapsedSeconds = (nowMs - previousAt) / 1000;
      const current = new Map<number, ProcessCounters>();
      const usage: Array<ProcessUsage & { comm: string }> = [];
      for (const pid of pids) {
        const raw = readText(join(procRoot, String(pid), "stat"));
        const stat = raw != null ? parseProcStat(raw) : null;
        if (stat == null) {
          // Exited between readdir and read.
          continue;
        }
        current.set(pid, {
          cpuTicks: stat.cpuTicks,
          startTicks: stat.startTicks,
        });
        const before = previous?.get(pid);
        // A reused pid starts a new process; its old counters do not apply.
        if (before == null || before.startTicks !== stat.startTicks) {
          continue;
        }
        const cpuSeconds =
          (stat.cpuTicks - before.cpuTicks) / CLOCK_TICKS_PER_SECOND;
        usage.push({
          pid,
          comm: stat.comm,
          name: "",
          cpuPct:
            elapsedSeconds > 0
              ? Math.round((cpuSeconds / elapsedSeconds) * 100)
              : 0,
          rssMb: Math.round((stat.rssPages * pageSizeBytes) / (1024 * 1024)),
        });
      }

      const hadPrevious = previous != null;
      previous = current;
      previousAt = nowMs;
      if (!hadPrevious) {
        last = null;
        return null;
      }

      // The busiest by CPU, then the largest by memory (an idle process can
      // still fill the cgroup), then the daemon for comparison.
      const byCpu = [...usage].sort(
        (a, b) => b.cpuPct - a.cpuPct || b.rssMb - a.rssMb,
      );
      const reported = byCpu.slice(0, TOP_BY_CPU);
      const byMemory = [...usage].sort((a, b) => b.rssMb - a.rssMb);
      for (const entry of byMemory) {
        if (reported.length >= TOP_BY_CPU + TOP_BY_MEMORY) {
          break;
        }
        if (!reported.includes(entry)) {
          reported.push(entry);
        }
      }
      const daemon = usage.find((entry) => entry.pid === daemonPid);
      if (daemon && !reported.includes(daemon)) {
        reported.push(daemon);
      }
      // Names are read only for the reported processes.
      last = reported.map(({ comm, ...entry }) => ({
        ...entry,
        name: processName(procRoot, entry.pid, comm, daemonPid),
      }));
      return last;
    },
  };
}
