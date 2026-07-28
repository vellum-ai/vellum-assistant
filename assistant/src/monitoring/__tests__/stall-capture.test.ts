/**
 * Tests for the monitor-side daemon stall capture. The heartbeat file is
 * written directly (bypassing the daemon-side writer) so staleness and pid
 * liveness can be controlled; kernel-stack/proc-state fields are
 * environment-dependent and only asserted for shape.
 */

import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";

import { getMonitoringDataDir } from "../../util/platform.js";
import { getDaemonHeartbeatPath } from "../daemon-heartbeat.js";
import type { ResourceSample } from "../resource-sample-types.js";
import {
  createStallCaptureMonitor,
  findRecentStallCapture,
  parseProcStatState,
} from "../stall-capture.js";

function makeSample(ts: number): ResourceSample {
  return {
    ts,
    memory: null,
    memoryStat: null,
    reclaim: null,
    cpu: null,
    events: null,
    deltas: null,
    disk: null,
    activeConversations: null,
  };
}

function writeHeartbeat(pid: number): void {
  const path = getDaemonHeartbeatPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, String(pid));
}

function stallFiles(): string[] {
  try {
    return readdirSync(join(getMonitoringDataDir(), "snapshots")).filter((f) =>
      f.startsWith("stall-"),
    );
  } catch {
    return [];
  }
}

let dataDir: string;

beforeEach(() => {
  dataDir = getMonitoringDataDir();
  for (const f of stallFiles()) {
    rmSync(join(dataDir, "snapshots", f));
  }
});

describe("parseProcStatState", () => {
  test("extracts the state field after the comm", () => {
    expect(parseProcStatState("1 (bun) S 0 1 1 0 -1 4194560")).toBe("S");
    expect(parseProcStatState("7 (tricky (name) x) D 1 7 7 0 -1")).toBe("D");
  });

  test("returns null on malformed content", () => {
    expect(parseProcStatState("")).toBeNull();
    expect(parseProcStatState("1 (bun)")).toBeNull();
    expect(parseProcStatState("1 (bun) 123 456")).toBeNull();
  });
});

describe("createStallCaptureMonitor", () => {
  test("captures when the heartbeat is stale and the daemon is alive", async () => {
    writeHeartbeat(process.pid);
    const monitor = createStallCaptureMonitor(dataDir);
    const now = Date.now() + 10_000; // heartbeat is 10s old from this clock

    monitor.check(makeSample(now), now);

    expect(stallFiles()).toHaveLength(1);
    const capture = await findRecentStallCapture(now - 1_000);
    expect(capture).not.toBeNull();
    expect(capture!.daemonPid).toBe(process.pid);
    expect(capture!.heartbeatAgeMs).toBeGreaterThanOrEqual(6_000);
    expect(capture!.sample.ts).toBe(now);
    // Environment-dependent (root-only / Linux-only) — shape, not value.
    expect(capture).toHaveProperty("kernelStack");
    expect(capture).toHaveProperty("processState");
  });

  test("does not capture on a fresh heartbeat", () => {
    writeHeartbeat(process.pid);
    const monitor = createStallCaptureMonitor(dataDir);
    monitor.check(makeSample(0), Date.now());
    expect(stallFiles()).toHaveLength(0);
  });

  test("cooldown bounds captures during a sustained stall", () => {
    writeHeartbeat(process.pid);
    const monitor = createStallCaptureMonitor(dataDir);
    const now = Date.now() + 10_000;
    monitor.check(makeSample(now), now);
    monitor.check(makeSample(now + 250), now + 250);
    expect(stallFiles()).toHaveLength(1);
  });

  test("skips a dead daemon (stopped, not stalled)", () => {
    // A pid far above any real allocation; process.kill(pid, 0) throws.
    writeHeartbeat(2 ** 30);
    const monitor = createStallCaptureMonitor(dataDir);
    monitor.check(makeSample(0), Date.now() + 10_000);
    expect(stallFiles()).toHaveLength(0);
  });
});

describe("findRecentStallCapture", () => {
  test("returns null when the newest capture predates the window", async () => {
    writeHeartbeat(process.pid);
    const monitor = createStallCaptureMonitor(dataDir);
    const now = Date.now() + 10_000;
    monitor.check(makeSample(now), now);

    expect(await findRecentStallCapture(now + 1)).toBeNull();
  });

  test("returns null when no captures exist", async () => {
    expect(await findRecentStallCapture(0)).toBeNull();
  });
});
