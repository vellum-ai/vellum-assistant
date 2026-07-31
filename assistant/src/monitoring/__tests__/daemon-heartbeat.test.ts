/**
 * Tests for the daemon heartbeat writer/reader against the per-test workspace.
 */

import { rmSync } from "node:fs";
import { beforeEach, describe, expect, test } from "bun:test";

import {
  getDaemonHeartbeatPath,
  readDaemonHeartbeat,
  touchDaemonHeartbeat,
} from "../daemon-heartbeat.js";

beforeEach(() => {
  try {
    rmSync(getDaemonHeartbeatPath());
  } catch {
    // Not written yet.
  }
});

describe("daemon heartbeat", () => {
  test("touch records this process's pid with a fresh mtime", () => {
    touchDaemonHeartbeat();

    const heartbeat = readDaemonHeartbeat(Date.now());
    expect(heartbeat).not.toBeNull();
    expect(heartbeat!.pid).toBe(process.pid);
    expect(heartbeat!.ageMs).toBeGreaterThanOrEqual(0);
    expect(heartbeat!.ageMs).toBeLessThan(5_000);
  });

  test("age grows with the reader's clock", () => {
    touchDaemonHeartbeat();
    const heartbeat = readDaemonHeartbeat(Date.now() + 7_000);
    // Filesystem mtime can be truncated below Date.now() at sub-ms precision.
    expect(heartbeat!.ageMs).toBeGreaterThanOrEqual(6_990);
  });

  test("recreates the file when it is removed between touches", () => {
    touchDaemonHeartbeat();
    rmSync(getDaemonHeartbeatPath());
    touchDaemonHeartbeat();
    expect(readDaemonHeartbeat(Date.now())).not.toBeNull();
  });

  test("reader returns null for a missing file", () => {
    expect(readDaemonHeartbeat(Date.now())).toBeNull();
  });
});
