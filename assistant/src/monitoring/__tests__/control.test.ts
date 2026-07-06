/**
 * Tests for the resource monitor process control surface.
 *
 * Focuses on the readiness wait (which gates whether `assistant monitoring
 * start` reports success) and the PID-file liveness probe, mirroring the
 * memory worker's worker-control tests.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import * as realLogger from "../../util/logger.js";
import * as realPlatform from "../../util/platform.js";

let tmpDir: string;
let pidPath: string;

mock.module("../../util/platform.js", () => ({
  ...realPlatform,
  getMonitoringPidPath: () => pidPath,
}));

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};
mock.module("../../util/logger.js", () => ({
  ...realLogger,
  getLogger: () => noopLogger,
  getCliLogger: () => noopLogger,
  getCurrentLogFilePath: () => join(tmpDir, "monitoring-test.log"),
}));

const {
  spawnMonitoringWorkerProcess,
  MonitoringWorkerSpawnError,
  probeMonitoringWorker,
  stopMonitoringWorkerProcess,
} = await import("../control.js");

function stubProcessKill(
  livePids: Set<number>,
  permissionErrorPids: Set<number> = new Set(),
): () => void {
  const original = process.kill.bind(process);
  process.kill = ((pid: number, signal?: string | number) => {
    if ((signal ?? 0) !== 0) {
      return true;
    }
    if (permissionErrorPids.has(pid)) {
      const err = new Error("kill EPERM") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    }
    if (livePids.has(pid)) {
      return true;
    }
    const err = new Error("kill ESRCH") as NodeJS.ErrnoException;
    err.code = "ESRCH";
    throw err;
  }) as typeof process.kill;
  return () => {
    process.kill = original;
  };
}

function stubBunSpawn(
  makeChild: () => {
    unref: () => void;
    kill: () => void;
    pid: number;
    exited?: Promise<unknown>;
  },
): () => void {
  const original = Bun.spawn;
  (Bun as { spawn: typeof Bun.spawn }).spawn = (() =>
    makeChild()) as unknown as typeof Bun.spawn;
  return () => {
    (Bun as { spawn: typeof Bun.spawn }).spawn = original;
  };
}

function neverExits(): Promise<unknown> {
  return new Promise(() => {});
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "monitoring-control-test-"));
  pidPath = join(tmpDir, "monitoring.pid");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("spawnMonitoringWorkerProcess", () => {
  test("returns the PID when the monitor writes its file immediately", async () => {
    const restore = stubBunSpawn(() => {
      writeFileSync(pidPath, "4242");
      return {
        unref: () => {},
        kill: () => {},
        pid: 4242,
        exited: neverExits(),
      };
    });
    try {
      const result = await spawnMonitoringWorkerProcess({
        pidWaitTimeoutMs: 1_000,
        pidPollIntervalMs: 10,
      });
      expect(result).toEqual({ pid: 4242, alreadyRunning: false });
    } finally {
      restore();
    }
  });

  test("fails fast when the child exits during startup", async () => {
    let killed = false;
    const restore = stubBunSpawn(() => ({
      unref: () => {},
      kill: () => {
        killed = true;
      },
      pid: 99,
      exited: Promise.resolve(1),
    }));
    try {
      await expect(
        spawnMonitoringWorkerProcess({
          pidWaitTimeoutMs: 10_000,
          pidPollIntervalMs: 10,
          terminateOnTimeout: true,
        }),
      ).rejects.toBeInstanceOf(MonitoringWorkerSpawnError);
      expect(killed).toBe(false);
    } finally {
      restore();
    }
  });

  test("terminates a still-alive child on timeout when asked", async () => {
    let killed = false;
    const restore = stubBunSpawn(() => ({
      unref: () => {},
      kill: () => {
        killed = true;
      },
      pid: 55,
      exited: neverExits(),
    }));
    try {
      await expect(
        spawnMonitoringWorkerProcess({
          pidWaitTimeoutMs: 150,
          pidPollIntervalMs: 20,
          terminateOnTimeout: true,
        }),
      ).rejects.toBeInstanceOf(MonitoringWorkerSpawnError);
      expect(killed).toBe(true);
    } finally {
      restore();
    }
  });

  test("reuses an already-running monitor without spawning", async () => {
    writeFileSync(pidPath, String(process.pid));
    let spawned = false;
    const restore = stubBunSpawn(() => {
      spawned = true;
      return { unref: () => {}, kill: () => {}, pid: 1, exited: neverExits() };
    });
    try {
      const result = await spawnMonitoringWorkerProcess({
        pidWaitTimeoutMs: 100,
      });
      expect(result).toEqual({ pid: process.pid, alreadyRunning: true });
      expect(spawned).toBe(false);
    } finally {
      restore();
    }
  });
});

describe("probeMonitoringWorker", () => {
  test("reports not_running when no PID file exists", () => {
    expect(probeMonitoringWorker()).toEqual({ status: "not_running" });
  });

  test("cleans up a stale PID file pointing at a dead process", () => {
    writeFileSync(pidPath, "999999");
    const restore = stubProcessKill(new Set());
    try {
      expect(probeMonitoringWorker()).toEqual({ status: "not_running" });
    } finally {
      restore();
    }
  });

  test("reports running (not throws) when the process exists but is not signalable (EPERM)", () => {
    writeFileSync(pidPath, "4321");
    const restore = stubProcessKill(new Set(), new Set([4321]));
    try {
      expect(probeMonitoringWorker()).toEqual({ status: "running", pid: 4321 });
    } finally {
      restore();
    }
  });
});

describe("stopMonitoringWorkerProcess", () => {
  test("is a no-op when the monitor is not running", () => {
    expect(stopMonitoringWorkerProcess()).toEqual({ status: "not_running" });
  });

  test("signals a running monitor and reports its prior state", () => {
    writeFileSync(pidPath, "4321");
    const signalled: Array<[number, string | number | undefined]> = [];
    const original = process.kill.bind(process);
    process.kill = ((pid: number, signal?: string | number) => {
      if ((signal ?? 0) === 0) {
        return true;
      } // liveness probe
      signalled.push([pid, signal]);
      return true;
    }) as typeof process.kill;
    try {
      expect(stopMonitoringWorkerProcess()).toEqual({
        status: "running",
        pid: 4321,
      });
      expect(signalled).toEqual([[4321, "SIGTERM"]]);
    } finally {
      process.kill = original;
    }
  });
});
