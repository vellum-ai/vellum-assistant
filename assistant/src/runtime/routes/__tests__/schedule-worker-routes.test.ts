/**
 * Tests for the schedule worker control routes (start / stop / status).
 *
 * The route handlers run inside the daemon and own the worker process. We mock
 * schedule worker-control and the config loader so the tests assert handler
 * behaviour:
 *   - start spawns as a daemon child (detached:false), enables the flag only on
 *     success, and throws on spawn failure (flag untouched).
 *   - stop disables the flag and signals the worker.
 *   - status reports the worker process, the flag, and the in-process runner.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { setConfig } from "../../../__tests__/helpers/set-config.js";
import { loadRawConfig } from "../../../config/loader.js";
import { getScheduleWorkerPidPath } from "../../../util/platform.js";

class FakeSpawnError extends Error {}

let spawnImpl: () => Promise<{ pid: number; alreadyRunning: boolean }>;
let spawnArgs: Array<{ detached?: boolean; terminateOnTimeout?: boolean }> = [];
let stopImpl: () => { status: "running" | "not_running"; pid?: number };
let workerProbe: { status: "running" | "not_running"; pid?: number } = {
  status: "not_running",
};
let configEnabled = false;

/** Seed the schedule-worker flag the routes read into the real config.json. */
function seedSchedules(): void {
  setConfig("schedules", { worker: { enabled: configEnabled } });
}

/** Read the persisted `schedules.worker.enabled` flag back from the file. */
function persistedWorkerEnabled(): boolean {
  const schedules = loadRawConfig().schedules as
    | { worker?: { enabled?: boolean } }
    | undefined;
  return schedules?.worker?.enabled === true;
}

mock.module("../../../schedule/worker-control.js", () => ({
  ScheduleWorkerSpawnError: FakeSpawnError,
  spawnScheduleWorkerProcess: async (opts: {
    detached?: boolean;
    terminateOnTimeout?: boolean;
  }) => {
    spawnArgs.push(opts);
    return spawnImpl();
  },
  stopScheduleWorkerProcess: () => stopImpl(),
  probeScheduleWorker: () => workerProbe,
}));

const { ROUTES } = await import("../schedule-worker-routes.js");

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
  workerProbe = { status: "not_running" };
  configEnabled = false;
  seedSchedules();
});

describe("schedules_worker_start", () => {
  test("spawns as a daemon child and enables the flag on success", async () => {
    spawnImpl = async () => ({ pid: 4242, alreadyRunning: false });

    const res = await handler("schedules_worker_start")();

    expect(spawnArgs).toEqual([{ detached: false, terminateOnTimeout: true }]);
    expect(persistedWorkerEnabled()).toBe(true);
    expect(res).toEqual({
      pid: 4242,
      alreadyRunning: false,
      workerEnabled: true,
      pidPath: getScheduleWorkerPidPath(),
    });
  });

  test("reports an already-running worker without re-spawning", async () => {
    spawnImpl = async () => ({ pid: 99, alreadyRunning: true });

    const res = await handler("schedules_worker_start")();

    expect(res).toMatchObject({ pid: 99, alreadyRunning: true });
    expect(persistedWorkerEnabled()).toBe(true);
  });

  test("throws and leaves the flag untouched when the spawn fails", async () => {
    spawnImpl = async () => {
      throw new FakeSpawnError("worker exited during startup");
    };

    await expect(handler("schedules_worker_start")()).rejects.toThrow(
      "worker exited during startup",
    );
    // A failed spawn leaves the seeded flag untouched (never enabled).
    expect(persistedWorkerEnabled()).toBe(false);
  });
});

describe("schedules_worker_stop", () => {
  test("disables the flag and reports a signalled running worker", async () => {
    // Start from an enabled flag so the disable is observable.
    configEnabled = true;
    seedSchedules();
    stopImpl = () => ({ status: "running", pid: 555 });

    const res = await handler("schedules_worker_stop")();

    expect(persistedWorkerEnabled()).toBe(false);
    expect(res).toEqual({
      workerWasRunning: true,
      pid: 555,
      workerEnabled: false,
    });
  });

  test("disables the flag and succeeds when no worker is running", async () => {
    // Start from an enabled flag so the disable is observable.
    configEnabled = true;
    seedSchedules();
    stopImpl = () => ({ status: "not_running" });

    const res = await handler("schedules_worker_stop")();

    expect(persistedWorkerEnabled()).toBe(false);
    expect(res).toEqual({ workerWasRunning: false, workerEnabled: false });
  });
});

describe("schedules_worker_status", () => {
  test("reports a running worker with the flag on and the in-process scheduler standing down", async () => {
    workerProbe = { status: "running", pid: 321 };
    configEnabled = true;
    seedSchedules();

    const res = await handler("schedules_worker_status")();

    expect(res).toEqual({
      status: "running",
      pid: 321,
      workerEnabled: true,
      inProcessScheduler: { status: "not_running" },
    });
  });

  test("reports the daemon as the schedule runner when the flag is off", async () => {
    workerProbe = { status: "not_running" };
    configEnabled = false;
    seedSchedules();

    const res = await handler("schedules_worker_status")();

    expect(res).toEqual({
      status: "not_running",
      workerEnabled: false,
      inProcessScheduler: { status: "running", pid: process.pid },
    });
  });
});
