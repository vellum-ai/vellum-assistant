/**
 * Reports kernel OOM kills inside the container as `oom_kill` watchdog
 * telemetry.
 *
 * The cgroup's `memory.events` counter says that a kill happened; only the
 * kernel log says who died. The monitor reads `/dev/kmsg`, matches the
 * kernel's "Killed process" line, and emits one event per scan naming each
 * victim's comm, `oom_score_adj` and resident size, plus whether the victim
 * was the daemon. That last field is the fleet-wide check on the OOM priority
 * policy in `util/oom-priority.ts`.
 *
 * A cursor file on the monitor data dir (kernel boot id + last kmsg sequence)
 * keeps a restarted monitor from re-reporting kills the previous one already
 * sent, which matters because the kill that takes the daemon down restarts
 * the monitor with it. The cursor resets when the kernel does.
 */

import {
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { recordWatchdogEvent } from "../telemetry/watchdog-events-store.js";
import { getLogger } from "../util/logger.js";
import { getMonitoringDataDir } from "../util/platform.js";
import type { ResourceSample } from "./resource-sample-types.js";

const log = getLogger("oom-kill-reporter");

export const OOM_KILL_CHECK_NAME = "oom_kill";
const CURSOR_FILENAME = "oom-kill-cursor.json";
/** Kernel log scan cadence when `memory.events` reports nothing (cgroup v1, gVisor). */
const FALLBACK_SCAN_INTERVAL_MS = 60_000;
/** Victims listed per event; the count is always reported in full. */
const MAX_VICTIMS_IN_DETAIL = 10;
/** /dev/kmsg returns one record per read and rejects buffers smaller than a record. */
const KMSG_READ_BUFFER_BYTES = 8192;

export interface KmsgOomKill {
  /** kmsg sequence number; monotonic for the life of the kernel. */
  seq: number;
  pid: number;
  comm: string;
  oomScoreAdj: number | null;
  anonRssKb: number | null;
  totalVmKb: number | null;
}

/** `prio,seq,timestamp,flags;message`, then optional continuation lines starting with a space. */
const KMSG_RECORD_RE = /^\d+,(\d+),\d+,[^;]*;(.*)$/;
const OOM_KILL_RE = /[Oo]ut of memory: Killed process (\d+) \(([^)]*)\)(.*)$/;

function kb(fields: string, key: string): number | null {
  const match = new RegExp(`${key}:(\\d+)kB`).exec(fields);
  return match ? parseInt(match[1], 10) : null;
}

/** Extract OOM-kill records from raw `/dev/kmsg` text. */
export function parseKmsgOomKills(raw: string): KmsgOomKill[] {
  const kills: KmsgOomKill[] = [];
  for (const line of raw.split("\n")) {
    const record = KMSG_RECORD_RE.exec(line);
    if (!record) {
      continue;
    }
    const kill = OOM_KILL_RE.exec(record[2]);
    if (!kill) {
      continue;
    }
    const fields = kill[3];
    const adj = /oom_score_adj:(-?\d+)/.exec(fields);
    kills.push({
      seq: parseInt(record[1], 10),
      pid: parseInt(kill[1], 10),
      comm: kill[2],
      oomScoreAdj: adj ? parseInt(adj[1], 10) : null,
      anonRssKb: kb(fields, "anon-rss"),
      totalVmKb: kb(fields, "total-vm"),
    });
  }
  return kills;
}

/**
 * Drain `/dev/kmsg` without blocking. Each read returns one record; the
 * device answers EAGAIN once the ring buffer is exhausted and EPIPE when
 * records were overwritten under the reader, which only means some history
 * is gone. Null when the device cannot be opened (non-Linux, gVisor).
 */
export function readKmsg(path = "/dev/kmsg"): string | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  const chunks: string[] = [];
  const buffer = Buffer.alloc(KMSG_READ_BUFFER_BYTES);
  try {
    for (;;) {
      try {
        const bytes = readSync(fd, buffer);
        if (bytes <= 0) {
          break;
        }
        chunks.push(buffer.toString("utf-8", 0, bytes));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EPIPE") {
          continue;
        }
        break;
      }
    }
  } finally {
    closeSync(fd);
  }
  return chunks.join("");
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
  lastSeq: number;
}

function readCursor(path: string): Cursor | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as Cursor).lastSeq === "number"
    ) {
      return {
        bootId: (parsed as Cursor).bootId ?? null,
        lastSeq: (parsed as Cursor).lastSeq,
      };
    }
  } catch {
    // Missing or unreadable: report everything the kernel log still holds.
  }
  return null;
}

function writeCursor(path: string, cursor: Cursor): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(cursor));
}

export interface OomKillReporterOptions {
  readKmsg?: () => string | null;
  readBootId?: () => string | null;
  cursorPath?: string;
  record?: typeof recordWatchdogEvent;
}

export interface OomKillReporter {
  /**
   * Scan the kernel log when the cgroup counter moved, on the first tick
   * (to pick up the kill that restarted this monitor), and on a slow fallback
   * cadence. Returns the victims newly reported, for tests.
   */
  check(
    sample: ResourceSample,
    now: number,
    daemonPid: number | null,
  ): KmsgOomKill[];
}

export function createOomKillReporter(
  options: OomKillReporterOptions = {},
): OomKillReporter {
  const read = options.readKmsg ?? readKmsg;
  const bootId = options.readBootId ?? readBootId;
  const cursorPath =
    options.cursorPath ?? join(getMonitoringDataDir(), CURSOR_FILENAME);
  const record = options.record ?? recordWatchdogEvent;
  let lastScanAt: number | null = null;

  return {
    check(sample, now, daemonPid) {
      const counterMoved = (sample.deltas?.events?.oomKill ?? 0) > 0;
      if (
        lastScanAt != null &&
        !counterMoved &&
        now - lastScanAt < FALLBACK_SCAN_INTERVAL_MS
      ) {
        return [];
      }
      lastScanAt = now;

      const raw = read();
      if (raw == null) {
        return [];
      }
      const currentBootId = bootId();
      const cursor = readCursor(cursorPath);
      const sinceSeq =
        cursor != null && cursor.bootId === currentBootId ? cursor.lastSeq : -1;
      const all = parseKmsgOomKills(raw);
      const fresh = all.filter((kill) => kill.seq > sinceSeq);
      const lastSeq = Math.max(sinceSeq, ...all.map((kill) => kill.seq));
      if (lastSeq !== cursor?.lastSeq || currentBootId !== cursor?.bootId) {
        writeCursor(cursorPath, { bootId: currentBootId, lastSeq });
      }
      if (fresh.length === 0) {
        return [];
      }

      const killedDaemon =
        daemonPid != null && fresh.some((kill) => kill.pid === daemonPid);
      const detail = {
        victim_count: fresh.length,
        victims: fresh.slice(0, MAX_VICTIMS_IN_DETAIL).map((kill) => ({
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
      record({
        checkName: OOM_KILL_CHECK_NAME,
        value: fresh.length,
        detail,
      });
      log.warn(detail, "Kernel OOM kill in the assistant container");
      return fresh;
    },
  };
}
