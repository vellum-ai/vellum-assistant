/**
 * Tests for the schedule worker control routes (start / stop / status).
 *
 * The route handlers run inside the daemon and manage the worker process. We
 * mock schedule worker-control so the tests assert handler behaviour:
 *   - start spawns as a daemon child (detached:false) and throws on failure.
 *   - stop signals the worker and reports its prior state.
 *   - status reports the worker process liveness.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { getScheduleWorkerPidPath } from "../../../util/platform.js";

class FakeSpawnError extends Error {}

let spawnImpl: () => Promise<{ pid: number; alreadyRunning: boolean }>;
let spawnArgs: Array<{ detached?: boolean; terminateOnTimeout?: boolean }> = [];
let stopImpl: () => { status: "running" | "not_running"; pid?: number };
let workerProbe: { status: "running" | "not_running"; pid?: number } = {
  status: "not_running",
};

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
});

describe("schedules_worker_start", () => {
  test("spawns as a daemon child and returns the PID", async () => {
    spawnImpl = async () => ({ pid: 4242, alreadyRunning: false });

    const res = await handler("schedules_worker_start")();

    expect(spawnArgs).toEqual([{ detached: false }]);
    expect(res).toEqual({
      pid: 4242,
      alreadyRunning: false,
      pidPath: getScheduleWorkerPidPath(),
    });
  });

  test("reports an already-running worker without re-spawning", async () => {
    spawnImpl = async () => ({ pid: 99, alreadyRunning: true });

    const res = await handler("schedules_worker_start")();

    expect(res).toMatchObject({ pid: 99, alreadyRunning: true });
  });

  test("throws when the spawn fails", async () => {
    spawnImpl = async () => {
      throw new FakeSpawnError("worker exited during startup");
    };

    await expect(handler("schedules_worker_start")()).rejects.toThrow(
      "worker exited during startup",
    );
  });
});

describe("schedules_worker_stop", () => {
  test("reports a signalled running worker", async () => {
    stopImpl = () => ({ status: "running", pid: 555 });

    const res = await handler("schedules_worker_stop")();

    expect(res).toEqual({ workerWasRunning: true, pid: 555 });
  });

  test("succeeds when no worker is running", async () => {
    stopImpl = () => ({ status: "not_running" });

    const res = await handler("schedules_worker_stop")();

    expect(res).toEqual({ workerWasRunning: false });
  });
});

describe("schedules_worker_status", () => {
  test("reports a running worker with its PID", async () => {
    workerProbe = { status: "running", pid: 321 };

    const res = await handler("schedules_worker_status")();

    expect(res).toEqual({ status: "running", pid: 321 });
  });

  test("reports not_running when the worker process is absent", async () => {
    workerProbe = { status: "not_running" };

    const res = await handler("schedules_worker_status")();

    expect(res).toEqual({ status: "not_running" });
  });
});
