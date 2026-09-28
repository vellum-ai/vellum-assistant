/**
 * Reports kernel OOM kills in this container as `oom_kill` watchdog events.
 *
 * The log comes from `dmesg`, not `/dev/kmsg`: the device is not mounted in
 * the container, while `dmesg` uses the syslog syscall the container is
 * allowed. The log is per kernel, not per container. A kill is this
 * container's when the kernel's `oom-kill:` header names a cgroup carrying
 * this container's id, which the container learns from its own mount table
 * since `/proc/self/cgroup` reads `/` inside a cgroup namespace. The kernel
 * rate-limits that header in a burst, so header-less kills fall back to the
 * cgroup `memory.events` counter.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getRawShareAnalytics } from "../platform/consent-cache.js";
import { recordWatchdogEvent } from "../telemetry/watchdog-events-store.js";
import { getContainerMemoryEvents } from "../util/cgroup-memory.js";
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
/** Mounts whose source path the container runtime names after the container. */
const CONTAINER_ID_MOUNTPOINTS = new Set([
  "/etc/hosts",
  "/etc/hostname",
  "/etc/resolv.conf",
  "/dev/termination-log",
]);

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
  /** Victim's cgroup from the `oom-kill:` header; null when the header was rate-limited away. */
  memcg: string | null;
}

type Attribution = "cgroup" | "cgroup_counter" | "kernel_log";

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
const OOM_HEADER_RE = /^oom-kill:.*task_memcg=([^,]*),task=[^,]*,pid=(\d+)/;

function kb(fields: string, key: string): number | null {
  const match = new RegExp(`${key}:(\\d+)kB`).exec(fields);
  return match ? parseInt(match[1], 10) : null;
}

