/**
 * Daemon event-loop heartbeat, written for the resource monitor.
 *
 * The daemon's watchdog tick touches this file once per second from the main
 * event loop — a single mtime update, no sysfs reads. Because the touch runs
 * on the loop, a stale mtime *is* a blocked event loop, observable from the
 * monitor's own OS process while the stall is still in progress. The file
 * content is the daemon's pid, so the monitor knows which process's main
 * thread to inspect.
 *
 * Writes never throw — the heartbeat is diagnostics and must never break a
 * tick.
 */

import {
  mkdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { getMonitoringDataDir } from "../util/platform.js";

const HEARTBEAT_FILE = "daemon-heartbeat";

export function getDaemonHeartbeatPath(): string {
  return join(getMonitoringDataDir(), HEARTBEAT_FILE);
}

let pidWritten = false;

/** Daemon-side: refresh the heartbeat mtime. Call from the watchdog tick. */
export function touchDaemonHeartbeat(): void {
  try {
    const path = getDaemonHeartbeatPath();
    // First touch of this process rewrites the content so the recorded pid is
    // ours, not a previous daemon's.
    if (!pidWritten) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, String(process.pid));
      pidWritten = true;
      return;
    }
    const now = new Date();
    try {
      utimesSync(path, now, now);
    } catch {
      // File removed out from under us — recreate.
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, String(process.pid));
    }
  } catch {
    // Diagnostics-only — never let the heartbeat break a tick.
  }
}

export interface DaemonHeartbeat {
  pid: number;
  /** Milliseconds since the daemon's event loop last touched the file. */
  ageMs: number;
}

/**
 * Monitor-side: the heartbeat's pid and age, or null when the file is missing
 * or malformed.
 */
export function readDaemonHeartbeat(now: number): DaemonHeartbeat | null {
  try {
    const path = getDaemonHeartbeatPath();
    const mtimeMs = statSync(path).mtimeMs;
    const pid = parseInt(readFileSync(path, "utf-8").trim(), 10);
    if (!Number.isFinite(pid) || pid <= 0) {
      return null;
    }
    return { pid, ageMs: Math.max(0, now - mtimeMs) };
  } catch {
    return null;
  }
}
