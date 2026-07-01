/**
 * Tests for the resource monitor control routes (start / stop / status).
 *
 * The route handlers run inside the daemon and own the monitor process. We mock
 * resource-monitor-control, the config loader, and the sample ring buffer so the
 * tests assert handler behaviour:
 *   - start spawns as a daemon child (detached:false), enables the flag only on
 *     success, and throws on spawn failure (flag untouched).
 *   - stop disables the flag and signals the monitor.
 *   - status reports the monitor process, the flag, and the latest sample.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import * as actualLoader from "../../../config/loader.js";
import type { ResourceSample } from "../../../monitoring/resource-sampler.js";
import { getResourceMonitorPidPath } from "../../../util/platform.js";

class FakeSpawnError extends Error {}

let spawnImpl: () => Promise<{ pid: number; alreadyRunning: boolean }>;
let spawnArgs: Array<{ detached?: boolean; terminateOnTimeout?: boolean }> = [];
let stopImpl: () => { status: "running" | "not_running"; pid?: number };
/** Records the `resourceMonitor.enabled` values written via saveRawConfig. */
let enabledCalls: boolean[] = [];
let monitorProbe: { status: "running" | "not_running"; pid?: number } = {
  status: "not_running",
};
let configEnabled = false;
let latestSample: ResourceSample | null = null;

mock.module("../../../monitoring/resource-monitor-control.js", () => ({
  ResourceMonitorSpawnError: FakeSpawnError,
  spawnResourceMonitorProcess: async (opts: {
    detached?: boolean;
    terminateOnTimeout?: boolean;
  }) => {
    spawnArgs.push(opts);
    return spawnImpl();
  },
  stopResourceMonitorProcess: () => stopImpl(),
  probeResourceMonitor: () => monitorProbe,
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
    resourceMonitor: { enabled: configEnabled, ringBufferSize: 4000 },
  }),
  loadRawConfig: () => ({}),
  saveRawConfig: (cfg: { resourceMonitor?: { enabled?: boolean } }) => {
    enabledCalls.push(cfg.resourceMonitor?.enabled === true);
  },
}));

const { ROUTES } = await import("../resource-monitor-routes.js");

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
  monitorProbe = { status: "not_running" };
  configEnabled = false;
  latestSample = null;
});

describe("resource_monitor_start", () => {
  test("spawns as a daemon child and enables the flag on success", async () => {
    spawnImpl = async () => ({ pid: 4242, alreadyRunning: false });

    const res = await handler("resource_monitor_start")();

    expect(spawnArgs).toEqual([{ detached: false, terminateOnTimeout: true }]);
    expect(enabledCalls).toEqual([true]);
    expect(res).toEqual({
      pid: 4242,
      alreadyRunning: false,
      monitorEnabled: true,
      pidPath: getResourceMonitorPidPath(),
    });
  });

  test("reports an already-running monitor without re-spawning", async () => {
    spawnImpl = async () => ({ pid: 99, alreadyRunning: true });

    const res = await handler("resource_monitor_start")();

    expect(res).toMatchObject({ pid: 99, alreadyRunning: true });
    expect(enabledCalls).toEqual([true]);
  });

  test("throws and leaves the flag untouched when the spawn fails", async () => {
    spawnImpl = async () => {
      throw new FakeSpawnError("monitor exited during startup");
    };

    await expect(handler("resource_monitor_start")()).rejects.toThrow(
      "monitor exited during startup",
    );
    expect(enabledCalls).toEqual([]);
  });
});

describe("resource_monitor_stop", () => {
  test("disables the flag and reports a signalled running monitor", async () => {
    stopImpl = () => ({ status: "running", pid: 555 });

    const res = await handler("resource_monitor_stop")();

    expect(enabledCalls).toEqual([false]);
    expect(res).toEqual({
      monitorWasRunning: true,
      pid: 555,
      monitorEnabled: false,
    });
  });

  test("disables the flag and succeeds when no monitor is running", async () => {
    stopImpl = () => ({ status: "not_running" });

    const res = await handler("resource_monitor_stop")();

    expect(enabledCalls).toEqual([false]);
    expect(res).toEqual({ monitorWasRunning: false, monitorEnabled: false });
  });
});

describe("resource_monitor_status", () => {
  test("reports a running monitor with the enabled flag and no sample yet", async () => {
    monitorProbe = { status: "running", pid: 321 };
    configEnabled = true;
    latestSample = null;

    const res = await handler("resource_monitor_status")();

    expect(res).toMatchObject({
      status: "running",
      pid: 321,
      monitorEnabled: true,
      latestSample: null,
    });
  });

  test("surfaces the most recent persisted sample", async () => {
    monitorProbe = { status: "running", pid: 321 };
    configEnabled = true;
    latestSample = {
      ts: 1000,
      memory: {
        currentBytes: 6 * 1024 * 1024 * 1024,
        limitBytes: 8 * 1024 * 1024 * 1024,
        peakBytes: 7 * 1024 * 1024 * 1024,
        ratio: 0.75,
      },
      events: { low: 0, high: 0, max: 2, oom: 0, oomKill: 0 },
      disk: { path: "/workspace", usedMb: 100, totalMb: 1000, freeMb: 900 },
    };

    const res = await handler("resource_monitor_status")();

    expect(res).toMatchObject({
      monitorEnabled: true,
      latestSample: { ts: 1000, memory: { ratio: 0.75 } },
    });
  });

  test("reports not_running with the flag off", async () => {
    monitorProbe = { status: "not_running" };
    configEnabled = false;

    const res = await handler("resource_monitor_status")();

    expect(res).toMatchObject({
      status: "not_running",
      monitorEnabled: false,
    });
    expect(res.pid).toBeUndefined();
  });
});