export function oomKillsFromEntries(entries: KernelLogEntry[]): OomKill[] {
  const sorted = [...entries].sort((a, b) => a.time - b.time);
  // The header precedes its "Killed process" line and names the same pid.
  const memcgByPid = new Map<number, string>();
  const kills: OomKill[] = [];
  for (const entry of sorted) {
    const header = OOM_HEADER_RE.exec(entry.msg);
    if (header) {
      memcgByPid.set(parseInt(header[2], 10), header[1]);
      continue;
    }
    const kill = OOM_KILL_RE.exec(entry.msg);
    if (!kill) {
      continue;
    }
    const pid = parseInt(kill[1], 10);
    const fields = kill[3];
    const adj = /oom_score_adj:(-?\d+)/.exec(fields);
    kills.push({
      time: entry.time,
      pid,
      comm: kill[2],
      oomScoreAdj: adj ? parseInt(adj[1], 10) : null,
      anonRssKb: kb(fields, "anon-rss"),
      totalVmKb: kb(fields, "total-vm"),
      memcg: memcgByPid.get(pid) ?? null,
    });
    memcgByPid.delete(pid);
  }
  return kills;
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

/**
 * Container ids from `/proc/self/mountinfo`: the runtime names the source of
 * the hosts, hostname, resolv.conf and termination-log mounts after the
 * container (Kata: `<id>-<hash>-hosts`; Docker: `.../containers/<id>/hosts`).
 */
export function parseOwnContainerIds(mountinfo: string): Set<string> {
  const ids = new Set<string>();
  for (const line of mountinfo.split("\n")) {
    const fields = line.split(" ");
    if (fields.length < 5 || !CONTAINER_ID_MOUNTPOINTS.has(fields[4])) {
      continue;
    }
    for (const id of line.match(/[0-9a-f]{64}/g) ?? []) {
      ids.add(id);
    }
  }
  return ids;
}

function readOwnContainerIds(): Set<string> {
  try {
    return parseOwnContainerIds(readFileSync("/proc/self/mountinfo", "utf-8"));
  } catch {
    return new Set();
  }
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

function memcgIsOurs(memcg: string, ids: ReadonlySet<string>): boolean {
  for (const id of ids) {
    if (memcg.includes(id)) {
      return true;
    }
  }
  return false;
}

export interface OomKillReporterOptions {
  readKernelLog?: () => Promise<KernelLogEntry[] | null>;
  /** Cumulative cgroup oom_kill count, read after the log so it covers every logged kill. */
  readKillCounter?: () => number | null;
  readOwnContainerIds?: () => ReadonlySet<string>;
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
  const readKillCounter =
    options.readKillCounter ??
    (() => getContainerMemoryEvents()?.oomKill ?? null);
  const ownIds = options.readOwnContainerIds ?? readOwnContainerIds;
  const bootId = options.readBootId ?? readBootId;
  const shareAnalytics = options.shareAnalytics ?? getRawShareAnalytics;
  const cursorPath =
    options.cursorPath ?? join(getMonitoringDataDir(), CURSOR_FILENAME);
  const record = options.record ?? recordWatchdogEvent;

  let firstScan = true;
  let lastScanAt = 0;
  let lastKillCounter: number | null = null;
  /**
   * Counter credit with no log line yet: the kernel prints the kill line
   * before it increments the counter, so a kill between the log read and the
   * counter read is counted but not yet visible. Credit is spent on the next
   * scan and reported as unnamed if still unspent, so a kill that never logs
   * a line cannot claim a neighbour's later.
   */
  let owed = 0;
  /** A scan was skipped mid-way; the next tick scans regardless of the sampler. */
  let scanDue = false;
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

      const sampleDelta = sample.deltas?.events?.oomKill ?? 0;
      if (
        !firstScan &&
        !scanDue &&
        sampleDelta === 0 &&
        now - lastScanAt < FALLBACK_SCAN_INTERVAL_MS
      ) {
        return null;
      }
      scanDue = false;

      const entries = await read();
      const currentBootId = bootId();
      if (entries == null) {
        firstScan = false;
        lastScanAt = now;
        lastKillCounter = readKillCounter() ?? lastKillCounter;
        if (sampleDelta === 0) {
          return null;
        }
        const report: OomKillReport = {
          attribution: "cgroup_counter",
          victims: [],
          unnamed: sampleDelta,
        };
        const cursor = { bootId: currentBootId, lastTime: 0 };
        if (!queue(report, sample, daemonPid, cursor)) {
          pending = { report, sample, daemonPid, cursor };
        }
        return report;
      }

      // Read after the log so the count covers every line the log holds.
      const killCounter = readKillCounter();
      if (killCounter == null && sample.events != null) {
        // One failed read of a counter that exists: try again next tick
        // rather than treating every kill on the kernel as ours.
        scanDue = true;
        return null;
      }
      const isFirstScan = firstScan;
      firstScan = false;
      lastScanAt = now;
      const counterDelta =
        killCounter != null && lastKillCounter != null
          ? Math.max(0, killCounter - lastKillCounter)
          : null;
      lastKillCounter = killCounter ?? lastKillCounter;

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
      const ids = ownIds();

      let report: OomKillReport | null = null;
      if (counterDelta == null || isFirstScan) {
        // No counter to lean on: a kill that took the daemon down restarted
        // this monitor with it, and the new container's counter starts at 0.
        const ours = fresh.filter(
          (kill) => kill.memcg == null || memcgIsOurs(kill.memcg, ids),
        );
        if (ours.length > 0) {
          report = { attribution: "kernel_log", victims: ours, unnamed: 0 };
        }
        owed = 0;
      } else {
        const byHeader = fresh.filter(
          (kill) => kill.memcg != null && memcgIsOurs(kill.memcg, ids),
        );
        const unknown = fresh.filter((kill) => kill.memcg == null);
        // Header-attributed kills spend counter credit first; what is left
        // names header-less kills oldest first. Header-less kills beyond the
        // credit are neighbours', since our counter would have covered ours.
        const carry = owed;
        let credit = counterDelta + carry - byHeader.length;
        const byCounter = unknown.slice(0, Math.max(0, credit));
        credit = Math.max(0, credit - byCounter.length);
        owed = Math.min(credit, counterDelta);
        const unnamed = credit - owed;
        const victims = [...byHeader, ...byCounter].sort(
          (a, b) => a.time - b.time,
        );
        if (victims.length > 0 || unnamed > 0) {
          report = {
            attribution:
              byCounter.length === 0 && unnamed === 0
                ? "cgroup"
                : "cgroup_counter",
            victims,
            unnamed,
          };
        }
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
