/**
 * Tests for the resource monitor control routes (start / stop / status).
 *
 * The route handlers run inside the daemon and own the monitor process. We mock
 * monitoring-control, the config loader, and the sample ring buffer so the
 * tests assert handler behaviour:
 *   - start spawns as a daemon child (detached:false), enables the flag only on
 *     success, and throws on spawn failure (flag untouched).
 *   - stop disables the flag and signals the monitor.
 *   - status reports the monitor process, the flag, and the latest sample.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import * as actualLoader from "../../../config/loader.js";
import type { ResourceSample } from "../../../monitoring/resource-sampler.js";
import { getMonitoringPidPath } from "../../../util/platform.js";

class FakeSpawnError extends Error {}

let spawnImpl: () => Promise<{ pid: number; alreadyRunning: boolean }>;
let spawnArgs: Array<{ detached?: boolean; terminateOnTimeout?: boolean }> = [];
let stopImpl: () => { status: "running" | "not_running"; pid?: number };
/** Records the `monitoring.enabled` values written via saveRawConfig. */
let enabledCalls: boolean[] = [];
let monitoringProbe: { status: "running" | "not_running"; pid?: number } = {
  status: "not_running",
};
let configEnabled = false;
let latestSample: ResourceSample | null = null;

mock.module("../../../monitoring/control.js", () => ({
  MonitoringWorkerSpawnError: FakeSpawnError,
  spawnMonitoringWorkerProcess: async (opts: {
    detached?: boolean;
    terminateOnTimeout?: boolean;
  }) => {
    spawnArgs.push(opts);
    return spawnImpl();
  },
  stopMonitoringWorkerProcess: () => stopImpl(),
  probeMonitoringWorker: () => monitoringProbe,
}));

mock.module("../../../monitoring/sample-ring-buffer.js", () => ({
  SampleRingBuffer: class {
    readLast() {
      return latestSample;
    }
  },
}));

mock.module("../../../config/loader.js", () => ({
  ...actualLoader,
  getConfigReadOnly: () => ({
    monitoring: { enabled: configEnabled, ringBufferSize: 4000 },
  }),
  loadRawConfig: () => ({}),
  saveRawConfig: (cfg: { monitoring?: { enabled?: boolean } }) => {
    enabledCalls.push(cfg.monitoring?.enabled === true);
  },
}));

const { ROUTES } = await import("../monitoring-routes.js");

function handler(operationId: string) {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) throw new Error(`route ${operationId} not registered`);
  return route.handler as () => Promise<Record<string, unknown>>;
}

beforeEach(() => {
  spawnArgs = [];
  enabledCalls = [];
  spawnImpl = async () => ({ pid: 4242, alreadyRunning: false });
  stopImpl = () => ({ status: "not_running" });
  monitoringProbe = { status: "not_running" };
  configEnabled = false;
  latestSample = null;
});

describe("monitoring_start", () => {
  test("spawns as a daemon child and enables the flag on success", async () => {
    spawnImpl = async () => ({ pid: 4242, alreadyRunning: false });

    const res = await handler("monitoring_start")();

    expect(spawnArgs).toEqual([{ detached: false, terminateOnTimeout: true }]);
    expect(enabledCalls).toEqual([true]);
    expect(res).toEqual({
      pid: 4242,
      alreadyRunning: false,
      monitoringEnabled: true,
      pidPath: getMonitoringPidPath(),
    });
  });

  test("reports an already-running monitor without re-spawning", async () => {
    spawnImpl = async () => ({ pid: 99, alreadyRunning: true });

    const res = await handler("monitoring_start")();

    expect(res).toMatchObject({ pid: 99, alreadyRunning: true });
    expect(enabledCalls).toEqual([true]);
  });

  test("throws and leaves the flag untouched when the spawn fails", async () => {
    spawnImpl = async () => {
      throw new FakeSpawnError("monitor exited during startup");
    };

    await expect(handler("monitoring_start")()).rejects.toThrow(
      "monitor exited during startup",
    );
    expect(enabledCalls).toEqual([]);
  });
});

describe("monitoring_stop", () => {
  test("disables the flag and reports a signalled running monitor", async () => {
    stopImpl = () => ({ status: "running", pid: 555 });

    const res = await handler("monitoring_stop")();

    expect(enabledCalls).toEqual([false]);
    expect(res).toEqual({
      monitoringWasRunning: true,
      pid: 555,
      monitoringEnabled: false,
    });
  });

  test("disables the flag and succeeds when no monitor is running", async () => {
    stopImpl = () => ({ status: "not_running" });

    const res = await handler("monitoring_stop")();

    expect(enabledCalls).toEqual([false]);
    expect(res).toEqual({
      monitoringWasRunning: false,
      monitoringEnabled: false,
    });
  });
});

describe("monitoring_status", () => {
  test("reports a running monitor with the enabled flag and no sample yet", async () => {
    monitoringProbe = { status: "running", pid: 321 };
    configEnabled = true;
    latestSample = null;

    const res = await handler("monitoring_status")();

    expect(res).toMatchObject({
      status: "running",
      pid: 321,
      monitoringEnabled: true,
      latestSample: null,
    });
  });

  test("surfaces the most recent persisted sample", async () => {
    monitoringProbe = { status: "running", pid: 321 };
    configEnabled = true;
    latestSample = {
      ts: 1000,
      memory: {
        currentBytes: 6 * 1024 * 1024 * 1024,
        limitBytes: 8 * 1024 * 1024 * 1024,
        peakBytes: 7 * 1024 * 1024 * 1024,
        ratio: 0.75,
      },
      memoryStat: {
        anonBytes: 4 * 1024 * 1024 * 1024,
        fileBytes: 1024 * 1024 * 1024,
        kernelBytes: 512 * 1024 * 1024,
        slabReclaimableBytes: 400 * 1024 * 1024,
        slabUnreclaimableBytes: 100 * 1024 * 1024,
        unevictableBytes: 4 * 1024 * 1024 * 1024 + 100 * 1024 * 1024,
        reclaimableBytes: 1024 * 1024 * 1024 + 400 * 1024 * 1024,
      },
      reclaim: {
        pgscanDirect: 7_000_000,
        pgstealDirect: 6_500_000,
        workingsetRefaultFile: 123_456,
      },
      events: { low: 0, high: 0, max: 2, oom: 0, oomKill: 0 },
      deltas: {
        events: { low: 0, high: 0, max: 1, oom: 0, oomKill: 0 },
        reclaim: {
          pgscanDirect: 40_000,
          pgstealDirect: 35_000,
          workingsetRefaultFile: 300,
        },
      },
      disk: { path: "/workspace", usedMb: 100, totalMb: 1000, freeMb: 900 },
    };

    const res = await handler("monitoring_status")();

    expect(res).toMatchObject({
      monitoringEnabled: true,
      latestSample: { ts: 1000, memory: { ratio: 0.75 } },
    });
  });

  test("reports not_running with the flag off", async () => {
    monitoringProbe = { status: "not_running" };
    configEnabled = false;

    const res = await handler("monitoring_status")();

    expect(res).toMatchObject({
      status: "not_running",
      monitoringEnabled: false,
    });
    expect(res.pid).toBeUndefined();
  });
});
