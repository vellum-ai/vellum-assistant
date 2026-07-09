/**
 * Mid-stall capture of the daemon's main thread, taken by the resource
 * monitor.
 *
 * The daemon's event-loop watchdog can only report a freeze *after* the loop
 * unblocks — by then the interesting kernel state (D-state, a reclaim or futex
 * stack) is gone, and if the freeze ends in an OOM SIGKILL the report never
 * happens at all. The monitor process is unaffected by the freeze, so when it
 * sees the daemon heartbeat go stale it captures the daemon main thread's
 * kernel stack and process state *while the stall is in progress*, together
 * with the current resource sample (whose memory.stat / reclaim / cpu.stat
 * deltas classify the stall), and persists it to the snapshots directory.
 *
 * The daemon's watchdog report attaches the matching capture afterwards via
 * {@link findRecentStallCapture}.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { getLogger } from "../util/logger.js";
import { getMonitoringDataDir } from "../util/platform.js";
import { readDaemonHeartbeat } from "./daemon-heartbeat.js";
import { prunePrefixedJsonFiles } from "./prune-snapshots.js";
import type { ResourceSample } from "./resource-sample-types.js";

const log = getLogger("stall-capture");

const SNAPSHOTS_DIR = "snapshots";
const STALL_CAPTURE_PREFIX = "stall-";
/** Cap on retained stall captures so forensics can't fill the volume. */
const MAX_STALL_CAPTURES = 20;

/**
 * Heartbeat age that counts as a stalled event loop. Mirrors the watchdog's
 * detection floor: its default report threshold (5s of blockage) plus the 1s
 * tick interval the heartbeat is refreshed on.
 */
const STALL_AGE_THRESHOLD_MS = 6_000;

/** Minimum spacing between captures, mirroring the watchdog report cooldown. */
const CAPTURE_COOLDOWN_MS = 30_000;

/** Extract the state field (3rd) from `/proc/<pid>/stat`; comm may contain spaces. */
export function parseProcStatState(raw: string): string | null {
  const afterComm = raw.slice(raw.lastIndexOf(")") + 1).trim();
  const state = afterComm.split(/\s+/)[0];
  return state && /^[A-Za-z]$/.test(state) ? state : null;
}

function readProcFile(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface StallCapture {
  ts: number;
  daemonPid: number;
  /** How long the daemon's event loop had been silent at capture time. */
  heartbeatAgeMs: number;
  /**
   * Kernel stack of the daemon's main thread mid-stall
   * (`/proc/<pid>/task/<pid>/stack`, root-only; null when unreadable).
   */
  kernelStack: string | null;
  /** Daemon state from `/proc/<pid>/stat` (R running, S sleeping, D uninterruptible). */
  processState: string | null;
  /** The resource sample taken this tick — its deltas classify the stall. */
  sample: ResourceSample;
}

export interface StallCaptureMonitor {
  /** Evaluate the heartbeat and capture if the daemon looks stalled. */
  check: (sample: ResourceSample, now: number) => void;
}

export function createStallCaptureMonitor(
  dataDir: string,
): StallCaptureMonitor {
  const snapshotsDir = join(dataDir, SNAPSHOTS_DIR);
  let lastCaptureAt = 0;

  return {
    check: (sample: ResourceSample, now: number): void => {
      const heartbeat = readDaemonHeartbeat(now);
      if (heartbeat == null || heartbeat.ageMs < STALL_AGE_THRESHOLD_MS) {
        return;
      }
      if (now - lastCaptureAt < CAPTURE_COOLDOWN_MS) {
        return;
      }
      // A dead daemon leaves a stale heartbeat forever; that's a shutdown,
      // not a stall.
      if (!isProcessAlive(heartbeat.pid)) {
        return;
      }
      lastCaptureAt = now;

      const statRaw = readProcFile(`/proc/${heartbeat.pid}/stat`);
      const capture: StallCapture = {
        ts: now,
        daemonPid: heartbeat.pid,
        heartbeatAgeMs: heartbeat.ageMs,
        // The main thread's tid equals the pid.
        kernelStack: readProcFile(
          `/proc/${heartbeat.pid}/task/${heartbeat.pid}/stack`,
        ),
        processState: statRaw != null ? parseProcStatState(statRaw) : null,
        sample,
      };

      try {
        // A stall can precede the first high-memory snapshot; the nested
        // snapshots dir may not exist yet.
        mkdirSync(snapshotsDir, { recursive: true });
        writeFileSync(
          join(snapshotsDir, `${STALL_CAPTURE_PREFIX}${now}.json`),
          JSON.stringify(capture, null, 2),
        );
        prunePrefixedJsonFiles(
          snapshotsDir,
          STALL_CAPTURE_PREFIX,
          MAX_STALL_CAPTURES,
        );
        log.warn(
          {
            daemonPid: heartbeat.pid,
            heartbeatAgeMs: heartbeat.ageMs,
            processState: capture.processState,
            pgscanDirectDelta: sample.deltas?.reclaim?.pgscanDirect,
            throttledUsecDelta: sample.deltas?.cpu?.throttledUsec,
          },
          "Captured daemon stall (event loop heartbeat stale)",
        );
      } catch (err) {
        log.warn({ err }, "Failed to write daemon stall capture");
      }
    },
  };
}

/**
 * Newest stall capture whose timestamp is at or after `sinceTs`, or null.
 * Used by the daemon's watchdog report to attach the monitor's mid-stall
 * capture for the block window it is reporting.
 */
export async function findRecentStallCapture(
  sinceTs: number,
): Promise<StallCapture | null> {
  const snapshotsDir = join(getMonitoringDataDir(), SNAPSHOTS_DIR);
  let files: string[];
  try {
    files = (await readdir(snapshotsDir)).filter(
      (f) => f.startsWith(STALL_CAPTURE_PREFIX) && f.endsWith(".json"),
    );
  } catch {
    return null;
  }
  // Filenames embed the millisecond timestamp; lexical sort is chronological.
  files.sort();
  const newest = files[files.length - 1];
  if (newest == null) {
    return null;
  }
  const ts = parseInt(
    newest.slice(STALL_CAPTURE_PREFIX.length, -".json".length),
    10,
  );
  if (!Number.isFinite(ts) || ts < sinceTs) {
    return null;
  }
  try {
    const raw = await readFile(join(snapshotsDir, newest), "utf-8");
    return JSON.parse(raw) as StallCapture;
  } catch {
    return null;
  }
}
