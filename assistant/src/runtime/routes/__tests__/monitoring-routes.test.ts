/**
 * Tests for the resource monitor control routes (start / stop / status).
 *
 * The route handlers run inside the daemon and own the monitor process. We mock
 * monitoring-control, the config loader, and the sample ring buffer so the
 * tests assert handler behaviour:
 *   - start spawns as a daemon child (detached:false) and throws on spawn
 *     failure.
 *   - stop signals the monitor (a runtime pause — the daemon respawns it at
 *     the next boot).
 *   - status reports the monitor process and the latest sample.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import * as actualLoader from "../../../config/loader.js";
import type { ResourceSample } from "../../../monitoring/resource-sample-types.js";
import { getMonitoringPidPath } from "../../../util/platform.js";

class FakeSpawnError extends Error {}

let spawnImpl: () => Promise<{ pid: number; alreadyRunning: boolean }>;
let spawnArgs: Array<{ detached?: boolean; terminateOnTimeout?: boolean }> = [];
let stopImpl: () => { status: "running" | "not_running"; pid?: number };
let monitoringProbe: { status: "running" | "not_running"; pid?: number } = {
  status: "not_running",
};
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
    monitoring: { ringBufferSize: 4000 },
  }),
}));

const { ROUTES } = await import("../monitoring-routes.js");

function handler(operationId: string) {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) {
    throw new Error(`route ${operationId} not registered`);
  }
  return route.handler as () => Promise<Record<string, unknown>>;
}

beforeEach(() => {
  spawnArgs = [];
  spawnImpl = async () => ({ pid: 4242, alreadyRunning: false });
  stopImpl = () => ({ status: "not_running" });
  monitoringProbe = { status: "not_running" };
  latestSample = null;
});

describe("monitoring_start", () => {
  test("spawns as a daemon child", async () => {
    spawnImpl = async () => ({ pid: 4242, alreadyRunning: false });

    const res = await handler("monitoring_start")();

    expect(spawnArgs).toEqual([{ detached: false, terminateOnTimeout: true }]);
    expect(res).toEqual({
      pid: 4242,
      alreadyRunning: false,
      pidPath: getMonitoringPidPath(),
    });
  });

  test("reports an already-running monitor without re-spawning", async () => {
    spawnImpl = async () => ({ pid: 99, alreadyRunning: true });

    const res = await handler("monitoring_start")();

    expect(res).toMatchObject({ pid: 99, alreadyRunning: true });
  });

  test("throws when the spawn fails", async () => {
    spawnImpl = async () => {
      throw new FakeSpawnError("monitor exited during startup");
    };

    await expect(handler("monitoring_start")()).rejects.toThrow(
      "monitor exited during startup",
    );
  });
});

describe("monitoring_stop", () => {
  test("reports a signalled running monitor", async () => {
    stopImpl = () => ({ status: "running", pid: 555 });

    const res = await handler("monitoring_stop")();

    expect(res).toEqual({
      monitoringWasRunning: true,
      pid: 555,
    });
  });

  test("succeeds when no monitor is running", async () => {
    stopImpl = () => ({ status: "not_running" });

    const res = await handler("monitoring_stop")();

    expect(res).toEqual({
      monitoringWasRunning: false,
    });
  });
});

describe("monitoring_status", () => {
  test("reports a running monitor with no sample yet", async () => {
    monitoringProbe = { status: "running", pid: 321 };
    latestSample = null;

    const res = await handler("monitoring_status")();

    expect(res).toMatchObject({
      status: "running",
      pid: 321,
      latestSample: null,
    });
  });

  test("surfaces the most recent persisted sample", async () => {
    monitoringProbe = { status: "running", pid: 321 };
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
      cpu: {
        usageUsec: 4_500_000_000,
        userUsec: 3_000_000_000,
        systemUsec: 1_500_000_000,
        nrPeriods: 120_000,
        nrThrottled: 350,
        throttledUsec: 21_000_000,
      },
      events: { low: 0, high: 0, max: 2, oom: 0, oomKill: 0 },
      deltas: {
        events: { low: 0, high: 0, max: 1, oom: 0, oomKill: 0 },
        reclaim: {
          pgscanDirect: 40_000,
          pgstealDirect: 35_000,
          workingsetRefaultFile: 300,
        },
        cpu: {
          usageUsec: 250_000,
          userUsec: 100_000,
          systemUsec: 150_000,
          nrPeriods: 1,
          nrThrottled: 1,
          throttledUsec: 250_000,
        },
      },
      disk: { path: "/workspace", usedMb: 100, totalMb: 1000, freeMb: 900 },
      activeConversations: [
        {
          conversationId: "conv-xyz",
          title: "Memory consolidation",
          originChannel: null,
          originInterface: null,
          processingStartedAt: 900,
        },
      ],
    };

    const res = await handler("monitoring_status")();

    expect(res).toMatchObject({
      latestSample: { ts: 1000, memory: { ratio: 0.75 } },
    });
  });

  test("normalizes a legacy sample that predates newer fields", async () => {
    monitoringProbe = { status: "running", pid: 321 };
    // A record persisted by an older monitor: only the original fields.
    latestSample = {
      ts: 500,
      memory: {
        currentBytes: 1024,
        limitBytes: 2048,
        peakBytes: null,
        ratio: 0.5,
      },
      events: null,
      disk: null,
    } as ResourceSample;

    const res = await handler("monitoring_status")();

    expect(res.latestSample).toEqual({
      ts: 500,
      memory: {
        currentBytes: 1024,
        limitBytes: 2048,
        peakBytes: null,
        ratio: 0.5,
      },
      memoryStat: null,
      reclaim: null,
      cpu: null,
      events: null,
      deltas: null,
      disk: null,
      activeConversations: null,
    });
  });

  test("reports not_running when the monitor is down", async () => {
    monitoringProbe = { status: "not_running" };

    const res = await handler("monitoring_status")();

    expect(res).toMatchObject({
      status: "not_running",
    });
    expect(res.pid).toBeUndefined();
  });
});
