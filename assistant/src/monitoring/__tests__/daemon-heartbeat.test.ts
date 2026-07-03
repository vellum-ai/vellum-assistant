/**
 * Tests for the daemon heartbeat writer/reader against the per-test workspace.
 * The config loader is mocked so the `monitoring.enabled` gate can be
 * exercised both ways.
 */

import { existsSync, rmSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import * as actualLoader from "../../config/loader.js";

// null → delegate to the real loader. bun's mock.module persists for the
// whole process, so the mock must turn itself into a passthrough once this
// suite finishes or it would poison later test files sharing the process.
let monitoringEnabled: boolean | null = true;

mock.module("../../config/loader.js", () => ({
  ...actualLoader,
  getConfigReadOnly: () =>
    monitoringEnabled == null
      ? actualLoader.getConfigReadOnly()
      : { monitoring: { enabled: monitoringEnabled } },
}));

afterAll(() => {
  monitoringEnabled = null;
});

const { getDaemonHeartbeatPath, readDaemonHeartbeat, touchDaemonHeartbeat } =
  await import("../daemon-heartbeat.js");

beforeEach(() => {
  monitoringEnabled = true;
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

  test("no-ops when monitoring is disabled", () => {
    monitoringEnabled = false;
    touchDaemonHeartbeat();
    expect(existsSync(getDaemonHeartbeatPath())).toBe(false);
    expect(readDaemonHeartbeat(Date.now())).toBeNull();
  });

  test("reader returns null for a missing file", () => {
    expect(readDaemonHeartbeat(Date.now())).toBeNull();
  });
});
