/**
 * Reports kernel OOM kills in this container as `oom_kill` watchdog events.
 *
 * The log comes from `dmesg`, not `/dev/kmsg`: the device is not mounted in
 * the container, while `dmesg` uses the syslog syscall the container is
 * allowed. The log is per kernel, not per container, and `/proc/self/cgroup`
 * reads `/` inside the container, so kills are attributed by the cgroup
 * `memory.events` counter rather than by cgroup path.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getRawShareAnalytics } from "../platform/consent-cache.js";
import { recordWatchdogEvent } from "../telemetry/watchdog-events-store.js";
import { getLogger } from "../util/logger.js";
import { DAEMON_OOM_SCORE_ADJ } from "../util/oom-priority.js";
import { getMonitoringDataDir } from "../util/platform.js";
import type { ResourceSample } from "./resource-sample-types.js";

const log = getLogger("oom-kill-reporter");

export const OOM_KILL_CHECK_NAME = "oom_kill";
const CURSOR_FILENAME = "oom-kill-cursor.json";
/** Cadence for hosts without `memory.events`. */
const FALLBACK_SCAN_INTERVAL_MS = 60_000;
/** The detail bag is capped at 4 KiB server-side. */
const MAX_VICTIMS_IN_DETAIL = 10;
const DMESG_TIMEOUT_MS = 5_000;

export interface KernelLogEntry {
  /** Seconds since boot, monotonic for the life of the kernel. */
  time: number;
  msg: string;
}

export interface OomKill {
  time: number;
  pid: number;
  comm: string;
  oomScoreAdj: number | null;
  anonRssKb: number | null;
  totalVmKb: number | null;
}

type Attribution = "cgroup_counter" | "kernel_log";

/** `dmesg --json`: `{"dmesg":[{"pri":3,"time":44170.542,"msg":"..."}]}`. */
export function parseDmesgJson(text: string): KernelLogEntry[] | null {
  try {
    const parsed: unknown = JSON.parse(text);
    const rows = (parsed as { dmesg?: unknown }).dmesg;
    if (!Array.isArray(rows)) {
      return null;
    }
    const entries: KernelLogEntry[] = [];
    for (const row of rows) {
      const { time, msg } = row as { time?: unknown; msg?: unknown };
      if (typeof time === "number" && typeof msg === "string") {
        entries.push({ time, msg });
      }
    }
    return entries;
  } catch {
    return null;
  }
}

/** Plain `dmesg`: `[   44170.542000] message` per line. */
export function parseDmesgText(text: string): KernelLogEntry[] {
  const entries: KernelLogEntry[] = [];
  for (const line of text.split("\n")) {
    const match = /^\[\s*(\d+\.\d+)\]\s?(.*)$/.exec(line);
    if (match) {
      entries.push({ time: parseFloat(match[1]), msg: match[2] });
    }
  }
  return entries;
}

const OOM_KILL_RE = /[Oo]ut of memory: Killed process (\d+) \(([^)]*)\)(.*)$/;

function kb(fields: string, key: string): number | null {
  const match = new RegExp(`${key}:(\\d+)kB`).exec(fields);
  return match ? parseInt(match[1], 10) : null;
}

export function oomKillsFromEntries(entries: KernelLogEntry[]): OomKill[] {
  const kills: OomKill[] = [];
  for (const entry of entries) {
    const kill = OOM_KILL_RE.exec(entry.msg);
    if (!kill) {
      continue;
    }
    const fields = kill[3];
    const adj = /oom_score_adj:(-?\d+)/.exec(fields);
    kills.push({
      time: entry.time,
      pid: parseInt(kill[1], 10),
      comm: kill[2],
      oomScoreAdj: adj ? parseInt(adj[1], 10) : null,
      anonRssKb: kb(fields, "anon-rss"),
      totalVmKb: kb(fields, "total-vm"),
    });
  }
  return kills.sort((a, b) => a.time - b.time);
}

/** Null when `dmesg` is absent or lacks CAP_SYSLOG. */
export async function readKernelLog(): Promise<KernelLogEntry[] | null> {
  if (process.platform !== "linux") {
    return null;
  }
  const run = async (args: string[]): Promise<string | null> => {
    try {
      const proc = Bun.spawn(["dmesg", ...args], {
        stdout: "pipe",
        stderr: "ignore",
        windowsHide: true,
        timeout: DMESG_TIMEOUT_MS,
      });
      const text = await new Response(proc.stdout).text();
      return (await proc.exited) === 0 ? text : null;
    } catch {
      return null;
    }
  };
  const json = await run(["--json"]);
  const fromJson = json != null ? parseDmesgJson(json) : null;
  if (fromJson) {
    return fromJson;
  }
  const text = await run([]);
  return text != null ? parseDmesgText(text) : null;
}

function readBootId(): string | null {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim();
  } catch {
    return null;
  }
}

interface Cursor {
  bootId: string | null;
  lastTime: number;
}

function readCursor(path: string): Cursor | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<Cursor>;
    if (typeof parsed.lastTime === "number") {
      return { bootId: parsed.bootId ?? null, lastTime: parsed.lastTime };
    }
  } catch {
    // Missing or unreadable.
  }
  return null;
}

function writeCursor(path: string, cursor: Cursor): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cursor));
}

export interface OomKillReporterOptions {
  readKernelLog?: () => Promise<KernelLogEntry[] | null>;
  readBootId?: () => string | null;
  shareAnalytics?: () => boolean | null;
  cursorPath?: string;
  record?: typeof recordWatchdogEvent;
}

