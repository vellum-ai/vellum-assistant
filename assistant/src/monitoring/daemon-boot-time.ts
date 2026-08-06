/**
 * Daemon boot timestamp, persisted once per process for the resource monitor.
 *
 * The daemon records the wall-clock time it started so out-of-process recovery
 * (which runs in the monitor process) can tell state left by a previous daemon
 * from state the current daemon owns. A conversation's `processing_started_at`
 * set before this timestamp belongs to a process that has since exited and is
 * safe to clear; one set at or after it belongs to a live turn in the running
 * daemon and must be left alone.
 *
 * Writes never throw — a missing or malformed boot-time file makes recovery
 * fence conservatively (skip) rather than break the daemon.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getMonitoringDataDir } from "../util/platform.js";

const BOOT_TIME_FILE = "daemon-boot-time";

export function getDaemonBootTimePath(): string {
  return join(getMonitoringDataDir(), BOOT_TIME_FILE);
}

/**
 * Daemon-side: record this process's boot time. Call once, early in startup —
 * before the daemon can begin any turn — so every persisted
 * `processing_started_at` from this process is at or after it.
 */
export function recordDaemonBootTime(bootTimeMs: number): void {
  try {
    const path = getDaemonBootTimePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, String(bootTimeMs));
  } catch {
    // Best-effort — recovery fences conservatively when this is absent.
  }
}

/**
 * Monitor-side: the recorded daemon boot time in epoch ms, or null when the
 * file is missing or malformed.
 */
export function readDaemonBootTime(): number | null {
  try {
    const raw = readFileSync(getDaemonBootTimePath(), "utf-8").trim();
    const ms = parseInt(raw, 10);
    if (!Number.isFinite(ms) || ms <= 0) {
      return null;
    }
    return ms;
  } catch {
    return null;
  }
}