export interface OomKillReport {
  attribution: Attribution;
  victims: OomKill[];
  /** Kills the counter saw that the log could not name. */
  unnamed: number;
}

export interface OomKillReporter {
  /** Returns what was queued, for tests. */
  check(
    sample: ResourceSample,
    now: number,
    daemonPid: number | null,
  ): Promise<OomKillReport | null>;
}

export function createOomKillReporter(
  options: OomKillReporterOptions = {},
): OomKillReporter {
  const read = options.readKernelLog ?? readKernelLog;
  const bootId = options.readBootId ?? readBootId;
  const shareAnalytics = options.shareAnalytics ?? getRawShareAnalytics;
  const cursorPath =
    options.cursorPath ?? join(getMonitoringDataDir(), CURSOR_FILENAME);
  const record = options.record ?? recordWatchdogEvent;

  let firstScan = true;
  let lastScanAt = 0;
  /** A report the telemetry store refused; retried before the next scan. */
  let pending: {
    report: OomKillReport;
    sample: ResourceSample;
    daemonPid: number | null;
    cursor: Cursor;
  } | null = null;

  const queue = (
    report: OomKillReport,
    sample: ResourceSample,
    daemonPid: number | null,
    cursor: Cursor,
  ): boolean => {
    if (shareAnalytics() === false) {
      writeCursor(cursorPath, cursor);
      return true;
    }
    const killedDaemon = report.victims.some(
      (kill) =>
        kill.oomScoreAdj === DAEMON_OOM_SCORE_ADJ ||
        (daemonPid != null && kill.pid === daemonPid),
    );
    const detail = {
      attribution: report.attribution,
      victim_count: report.victims.length + report.unnamed,
      unnamed_victims: report.unnamed,
      victims: report.victims.slice(-MAX_VICTIMS_IN_DETAIL).map((kill) => ({
        pid: kill.pid,
        comm: kill.comm,
        oom_score_adj: kill.oomScoreAdj,
        anon_rss_kb: kill.anonRssKb,
        total_vm_kb: kill.totalVmKb,
      })),
      daemon_pid: daemonPid,
      killed_daemon: killedDaemon,
      memory_current_bytes: sample.memory?.currentBytes ?? null,
      memory_limit_bytes: sample.memory?.limitBytes ?? null,
      memory_peak_bytes: sample.memory?.peakBytes ?? null,
    };
    const queued = record({
      checkName: OOM_KILL_CHECK_NAME,
      value: detail.victim_count,
      detail,
    });
    if (!queued) {
      return false;
    }
    writeCursor(cursorPath, cursor);
    log.warn(detail, "Kernel OOM kill in the assistant container");
    return true;
  };

  return {
    async check(sample, now, daemonPid) {
      if (pending) {
        if (
          !queue(
            pending.report,
            pending.sample,
            pending.daemonPid,
            pending.cursor,
          )
        ) {
          return null;
        }
        pending = null;
      }

      const counterDelta = sample.deltas?.events?.oomKill ?? 0;
      const countersAvailable = sample.events != null;
      if (
        !firstScan &&
        counterDelta === 0 &&
        now - lastScanAt < FALLBACK_SCAN_INTERVAL_MS
      ) {
        return null;
      }
      const isFirstScan = firstScan;
      firstScan = false;
      lastScanAt = now;

      const entries = await read();
      const currentBootId = bootId();
      if (entries == null) {
        if (counterDelta === 0) {
          return null;
        }
        const report: OomKillReport = {
          attribution: "cgroup_counter",
          victims: [],
          unnamed: counterDelta,
        };
        const cursor = { bootId: currentBootId, lastTime: 0 };
        if (!queue(report, sample, daemonPid, cursor)) {
          pending = { report, sample, daemonPid, cursor };
        }
        return report;
      }

      const all = oomKillsFromEntries(entries);
      const maxTime = all.length > 0 ? all[all.length - 1].time : 0;
      const stored = readCursor(cursorPath);
      // A different boot id, or a log that has not yet reached the stored
      // timestamp, means the kernel restarted and the cursor is stale.
      const sameBoot =
        stored != null &&
        stored.bootId === currentBootId &&
        maxTime >= stored.lastTime;
      const sinceTime = sameBoot ? stored.lastTime : -1;
      const fresh = all.filter((kill) => kill.time > sinceTime);
      const cursor: Cursor = {
        bootId: currentBootId,
        lastTime: Math.max(sinceTime, maxTime),
      };

      let report: OomKillReport | null = null;
      // The counter says how many were ours; older new kills are neighbours'.
      if (counterDelta > 0) {
        report = {
          attribution: "cgroup_counter",
          victims: fresh.slice(-counterDelta),
          unnamed: Math.max(0, counterDelta - fresh.length),
        };
      } else if ((isFirstScan || !countersAvailable) && fresh.length > 0) {
        // No counter to lean on: a kill that took the daemon down restarted
        // this monitor with it, and the new container's counter starts at 0.
        report = { attribution: "kernel_log", victims: fresh, unnamed: 0 };
      }

      if (report == null) {
        if (!sameBoot || cursor.lastTime !== stored?.lastTime) {
          writeCursor(cursorPath, cursor);
        }
        return null;
      }
      if (!queue(report, sample, daemonPid, cursor)) {
        pending = { report, sample, daemonPid, cursor };
      }
      return report;
    },
  };
}
